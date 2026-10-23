# -*- coding: utf-8 -*-
"""删掉鼓点白闪：移除 UI、查询、默认值、解析、同步、事件与两处触发；
   保留 flashBackground 仅用于换歌时的一次柔光（强度大幅降低）。"""
from pathlib import Path

TS = Path(r"E:\Zilux2开发\web\src\ui\spaceShell.ts")
NL = "\r\n"


def read(p: Path) -> str:
    with p.open(encoding="utf-8", newline="") as f:
        return f.read()


def write(p: Path, s: str) -> None:
    with p.open("w", encoding="utf-8", newline="") as f:
        f.write(s)


def rep(text: str, lines_old, lines_new, tag: str) -> str:
    old = NL.join(lines_old)
    new = NL.join(lines_new) if lines_new else ""
    assert text.count(old) == 1, f"{tag}: got {text.count(old)}"
    return text.replace(old, new)


ts = read(TS)

# 1) HTML：整块删掉「鼓点白闪」
ts = rep(
    ts,
    [
        '              <div class="custom-label"><span>鼓点白闪</span><b data-beat-flash-current>开</b></div>',
        '              <div class="custom-seg" data-beat-flash-seg>',
        '                <button class="custom-seg-btn" data-beat-flash="0" type="button">关</button>',
        '                <button class="custom-seg-btn is-on" data-beat-flash="1" type="button">开</button>',
        "              </div>",
        '              <div class="custom-sub" data-beat-flash-options>',
        '                <div class="custom-label"><span>白闪强度</span><b data-beat-flash-strength-current>42%</b></div>',
        '                <input class="custom-slider" data-beat-flash-strength type="range" min="5" max="100" step="1" value="42" aria-label="鼓点白闪强度" />',
        '                <div class="custom-label"><span>白闪时长</span><b data-beat-flash-dur-current>0.95s</b></div>',
        '                <input class="custom-slider" data-beat-flash-dur type="range" min="0.25" max="2.4" step="0.05" value="0.95" aria-label="鼓点白闪时长" />',
        '                <div class="custom-label"><span>白闪颜色</span><b data-beat-flash-color-current>白</b></div>',
        '                <div class="custom-seg" data-beat-flash-color-seg>',
        '                  <button class="custom-seg-btn is-on" data-beat-flash-color="white" type="button">白</button>',
        '                  <button class="custom-seg-btn" data-beat-flash-color="cover" type="button">封面</button>',
        '                  <button class="custom-seg-btn" data-beat-flash-color="theme" type="button">主题</button>',
        '                  <button class="custom-seg-btn" data-beat-flash-color="warm" type="button">暖光</button>',
        "                </div>",
        "              </div>",
    ],
    [],
    "html-remove",
)

# 2) flashBackground：只保留换歌柔光，去掉 beat 分支与全部自定义项
ts = rep(
    ts,
    [
        "  const flashBackground = (strength = 1, beat = false): void => {",
        "    if (beat && !custom.beatFlash) return;",
        "    const scale = Math.max(0.06, custom.beatFlashStrength / 42);",
        "    const alpha = Math.min(0.9, Math.max(0.16, 1.02 * strength * scale));",
        "    const accent =",
        "      custom.beatFlashColor === 'cover'",
        "        ? (paletteColors?.[0] ?? '#ffffff')",
        "        : custom.beatFlashColor === 'theme'",
        "          ? (root.classList.contains('theme-gold') ? '#f4e2a4' : '#cfe3ff')",
        "          : custom.beatFlashColor === 'warm'",
        "            ? '#ffe2b0'",
        "            : '#ffffff';",
        "    flashLayer.style.background = [",
        "      `radial-gradient(150% 118% at 50% 44%, rgba(255, 255, 255, 0.99) 0%, ${withAlpha(accent, 0.86)} 32%, ${withAlpha(accent, 0.34)} 68%, ${withAlpha(accent, 0)} 96%)`,",
        "      `radial-gradient(80% 60% at 50% 44%, rgba(255, 255, 255, 0.96) 0%, ${withAlpha(accent, 0.5)} 46%, ${withAlpha(accent, 0)} 88%)`,",
        "    ].join(',');",
        "    flashLayer.style.transition = 'none';",
        "    flashLayer.style.opacity = String(alpha);",
        "    void flashLayer.offsetWidth;",
        "    flashLayer.style.transition = `opacity ${custom.beatFlashDur.toFixed(2)}s cubic-bezier(0.22, 0.8, 0.28, 1)`;",
        "    flashLayer.style.opacity = '0';",
        "  };",
    ],
    [
        "  // 仅用于换歌/换封面时的一次柔光，鼓点白闪已移除",
        "  const flashBackground = (strength = 1): void => {",
        "    const alpha = Math.min(0.34, Math.max(0.08, 0.34 * strength));",
        "    const accent = root.classList.contains('theme-gold') ? '#f4e2a4' : '#cfe3ff';",
        "    flashLayer.style.background = [",
        "      `radial-gradient(150% 118% at 50% 44%, rgba(255, 255, 255, 0.5) 0%, ${withAlpha(accent, 0.3)} 32%, ${withAlpha(accent, 0.12)} 68%, ${withAlpha(accent, 0)} 96%)`,",
        "      `radial-gradient(80% 60% at 50% 44%, rgba(255, 255, 255, 0.44) 0%, ${withAlpha(accent, 0.2)} 46%, ${withAlpha(accent, 0)} 88%)`,",
        "    ].join(',');",
        "    flashLayer.style.transition = 'none';",
        "    flashLayer.style.opacity = String(alpha);",
        "    void flashLayer.offsetWidth;",
        "    flashLayer.style.transition = 'opacity 0.8s cubic-bezier(0.22, 0.8, 0.28, 1)';",
        "    flashLayer.style.opacity = '0';",
        "  };",
    ],
    "flash-fn",
)

# 3) triggerColorSweep：去掉闪（同帧换色保留）
ts = rep(
    ts,
    [
        "    // 换色和擦除在同一帧开始：闪、擦、变色三件事同时发生，不会一前一后",
        "    flashBackground(Math.min(1, 0.42 + strength * 0.58), true);",
        "    applyBgColorSetting(false);",
    ],
    [
        "    // 换色与擦除同帧开始（白闪已移除，只保留擦除转场）",
        "    applyBgColorSetting(false);",
    ],
    "sweep-no-flash",
)

# 4) 鼓点回调：去掉白闪调用
ts = rep(
    ts,
    [
        "      // 白闪跟随音频节奏：每个鼓点来一下（强弱跟能量），不依赖背景换色模式",
        "      const beatHit = frame.beat || crossed;",
        "      if (beatHit && colorPlaying && now - lastBeatFlashAt > 150) {",
        "        lastBeatFlashAt = now;",
        "        const strength = Math.min(1, 0.22 + Math.max(0, Math.min(1, bass)) * 0.78);",
        "        space?.flashLyricColor(strength * 0.9);",
        "        flashBackground(0.35 + strength * 0.55, true);",
    ],
    [
        "      // 鼓点命中：歌词闪光、背景粒子响应、节奏换色累计（白闪已删除）",
        "      const beatHit = frame.beat || crossed;",
        "      if (beatHit && colorPlaying && now - lastBeatFlashAt > 150) {",
        "        lastBeatFlashAt = now;",
        "        const strength = Math.min(1, 0.22 + Math.max(0, Math.min(1, bass)) * 0.78);",
        "        space?.flashLyricColor(strength * 0.9);",
    ],
    "beat-no-flash",
)

# 5) 查询块（含 BEAT_FLASH_LABEL）
ts = rep(
    ts,
    [
        "  const beatFlashBtns = root.querySelectorAll<HTMLButtonElement>('[data-beat-flash]');",
        "  const beatFlashCurrent = root.querySelector<HTMLElement>('[data-beat-flash-current]')!;",
        "  const beatFlashOptions = root.querySelector<HTMLElement>('[data-beat-flash-options]')!;",
        "  const beatFlashStrengthInput = root.querySelector<HTMLInputElement>('[data-beat-flash-strength]')!;",
        "  const beatFlashStrengthCurrent = root.querySelector<HTMLElement>('[data-beat-flash-strength-current]')!;",
        "  const beatFlashDurInput = root.querySelector<HTMLInputElement>('[data-beat-flash-dur]')!;",
        "  const beatFlashDurCurrent = root.querySelector<HTMLElement>('[data-beat-flash-dur-current]')!;",
        "  const beatFlashColorBtns = root.querySelectorAll<HTMLButtonElement>('[data-beat-flash-color]');",
        "  const beatFlashColorCurrent = root.querySelector<HTMLElement>('[data-beat-flash-color-current]')!;",
        "  const BEAT_FLASH_LABEL: Record<string, string> = { white: '白', cover: '封面', theme: '主题', warm: '暖光' };",
    ],
    [],
    "queries-remove",
)

# 6) 默认值
ts = rep(
    ts,
    [
        "    beatFlash: true,",
        "    beatFlashStrength: 42,",
        "    beatFlashDur: 0.95,",
        "    beatFlashColor: 'white' as 'white' | 'cover' | 'theme' | 'warm',",
    ],
    [],
    "defaults-remove",
)

# 7) Partial 类型
ts = rep(
    ts,
    [
        "        beatFlash?: unknown;",
        "        beatFlashStrength?: unknown;",
        "        beatFlashDur?: unknown;",
        "        beatFlashColor?: unknown;",
    ],
    [],
    "partial-remove",
)

# 8) loadCustom 解析
ts = rep(
    ts,
    [
        "        beatFlash: typeof parsed.beatFlash === 'boolean' ? parsed.beatFlash : true,",
        "        beatFlashStrength:",
        "          typeof parsed.beatFlashStrength === 'number'",
        "            ? Math.min(100, Math.max(5, Math.round(parsed.beatFlashStrength)))",
        "            : 42,",
        "        beatFlashDur:",
        "          typeof parsed.beatFlashDur === 'number'",
        "            ? Math.min(2.4, Math.max(0.25, Math.round(parsed.beatFlashDur * 20) / 20))",
        "            : 0.95,",
        "        beatFlashColor:",
        "          parsed.beatFlashColor === 'cover' ||",
        "          parsed.beatFlashColor === 'theme' ||",
        "          parsed.beatFlashColor === 'warm'",
        "            ? parsed.beatFlashColor",
        "            : 'white',",
    ],
    [],
    "load-remove",
)

# 9) syncBeatFlashUi 函数与调用
ts = rep(
    ts,
    [
        "  const syncBeatFlashUi = (): void => {",
        "    beatFlashBtns.forEach((button) => {",
        "      button.classList.toggle('is-on', (button.dataset.beatFlash === '1') === custom.beatFlash);",
        "    });",
        "    beatFlashCurrent.textContent = custom.beatFlash ? '开' : '关';",
        "    beatFlashOptions.classList.toggle('is-off', !custom.beatFlash);",
        "    beatFlashStrengthInput.value = String(custom.beatFlashStrength);",
        "    beatFlashStrengthCurrent.textContent = `${custom.beatFlashStrength}%`;",
        "    beatFlashDurInput.value = String(custom.beatFlashDur);",
        "    beatFlashDurCurrent.textContent = `${custom.beatFlashDur.toFixed(2)}s`;",
        "    beatFlashColorBtns.forEach((button) => {",
        "      button.classList.toggle('is-on', button.dataset.beatFlashColor === custom.beatFlashColor);",
        "    });",
        "    beatFlashColorCurrent.textContent = BEAT_FLASH_LABEL[custom.beatFlashColor] ?? '白';",
        "  };",
    ],
    [],
    "sync-remove",
)
ts = rep(
    ts,
    [
        "    syncHotkeysUi();",
        "    syncBeatFlashUi();",
        "    syncSweepUi();",
    ],
    [
        "    syncHotkeysUi();",
        "    syncSweepUi();",
    ],
    "sync-call-remove",
)

# 10) 事件处理
ts = rep(
    ts,
    [
        "  beatFlashBtns.forEach((button) => {",
        "    button.addEventListener('click', () => {",
        "      custom.beatFlash = button.dataset.beatFlash === '1';",
        "      syncCustomUi();",
        "      persistCustom();",
        "    });",
        "  });",
        "  beatFlashStrengthInput.addEventListener('input', () => {",
        "    custom.beatFlashStrength = Math.min(100, Math.max(5, Math.round(Number(beatFlashStrengthInput.value) || 42)));",
        "    beatFlashStrengthCurrent.textContent = `${custom.beatFlashStrength}%`;",
        "    persistCustom();",
        "  });",
        "  beatFlashDurInput.addEventListener('input', () => {",
        "    custom.beatFlashDur = Math.min(2.4, Math.max(0.25, Math.round((Number(beatFlashDurInput.value) || 0.95) * 20) / 20));",
        "    beatFlashDurCurrent.textContent = `${custom.beatFlashDur.toFixed(2)}s`;",
        "    persistCustom();",
        "  });",
        "  beatFlashColorBtns.forEach((button) => {",
        "    button.addEventListener('click', () => {",
        "      const value = button.dataset.beatFlashColor;",
        "      custom.beatFlashColor =",
        "        value === 'cover' || value === 'theme' || value === 'warm' ? value : 'white';",
        "      syncCustomUi();",
        "      persistCustom();",
        "    });",
        "  });",
    ],
    [],
    "handlers-remove",
)

# 11) flashBackground 只在换歌处调用，参数保持兼容
write(TS, ts)
print("OK: html-remove, flash-fn, sweep-no-flash, beat-no-flash, queries-remove, defaults-remove, partial-remove, load-remove, sync-remove, sync-call-remove, handlers-remove")
