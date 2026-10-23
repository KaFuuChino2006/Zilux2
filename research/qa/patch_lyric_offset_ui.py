"""给歌词偏移加界面滑条（外观 → 歌词动画「歌词偏移」），并修正 [ / ] 方向语义。"""
import io
from pathlib import Path

path = Path(r"E:\Zilux2开发\web\src\ui\spaceShell.ts")
with io.open(path, "r", encoding="utf-8", newline="") as handle:
    raw = handle.read()
crlf = "\r\n" in raw
text = raw.replace("\r\n", "\n")


def rep(old: str, new: str, count: int = 1) -> None:
    global text
    got = text.count(old)
    assert got == count, f"anchor count {got} != {count}: {old[:70]!r}"
    text = text.replace(old, new)


# 1) 面板 HTML：歌词间距下面加「歌词偏移」
rep(
    '                <input class="custom-slider" data-lyric-tracking type="range" min="50" max="250" step="1" value="100" aria-label="歌词字间距" />\n',
    '                <input class="custom-slider" data-lyric-tracking type="range" min="50" max="250" step="1" value="100" aria-label="歌词字间距" />\n'
    '                <div class="custom-label"><span>歌词偏移</span><b data-lyric-offset-current>0.0s</b></div>\n'
    '                <input class="custom-slider" data-lyric-offset type="range" min="-50" max="50" step="1" value="0" aria-label="歌词偏移" />\n',
)

# 2) tip 文案补充
rep(
    '                <p class="custom-tip">辉光：字形外圈的柔光晕；大小随机：每个字大小略有差异；位置偏差：每个字上下左右轻微错位；间距：字与字的间隔（100% 为默认）</p>\n',
    '                <p class="custom-tip">辉光：字形外圈的柔光晕；大小随机：每个字大小略有差异；位置偏差：每个字上下左右轻微错位；间距：字与字的间隔（100% 为默认）；偏移：正数让歌词提前、负数让歌词延后（按曲目记忆，也可用 [ / ] 微调）</p>\n',
)

# 3) 查询
rep(
    "  const lyricTrackingCurrent = root.querySelector<HTMLElement>('[data-lyric-tracking-current]')!;\n",
    "  const lyricTrackingCurrent = root.querySelector<HTMLElement>('[data-lyric-tracking-current]')!;\n"
    "  const lyricOffsetInput = root.querySelector<HTMLInputElement>('[data-lyric-offset]')!;\n"
    "  const lyricOffsetCurrent = root.querySelector<HTMLElement>('[data-lyric-offset-current]')!;\n",
)

# 4) 偏移逻辑：加 syncLyricOffsetUi / setLyricOffset，nudge 复用，初始化刷新
rep(
    "  /** 微调当前曲目的歌词偏移：正数=歌词提前出现（歌词比声音快） */\n"
    "  function nudgeLyricOffset(delta: number): void {\n"
    "    const track = island.currentTrack();\n"
    "    if (!track) return;\n"
    "    lyricOffset = Math.max(-30, Math.min(30, Math.round((lyricOffset + delta) * 10) / 10));\n"
    "    lyricOffsets.set(`${track.source}:${track.id}`, lyricOffset);\n"
    "    persistLyricOffsets();\n"
    "    if (lyricsOpen) space?.setLyricsTime(lyricClockNow());\n"
    "    const sign = lyricOffset >= 0 ? '+' : '';\n"
    "    setStatus(`歌词偏移 ${sign}${lyricOffset.toFixed(1)}s（[ / ] 微调）`);\n"
    "  }\n",
    "  function syncLyricOffsetUi(): void {\n"
    "    const steps = Math.max(-50, Math.min(50, Math.round(lyricOffset * 10)));\n"
    "    lyricOffsetInput.value = String(steps);\n"
    "    const sign = lyricOffset >= 0 ? '+' : '';\n"
    "    lyricOffsetCurrent.textContent = `${sign}${lyricOffset.toFixed(1)}s`;\n"
    "  }\n"
    "\n"
    "  /** 设置当前曲目的歌词偏移：正数=歌词提前出现（歌词比声音快），负数=歌词延后 */\n"
    "  function setLyricOffset(value: number): void {\n"
    "    lyricOffset = Math.max(-30, Math.min(30, Math.round(value * 10) / 10));\n"
    "    const track = island.currentTrack();\n"
    "    if (track) {\n"
    "      lyricOffsets.set(`${track.source}:${track.id}`, lyricOffset);\n"
    "      persistLyricOffsets();\n"
    "    }\n"
    "    syncLyricOffsetUi();\n"
    "    if (lyricsOpen) space?.setLyricsTime(lyricClockNow());\n"
    "    const sign = lyricOffset >= 0 ? '+' : '';\n"
    "    setStatus(`歌词偏移 ${sign}${lyricOffset.toFixed(1)}s（正值提前 · 负值延后）`);\n"
    "  }\n"
    "\n"
    "  /** 微调当前曲目的歌词偏移：正数=歌词提前出现（歌词比声音快） */\n"
    "  function nudgeLyricOffset(delta: number): void {\n"
    "    setLyricOffset(lyricOffset + delta);\n"
    "  }\n"
    "\n"
    "  syncLyricOffsetUi();\n",
)

# 5) 载入歌词时刷新界面
rep(
    "    lyricOffset = lyricOffsets.get(key) ?? 0;\n",
    "    lyricOffset = lyricOffsets.get(key) ?? 0;\n"
    "    syncLyricOffsetUi();\n",
)

# 6) 滑条事件（接在歌词间距 handler 之后）
rep(
    "  lyricTrackingInput.addEventListener('input', () => {\n"
    "    custom.lyricTracking = Math.min(250, Math.max(50, Math.round(Number(lyricTrackingInput.value) || 100)));\n"
    "    lyricTrackingCurrent.textContent = `${custom.lyricTracking}%`;\n"
    "    applyLyricTypeStyle();\n"
    "    persistCustom();\n"
    "  });\n",
    "  lyricTrackingInput.addEventListener('input', () => {\n"
    "    custom.lyricTracking = Math.min(250, Math.max(50, Math.round(Number(lyricTrackingInput.value) || 100)));\n"
    "    lyricTrackingCurrent.textContent = `${custom.lyricTracking}%`;\n"
    "    applyLyricTypeStyle();\n"
    "    persistCustom();\n"
    "  });\n"
    "  lyricOffsetInput.addEventListener('input', () => {\n"
    "    setLyricOffset(Number(lyricOffsetInput.value) / 10);\n"
    "  });\n"
    "  lyricOffsetInput.addEventListener('change', () => {\n"
    "    setLyricOffset(Number(lyricOffsetInput.value) / 10);\n"
    "    persistCustom();\n"
    "  });\n",
)

# 7) [ / ] 方向：正数=提前，所以 [ 应增大偏移、] 减小
rep(
    "nudgeLyricOffset(event.key === '[' ? -0.2 : 0.2);\n",
    "nudgeLyricOffset(event.key === '[' ? 0.2 : -0.2);\n",
)

with io.open(path, "w", encoding="utf-8", newline="") as handle:
    handle.write(text.replace("\n", "\r\n") if crlf else text)

print("OK: lyric-offset-ui")
