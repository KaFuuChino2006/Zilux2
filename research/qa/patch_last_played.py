# -*- coding: utf-8 -*-
"""播放进度：从「每首歌都记」改成「只记上一次退出时那首」。"""
import io
import sys

path = "E:/Zilux2开发/web/src/ui/islandPlayer.ts"
with io.open(path, "r", encoding="utf-8", newline="") as f:
    text = f.read()

old = """  /* 播放进度记忆：按「平台:id」记住上次听到的位置，下次播放同一首时接着放 */
  const PROGRESS_KEY = 'zilux2.playProgress';
  const progressKeyOf = (track: OnlineTrack): string => `${track.source}:${track.id}`;
  const readProgressMap = (): Record<string, { t: number; at: number }> => {
    try {
      const raw = window.localStorage.getItem(PROGRESS_KEY);
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return {};
      return parsed as Record<string, { t: number; at: number }>;
    } catch {
      return {};
    }
  };
  function writeProgressMap(map: Record<string, { t: number; at: number }>): void {
    try {
      window.localStorage.setItem(PROGRESS_KEY, JSON.stringify(map));
    } catch {
      /* localStorage 不可用时忽略 */
    }
  }
  let pendingResume = 0;
  let lastProgressSave = 0;
  function savedProgress(track: OnlineTrack): number {
    const entry = readProgressMap()[progressKeyOf(track)];
    if (!entry || typeof entry.t !== 'number') return 0;
    return entry.t >= 3 ? Math.round(entry.t) : 0;
  }
  function saveProgress(): void {
    const track = currentTrack();
    if (!track) return;
    const position = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    const map = readProgressMap();
    const key = progressKeyOf(track);
    // 开头几秒、结束前几秒都不值得记，视为「刚开始 / 已听完」
    if (position < 3 || (duration > 0 && position > duration - 4)) {
      if (map[key]) {
        delete map[key];
        writeProgressMap(map);
      }
      return;
    }
    map[key] = { t: Math.round(position), at: Date.now() };
    writeProgressMap(map);
  }
  function clearProgress(track: OnlineTrack | null): void {
    if (!track) return;
    const map = readProgressMap();
    const key = progressKeyOf(track);
    if (!map[key]) return;
    delete map[key];
    writeProgressMap(map);
  }
"""

new = """  /* 播放进度记忆：只记住「上一次退出时正在听的那一首」听到哪里；
     其它歌（包括以前听过的）一律从头播，不做逐曲进度。 */
  const PROGRESS_KEY = 'zilux2.lastPlayed';
  const progressKeyOf = (track: OnlineTrack): string => `${track.source}:${track.id}`;
  type LastPlayed = { key: string; t: number; at: number; title: string; artist: string };
  function readLastPlayed(): LastPlayed | null {
    try {
      const raw = window.localStorage.getItem(PROGRESS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<LastPlayed> | null;
      if (!parsed || typeof parsed.key !== 'string' || typeof parsed.t !== 'number') return null;
      return {
        key: parsed.key,
        t: parsed.t,
        at: typeof parsed.at === 'number' ? parsed.at : 0,
        title: typeof parsed.title === 'string' ? parsed.title : '',
        artist: typeof parsed.artist === 'string' ? parsed.artist : '',
      };
    } catch {
      return null;
    }
  }
  function writeLastPlayed(record: LastPlayed | null): void {
    try {
      if (record) window.localStorage.setItem(PROGRESS_KEY, JSON.stringify(record));
      else window.localStorage.removeItem(PROGRESS_KEY);
    } catch {
      /* localStorage 不可用时忽略 */
    }
  }
  // 旧版本按每首歌记录进度，升级后清掉，避免残留数据让别的歌也从中间开始
  try {
    window.localStorage.removeItem('zilux2.playProgress');
  } catch {
    /* ignore */
  }
  let pendingResume = 0;
  let lastProgressSave = 0;
  function savedProgress(track: OnlineTrack): number {
    const last = readLastPlayed();
    if (!last || last.key !== progressKeyOf(track)) return 0;
    return last.t >= 3 ? Math.round(last.t) : 0;
  }
  function saveProgress(): void {
    const track = currentTrack();
    if (!track) return;
    const position = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    const key = progressKeyOf(track);
    // 开头几秒、结束前几秒都不值得记，视为「刚开始 / 已听完」
    if (position < 3 || (duration > 0 && position > duration - 4)) {
      const last = readLastPlayed();
      if (last && last.key === key) writeLastPlayed(null);
      return;
    }
    writeLastPlayed({
      key,
      t: Math.round(position),
      at: Date.now(),
      title: track.title ?? '',
      artist: track.artist ?? '',
    });
  }
  function clearProgress(track: OnlineTrack | null): void {
    if (!track) return;
    const last = readLastPlayed();
    if (!last || last.key !== progressKeyOf(track)) return;
    writeLastPlayed(null);
  }
"""

seq = chr(13) + chr(10)
crlf = seq if seq in text else chr(10)
old = old.replace(chr(10), crlf)
new = new.replace(chr(10), crlf)

count = text.count(old)
if count != 1:
    sys.exit("last-played: found %d matches" % count)
text = text.replace(old, new)

with io.open(path, "w", encoding="utf-8", newline="") as f:
    f.write(text)
print("OK: last-played")
