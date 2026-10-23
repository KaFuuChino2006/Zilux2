# -*- coding: utf-8 -*-
"""歌词文字细节（辉光 / 每字大小随机 / 每字位置偏差）—— spaceShell 侧补丁
floatScene.ts 的渲染层已由 patch_lyric_type.py 写入，这里只补 UI 与下发。
"""
from pathlib import Path

TS = Path(r"E:\Zilux2开发\web\src\ui\spaceShell.ts")
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


ts = read(TS)

# A) HTML：在「散布封面」之前插入文字细节三滑条
html = CRLF.join(
    [
        '              <div class="custom-field">',
        '                <div class="custom-label"><span>文字辉光</span><b data-lyric-glow-current>35%</b></div>',
        '                <input class="custom-slider" data-lyric-glow type="range" min="0" max="100" step="1" value="35" aria-label="歌词文字辉光" />',
        '                <div class="custom-label"><span>每字大小随机</span><b data-lyric-size-jitter-current>12%</b></div>',
        '                <input class="custom-slider" data-lyric-size-jitter type="range" min="0" max="40" step="1" value="12" aria-label="每字大小随机幅度" />',
        '                <div class="custom-label"><span>每字位置偏差</span><b data-lyric-pos-jitter-current>8%</b></div>',
        '                <input class="custom-slider" data-lyric-pos-jitter type="range" min="0" max="30" step="1" value="8" aria-label="每字位置偏差幅度" />',
        '                <p class="custom-tip">辉光：字形外圈的柔光晕；大小随机：每个字大小略有差异；位置偏差：每个字上下左右轻微错位</p>',
        '              </div>',
        '              <div class="custom-field">',
        '                <div class="custom-label"><span>散布封面</span>',
    ]
)
ts = rep(
    ts,
    '              <div class="custom-field">' + CRLF
    + '                <div class="custom-label"><span>散布封面</span>',
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

# D) Partial 类型
ts = rep(
    ts,
    "        lyricFont?: unknown;",
    "        lyricFont?: unknown;" + CRLF
    + "        lyricGlow?: unknown;" + CRLF
    + "        lyricSizeJitter?: unknown;" + CRLF
    + "        lyricPosJitter?: unknown;",
    "partial-type",
)

# E) clampUnit 工具（放在 clampCount 之前）
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

# F) loadCustom 解析
ts = rep(
    ts,
    "        lyricFont: typeof parsed.lyricFont === 'string' ? parsed.lyricFont.slice(0, 80) : '',",
    "        lyricFont: typeof parsed.lyricFont === 'string' ? parsed.lyricFont.slice(0, 80) : ''," + CRLF
    + "        lyricGlow: clampUnit(parsed.lyricGlow, DEFAULT_CUSTOM.lyricGlow, 0, 100)," + CRLF
    + "        lyricSizeJitter: clampUnit(parsed.lyricSizeJitter, DEFAULT_CUSTOM.lyricSizeJitter, 0, 40)," + CRLF
    + "        lyricPosJitter: clampUnit(parsed.lyricPosJitter, DEFAULT_CUSTOM.lyricPosJitter, 0, 30),",
    "load-parse",
)

# G) syncCustomUi 同步（用「value + textContent」这对唯一组合做锚点，避免撞 handler 里的同名行）
sync_old = (
    "    mgSweepWidthInput.value = String(custom.mgSweepWidth);" + CRLF
    + "    mgSweepWidthCurrent.textContent = `${custom.mgSweepWidth}px`;"
)
sync_new = (
    sync_old + CRLF
    + "    lyricGlowInput.value = String(custom.lyricGlow);" + CRLF
    + "    lyricGlowCurrent.textContent = `${custom.lyricGlow}%`;" + CRLF
    + "    lyricSizeJitterInput.value = String(custom.lyricSizeJitter);" + CRLF
    + "    lyricSizeJitterCurrent.textContent = `${custom.lyricSizeJitter}%`;" + CRLF
    + "    lyricPosJitterInput.value = String(custom.lyricPosJitter);" + CRLF
    + "    lyricPosJitterCurrent.textContent = `${custom.lyricPosJitter}%`;"
)
ts = rep(ts, sync_old, sync_new, "sync")

# H) 下发函数（放在 applySpectrumSetting 之前）
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

# I) applyCustom 里调用
ts = rep(
    ts,
    "    space?.setLyricFontFamily(custom.lyricFont || '');" + CRLF + "  };",
    "    space?.setLyricFontFamily(custom.lyricFont || '');" + CRLF
    + "    applyLyricTypeStyle();" + CRLF
    + "  };",
    "apply-custom",
)

# J) 事件绑定
handlers_old = (
    "  mgSweepWidthInput.addEventListener('input', () => {" + CRLF
    + "    custom.mgSweepWidth = Math.min(720, Math.max(6, Math.round(Number(mgSweepWidthInput.value) || 54)));" + CRLF
    + "    mgSweepWidthCurrent.textContent = `${custom.mgSweepWidth}px`;" + CRLF
    + "    persistCustom();" + CRLF
    + "  });"
)
handlers_new = handlers_old + CRLF + CRLF.join(
    [
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
ts = rep(ts, handlers_old, handlers_new, "handlers")

write(TS, ts)
print("OK: ts-html, ts-queries, ts-defaults, ts-load, ts-sync, ts-apply, ts-handlers")
