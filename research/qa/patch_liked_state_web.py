# -*- coding: utf-8 -*-
"""Web: like button reflects already-liked state."""
import io

BASE = r"E:\Zilux2开发\web\src"


def read(p):
    return io.open(p, "r", encoding="utf-8", newline="").read()


def write(p, s):
    io.open(p, "w", encoding="utf-8", newline="").write(s)


def patch(p, pairs):
    s = read(p)
    for old, new in pairs:
        assert s.count(old) == 1, (p, old[:60])
        s = s.replace(old, new, 1)
    write(p, s)


# 1) client.ts: checkLiked
client = BASE + r"\online\client.ts"
patch(client, [
    ("""/** 加入「我喜欢的音乐」（宿主写入平台收藏）。 */""",
     """/** 查询歌曲是否已在对应平台「我喜欢的音乐」中。 */
export async function checkLiked(source: OnlineSource, id: string): Promise<boolean> {
  if (mockMode) return false;
  const body = await api<{ liked?: boolean }>('/api/library/liked', { source, id });
  return body.liked === true;
}

/** 加入「我喜欢的音乐」（宿主写入平台收藏）。 */"""),
])

# 2) islandPlayer.ts: setLiked + onTrack
island = BASE + r"\ui\islandPlayer.ts"
patch(island, [
    ("""  setVolume(volume: number): void;
}""",
     """  setVolume(volume: number): void;
  /** 切换「喜欢」高亮（用于回显该歌曲是否已在喜欢里）。 */
  setLiked(liked: boolean): void;
}"""),
    ("""  onLike?(): void;
}""",
     """  onLike?(): void;
  /** 切歌回调（用于查询喜欢状态等） */
  onTrack?(track: OnlineTrack): void;
}"""),
    ("""  function setVolume(next: number): void {
    volume = Math.max(0, Math.min(1, next));
    audio.volume = volume;
  }""",
     """  function setVolume(next: number): void {
    volume = Math.max(0, Math.min(1, next));
    audio.volume = volume;
  }

  function setLiked(liked: boolean): void {
    likeBtn.classList.toggle('is-liked', liked);
    likeBtn.setAttribute('aria-pressed', liked ? 'true' : 'false');
  }"""),
    ("""    likeBtn.classList.remove('is-liked');
    root.hidden = false;""",
     """    likeBtn.classList.remove('is-liked');
    root.hidden = false;
    options.onTrack?.(track);"""),
    ("""    setVolume,
""",
     """    setVolume,
    setLiked,
"""),
])

# 3) spaceShell.ts: refresh liked state on track change
shell = BASE + r"\ui\spaceShell.ts"
patch(shell, [
    ("""import { addLikedTrack, fetchLyric, isMockOnline, onOnlineChange, searchOnline } from '../online/client';""",
     """import { addLikedTrack, checkLiked, fetchLyric, isMockOnline, onOnlineChange, searchOnline } from '../online/client';"""),
    ("""  async function likeCurrentTrack(): Promise<void> {""",
     """  let likedStateToken = 0;
  async function refreshLikedState(track: { source: 'netease' | 'qq'; id: string }): Promise<void> {
    const token = ++likedStateToken;
    try {
      const liked = await checkLiked(track.source, track.id);
      if (token === likedStateToken) island.setLiked(liked);
    } catch {
      // 查询失败时保持未点亮，不打扰用户。
    }
  }

  async function likeCurrentTrack(): Promise<void> {"""),
    ("""      await addLikedTrack(track.source, track.id);
      showToast(`已加入「我喜欢的音乐」：《${track.title}》`, 'ok');""",
     """      await addLikedTrack(track.source, track.id);
      island.setLiked(true);
      showToast(`已加入「我喜欢的音乐」：《${track.title}》`, 'ok');"""),
    ("""    onLike: () => void likeCurrentTrack(),""",
     """    onLike: () => void likeCurrentTrack(),
    onTrack: (track) => void refreshLikedState(track),"""),
])

print("web liked-state patched")
