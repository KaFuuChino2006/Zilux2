# -*- coding: utf-8 -*-
"""回退 spaceShell 里新增的缓存/时间轴守卫（疑似引发渲染 OOM），保留 floatScene 旧行清理。"""

import io

p = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
s = io.open(p, "r", encoding="utf-8", newline="").read()

# 1) 去掉缓存声明
old = """  let lyricsTrackKey = '';
  const lyricCache = new Map<string, LyricLineData[]>();
  const lyricPending = new Map<string, Promise<void>>();"""
new = """  let lyricsTrackKey = '';"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 2) 时钟改回直接取 currentTime（去掉 isTrackLive 守卫）
old = """    // 两种模式都用 3D 歌词引擎的时间轴；PV 的 DOM 层只保留背景氛围（不再画字）
    // 音频还没切到当前曲目时（旧 currentTime 还在），时间轴锁 0，防止「上一首进度」错配新歌词
    space?.setLyricsTime(island.isTrackLive() ? island.currentTime() : 0);"""
new = """    // 两种模式都用 3D 歌词引擎的时间轴；PV 的 DOM 层只保留背景氛围（不再画字）
    space?.setLyricsTime(island.currentTime());"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 3) 去掉 loadLyrics3d 的缓存/复用包装，恢复原控制流
old = """    const cached = lyricCache.get(key);
    if (cached) {
      space?.setLyrics(cached);
      pvLyrics.setLines(
        cached.map((line, index) => ({
          text: line.text,
          translation: line.translation,
          start: line.startTime,
          end: cached[index + 1]?.startTime ?? line.startTime + 4,
        })),
      );
      return;
    }
    const inflight = lyricPending.get(key);
    if (inflight) return inflight;
    const task = (async (): Promise<void> => {
    try {"""
new = """    try {"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """      lyricCache.set(key, lines);
      if (lyricsTrackKey !== key) return;
      space?.setLyrics(lines);"""
new = """      space?.setLyrics(lines);"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """      else space?.setLyricsTime(island.isTrackLive() ? island.currentTime() : 0);"""
new = """      else space?.setLyricsTime(island.currentTime());"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """      if (lyricsTrackKey === key) lyricsTrackKey = '';
      showToast('歌词读取失败，稍后再试', 'warn');
    } finally {
      lyricPending.delete(key);
    }
    })();
    lyricPending.set(key, task);
    return task;
  }"""
new = """      if (lyricsTrackKey === key) lyricsTrackKey = '';
      showToast('歌词读取失败，稍后再试', 'warn');
    }
  }"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("spaceShell lyric patch reverted (keep stale-plane hiding)")
