"""过滤 LRC 里的制作信息行（作词/作曲/编曲…），避免前奏期间就显示这些文字。"""
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


# 1) 插入过滤工具
rep(
    "  /** 把 LRC（+可选翻译/逐字轴）转成 3D 歌词行。 */\n  function lyricLinesFromText(",
    "  /** 制作信息行（作词/作曲/编曲/制作人…）：很多 LRC 把它们放在 00:00 附近，\n"
    "   * 歌曲前奏很长时这些文字会提前出现，看起来像“歌词直接就开始播放”，需要过滤。 */\n"
    "  const CREDIT_HEAD = /(词|曲|编曲|制作|监制|出品|发行|混音|母带|录音|吉他|贝斯|鼓|键盘|和声|弦乐|企划|统筹|原唱|演唱|翻唱|lyrics?|composer|arranger|producer|mixed|mastered|guitar|bass|drums|vocal)/i;\n"
    "  const SYMBOL_ONLY = /^[\\s\\-—–…·。，,、.~\\/*_+♪♫]+$/;\n"
    "  function isCreditLine(raw: string): boolean {\n"
    "    const text = raw.trim();\n"
    "    if (!text) return true;\n"
    "    if (SYMBOL_ONLY.test(text)) return true;\n"
    "    const match = /^([^:：]{1,10})\\s*[:：]\\s*(\\S.*)$/.exec(text);\n"
    "    if (!match) return false;\n"
    "    const head = match[1] ?? '';\n"
    "    const body = match[2] ?? '';\n"
    "    // “作词 : 山口一郎” 这类短头 + 短值，且带制作关键词\n"
    "    return text.length <= 32 && body.length <= 24 && CREDIT_HEAD.test(head);\n"
    "  }\n"
    "\n"
    "  /** 把 LRC（+可选翻译/逐字轴）转成 3D 歌词行。 */\n  function lyricLinesFromText(",
)

# 2) 本地 LRC 过滤
rep(
    "    const parsed = applyTranslation(parseLrc(lrcText), translation ?? null).filter(\n"
    "      (line) => line.text.trim().length > 0,\n"
    "    );\n",
    "    const parsed = applyTranslation(parseLrc(lrcText), translation ?? null).filter(\n"
    "      (line) => line.text.trim().length > 0 && !isCreditLine(line.text),\n"
    "    );\n",
)

# 3) 在线歌词过滤
rep(
    "      const parsed = applyTranslation(parseLrc(lyric.lrc), lyric.translation).filter(\n"
    "        (line) => line.text.trim().length > 0,\n"
    "      );\n",
    "      const parsed = applyTranslation(parseLrc(lyric.lrc), lyric.translation).filter(\n"
    "        (line) => line.text.trim().length > 0 && !isCreditLine(line.text),\n"
    "      );\n",
)

with io.open(path, "w", encoding="utf-8", newline="") as handle:
    handle.write(text.replace("\n", "\r\n") if crlf else text)

print("OK: credit-lines-filter")
