# -*- coding: utf-8 -*-
"""本地歌曲库：支持同目录 .lrc 歌词 + 播放/扫描诊断日志。"""
import io


def patch(path, steps):
    raw = io.open(path, encoding="utf-8", newline="").read()
    crlf = "\r\n" in raw
    text = raw.replace("\r\n", "\n")
    for name, old, new, count in steps:
        got = text.count(old)
        assert got == count, f"{name}: count={got} expected {count}"
        text = text.replace(old, new)
        print(f"OK: {name}")
    io.open(path, "w", encoding="utf-8", newline="").write(
        text.replace("\n", "\r\n") if crlf else text
    )


ROOT = r"E:\Zilux2开发"
CS = ROOT + r"\src\Zilux2\Local\LocalMusicService.cs"
BR = ROOT + r"\web\src\bridge.ts"
SS = ROOT + r"\web\src\ui\spaceShell.ts"

cs_steps = [
    (
        "cs-scan-signature",
        "    private static List<LocalTrackDto> Scan(string folder)\n    {\n        var results = new List<LocalTrackDto>();\n",
        "    private static List<LocalTrackDto> Scan(string folder, List<string> lyrics)\n    {\n        var results = new List<LocalTrackDto>();\n",
        1,
    ),
    (
        "cs-scan-lrc",
        """                var extension = Path.GetExtension(file);
                if (!AudioExtensions.Contains(extension))
                {
                    continue;
                }

""",
        """                var extension = Path.GetExtension(file);
                if (string.Equals(extension, ".lrc", StringComparison.OrdinalIgnoreCase))
                {
                    if (lyrics.Count < 2000)
                    {
                        lyrics.Add(Path.GetRelativePath(folder, file).Replace('\\\\', '/'));
                    }

                    continue;
                }

                if (!AudioExtensions.Contains(extension))
                {
                    continue;
                }

""",
        1,
    ),
    (
        "cs-load-lyrics",
        "        List<LocalTrackDto> tracks;\n        try\n        {\n            tracks = Scan(fullPath);\n",
        "        List<LocalTrackDto> tracks;\n        var lyrics = new List<string>();\n        try\n        {\n            tracks = Scan(fullPath, lyrics);\n",
        1,
    ),
    (
        "cs-load-post",
        '        HostLog.Info($"[local] mapped {fullPath} ({tracks.Count} tracks)");\n        PostTracks(fullPath, tracks, null);\n',
        '        HostLog.Info($"[local] mapped {fullPath} ({tracks.Count} tracks, {lyrics.Count} lyrics)");\n        PostTracks(fullPath, tracks, lyrics, null);\n',
        1,
    ),
    (
        "cs-posttracks-signature",
        "    private void PostTracks(string folder, List<LocalTrackDto> tracks, string? error)\n",
        "    private void PostTracks(string folder, List<LocalTrackDto> tracks, List<string>? lyrics, string? error)\n",
        1,
    ),
    (
        "cs-posttracks-payload",
        "            Tracks = tracks,\n            Error = error,\n",
        "            Tracks = tracks,\n            Lyrics = lyrics,\n            Error = error,\n",
        1,
    ),
    (
        "cs-posterror-call",
        "        PostTracks(folder ?? string.Empty, new List<LocalTrackDto>(), message);\n",
        "        PostTracks(folder ?? string.Empty, new List<LocalTrackDto>(), null, message);\n",
        1,
    ),
    (
        "cs-payload-lyrics",
        "    public List<LocalTrackDto> Tracks { get; set; } = new();\n\n    public string? Error { get; set; }\n",
        "    public List<LocalTrackDto> Tracks { get; set; } = new();\n\n    public List<string>? Lyrics { get; set; }\n\n    public string? Error { get; set; }\n",
        1,
    ),
]

br_steps = [
    (
        "br-payload-lyrics",
        "  tracks: LocalLibraryTrack[];\n  error?: string | null;\n",
        "  tracks: LocalLibraryTrack[];\n  lyrics?: string[];\n  error?: string | null;\n",
        1,
    ),
    (
        "br-normalize-lyrics",
        "        error: typeof raw.error === 'string' && raw.error ? raw.error : null,\n",
        "        lyrics: Array.isArray(raw.lyrics)\n          ? (raw.lyrics as unknown[]).filter((item): item is string => typeof item === 'string')\n          : [],\n        error: typeof raw.error === 'string' && raw.error ? raw.error : null,\n",
        1,
    ),
]

ss_steps = [
    (
        "ss-lrc-map",
        "  const localCoverCache = new Map<number, string>();\n",
        "  const localCoverCache = new Map<number, string>();\n  const localLrcById = new Map<string, string>();\n",
        1,
    ),
    (
        "ss-lrc-helpers",
        """    return `https://localmusic.local/${encoded}`;
  }
""",
        """    return `https://localmusic.local/${encoded}`;
  }

  /** 归一化文件名，用于把 .lrc 和音频对上（去扩展名/编号/分隔符/大小写） */
  function localLyricKey(input: string): string {
    return input
      .toLowerCase()
      .replace(/\\.[a-z0-9]+$/, '')
      .replace(/[\\s\\-_.·・、]/g, '')
      .replace(/^[0-9]+/, '');
  }

  /** 在同目录 .lrc 里找最可能对上的那首（名称可能日文/英文写法不同） */
  function localLyricFor(name: string, lyrics: string[] | undefined): string {
    if (!lyrics || lyrics.length === 0) return '';
    const key = localLyricKey(name);
    if (!key) return '';
    const bases = lyrics.map((rel) => ({ rel, base: localLyricKey(rel.split('/').pop() ?? rel) }));
    const exact = bases.find((entry) => entry.base === key);
    if (exact) return exact.rel;
    const contained = bases.find((entry) => entry.base.includes(key) || key.includes(entry.base));
    if (contained) return contained.rel;
    const partial = bases.find((entry) => {
      for (let index = 0; index + 2 <= key.length; index += 1) {
        if (entry.base.includes(key.slice(index, index + 2))) return true;
      }
      return false;
    });
    return partial ? partial.rel : '';
  }
""",
        1,
    ),
    (
        "ss-apply-lrc",
        """    localTracks = payload.tracks.map((entry) => {
      const title = localTitleOf(entry.name);
      return {
        source: 'local',
        id: localTrackUrl(entry.rel),
""",
        """    localLrcById.clear();
    localTracks = payload.tracks.map((entry) => {
      const title = localTitleOf(entry.name);
      const id = localTrackUrl(entry.rel);
      const lyricRel = localLyricFor(entry.name, payload.lyrics);
      if (lyricRel) localLrcById.set(id, lyricRel);
      return {
        source: 'local',
        id,
""",
        1,
    ),
    (
        "ss-lyrics-local",
        """    if (track.source === 'local') {
      space?.setLyrics([]);
      space?.setLyricsTime(0);
      return;
    }
""",
        """    if (track.source === 'local') {
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
""",
        1,
    ),
]

patch(CS, cs_steps)
patch(BR, br_steps)
patch(SS, ss_steps)
print("DONE")
