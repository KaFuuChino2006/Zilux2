"""歌词偏移：在线歌词与本地音轨版本不一致时，按曲目微调时间轴（[ / ] 键）。"""
import io
from pathlib import Path

ROOT = Path(r"E:\Zilux2开发")
SHELL = ROOT / "web/src/ui/spaceShell.ts"


def load(path):
    raw = io.open(str(path), "r", encoding="utf-8", newline="").read()
    crlf = "\r\n" in raw
    return raw.replace("\r\n", "\n"), crlf


def save(path, text, crlf):
    io.open(str(path), "w", encoding="utf-8", newline="").write(
        text.replace("\n", "\r\n") if crlf else text
    )


def rep(text, old, new, count=1, tag=""):
    got = text.count(old)
    assert got == count, f"{tag} expect {count} got {got}"
    return text.replace(old, new)


shell, shell_crlf = load(SHELL)

state = """  /** 歌词偏移（秒，按曲目记忆）：在线歌词和本地音轨版本不同步时手动微调 */
  const LYRIC_OFFSET_KEY = 'zilux2.lyricOffsets';
  const lyricOffsets = new Map<string, number>();
  let lyricOffset = 0;
  try {
    const rawOffsets = window.localStorage.getItem(LYRIC_OFFSET_KEY);
    const parsedOffsets = rawOffsets ? (JSON.parse(rawOffsets) as Record<string, number>) : {};
    for (const [offsetKey, offsetValue] of Object.entries(parsedOffsets)) {
      if (typeof offsetValue === 'number' && Number.isFinite(offsetValue)) {
        lyricOffsets.set(offsetKey, Math.max(-30, Math.min(30, offsetValue)));
      }
    }
  } catch {
    host.log('warn', '[lyrics] offset cache unreadable');
  }

  function persistLyricOffsets(): void {
    try {
      window.localStorage.setItem(LYRIC_OFFSET_KEY, JSON.stringify(Object.fromEntries(lyricOffsets)));
    } catch {
      // 忽略存储失败
    }
  }

  function lyricClockNow(): number {
    return Math.max(0, island.currentTime() + lyricOffset);
  }

  /** 微调当前曲目的歌词偏移：正数=歌词提前出现（歌词比声音快） */
  function nudgeLyricOffset(delta: number): void {
    const track = island.currentTrack();
    if (!track) return;
    lyricOffset = Math.max(-30, Math.min(30, Math.round((lyricOffset + delta) * 10) / 10));
    lyricOffsets.set(`${track.source}:${track.id}`, lyricOffset);
    persistLyricOffsets();
    if (lyricsOpen) space?.setLyricsTime(lyricClockNow());
    const sign = lyricOffset >= 0 ? '+' : '';
    setStatus(`歌词偏移 ${sign}${lyricOffset.toFixed(1)}s（[ / ] 微调）`);
  }

"""

shell = rep(
    shell,
    "  let lyricsTrackKey = '';\n",
    "  let lyricsTrackKey = '';\n" + state,
    tag="offset-state",
)

shell = rep(
    shell,
    "    space?.setLyricsTime(island.currentTime());\n    updateMgCorners();",
    "    space?.setLyricsTime(lyricClockNow());\n    updateMgCorners();",
    tag="offset-step",
)

# 载入歌词时恢复该曲目的偏移
shell = rep(
    shell,
    """    const key = `${track.source}:${track.id}`;
    if (lyricsTrackKey === key) return;
    lyricsTrackKey = key;""",
    """    const key = `${track.source}:${track.id}`;
    if (lyricsTrackKey === key) return;
    lyricsTrackKey = key;
    lyricOffset = lyricOffsets.get(key) ?? 0;""",
    tag="offset-restore",
)

# 三处初始化歌词时间点应用偏移
shell = rep(
    shell,
    "      if (lines.length === 0) showToast('这首歌暂时没有找到歌词', 'info');\n      else space?.setLyricsTime(island.currentTime());",
    "      if (lines.length === 0) showToast('这首歌暂时没有找到歌词', 'info');\n      else space?.setLyricsTime(lyricClockNow());",
    tag="offset-local",
)
shell = rep(
    shell,
    "      if (lines.length === 0) showToast('这首歌暂时没有歌词', 'info');\n      else space?.setLyricsTime(island.currentTime());",
    "      if (lines.length === 0) showToast('这首歌暂时没有歌词', 'info');\n      else space?.setLyricsTime(lyricClockNow());",
    tag="offset-online",
)
shell = rep(
    shell,
    "    space?.setLyricsView(true);\n    space?.setLyricsTime(island.currentTime());",
    "    space?.setLyricsView(true);\n    space?.setLyricsTime(lyricClockNow());",
    tag="offset-enter",
)

# 歌词界面上 [ / ] 调偏移
shell = rep(
    shell,
    """    if (event.key === 'Escape' && lyricsOpen) {
      event.preventDefault();
      exitLyricsView();
      return;
    }""",
    """    if (lyricsOpen && (event.key === '[' || event.key === ']')) {
      event.preventDefault();
      nudgeLyricOffset(event.key === '[' ? -0.2 : 0.2);
      return;
    }
    if (event.key === 'Escape' && lyricsOpen) {
      event.preventDefault();
      exitLyricsView();
      return;
    }""",
    tag="offset-keys",
)

shell = rep(
    shell,
    "    setStatus('歌词模式 · 点「返回」或按 Esc 回到封面墙');",
    "    setStatus('歌词模式 · [ / ] 调歌词偏移 · Esc 回到封面墙');",
    tag="offset-status",
)

save(SHELL, shell, shell_crlf)
print("OK: lyric offset")
