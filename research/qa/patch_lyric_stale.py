# -*- coding: utf-8 -*-
"""修「切歌后仍显示上一首歌词」：清空时隐藏旧行 + 歌词缓存 + 音频就绪前锁 0 时间轴。"""

import io


def patch(path, pairs):
    s = io.open(path, "r", encoding="utf-8", newline="").read()
    for old, new in pairs:
        assert s.count(old) == 1, (path, old[:80])
        s = s.replace(old, new, 1)
    io.open(path, "w", encoding="utf-8", newline="").write(s)


FS = r"E:\Zilux2开发\web\src\three\floatScene.ts"
patch(
    FS,
    [
        # 1) 清空歌词时立刻隐藏所有旧行（否则上一次的文字会冻结留在屏幕上）
        (
            """    setLyrics(lines: LyricLineData[]) {
      lyricData = lines;
      lyricActive = -1;
      lyricPrev = -1;
      lyricSweep = -1;
      lyricSweepStrength = 0;
      ensureLyricLines();
      applyLyricSweepUniforms();
    },""",
            """    setLyrics(lines: LyricLineData[]) {
      lyricData = lines;
      lyricActive = -1;
      lyricPrev = -1;
      lyricSweep = -1;
      lyricSweepStrength = 0;
      ensureLyricLines();
      applyLyricSweepUniforms();
      // 立刻清掉旧行，避免切歌后上一首歌词冻结在画面里
      for (const view of lyricLines) {
        view.amount = 0;
        view.group.visible = false;
        view.plane.material.uniforms.uOpacity!.value = 0;
        hideSplitLine(view);
      }
      if (mgSweepBar) {
        mgSweepLife = -1;
        mgSweepBar.visible = false;
      }
    },""",
        ),
        # 2) 无当前句（歌词还没到/这首歌没词）时隐藏所有行
        (
            """    const active = lyricActive;
    lyricSlotUsed.clear();""",
            """    const active = lyricActive;
    lyricSlotUsed.clear();
    if (active < 0) {
      for (const view of lyricLines) {
        view.amount = 0;
        view.group.visible = false;
        view.plane.material.uniforms.uOpacity!.value = 0;
        hideSplitLine(view);
      }
      return;
    }""",
        ),
        # 3) 当前句/上一句显示时确保 group.visible
        (
            """      if (view.index !== active) {
        view.index = active;
        view.active = true;
        view.text = line.text;""",
            """      if (view.index !== active) {
        view.index = active;
        view.active = true;
        view.group.visible = true;
        view.text = line.text;""",
        ),
        (
            """        prev.plane.material.uniforms.uProgress!.value = 1;""",
            """        prev.group.visible = true;
        prev.plane.material.uniforms.uProgress!.value = 1;""",
        ),
    ],
)

IP = r"E:\Zilux2开发\web\src\ui\islandPlayer.ts"
patch(
    IP,
    [
        # 接口
        (
            "  currentTrack(): OnlineTrack | null;",
            "  currentTrack(): OnlineTrack | null;\n  isTrackLive(): boolean;",
        ),
        # 切歌前先停旧音频，避免旧 currentTime 被写进新歌歌词时间轴
        (
            """    try {
      audio.src = streamUrl(track);
      audio.currentTime = 0;
    } catch (error) {""",
            """    try {
      audio.pause();
      audio.src = streamUrl(track);
      audio.load();
    } catch (error) {""",
        ),
        # 实现
        (
            """    currentTrack() {
      return currentTrack();
    },""",
            """    currentTrack() {
      return currentTrack();
    },
    isTrackLive() {
      const track = currentTrack();
      if (!track) return false;
      if (audio.readyState < 1) return false;
      try {
        const src = audio.currentSrc || audio.src || '';
        if (!src) return false;
        const id = new URL(src, window.location.href).searchParams.get('id');
        return id === track.id;
      } catch {
        return false;
      }
    },""",
        ),
    ],
)

SS = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
patch(
    SS,
    [
        # 歌词缓存 + 请求去重
        (
            """  let lyricsTimer = 0;
  let lyricsTrackKey = '';""",
            """  let lyricsTimer = 0;
  let lyricsTrackKey = '';
  const lyricCache = new Map<string, LyricLineData[]>();
  const lyricPending = new Map<string, Promise<void>>();""",
        ),
        # 时钟：音频未就绪时锁在 0，避免用上一首的播放位置映射新歌词
        (
            """    // 两种模式都用 3D 歌词引擎的时间轴；PV 的 DOM 层只保留背景氛围（不再画字）
    space?.setLyricsTime(island.currentTime());""",
            """    // 两种模式都用 3D 歌词引擎的时间轴；PV 的 DOM 层只保留背景氛围（不再画字）
    // 音频还没切到当前曲目时（旧 currentTime 还在），时间轴锁 0，防止「上一首进度」错配新歌词
    space?.setLyricsTime(island.isTrackLive() ? island.currentTime() : 0);""",
        ),
        # loadLyrics3d：命中缓存直接显示；同曲并发请求复用
        (
            """  async function loadLyrics3d(track: OnlineTrack): Promise<void> {
    const key = `${track.source}:${track.id}`;
    if (lyricsTrackKey === key) return;
    lyricsTrackKey = key;
    // 切歌立刻清掉上一首的歌词（新歌前奏期间不要残留旧文字）
    space?.setLyrics([]);
    try {""",
            """  async function loadLyrics3d(track: OnlineTrack): Promise<void> {
    const key = `${track.source}:${track.id}`;
    if (lyricsTrackKey === key) return;
    lyricsTrackKey = key;
    // 切歌立刻清掉上一首的歌词（新歌前奏期间不要残留旧文字）
    space?.setLyrics([]);
    space?.setLyricsTime(0);
    const cached = lyricCache.get(key);
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
    try {""",
        ),
        # 成功分支：写缓存 + 时间轴按音频是否就绪
        (
            """      space?.setLyrics(lines);
      pvLyrics.setLines(""",
            """      lyricCache.set(key, lines);
      if (lyricsTrackKey !== key) return;
      space?.setLyrics(lines);
      pvLyrics.setLines(""",
        ),
        (
            """      if (lines.length === 0) showToast('这首歌暂时没有歌词', 'info');
      else space?.setLyricsTime(island.currentTime());
    } catch (error) {""",
            """      if (lines.length === 0) showToast('这首歌暂时没有歌词', 'info');
      else space?.setLyricsTime(island.isTrackLive() ? island.currentTime() : 0);
    } catch (error) {""",
        ),
        # 收尾：移除 pending
        (
            """      if (lyricsTrackKey === key) lyricsTrackKey = '';
      showToast('歌词读取失败，稍后再试', 'warn');
    }
  }""",
            """      if (lyricsTrackKey === key) lyricsTrackKey = '';
      showToast('歌词读取失败，稍后再试', 'warn');
    } finally {
      lyricPending.delete(key);
    }
    })();
    lyricPending.set(key, task);
    return task;
  }""",
        ),
        # onTrack 清空时同时把时间轴归零
        (
            """      // 切歌立刻清空上一首歌词，避免「放的是新歌、显示的是旧歌歌词」
      space?.setLyrics([]);
      lyricsTrackKey = '';""",
            """      // 切歌立刻清空上一首歌词，避免「放的是新歌、显示的是旧歌歌词」
      space?.setLyrics([]);
      space?.setLyricsTime(0);
      lyricsTrackKey = '';""",
        ),
    ],
)
print("lyric stale-plane/cache/time-axis patched")
