# -*- coding: utf-8 -*-
"""修切歌后歌词残留/时间轴串台：切歌立即清空并重载，歌词时钟校验曲目键。"""

import io

P = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
s = io.open(P, "r", encoding="utf-8", newline="").read()


def rep(old, new, count=1):
    global s
    assert s.count(old) == count, old[:90]
    s = s.replace(old, new, count)


# 1) onTrack：切歌立即清空旧歌词并重置键，歌词页打开时立刻加载新歌词
rep(
    """    onTrack: (track) => {
      void refreshLikedState(track);
      if (track) void recordRecent(track);
      onTrackColor(track);
      reportNowPlaying();
    },""",
    """    onTrack: (track) => {
      void refreshLikedState(track);
      if (track) void recordRecent(track);
      onTrackColor(track);
      reportNowPlaying();
      // 切歌立刻清空上一首歌词，避免「放的是新歌、显示的是旧歌歌词」
      space?.setLyrics([]);
      lyricsTrackKey = '';
      if (lyricsOpen && track) void loadLyrics3d(track);
    },""",
)

# 2) 歌词时钟：每帧确认时钟对应的就是当前播放曲目，不一致立即重载
rep(
    """  function stepLyricsClock(): void {
    if (!lyricsOpen) return;
    // 两种模式都用 3D 歌词引擎的时间轴；PV 的 DOM 层只保留背景氛围（不再画字）
    space?.setLyricsTime(island.currentTime());""",
    """  function stepLyricsClock(): void {
    if (!lyricsOpen) return;
    const track = island.currentTrack();
    const key = track ? `${track.source}:${track.id}` : '';
    if (track && lyricsTrackKey && keysMismatch(key)) {
      // 兜底：歌词键与当前曲目不一致时清空重载（防止切歌时序漏掉 onTrack）
      space?.setLyrics([]);
      lyricsTrackKey = '';
      void loadLyrics3d(track);
    }
    // 两种模式都用 3D 歌词引擎的时间轴；PV 的 DOM 层只保留背景氛围（不再画字）
    space?.setLyricsTime(island.currentTime());""",
)

# 3) keysMismatch 辅助（放在 lyricsTrackKey 声明后）
rep(
    """  let lyricsTimer = 0;
  let lyricsTrackKey = '';""",
    """  let lyricsTimer = 0;
  let lyricsTrackKey = '';
  const keysMismatch = (currentKey: string): boolean =>
    lyricsTrackKey !== '' && lyricsTrackKey !== currentKey;""",
)

io.open(P, "w", encoding="utf-8", newline="").write(s)
print("lyric switch sync patched")
