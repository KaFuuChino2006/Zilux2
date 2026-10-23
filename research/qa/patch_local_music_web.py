"""本地歌曲库 - Web 侧补丁。

改动：
1) online/types.ts：OnlineSource 增加 'local'，SOURCE_LABEL 增加本地文案
2) online/client.ts：streamUrl 对 local 直接返回 track.id（宿主虚拟主机 URL）
3) bridge.ts：新增 pickLocalMusic / restoreLocalMusic 与 onLocalLibrary 订阅
4) ui/icons.ts：新增 folder 图标
5) ui/spaceShell.ts：左 rail 本地歌曲按钮、本地曲库载入与展示、在线接口对 local 的绕过
"""

import io
from pathlib import Path

ROOT = Path(r"E:\Zilux2开发\web\src")
results = []


def patch(rel: str, steps):
    path = ROOT / rel
    raw = io.open(path, "r", encoding="utf-8", newline="").read()
    crlf = "\r\n" in raw
    text = raw.replace("\r\n", "\n")
    for label, old, new, count in steps:
        got = text.count(old)
        assert got == count, f"FAIL: {rel}::{label} (count={got}, want={count})"
        text = text.replace(old, new)
        results.append(f"OK: {rel}::{label}")
    out = text.replace("\n", "\r\n") if crlf else text
    io.open(path, "w", encoding="utf-8", newline="").write(out)


# 1) types
patch(
    "online/types.ts",
    [
        (
            "source-union",
            "export type OnlineSource = 'netease' | 'qq';",
            "export type OnlineSource = 'netease' | 'qq' | 'local';",
            1,
        ),
        (
            "source-label",
            "export const SOURCE_LABEL: Record<OnlineSource, string> = {\n  netease: '网易云',\n  qq: 'QQ 音乐',\n};",
            "export const SOURCE_LABEL: Record<OnlineSource, string> = {\n  netease: '网易云',\n  qq: 'QQ 音乐',\n  local: '本地',\n};",
            1,
        ),
    ],
)

# 2) streamUrl
patch(
    "online/client.ts",
    [
        (
            "stream-local",
            "export function streamUrl(track: OnlineTrack): string {\n  if (mockMode) return mockAudioUrl();",
            "export function streamUrl(track: OnlineTrack): string {\n  // 本地歌曲：id 就是 https://localmusic.local/... 的完整地址，直接交给 <audio>\n  if (track.source === 'local') return track.id;\n  if (mockMode) return mockAudioUrl();",
            1,
        ),
    ],
)

# 3) bridge
patch(
    "bridge.ts",
    [
        (
            "api-request-fonts",
            "  /** 请求宿主枚举系统已安装字体（歌词字体选择用） */\n  requestFonts(): void {\n    post({ v: 1, type: 'fonts' });\n  },",
            "  /** 请求宿主枚举系统已安装字体（歌词字体选择用） */\n  requestFonts(): void {\n    post({ v: 1, type: 'fonts' });\n  },\n  /** 让宿主弹出系统文件夹选择器，扫描本地歌曲（结果走 localLibrary 事件） */\n  pickLocalMusic(): void {\n    post({ v: 1, type: 'local', action: 'pick' });\n  },\n  /** 按上次记录的文件夹路径重新载入本地歌曲库 */\n  restoreLocalMusic(folder: string): void {\n    post({ v: 1, type: 'local', action: 'restore', folder });\n  },",
            1,
        ),
        (
            "local-library-subscribe",
            "export function onMediaControl(handler: (control: MediaControl) => void): () => void {",
            "/* ---- 本地歌曲库（localLibrary event v1） ---- */\n\nexport interface LocalLibraryTrack {\n  rel: string;\n  name: string;\n  size: number;\n}\n\nexport interface LocalLibraryPayload {\n  folder: string;\n  name: string;\n  tracks: LocalLibraryTrack[];\n  error?: string | null;\n}\n\nconst localLibraryHandlers = new Set<(payload: LocalLibraryPayload) => void>();\nlet localLibraryBound = false;\n\n/** 订阅宿主扫描完成的本地歌曲库（选择文件夹或按记录恢复后推送）。 */\nexport function onLocalLibrary(handler: (payload: LocalLibraryPayload) => void): () => void {\n  localLibraryHandlers.add(handler);\n  if (!localLibraryBound) {\n    localLibraryBound = true;\n    host.onMessage((message) => {\n      if (message.type !== 'host' || message.event !== 'localLibrary') return;\n      const payload = message.payload;\n      if (!payload || typeof payload !== 'object') return;\n      const raw = payload as Partial<LocalLibraryPayload>;\n      const tracks = Array.isArray(raw.tracks) ? raw.tracks : [];\n      const normalized: LocalLibraryPayload = {\n        folder: typeof raw.folder === 'string' ? raw.folder : '',\n        name: typeof raw.name === 'string' ? raw.name : '',\n        tracks: tracks.filter(\n          (item): item is LocalLibraryTrack =>\n            !!item && typeof item.rel === 'string' && typeof item.name === 'string',\n        ),\n        error: typeof raw.error === 'string' && raw.error ? raw.error : null,\n      };\n      localLibraryHandlers.forEach((listener) => {\n        try {\n          listener(normalized);\n        } catch (err) {\n          console.warn('[bridge] localLibrary handler failed', err);\n        }\n      });\n    });\n  }\n  return () => {\n    localLibraryHandlers.delete(handler);\n  };\n}\n\nexport function onMediaControl(handler: (control: MediaControl) => void): () => void {",
            1,
        ),
    ],
)

# 4) icons
patch(
    "ui/icons.ts",
    [
        (
            "icon-union",
            "  | 'playlist'\n",
            "  | 'playlist'\n  | 'folder'\n",
            1,
        ),
        (
            "icon-path",
            "  playlist: 'M4 6h11M4 12h8M4 18h6M19.5 15.5V7l2-.8',",
            "  playlist: 'M4 6h11M4 12h8M4 18h6M19.5 15.5V7l2-.8',\n  folder: 'M3.5 7.5h5.1l1.7 2.1h10.2v9.9H3.5zM3.5 9.6h16.5',",
            1,
        ),
    ],
)

# 5) spaceShell
patch(
    "ui/spaceShell.ts",
    [
        (
            "import-bridge",
            "import { host, onMediaControl, reportMedia } from '../bridge';",
            "import { host, onLocalLibrary, onMediaControl, reportMedia, type LocalLibraryPayload } from '../bridge';",
            1,
        ),
        (
            "rail-html",
            "      <button class=\"space-rail-btn\" data-rail=\"library\" type=\"button\" aria-label=\"歌单\" title=\"歌单\">${icon('playlist', 18)}</button>",
            "      <button class=\"space-rail-btn\" data-rail=\"local\" type=\"button\" aria-label=\"本地歌曲\" title=\"本地歌曲 · 选择文件夹\">${icon('folder', 18)}</button>\n      <button class=\"space-rail-btn\" data-rail=\"library\" type=\"button\" aria-label=\"歌单\" title=\"歌单\">${icon('playlist', 18)}</button>",
            1,
        ),
        (
            "rail-handler",
            "      if (feature === 'library') {\n        toggleLibrarySheet();\n        return;\n      }",
            "      if (feature === 'local') {\n        handleLocalRail();\n        return;\n      }\n      if (feature === 'library') {\n        toggleLibrarySheet();\n        return;\n      }",
            1,
        ),
        (
            "state",
            "  let tileTracks: OnlineTrack[] = [];",
            "  let tileTracks: OnlineTrack[] = [];\n\n  /* ---- 本地歌曲库 ---- */\n  const LOCAL_FOLDER_KEY = 'zilux2.localFolder';\n  let localTracks: OnlineTrack[] = [];\n  let localFolder = '';\n  let localViewOpen = false;\n  let localPickBusy = false;\n  const localCoverCache = new Map<number, string>();\n\n  /** 用文件名 hash 生成一张渐变封面（24 套共享，省内存） */\n  function localCoverFor(name: string): string {\n    let hash = 2166136261;\n    for (let index = 0; index < name.length; index += 1) {\n      hash ^= name.charCodeAt(index);\n      hash = Math.imul(hash, 16777619);\n    }\n    const seed = Math.abs(hash) % 24;\n    const cached = localCoverCache.get(seed);\n    if (cached) return cached;\n    const hue = (seed * 47 + 12) % 360;\n    const canvas = document.createElement('canvas');\n    canvas.width = 256;\n    canvas.height = 256;\n    const ctx = canvas.getContext('2d');\n    if (!ctx) return '';\n    const base = ctx.createLinearGradient(0, 0, 256, 256);\n    base.addColorStop(0, `hsl(${hue} 58% 42%)`);\n    base.addColorStop(0.52, `hsl(${(hue + 26) % 360} 54% 30%)`);\n    base.addColorStop(1, `hsl(${(hue + 208) % 360} 44% 16%)`);\n    ctx.fillStyle = base;\n    ctx.fillRect(0, 0, 256, 256);\n    const glow = ctx.createRadialGradient(96, 78, 6, 128, 128, 180);\n    glow.addColorStop(0, 'rgba(255,255,255,0.34)');\n    glow.addColorStop(1, 'rgba(0,0,0,0)');\n    ctx.fillStyle = glow;\n    ctx.fillRect(0, 0, 256, 256);\n    ctx.strokeStyle = 'rgba(255,255,255,0.16)';\n    ctx.lineWidth = 2;\n    ctx.strokeRect(1, 1, 254, 254);\n    const url = canvas.toDataURL('image/jpeg', 0.82);\n    localCoverCache.set(seed, url);\n    return url;\n  }\n\n  function localTitleOf(name: string): string {\n    const stripped = name.replace(/^\\s*\\d{1,3}\\s*[._\\-、\\s]+/, '').trim();\n    return stripped || name;\n  }\n\n  function localTrackUrl(rel: string): string {\n    const encoded = rel\n      .split('/')\n      .filter((segment) => segment.length > 0)\n      .map((segment) => encodeURIComponent(segment))\n      .join('/');\n    return `https://localmusic.local/${encoded}`;\n  }\n\n  function applyLocalLibrary(payload: LocalLibraryPayload, show: boolean): void {\n    const album = payload.name || '本地歌曲';\n    localFolder = payload.folder;\n    window.localStorage.setItem(LOCAL_FOLDER_KEY, localFolder);\n    localTracks = payload.tracks.map((entry) => {\n      const title = localTitleOf(entry.name);\n      return {\n        source: 'local',\n        id: localTrackUrl(entry.rel),\n        title,\n        artist: album,\n        album,\n        durationMs: 0,\n        cover: localCoverFor(entry.rel || entry.name),\n        playable: true,\n      };\n    });\n    if (!show) {\n      setStatus(`本地歌曲库 · ${album} · 已载入 ${localTracks.length} 首，点左侧文件夹图标可打开`);\n      return;\n    }\n    localViewOpen = true;\n    likedViewOpen = false;\n    hideTileDetail();\n    tileTracks = localTracks;\n    space?.setTiles(tilePayload(localTracks));\n    space?.setTilePage(1);\n    setStatus(\n      localTracks.length > 0\n        ? `本地歌曲库 · ${album} · 共 ${localTracks.length} 首 · 单击封面看详情 / 双击播放 / 拖动旋转 / 滚轮缩放`\n        : `本地歌曲库 · ${album} · 这个文件夹里没有找到音频文件`,\n    );\n    showToast(\n      localTracks.length > 0 ? `已载入本地歌曲 ${localTracks.length} 首` : '文件夹里没有找到音频文件',\n      localTracks.length > 0 ? 'ok' : 'info',\n    );\n  }\n\n  function pickLocalLibrary(): void {\n    if (localPickBusy) return;\n    localPickBusy = true;\n    setStatus('本地歌曲库 · 正在等待选择文件夹…');\n    host.pickLocalMusic();\n  }\n\n  function showLocalLibrary(): void {\n    if (localTracks.length === 0) {\n      pickLocalLibrary();\n      return;\n    }\n    localViewOpen = true;\n    likedViewOpen = false;\n    hideTileDetail();\n    tileTracks = localTracks;\n    space?.setTiles(tilePayload(localTracks));\n    space?.setTilePage(1);\n    setStatus(`本地歌曲库 · ${localFolder || '本地'} · 共 ${localTracks.length} 首 · 单击封面看详情 / 双击播放`);\n  }\n\n  function handleLocalRail(): void {\n    if (localPickBusy) return;\n    if (localTracks.length === 0) {\n      const saved = window.localStorage.getItem(LOCAL_FOLDER_KEY);\n      if (saved) {\n        localPickBusy = true;\n        setStatus('本地歌曲库 · 正在载入上次的文件夹…');\n        host.restoreLocalMusic(saved);\n        return;\n      }\n      pickLocalLibrary();\n      return;\n    }\n    if (localViewOpen) {\n      pickLocalLibrary();\n      return;\n    }\n    showLocalLibrary();\n  }",
            1,
        ),
        (
            "subscribe",
            "  const offMediaControl = onMediaControl((control) => {",
            "  onLocalLibrary((payload) => {\n    localPickBusy = false;\n    if (payload.error) {\n      window.localStorage.removeItem(LOCAL_FOLDER_KEY);\n      showToast(payload.error, 'error');\n      setStatus('本地歌曲库 · 载入失败');\n      return;\n    }\n    applyLocalLibrary(payload, true);\n  });\n\n  const offMediaControl = onMediaControl((control) => {",
            1,
        ),
        (
            "liked-state-local",
            "  async function refreshLikedState(track: { source: 'netease' | 'qq'; id: string }): Promise<void> {\n    const token = ++likedStateToken;",
            "  async function refreshLikedState(track: OnlineTrack): Promise<void> {\n    if (track.source === 'local') {\n      island.setLiked(false);\n      return;\n    }\n    const token = ++likedStateToken;",
            1,
        ),
        (
            "like-local",
            "    const track = island.currentTrack();\n    if (!track) {\n      showToast('先放一首歌，再点喜欢', 'info');\n      return;\n    }",
            "    const track = island.currentTrack();\n    if (!track) {\n      showToast('先放一首歌，再点喜欢', 'info');\n      return;\n    }\n    if (track.source === 'local') {\n      showToast('本地歌曲暂不支持收藏', 'info');\n      return;\n    }",
            1,
        ),
        (
            "recent-local",
            "      if (track) void recordRecent(track);",
            "      if (track && track.source !== 'local') void recordRecent(track);",
            1,
        ),
        (
            "lyrics-local",
            "    if (lyricsTrackKey === key) return;\n    lyricsTrackKey = key;",
            "    if (lyricsTrackKey === key) return;\n    lyricsTrackKey = key;\n    if (track.source === 'local') {\n      space?.setLyrics([]);\n      space?.setLyricsTime(0);\n      return;\n    }",
            1,
        ),
        (
            "mgc-source",
            "    mgcSource.textContent = track.source === 'qq' ? 'QQ 音乐' : '网易云音乐';",
            "    mgcSource.textContent =\n      track.source === 'local' ? '本地歌曲' : track.source === 'qq' ? 'QQ 音乐' : '网易云音乐';",
            1,
        ),
        (
            "liked-page-local",
            "      likedPage = target;\n      persistLikedPage(source, likedPage);\n      tileTracks = tracks;",
            "      likedPage = target;\n      persistLikedPage(source, likedPage);\n      localViewOpen = false;\n      tileTracks = tracks;",
            1,
        ),
    ],
)

print("\n".join(results))
print("DONE")
