# -*- coding: utf-8 -*-
"""接通 Windows SMTC（GSMTC 下发）：island 播放状态 → host → Now Playing；媒体键回传 → island。"""
import io

ip_path = r"E:\Zilux2开发\web\src\ui\islandPlayer.ts"
ss_path = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"

# ---------- islandPlayer: 增加 seek ----------
s = io.open(ip_path, "r", encoding="utf-8", newline="").read()
old = """  /** 切换「喜欢」高亮（回显该歌曲是否已在喜欢里） */
  setLiked(liked: boolean): void;"""
new = """  /** 切换「喜欢」高亮（回显该歌曲是否已在喜欢里） */
  setLiked(liked: boolean): void;
  /** 跳转到指定秒数（供系统媒体浮层拖动进度使用） */
  seek(seconds: number): void;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """    setLiked(liked: boolean) {
      likeBtn.classList.toggle('is-liked', liked);
      likeBtn.setAttribute('aria-pressed', liked ? 'true' : 'false');
    },"""
new = """    setLiked(liked: boolean) {
      likeBtn.classList.toggle('is-liked', liked);
      likeBtn.setAttribute('aria-pressed', liked ? 'true' : 'false');
    },
    seek(seconds: number) {
      if (!Number.isFinite(seconds)) return;
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : seconds;
      audio.currentTime = Math.min(duration, Math.max(0, seconds));
      updateClock();
    },"""
assert s.count(old) == 1
s = s.replace(old, new, 1)
io.open(ip_path, "w", encoding="utf-8", newline="").write(s)
print("islandPlayer seek added")

# ---------- spaceShell: 上报与命令 ----------
s = io.open(ss_path, "r", encoding="utf-8", newline="").read()

old = "import { host } from '../bridge';"
new = "import { host, onMediaControl, reportMedia } from '../bridge';"
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 在 island 创建后接入：状态上报辅助 + 每秒进度 + 媒体键命令
old = """  const island = createIslandPlayer({"""
new = """  let mediaReportTimer = 0;
  let mediaPlaying = false;
  const reportNowPlaying = (): void => {
    const track = island.currentTrack();
    if (!track) {
      reportMedia({ playing: false, title: '', artist: '' });
      return;
    }
    reportMedia({
      title: track.title,
      artist: track.artist,
      album: track.album,
      coverUrl: track.cover,
      durationMs: track.durationMs ?? 0,
      positionMs: Math.round(island.currentTime() * 1000),
      playing: mediaPlaying,
    });
  };
  const island = createIslandPlayer({"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# onTrack：立即上报（封面/标题）
old = """    onTrack: (track) => {
      void refreshLikedState(track);
      if (track) void recordRecent(track);
      onTrackColor(track);
    },"""
new = """    onTrack: (track) => {
      void refreshLikedState(track);
      if (track) void recordRecent(track);
      onTrackColor(track);
      reportNowPlaying();
    },"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# onStateChange：记录播放态 + 上报（并启动 1s 进度节流）
old = """      space?.setPlaying(state.playing);
      colorPlaying = state.playing;"""
new = """      space?.setPlaying(state.playing);
      colorPlaying = state.playing;
      mediaPlaying = state.playing;
      reportNowPlaying();"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 在 onStateChange 块之后（找到其闭合）插入 timer + 媒体控制订阅
old = """  root.appendChild(island.element);"""
assert s.count(old) == 1
insert = """  root.appendChild(island.element);

  // Windows Now Playing（SMTC）：状态上报节流到 1 次/秒，媒体键命令回传给灵动岛
  mediaReportTimer = window.setInterval(() => {
    if (mediaPlaying) reportNowPlaying();
  }, 1000);
  const offMediaControl = onMediaControl((control) => {
    switch (control.action) {
      case 'play':
        if (!mediaPlaying) island.toggle();
        break;
      case 'pause':
        if (mediaPlaying) island.toggle();
        break;
      case 'next':
        island.next();
        break;
      case 'prev':
        island.prev();
        break;
      case 'stop':
        island.toggle();
        break;
      case 'seek':
        if (typeof control.positionMs === 'number') island.seek(control.positionMs / 1000);
        break;
      default:
        break;
    }
  });"""
s = s.replace(old, insert, 1)

# destroy 清理
old = """      window.clearInterval(lyricsTimer);
      space?.setLyricsView(false);
      island.destroy();"""
new = """      window.clearInterval(lyricsTimer);
      window.clearInterval(mediaReportTimer);
      offMediaControl();
      space?.setLyricsView(false);
      island.destroy();"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

io.open(ss_path, "w", encoding="utf-8", newline="").write(s)
print("spaceShell SMTC wiring added")
