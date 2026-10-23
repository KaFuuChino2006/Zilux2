# -*- coding: utf-8 -*-
"""歌词文字：可调辉光 + 每字随机大小 + 每字位置随机偏差"""
from pathlib import Path

ROOT = Path(r"E:\Zilux2开发")
FS = ROOT / "web/src/three/floatScene.ts"
TS = ROOT / "web/src/ui/spaceShell.ts"
CRLF = "\r\n"


def read(p: Path) -> str:
    with p.open(encoding="utf-8", newline="") as f:
        return f.read()


def write(p: Path, s: str) -> None:
    with p.open("w", encoding="utf-8", newline="") as f:
        f.write(s)


def rep(text: str, old: str, new: str, tag: str, count: int = 1) -> str:
    assert text.count(old) == count, f"{tag}: expect {count}, got {text.count(old)}"
    return text.replace(old, new)


# ============================ floatScene.ts ============================
fs = read(FS)

# 1) 状态变量
fs = rep(
    fs,
    "  let lyricFontFamily = '';",
    "  let lyricFontFamily = '';" + CRLF
    + "  // 歌词文字的辉光强度与「每字随机」幅度（0~1 的比例值）" + CRLF
    + "  let lyricTypeGlow = 0.35;" + CRLF
    + "  let lyricTypeSizeJitter = 0.12;" + CRLF
    + "  let lyricTypePosJitter = 0.08;",
    "state",
)

# 2) uniform 声明
fs = rep(
    fs,
    "            uUvScale: { value: new THREE.Vector2(1, 1) },",
    "            uUvScale: { value: new THREE.Vector2(1, 1) }," + CRLF
    + "            uGlow: { value: 0.35 },",
    "uniforms",
)

# 3) fragment 里声明 uGlow
fs = rep(
    fs,
    "            'uniform vec2 uUvScale;',",
    "            'uniform vec2 uUvScale;'," + CRLF
    + "            'uniform float uGlow;',",
    "frag-decl",
)

# 4) 辉光采样：在字形外圈按 8 个方向取 alpha，做柔光晕
glow_sample = (
    "            '  vec2 guv = vUv * uUvScale + uUvOffset;'," + CRLF
    + "            '  vec4 tex = texture2D(uMap, guv);'," + CRLF
    + "            '  // 辉光：在字形四周采样一圈 alpha，形成可调的柔光晕'," + CRLF
    + "            '  float halo = 0.0;'," + CRLF
    + "            '  if (uGlow > 0.002) {'," + CRLF
    + "            '    vec2 gr = vec2(0.014, 0.055) * uGlow;'," + CRLF
    + "            '    float gs = 0.0;'," + CRLF
    + "            '    gs += texture2D(uMap, guv + vec2(gr.x, 0.0)).a;'," + CRLF
    + "            '    gs += texture2D(uMap, guv - vec2(gr.x, 0.0)).a;'," + CRLF
    + "            '    gs += texture2D(uMap, guv + vec2(0.0, gr.y)).a;'," + CRLF
    + "            '    gs += texture2D(uMap, guv - vec2(0.0, gr.y)).a;'," + CRLF
    + "            '    gs += texture2D(uMap, guv + gr * vec2(0.72, 0.72)).a;'," + CRLF
    + "            '    gs += texture2D(uMap, guv - gr * vec2(0.72, 0.72)).a;'," + CRLF
    + "            '    gs += texture2D(uMap, guv + gr * vec2(0.72, -0.72)).a;'," + CRLF
    + "            '    gs += texture2D(uMap, guv + gr * vec2(-0.72, 0.72)).a;'," + CRLF
    + "            '    halo = clamp(gs / 8.0, 0.0, 1.0);'," + CRLF
    + "            '  }'," + CRLF
    + "            '  if (tex.a < 0.02 && halo < 0.02) discard;',"
)
fs = rep(
    fs,
    "            '  vec2 guv = vUv * uUvScale + uUvOffset;'," + CRLF
    + "            '  vec4 tex = texture2D(uMap, guv);'," + CRLF
    + "            '  if (tex.a < 0.02) discard;',",
    glow_sample,
    "frag-glow",
)

# 5) 结尾把光晕叠上去
fs = rep(
    fs,
    "            '  gl_FragColor = vec4(color, alpha);',",
    "            '  // 柔光晕：颜色跟随当前句颜色，越往外越淡'," + CRLF
    + "            '  if (halo > 0.002) {'," + CRLF
    + "            '    float haloOut = clamp(halo * (1.0 - tex.a), 0.0, 1.0);'," + CRLF
    + "            '    color = mix(color, baseColor, clamp(haloOut * 1.4, 0.0, 1.0));'," + CRLF
    + "            '    alpha = clamp(alpha + haloOut * uGlow * 0.9, 0.0, 1.0);'," + CRLF
    + "            '  }'," + CRLF
    + "            '  gl_FragColor = vec4(color, alpha);',",
    "frag-compose",
)

# 6) 每帧同步 uGlow
fs = rep(
    fs,
    "    material.uniforms.uFlash!.value = lyricColorFlash;",
    "    material.uniforms.uFlash!.value = lyricColorFlash;" + CRLF
    + "    material.uniforms.uGlow!.value = lyricTypeGlow;",
    "uniform-sync",
)

# 7) paintLyricLine 改用「逐字随机」绘制
fs = rep(
    fs,
    "      view.charBoxes = drawLyricTextWithBoxes(ctx, view.text, W / 2, mainY, W * 0.94, 2, 56, 34, 700).map(",
    "      view.charBoxes = drawLyricGlyphsWithBoxes(ctx, view.text, W / 2, mainY, W * 0.94, 2, 56, 34, 700, view.index).map(",
    "paint-call",
)

# 8) 新增逐字绘制函数（放在 drawLyricTextWithBoxes 之后）
glyph_fn = CRLF.join(
    [
        "  /** 逐字绘制：每个字可有随机的字号与位置偏差（可调），同时记录横向范围用于逐字点亮 */",
        "  function drawLyricGlyphsWithBoxes(",
        "    ctx: CanvasRenderingContext2D,",
        "    text: string,",
        "    centerX: number,",
        "    centerY: number,",
        "    maxWidth: number,",
        "    maxLines: number,",
        "    baseSize: number,",
        "    minSize: number,",
        "    weight: number,",
        "    seed: number,",
        "  ): Array<{ x0: number; x1: number }> {",
        "    if (!text) return [];",
        "    const size = fitLyricFontSize(ctx, text, maxWidth, baseSize, minSize, weight);",
        "    let lines = [text];",
        "    if (ctx.measureText(text).width > maxWidth) {",
        "      lines = [];",
        "      const perLine = Math.max(1, Math.ceil(text.length / maxLines));",
        "      for (let i = 0; i < text.length; i += perLine) lines.push(text.slice(i, i + perLine));",
        "    }",
        "    const lineHeight = size * 1.16;",
        "    const startY = centerY - ((lines.length - 1) * lineHeight) / 2;",
        "    const boxes: Array<{ x0: number; x1: number }> = [];",
        "    // 同一句里每个字的随机值固定（换帧不会乱跳），不同句子由 seed 区分",
        "    const rand = (n: number): number => {",
        "      const v = Math.sin((n + 1) * 127.1 + seed * 311.7 + text.length * 74.7) * 43758.5453;",
        "      return v - Math.floor(v);",
        "    };",
        "    const jitterOn = lyricTypeSizeJitter > 0.001 || lyricTypePosJitter > 0.001;",
        "    lines.forEach((line, lineIndex) => {",
        "      const y = startY + lineIndex * lineHeight;",
        "      if (!jitterOn) {",
        "        ctx.font = weight + ' ' + size + 'px ' + lyricFontStack();",
        "        if (lines.length === 1) {",
        "          let cursor = centerX - ctx.measureText(line).width / 2;",
        "          for (const glyph of Array.from(line)) {",
        "            const width = ctx.measureText(glyph).width;",
        "            if (glyph.trim().length > 0) boxes.push({ x0: cursor, x1: cursor + width });",
        "            cursor += width;",
        "          }",
        "        }",
        "        ctx.fillText(line, centerX, y);",
        "        return;",
        "      }",
        "      const glyphs = Array.from(line);",
        "      ctx.font = weight + ' ' + size + 'px ' + lyricFontStack();",
        "      const widths = glyphs.map((glyph) => ctx.measureText(glyph).width);",
        "      const total = widths.reduce((sum, width) => sum + width, 0);",
        "      let cursor = centerX - total / 2;",
        "      glyphs.forEach((glyph, index) => {",
        "        const width = widths[index];",
        "        const r1 = rand(index * 3);",
        "        const r2 = rand(index * 3 + 1);",
        "        const r3 = rand(index * 3 + 2);",
        "        const scale = 1 + (r1 - 0.5) * 2 * lyricTypeSizeJitter;",
        "        const charSize = Math.max(10, size * scale);",
        "        const dx = (r2 - 0.5) * 2 * lyricTypePosJitter * size * 0.55;",
        "        const dy = (r3 - 0.5) * 2 * lyricTypePosJitter * size * 0.5;",
        "        if (glyph.trim().length > 0) {",
        "          ctx.font = weight + ' ' + charSize.toFixed(2) + 'px ' + lyricFontStack();",
        "          ctx.fillText(glyph, cursor + width / 2 + dx, y + dy);",
        "          if (lines.length === 1) boxes.push({ x0: cursor, x1: cursor + width });",
        "        }",
        "        cursor += width;",
        "      });",
        "    });",
        "    return lines.length === 1 ? boxes : [];",
        "  }",
        "",
        "  function ensureLyricLines(): void {",
    ]
)
fs = rep(fs, "  function ensureLyricLines(): void {", glyph_fn, "glyph-fn")

# 9) Handle 接口
fs = rep(
    fs,
    "  setLyricFontFamily(family: string): void;",
    "  setLyricFontFamily(family: string): void;" + CRLF
    + "  setLyricTypeStyle(style: { glow?: number; sizeJitter?: number; posJitter?: number }): void;",
    "handle-iface",
)

# 10) Handle 实现
impl = CRLF.join(
    [
        "    setLyricTypeStyle(style) {",
        "      if (typeof style.glow === 'number') lyricTypeGlow = Math.max(0, Math.min(1, style.glow));",
        "      if (typeof style.sizeJitter === 'number')",
        "        lyricTypeSizeJitter = Math.max(0, Math.min(0.4, style.sizeJitter));",
        "      if (typeof style.posJitter === 'number')",
        "        lyricTypePosJitter = Math.max(0, Math.min(0.4, style.posJitter));",
        "      for (const view of lyricLines) {",
        "        if (view.index >= 0 || view.text) paintLyricLine(view);",
        "      }",
        "    },",
        "    setLyricColorMode(mode, palette) {",
    ]
)
fs = rep(fs, "    setLyricColorMode(mode, palette) {", impl, "handle-impl")
write(FS, fs)

# ============================ spaceShell.ts ============================
ts = read(TS)

# A) HTML：歌词动画里加「文字细节」一节（放在「散布封面」之前）
html = CRLF.join(
    [
        "              <div class=\"custom-field\">",
        "                <div class=\"custom-label\"><span>文字辉光</span><b data-lyric-glow-current>35%</b></div>",
        "                <input class=\"custom-slider\" data-lyric-glow type=\"range\" min=\"0\" max=\"100\" step=\"1\" value=\"35\" aria-label=\"歌词文字辉光\" />",
        "                <div class=\"custom-label\"><span>每字大小随机</span><b data-lyric-size-jitter-current>12%</b></div>",
        "                <input class=\"custom-slider\" data-lyric-size-jitter type=\"range\" min=\"0\" max=\"40\" step=\"1\" value=\"12\" aria-label=\"每字大小随机幅度\" />",
        "                <div class=\"custom-label\"><span>每字位置偏差</span><b data-lyric-pos-jitter-current>8%</b></div>",
        "                <input class=\"custom-slider\" data-lyric-pos-jitter type=\"range\" min=\"0\" max=\"30\" step=\"1\" value=\"8\" aria-label=\"每字位置偏差幅度\" />",
        "                <p class=\"custom-tip\">辉光：字形外圈的柔光晕；大小随机：每个字大小略有差异；位置偏差：每个字上下左右轻微错位</p>",
        "              </div>",
        "              <div class=\"custom-field\">",
        "                <div class=\"custom-label\"><span>散布封面</span>",
    ]
)
ts = rep(
    ts,
    "              <div class=\"custom-field\">" + CRLF
    + "                <div class=\"custom-label\"><span>散布封面</span>",
    html,
    "html",
)

# B) 查询
queries = CRLF.join(
    [
        "  const lyricsSizeBtns = root.querySelectorAll<HTMLButtonElement>('[data-lyrics-size]');",
        "  const lyricGlowInput = root.querySelector<HTMLInputElement>('[data-lyric-glow]')!;",
        "  const lyricGlowCurrent = root.querySelector<HTMLElement>('[data-lyric-glow-current]')!;",
        "  const lyricSizeJitterInput = root.querySelector<HTMLInputElement>('[data-lyric-size-jitter]')!;",
        "  const lyricSizeJitterCurrent = root.querySelector<HTMLElement>('[data-lyric-size-jitter-current]')!;",
        "  const lyricPosJitterInput = root.querySelector<HTMLInputElement>('[data-lyric-pos-jitter]')!;",
        "  const lyricPosJitterCurrent = root.querySelector<HTMLElement>('[data-lyric-pos-jitter-current]')!;",
    ]
)
ts = rep(
    ts,
    "  const lyricsSizeBtns = root.querySelectorAll<HTMLButtonElement>('[data-lyrics-size]');",
    queries,
    "queries",
)

# C) 默认值
ts = rep(
    ts,
    "    lyricFont: '',",
    "    lyricFont: ''," + CRLF
    + "    lyricGlow: 35," + CRLF
    + "    lyricSizeJitter: 12," + CRLF
    + "    lyricPosJitter: 8,",
    "defaults",
)

# D) 解析类型
ts = rep(
    ts,
    "        lyricFont?: unknown;",
    "        lyricFont?: unknown;" + CRLF
    + "        lyricGlow?: unknown;" + CRLF
    + "        lyricSizeJitter?: unknown;" + CRLF
    + "        lyricPosJitter?: unknown;",
    "partial-type",
)

# E) loadCustom 解析
ts = rep(
    ts,
    "        lyricFont: typeof parsed.lyricFont === 'string' ? parsed.lyricFont.slice(0, 80) : '',",
    "        lyricFont: typeof parsed.lyricFont === 'string' ? parsed.lyricFont.slice(0, 80) : ''," + CRLF
    + "        lyricGlow: pdf(parsed.lyricGlow, DEFAULT_CUSTOM.lyricGlow, 0, 100),".replace("pdf", "clampUnit")
    + CRLF
    + "        lyricSizeJitter: clampUnit(parsed.lyricSizeJitter, DEFAULT_CUSTOM.lyricSizeJitter, 0, 40),"
    + CRLF
    + "        lyricPosJitter: clampUnit(parsed.lyricPosJitter, DEFAULT_CUSTOM.lyricPosJitter, 0, 30),",
    "load-parse",
)

# loadCustom 里的通用夹取工具：在 clampCount 之后加一个 clampUnit
ts = rep(
    ts,
    "      const clampCount = (value: unknown, fallback: number): number => {",
    "      const clampUnit = (value: unknown, fallback: number, min: number, max: number): number => {" + CRLF
    + "        const n = Number(value);" + CRLF
    + "        if (!Number.isFinite(n)) return fallback;" + CRLF
    + "        return Math.min(max, Math.max(min, Math.round(n)));" + CRLF
    + "      };" + CRLF
    + "      const clampCount = (value: unknown, fallback: number): number => {",
    "clamp-unit",
)

# F) syncCustomUi 同步
sync = CRLF.join(
    [
        "    mgSweepWidthCurrent.textContent = `${custom.mgSweepWidth}px`;",
        "    lyricGlowInput.value = String(custom.lyricGlow);",
        "    lyricGlowCurrent.textContent = `${custom.lyricGlow}%`;",
        "    lyricSizeJitterInput.value = String(custom.lyricSizeJitter);",
        "    lyricSizeJitterCurrent.textContent = `${custom.lyricSizeJitter}%`;",
        "    lyricPosJitterInput.value = String(custom.lyricPosJitter);",
        "    lyricPosJitterCurrent.textContent = `${custom.lyricPosJitter}%`;",
    ]
)
ts = rep(
    ts,
    "    mgSweepWidthCurrent.textContent = `${custom.mgSweepWidth}px`;",
    sync,
    "sync",
)

# G) 应用函数
apply_fn = CRLF.join(
    [
        "  function applyLyricTypeStyle(): void {",
        "    space?.setLyricTypeStyle({",
        "      glow: custom.lyricGlow / 100,",
        "      sizeJitter: custom.lyricSizeJitter / 100,",
        "      posJitter: custom.lyricPosJitter / 100,",
        "    });",
        "  }",
        "",
        "  function applySpectrumSetting(): void {",
    ]
)
ts = rep(ts, "  function applySpectrumSetting(): void {", apply_fn, "apply-fn")

# 在 applyCustom 里调用
ts = rep(
    ts,
    "    space?.setLyricFontFamily(custom.lyricFont || '');\r\n  };",
    "    space?.setLyricFontFamily(custom.lyricFont || '');" + CRLF
    + "    applyLyricTypeStyle();" + CRLF
    + "  };",
    "apply-custom",
)

# H) 事件绑定（放在 mgSweepWidth 之后）
handlers = CRLF.join(
    [
        "  mgSweepWidthInput.addEventListener('input', () => {",
        "    custom.mgSweepWidth = Math.min(720, Math.max(6, Math.round(Number(mgSweepWidthInput.value) || 54)));",
        "    mgSweepWidthCurrent.textContent = `${custom.mgSweepWidth}px`;",
        "    persistCustom();",
        "  });",
        "  lyricGlowInput.addEventListener('input', () => {",
        "    custom.lyricGlow = Math.min(100, Math.max(0, Math.round(Number(lyricGlowInput.value) || 0)));",
        "    lyricGlowCurrent.textContent = `${custom.lyricGlow}%`;",
        "    applyLyricTypeStyle();",
        "    persistCustom();",
        "  });",
        "  lyricSizeJitterInput.addEventListener('input', () => {",
        "    custom.lyricSizeJitter = Math.min(40, Math.max(0, Math.round(Number(lyricSizeJitterInput.value) || 0)));",
        "    lyricSizeJitterCurrent.textContent = `${custom.lyricSizeJitter}%`;",
        "    applyLyricTypeStyle();",
        "    persistCustom();",
        "  });",
        "  lyricPosJitterInput.addEventListener('input', () => {",
        "    custom.lyricPosJitter = Math.min(30, Math.max(0, Math.round(Number(lyricPosJitterInput.value) || 0)));",
        "    lyricPosJitterCurrent.textContent = `${custom.lyricPosJitter}%`;",
        "    applyLyricTypeStyle();",
        "    persistCustom();",
        "  });",
    ]
)
ts = rep(
    ts,
    "  mgSweepWidthInput.addEventListener('input', () => {" + CRLF
    + "    custom.mgSweepWidth = Math.min(720, Math.max(6, Math.round(Number(mgSweepWidthInput.value) || 54)));" + CRLF
    + "    mgSweepWidthCurrent.textContent = `${custom.mgSweepWidth}px`;" + CRLF
    + "    persistCustom();" + CRLF
    + "  });",
    handlers,
    "handlers",
)
write(TS, ts)
print("OK: fs-state, fs-uniform, fs-glow, fs-glyph, fs-handle; ts-html, ts-queries, ts-defaults, ts-load, ts-sync, ts-apply, ts-handlers")
