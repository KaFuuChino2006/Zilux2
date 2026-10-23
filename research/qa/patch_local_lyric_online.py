"""本地歌曲：内嵌封面接线 + 没有 .lrc 时自动去在线源找歌词。"""
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

# 1) 有内嵌封面就用真封面，否则退回生成的渐变封面
shell = rep(
    shell,
    "        cover: localCoverFor(entry.rel || entry.name),",
    "        cover: entry.hasCover ? localCoverUrl(entry.rel) : localCoverFor(entry.rel || entry.name),",
    tag="cover-wire",
)

# 2) 本地歌词：先 .lrc，没有就去在线找
old_local = """    if (track.source === 'local') {
      space?.setLyrics([]);
      space?.setLyricsTime(0);
      const lyricRel = localLrcById.get(track.id);
      if (!lyricRel) {
        host.log('info', `[local] lyrics missing for ${track.title}`);
        return;
      }
      try {
        const response = await fetch(localTrackUrl(lyricRel));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const lrcText = await response.text();
        if (lyricsTrackKey !== key) return;
        const parsed = parseLrc(lrcText).filter((line) => line.text.trim().length > 0);
        const lines: LyricLineData[] = parsed.map((line, index) => {
          const start = line.timeMs / 1000;
          const nextStart = parsed[index + 1]?.timeMs ?? 0;
          const end = nextStart > line.timeMs ? Math.min(nextStart / 1000, start + 8) : start + 4;
          const glyphs = Array.from(line.text).filter((char) => char.trim().length > 0);
          const span = Math.max(0.4, end - start) / Math.max(1, glyphs.length);
          return {
            text: line.text,
            translation: line.translation,
            startTime: start,
            chars: glyphs.map((char, i) => ({ text: char, start: start + i * span, end: start + (i + 1) * span })),
          };
        });
        space?.setLyrics(lines);
        if (lines.length === 0) showToast('这首歌暂时没有歌词', 'info');
        else space?.setLyricsTime(island.currentTime());
        host.log('info', `[local] lyrics loaded ${lines.length} lines from ${lyricRel}`);
      } catch (error) {
        host.log('warn', `[local] lyrics load failed ${lyricRel}: ${String(error)}`);
        if (lyricsTrackKey === key) lyricsTrackKey = '';
      }
      return;
    }
"""

new_local = """    if (track.source === 'local') {
      space?.setLyrics([]);
      space?.setLyricsTime(0);
      const lyricRel = localLrcById.get(track.id);
      let lines: LyricLineData[] = [];
      if (lyricRel) {
        lines = await loadLocalLrcLines(key, lyricRel);
      }
      if (lines.length === 0) {
        // 本地没有 .lrc 时，按「歌名 + 歌手」去在线源找一份歌词
        lines = await searchOnlineLyrics(track);
      }
      if (lyricsTrackKey !== key) return;
      space?.setLyrics(lines);
      if (lines.length === 0) showToast('这首歌暂时没有找到歌词', 'info');
      else space?.setLyricsTime(island.currentTime());
      return;
    }
"""

shell = rep(shell, old_local, new_local, tag="local-lyric-branch")

helpers = """  /** 把 LRC（+可选翻译/逐字轴）转成 3D 歌词行。 */
  function lyricLinesFromText(lrcText: string, translation?: string | null, yrc?: string | null): LyricLineData[] {
    const parsed = applyTranslation(parseLrc(lrcText), translation ?? null).filter(
      (line) => line.text.trim().length > 0,
    );
    const charLines = parseCharLyric(yrc ?? '');
    return parsed.map((line, index) => {
      const start = line.timeMs / 1000;
      const nextStart = parsed[index + 1]?.timeMs ?? 0;
      const end = nextStart > line.timeMs ? Math.min(nextStart / 1000, start + 8) : start + 4;
      const glyphs = Array.from(line.text).filter((char) => char.trim().length > 0);
      const timed = charLines.find((entry) => Math.abs(entry.timeMs - line.timeMs) <= 260);
      let chars = timed
        ? timed.chars.map((char) => ({ text: char.text, start: char.startMs / 1000, end: char.endMs / 1000 }))
        : [];
      if (chars.length === 0 && glyphs.length > 0) {
        const span = Math.max(0.4, end - start) / glyphs.length;
        chars = glyphs.map((char, i) => ({ text: char, start: start + i * span, end: start + (i + 1) * span }));
      }
      return {
        text: line.text,
        translation: line.translation,
        startTime: start,
        chars: chars.length > 0 ? chars : undefined,
      };
    });
  }

  /** 读同目录 .lrc（本地歌曲优先用这个）。 */
  async function loadLocalLrcLines(key: string, lyricRel: string): Promise<LyricLineData[]> {
    try {
      const response = await fetch(localTrackUrl(lyricRel));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const lrcText = await response.text();
      if (lyricsTrackKey !== key) return [];
      const lines = lyricLinesFromText(lrcText);
      host.log('info', `[local] lyrics local ${lyricRel} ${lines.length} lines`);
      return lines;
    } catch (error) {
      host.log('warn', `[local] lyrics load failed ${lyricRel}: ${String(error)}`);
      return [];
    }
  }

  /** 本地歌曲没有 .lrc 时，去在线源按「歌名 + 歌手」搜一份歌词；找不到返回空。 */
  async function searchOnlineLyrics(track: OnlineTrack): Promise<LyricLineData[]> {
    const album = track.album && track.album !== '本地歌曲' ? '' : '';
    const query = `${track.title} ${track.artist === '本地歌曲' ? album : track.artist}`.trim();
    if (!query) return [];
    for (const source of ['netease', 'qq'] as const) {
      try {
        const result = await searchOnline(source, query, 6);
        const candidate =
          result.tracks.find((item) => {
            const name = item.title ?? '';
            if (!name) return false;
            return name.includes(track.title) || track.title.includes(name);
          }) ?? result.tracks[0];
        if (!candidate) continue;
        const lyric = await fetchLyric(source, candidate.id);
        const lines = lyricLinesFromText(lyric.lrc, lyric.translation, lyric.yrc);
        if (lines.length === 0) continue;
        host.log('info', `[local] lyrics online ${source}:${candidate.id} ${lines.length} lines for ${track.title}`);
        return lines;
      } catch (error) {
        host.log('warn', `[local] lyrics online failed ${source}: ${String(error)}`);
      }
    }
    return [];
  }

"""
shell = rep(
    shell,
    "  async function loadLyrics3d(track: OnlineTrack): Promise<void> {",
    helpers + "  async function loadLyrics3d(track: OnlineTrack): Promise<void> {",
    tag="lyric-helpers",
)

save(SHELL, shell, shell_crlf)
print("OK: shell cover + online lyrics")
