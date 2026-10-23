# -*- coding: utf-8 -*-
"""Web side: add-to-liked button in the bottom island player."""
import io

BASE = r"E:\Zilux2开发\web\src"


def read(path):
    return io.open(path, "r", encoding="utf-8", newline="").read()


def write(path, text):
    io.open(path, "w", encoding="utf-8", newline="").write(text)


def patch(path, pairs):
    text = read(path)
    for old, new in pairs:
        assert text.count(old) == 1, (path, old[:60])
        text = text.replace(old, new, 1)
    write(path, text)


# ---------- 1) client.ts: POST + addLikedTrack ----------
client = BASE + r"\online\client.ts"
patch(client, [
    ("""export async function fetchLyric(source: OnlineSource, id: string): Promise<OnlineLyric> {
  return api<OnlineLyric>('/api/lyric', { source, id });
}""",
     """export async function fetchLyric(source: OnlineSource, id: string): Promise<OnlineLyric> {
  return api<OnlineLyric>('/api/lyric', { source, id });
}

/** 加入「我喜欢的音乐」（宿主写入平台收藏）。 */
export async function addLikedTrack(source: OnlineSource, id: string): Promise<void> {
  if (mockMode) return;
  const current = info;
  if (!current) throw new OnlineError('not-ready', '在线源尚未就绪');
  const query = new URLSearchParams({ source, id, token: current.token });
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 12_000);
  try {
    const resp = await fetch(`${baseUrl()}/api/library/like?${query.toString()}`, {
      method: 'POST',
      signal: controller.signal,
      cache: 'no-store',
    });
    const type = resp.headers.get('content-type') ?? '';
    if (!type.includes('application/json')) {
      throw new OnlineError(`http-${resp.status}`, `网络请求失败（${resp.status}）`);
    }
    const body = (await resp.json()) as { error?: string; message?: string };
    if (!resp.ok) {
      throw new OnlineError(body.error ?? `http-${resp.status}`, body.message ?? '加入喜欢失败');
    }
  } catch (err) {
    if (err instanceof OnlineError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new OnlineError('timeout', '请求超时，请稍后重试');
    }
    throw new OnlineError('network', '无法连接在线源，请确认宿主已启动');
  } finally {
    window.clearTimeout(timer);
  }
}"""),
])

# ---------- 2) islandPlayer.ts: heart button ----------
island = BASE + r"\ui\islandPlayer.ts"
patch(island, [
    ("""const ICON_REPEAT =""",
     """const ICON_HEART =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 13.4l-.6-.5C4.1 10.2 2.2 8.5 2.2 6.3 2.2 4.5 3.6 3.1 5.4 3.1c1 0 2 .5 2.6 1.3.6-.8 1.6-1.3 2.6-1.3 1.8 0 3.2 1.4 3.2 3.2 0 2.2-1.9 3.9-5.2 6.6z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
const ICON_REPEAT ="""),
    ("""export interface IslandPlayerOptions {
  onError?(message: string): void;
  onStateChange?(state: { playing: boolean; title: string }): void;
}""",
     """export interface IslandPlayerOptions {
  onError?(message: string): void;
  onStateChange?(state: { playing: boolean; title: string }): void;
  /** 点击「喜欢」按钮（把当前歌曲加入我喜欢的音乐） */
  onLike?(): void;
}"""),
    ("""      <span class="island-clock" data-island-clock>0:00 / 0:00</span>""",
     """      <button class="island-btn island-like" data-island-like type="button" aria-label="加入我喜欢" title="加入我喜欢">${ICON_HEART}</button>
      <span class="island-clock" data-island-clock>0:00 / 0:00</span>"""),
    ("""  const modeBtn = root.querySelector<HTMLButtonElement>('[data-island-mode]')!;""",
     """  const likeBtn = root.querySelector<HTMLButtonElement>('[data-island-like]')!;
  const modeBtn = root.querySelector<HTMLButtonElement>('[data-island-mode]')!;"""),
    ("""    titleEl.textContent = track.title;
    root.hidden = false;""",
     """    titleEl.textContent = track.title;
    likeBtn.classList.remove('is-liked');
    root.hidden = false;"""),
    ("""  modeBtn.addEventListener('click', () => cycleMode());""",
     """  modeBtn.addEventListener('click', () => cycleMode());
  likeBtn.addEventListener('click', () => {
    if (!currentTrack()) return;
    likeBtn.classList.add('is-liked');
    window.setTimeout(() => likeBtn.classList.remove('is-liked'), 800);
    options.onLike?.();
  });"""),
])

# ---------- 3) spaceShell.ts: wire onLike ----------
shell = BASE + r"\ui\spaceShell.ts"
patch(shell, [
    ("""  const island = createIslandPlayer({
    onError: (message) => showToast(message, 'error'),""",
     """  async function likeCurrentTrack(): Promise<void> {
    const track = island.currentTrack();
    if (!track) {
      showToast('先放一首歌，再点喜欢', 'info');
      return;
    }
    try {
      await addLikedTrack(track.source, track.id);
      showToast(`已加入「我喜欢的音乐」：《${track.title}》`, 'ok');
      // 收藏变化后让下一次进入我喜欢时重新拉取（不打断当前墙）。
      likedPages.clear();
      if (likedViewOpen && likedSource === track.source) void showLikedPage(likedPage, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : '加入喜欢失败';
      showToast(message, 'error');
    }
  }

  const island = createIslandPlayer({
    onError: (message) => showToast(message, 'error'),
    onLike: () => void likeCurrentTrack(),"""),
])

# import addLikedTrack
shell_text = read(shell)
old_import = "import { fetchLibraryOverview, fetchPlaylist, fetchLyric, searchOnline, streamUrl } from '../online/client';"
if shell_text.count(old_import) == 1:
    shell_text = shell_text.replace(old_import, "import { addLikedTrack, fetchLibraryOverview, fetchPlaylist, fetchLyric, searchOnline, streamUrl } from '../online/client';", 1)
else:
    # fall back: extend whatever the client import line looks like
    import re
    match = re.search(r"import \{([^}]*)\} from '\.\./online/client';", shell_text)
    assert match, "client import not found"
    names = match.group(1)
    if "addLikedTrack" not in names:
        shell_text = shell_text[: match.start(1)] + " addLikedTrack," + names + shell_text[match.end(1):]
write(shell, shell_text)

# ---------- 4) CSS ----------
css = BASE + r"\styles\space.css"
css_text = read(css)
css_text += """

/* 灵动岛「喜欢」按钮 */
.island-like {
  flex: none;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1px solid rgba(120, 130, 160, 0.16);
  background: rgba(255, 255, 255, 0.72);
  color: #4b5464;
  transition: transform 0.18s ease, background 0.18s ease, color 0.18s ease;
}
.island-like:hover {
  transform: translateY(-1px) scale(1.04);
  background: rgba(255, 255, 255, 0.92);
  color: #e263a1;
}
.island-like.is-liked {
  color: #e263a1;
  background: rgba(255, 226, 240, 0.95);
  transform: scale(1.16);
}
"""
write(css, css_text)
print("web like button patched")
