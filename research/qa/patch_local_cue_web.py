"""Web 侧：CUE 分轨（startAt / 分轨时长）与 DSF 曲目展示。"""
import io
from pathlib import Path

ROOT = Path(r"E:\Zilux2开发\web\src")
STEP = []


def load(path):
    raw = io.open(str(path), "r", encoding="utf-8", newline="").read()
    crlf = "\r\n" in raw
    return raw.replace("\r\n", "\n"), crlf


def save(path, text, crlf):
    io.open(str(path), "w", encoding="utf-8", newline="").write(text.replace("\n", "\r\n") if crlf else text)


def rep(text, old, new, name, count=1):
    got = text.count(old)
    assert got == count, f"{name}: count={got}"
    STEP.append(name)
    return text.replace(old, new)


# ---------------------------------------------------------------- online/types.ts
p = ROOT / "online" / "types.ts"
text, crlf = load(p)
text = rep(
    text,
    "  /** 宿主代理后的绝对 URL（可能为空串） */\n  cover: string;\n  playable: boolean;\n}",
    "  /** 宿主代理后的绝对 URL（可能为空串） */\n"
    "  cover: string;\n"
    "  playable: boolean;\n"
    "  /** 本地 CUE 分轨：在整轨镜像文件里的起始秒（0 表示整个文件） */\n"
    "  startAt?: number;\n"
    "}",
    "types-startAt",
)
save(p, text, crlf)

# ---------------------------------------------------------------- bridge.ts
p = ROOT / "bridge.ts"
text, crlf = load(p)
text = rep(
    text,
    "  /** 音频里是否内嵌封面（宿主只给标记，图片走 /__cover 单独取）。 */\n  hasCover?: boolean;\n}",
    "  /** 音频里是否内嵌封面（宿主只给标记，图片走 /__cover 单独取）。 */\n"
    "  hasCover?: boolean;\n"
    "  /** CUE 曲名 */\n"
    "  title?: string;\n"
    "  /** CUE 歌手 */\n"
    "  artist?: string;\n"
    "  /** CUE 分轨在镜像文件里的起始毫秒 */\n"
    "  startMs?: number;\n"
    "  /** CUE 分轨时长毫秒（0 = 播到文件结束） */\n"
    "  durationMs?: number;\n"
    "  /** CUE 曲目号（0 = 整个文件） */\n"
    "  cue?: number;\n"
    "}",
    "bridge-track-fields",
)
text = rep(
    text,
    "          .map((item) => ({ ...item, hasCover: item.hasCover === true })),",
    "          .map((item) => ({\n"
    "            ...item,\n"
    "            hasCover: item.hasCover === true,\n"
    "            title: typeof item.title === 'string' && item.title ? item.title : undefined,\n"
    "            artist: typeof item.artist === 'string' && item.artist ? item.artist : undefined,\n"
    "            startMs: Number(item.startMs) > 0 ? Number(item.startMs) : 0,\n"
    "            durationMs: Number(item.durationMs) > 0 ? Number(item.durationMs) : 0,\n"
    "            cue: Number(item.cue) > 0 ? Number(item.cue) : 0,\n"
    "          })),",
    "bridge-normalize",
)
save(p, text, crlf)

# ---------------------------------------------------------------- spaceShell.ts
p = ROOT / "ui" / "spaceShell.ts"
text, crlf = load(p)
old_map = """    localTracks = payload.tracks.map((entry) => {
      const title = localTitleOf(entry.name);
      const id = localTrackUrl(entry.rel);
      const lyricRel = localLyricFor(entry.name, payload.lyrics);
      if (lyricRel) localLrcById.set(id, lyricRel);
      if (entry.hasCover) {
        localEmbeddedCovers.add(id);
        // 有内嵌封面就不再用旧会话缓存里的在线封面
        localOnlineCovers.delete(id);
      }
      return {
        source: 'local',
        id,
        title,
        artist: album,
        album,
        durationMs: 0,
        cover: entry.hasCover
          ? localCoverUrl(entry.rel)
          : (localOnlineCovers.get(id) ?? localCoverFor(entry.rel || entry.name)),
        playable: true,
      };
    });
"""
new_map = """    localTracks = payload.tracks.map((entry) => {
      const baseId = localTrackUrl(entry.rel);
      // CUE 分轨：同一个镜像文件 URL 用 ?cue=N 区分；播放时从 startAt 开始、只播 durationMs
      const id = entry.cue ? `${baseId}?cue=${entry.cue}` : baseId;
      const title = entry.title?.trim() || localTitleOf(entry.name);
      const artist = entry.artist?.trim() || album;
      const lyricRel = localLyricFor(title, payload.lyrics) ?? localLyricFor(entry.name, payload.lyrics);
      if (lyricRel) localLrcById.set(id, lyricRel);
      if (entry.hasCover) {
        localEmbeddedCovers.add(id);
        // 有内嵌封面就不再用旧会话缓存里的在线封面
        localOnlineCovers.delete(id);
      }
      return {
        source: 'local',
        id,
        title,
        artist,
        album: (entry.cue ?? 0) > 0 ? `CUE · ${album}` : album,
        durationMs: entry.durationMs ?? 0,
        cover: entry.hasCover
          ? localCoverUrl(entry.rel)
          : (localOnlineCovers.get(id) ?? localCoverFor(entry.rel || entry.name)),
        playable: true,
        startAt: entry.startMs ? entry.startMs / 1000 : 0,
      };
    });
"""
text = rep(text, old_map, new_map, "spaceShell-cue-map")
save(p, text, crlf)

# ---------------------------------------------------------------- islandPlayer.ts
p = ROOT / "ui" / "islandPlayer.ts"
text, crlf = load(p)

text = rep(
    text,
    "  let pendingResume = 0;\n  let lastProgressSave = 0;\n",
    "  let pendingResume = 0;\n"
    "  let lastProgressSave = 0;\n"
    "  // CUE 分轨：整轨镜像文件里本曲的起点（秒）与时长（秒，0 = 播到文件结束）\n"
    "  let trackStart = 0;\n"
    "  let trackLimit = 0;\n"
    "  let segmentEnding = false;\n"
    "  function positionOf(): number {\n"
    "    const raw = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;\n"
    "    return Math.max(0, raw - trackStart);\n"
    "  }\n\n"
    "  function durationOf(): number {\n"
    "    if (trackLimit > 0) return trackLimit;\n"
    "    const raw = Number.isFinite(audio.duration) ? audio.duration : 0;\n"
    "    return Math.max(0, raw - trackStart);\n"
    "  }\n",
    "player-state",
)

text = rep(
    text,
    "    const position = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;\n"
    "    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;\n"
    "    const key = progressKeyOf(track);\n",
    "    const position = positionOf();\n"
    "    const duration = durationOf();\n"
    "    const key = progressKeyOf(track);\n",
    "player-save-progress",
)

text = rep(
    text,
    "  function updateClock(): void {\n"
    "    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;\n"
    "    const position = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;\n",
    "  function updateClock(): void {\n"
    "    const duration = durationOf();\n"
    "    const position = positionOf();\n",
    "player-clock",
)

text = rep(
    text,
    "    pendingResume = savedProgress(track);\n"
    "    titleEl.textContent = track.title;\n",
    "    pendingResume = savedProgress(track);\n"
    "    trackStart = track.startAt ?? 0;\n"
    "    trackLimit = (track.durationMs ?? 0) > 0 ? (track.durationMs ?? 0) / 1000 : 0;\n"
    "    segmentEnding = false;\n"
    "    titleEl.textContent = track.title;\n",
    "player-playindex",
)

text = rep(
    text,
    "  audio.addEventListener('timeupdate', () => {\n"
    "    updateClock();\n",
    "  audio.addEventListener('timeupdate', () => {\n"
    "    // CUE 分轨：播到本曲结束点就自动下一首（整轨文件还没播完）\n"
    "    if (trackLimit > 0 && audio.currentTime >= trackStart + trackLimit - 0.25) {\n"
    "      if (!segmentEnding) {\n"
    "        segmentEnding = true;\n"
    "        clearProgress(currentTrack());\n"
    "        pickNext(1);\n"
    "      }\n"
    "      return;\n"
    "    }\n"
    "    updateClock();\n",
    "player-segment-end",
)

text = rep(
    text,
    "  audio.addEventListener('loadedmetadata', () => {\n"
    "    updateClock();\n"
    "    if (pendingResume <= 0) return;\n"
    "    const seconds = pendingResume;\n"
    "    pendingResume = 0;\n"
    "    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;\n"
    "    if (duration > 0 && seconds >= duration - 2) return;\n"
    "    try {\n"
    "      audio.currentTime = seconds;\n"
    "      options.onResume?.(seconds);\n",
    "  audio.addEventListener('loadedmetadata', () => {\n"
    "    updateClock();\n"
    "    if (pendingResume <= 0) return;\n"
    "    const seconds = pendingResume;\n"
    "    pendingResume = 0;\n"
    "    const duration = durationOf();\n"
    "    if (duration > 0 && seconds >= duration - 2) return;\n"
    "    try {\n"
    "      audio.currentTime = trackStart + seconds;\n"
    "      options.onResume?.(seconds);\n",
    "player-loadedmeta",
)

text = rep(
    text,
    "  prevBtn.addEventListener('click', () => {\n"
    "    if (audio.currentTime > 4 && mode !== 'shuffle') {\n"
    "      audio.currentTime = 0;\n",
    "  prevBtn.addEventListener('click', () => {\n"
    "    if (positionOf() > 4 && mode !== 'shuffle') {\n"
    "      audio.currentTime = trackStart;\n",
    "player-prev",
)

text = rep(
    text,
    "    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));\n"
    "    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;\n"
    "    if (duration > 0) audio.currentTime = ratio * duration;\n",
    "    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));\n"
    "    const duration = durationOf();\n"
    "    if (duration > 0) audio.currentTime = trackStart + ratio * duration;\n",
    "player-seek-drag",
)

text = rep(
    text,
    "    currentTime() {\n"
    "      return Number.isFinite(audio.currentTime) ? audio.currentTime : 0;\n",
    "    currentTime() {\n"
    "      return positionOf();\n",
    "player-current-time",
)

text = rep(
    text,
    "    seek(seconds: number) {\n"
    "      if (!Number.isFinite(seconds)) return;\n"
    "      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : seconds;\n"
    "      audio.currentTime = Math.min(duration, Math.max(0, seconds));\n",
    "    seek(seconds: number) {\n"
    "      if (!Number.isFinite(seconds)) return;\n"
    "      const duration = durationOf();\n"
    "      const target = duration > 0 ? Math.min(duration, Math.max(0, seconds)) : Math.max(0, seconds);\n"
    "      audio.currentTime = trackStart + target;\n",
    "player-seek-api",
)

save(p, text, crlf)

print("OK: " + ", ".join(STEP))
