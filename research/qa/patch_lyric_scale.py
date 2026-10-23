# -*- coding: utf-8 -*-
"""3D 歌词字号：小/中/大 分段按钮改为可滑动滑条（60%–160%）"""
from pathlib import Path

SS = Path(r"E:\Zilux2开发\web\src\ui\spaceShell.ts")
NL = "\r\n"


def read(p: Path) -> str:
    with p.open(encoding="utf-8", newline="") as f:
        return f.read()


def write(p: Path, s: str) -> None:
    with p.open("w", encoding="utf-8", newline="") as f:
        f.write(s)


def rep(text: str, lines_old, lines_new, tag: str) -> str:
    old = NL.join(lines_old)
    new = NL.join(lines_new)
    assert text.count(old) == 1, f"{tag}: got {text.count(old)}"
    return text.replace(old, new)


ss = read(SS)

# 1) HTML：分段按钮 -> 滑条
ss = rep(
    ss,
    [
        '                <div class="custom-label"><span>3D 歌词字号</span><b data-lyrics-size-current>中</b></div>',
        '                <div class="custom-seg" data-lyrics-size-seg>',
        '                  <button class="custom-seg-btn" data-lyrics-size="small" type="button">小</button>',
        '                  <button class="custom-seg-btn is-on" data-lyrics-size="medium" type="button">中</button>',
        '                  <button class="custom-seg-btn" data-lyrics-size="large" type="button">大</button>',
        "                </div>",
        '                <p class="custom-tip">3D 空间里歌词的字号，改完立即生效并保存</p>',
    ],
    [
        '                <div class="custom-label"><span>3D 歌词字号</span><b data-lyrics-scale-current>100%</b></div>',
        '                <input class="custom-slider" data-lyrics-scale type="range" min="60" max="160" step="2" value="100" aria-label="3D 歌词字号" />',
        '                <p class="custom-tip">3D 空间里歌词的字号，可任意滑动调节（60%–160%），改完立即生效并保存</p>',
    ],
    "html",
)

# 2) 查询
ss = rep(
    ss,
    [
        "  const lyricsSizeBtns = root.querySelectorAll<HTMLButtonElement>('[data-lyrics-size]');",
    ],
    [
        "  const lyricsScaleInput = root.querySelector<HTMLInputElement>('[data-lyrics-scale]')!;",
        "  const lyricsScaleCurrent = root.querySelector<HTMLElement>('[data-lyrics-scale-current]')!;",
    ],
    "query",
)
ss = rep(
    ss,
    [
        "  const lyricsSizeCurrent = root.querySelector<HTMLElement>('[data-lyrics-size-current]')!;",
    ],
    [],
    "query-old",
)

# 3) 默认值
ss = rep(
    ss,
    [
        "    lyricGlow: 55,",
    ],
    [
        "    lyricGlow: 55,",
        "    lyricsScale: 100,",
    ],
    "default",
)

# 4) Partial 类型
ss = rep(
    ss,
    [
        "        lyricGlow?: unknown;",
    ],
    [
        "        lyricGlow?: unknown;",
        "        lyricsScale?: unknown;",
    ],
    "partial",
)

# 5) loadCustom 解析
ss = rep(
    ss,
    [
        "        lyricGlow: clampUnit(parsed.lyricGlow, DEFAULT_CUSTOM.lyricGlow, 0, 100),",
    ],
    [
        "        lyricGlow: clampUnit(parsed.lyricGlow, DEFAULT_CUSTOM.lyricGlow, 0, 100),",
        "        lyricsScale: clampUnit(parsed.lyricsScale, DEFAULT_CUSTOM.lyricsScale, 60, 160),",
    ],
    "load",
)

# 6) 去掉旧的枚举换算，字号统一由 custom.lyricsScale 决定
ss = rep(
    ss,
    [
        "  const sceneLyricsScale = (size: string): number =>",
        "    size === 'small' ? 0.88 : size === 'large' ? 1.16 : 1;",
        "",
    ],
    [],
    "drop-helper",
)
ss = rep(
    ss,
    [
        "    space?.setLyricsScale(sceneLyricsScale(next.appearance.lyricsSize));",
    ],
    [
        "    space?.setLyricsScale(custom.lyricsScale / 100);",
    ],
    "apply-settings",
)

# 7) applyCustom 里同步字号
ss = rep(
    ss,
    [
        "    space?.setLyricFontFamily(custom.lyricFont || '');",
        "    applyLyricTypeStyle();",
    ],
    [
        "    space?.setLyricFontFamily(custom.lyricFont || '');",
        "    applyLyricTypeStyle();",
        "    space?.setLyricsScale(custom.lyricsScale / 100);",
    ],
    "apply-custom",
)

# 8) syncCustomUi
ss = rep(
    ss,
    [
        "    const lyricsSize = getSettings().appearance.lyricsSize;",
        "    lyricsSizeBtns.forEach((button) => {",
        "      button.classList.toggle('is-on', button.dataset.lyricsSize === lyricsSize);",
        "    });",
        "    lyricsSizeCurrent.textContent = lyricsSize === 'small' ? '小' : lyricsSize === 'large' ? '大' : '中';",
    ],
    [
        "    lyricsScaleInput.value = String(custom.lyricsScale);",
        "    lyricsScaleCurrent.textContent = `${custom.lyricsScale}%`;",
    ],
    "sync",
)

# 9) 事件处理器
ss = rep(
    ss,
    [
        "  lyricsSizeBtns.forEach((button) => {",
        "    button.addEventListener('click', () => {",
        "      const value = button.dataset.lyricsSize;",
        "      const size = value === 'small' || value === 'large' ? value : 'medium';",
        "      patchSettings({ appearance: { lyricsSize: size } } as never);",
        "      applySettingsToScene(getSettings());",
        "      syncCustomUi();",
        "      syncSettingsUi();",
        "    });",
        "  });",
    ],
    [
        "  lyricsScaleInput.addEventListener('input', () => {",
        "    custom.lyricsScale = Math.min(160, Math.max(60, Math.round(Number(lyricsScaleInput.value) || 100)));",
        "    lyricsScaleCurrent.textContent = `${custom.lyricsScale}%`;",
        "    space?.setLyricsScale(custom.lyricsScale / 100);",
        "    persistCustom();",
        "  });",
    ],
    "handler",
)

write(SS, ss)
print("OK: html, query, query-old, default, partial, load, drop-helper, apply-settings, apply-custom, sync, handler")
