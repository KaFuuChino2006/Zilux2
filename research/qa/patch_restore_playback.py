import io

app_path = r'E:\Zilux2开发\web\src\ui\app.ts'
player_path = r'E:\Zilux2开发\web\src\ui\player.ts'
main_path = r'E:\Zilux2开发\web\src\main.ts'


def load(p):
    with io.open(p, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def save(p, text):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


def apply(path, label, edits):
    text = load(path)
    nl = '\r\n' if '\r\n' in text else '\n'
    for name, old, new in edits:
        old = old.replace('\n', nl)
        new = new.replace('\n', nl)
        got = text.count(old)
        assert got == 1, '%s / %s: expected 1 match, got %d' % (label, name, got)
        text = text.replace(old, new)
    save(path, text)
    print('%s OK (%d edits)' % (label, len(edits)))


# 1) 顶栏删掉「发现」
apply(app_path, 'app.ts remove discover pill', [
    (
        'discover pill',
        """    const discoverPill = h(
      'button',
      { class: 'pill', title: '每日推荐 / 最近播放' },
      icon('sparkle', 17),
      h('span', { text: '发现' }),
    );
    discoverPill.addEventListener('click', () => this.openDiscover());

""",
        '',
    ),
    (
        'topbar center',
        "      h('div', { class: 'topbar-center' }, searchWrap, discoverPill),",
        "      h('div', { class: 'topbar-center' }, searchWrap),",
    ),
])

# 2) 播放器：记住上次播放 + 启动恢复
apply(player_path, 'player.ts last-played memory', [
    (
        'setState persist hook',
        """function setState(patch: Partial<PlayerState>): void {
  state = { ...state, ...patch };
  emit();
}""",
        """function setState(patch: Partial<PlayerState>): void {
  state = { ...state, ...patch };
  emit();
  if (state.track) schedulePersist();
}

/** 上次退出时的播放状态：启动时恢复播放条（不自动播放）。 */
const LAST_KEY = 'zilux2.lastPlay';
const LAST_QUEUE_LIMIT = 200;
let persistTimer = 0;

interface SavedPlayback {
  track: OnlineTrack;
  queue: OnlineTrack[];
  index: number;
  positionMs: number;
  mode?: PlayMode;
}

function persistNow(): void {
  const track = state.track;
  if (!track) return;
  try {
    const queue = state.queue.length > 0 ? state.queue.slice(0, LAST_QUEUE_LIMIT) : [track];
    const saved: SavedPlayback = {
      track,
      queue,
      index: Math.max(0, state.index),
      positionMs: Math.round(state.positionMs),
      mode: state.mode,
    };
    localStorage.setItem(LAST_KEY, JSON.stringify(saved));
  } catch {
    /* 忽略 */
  }
}

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = window.setTimeout(() => {
    persistTimer = 0;
    persistNow();
  }, 1200);
}

/** 启动时恢复上次播放的歌曲 / 队列 / 进度（保持暂停，等用户按播放）。 */
export function restoreLastPlayback(): boolean {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw) as Partial<SavedPlayback> | null;
    const track = saved?.track;
    if (!track || !track.id) return false;
    const queue = Array.isArray(saved?.queue) && saved.queue.length > 0 ? saved.queue : [track];
    const index = Math.max(0, Math.min(saved?.index ?? 0, queue.length - 1));
    const resumeMs = Math.max(0, saved?.positionMs ?? 0);
    applyCue(track);
    state = {
      ...state,
      track,
      queue,
      index,
      playing: false,
      loading: false,
      positionMs: resumeMs,
      durationMs: track.durationMs ?? 0,
      liked: false,
      mode: saved?.mode ?? state.mode,
    };
    audio.preload = 'metadata';
    try {
      audio.src = streamUrl(track);
    } catch (err) {
      console.warn('[player] restore src failed', err);
    }
    audio.volume = state.volume;
    const onMeta = (): void => {
      audio.removeEventListener('loadedmetadata', onMeta);
      if (resumeMs > 0) {
        try {
          audio.currentTime = startAt + resumeMs / 1000;
        } catch {
          /* 忽略 */
        }
      }
      setState({ durationMs: durationMs() });
    };
    audio.addEventListener('loadedmetadata', onMeta);
    emit();
    refreshLiked(track);
    return true;
  } catch (err) {
    console.warn('[player] restore failed', err);
    return false;
  }
}""",
    ),
    (
        'pagehide persist',
        """/* 音量跟随设置 */
window.addEventListener('zilux:volume', (event) => {""",
        """/* 退出前把最后状态落盘 */
window.addEventListener('pagehide', persistNow);
window.addEventListener('beforeunload', persistNow);

/* 音量跟随设置 */
window.addEventListener('zilux:volume', (event) => {""",
    ),
])

# 3) main.ts：启动时恢复播放条
apply(main_path, 'main.ts restore', [
    (
        'import',
        "import { setVolume } from './ui/player';",
        "import { restoreLastPlayback, setVolume } from './ui/player';",
    ),
    (
        'call restore',
        """  const app = new App();
  app.mount(root);""",
        """  const app = new App();
  app.mount(root);
  restoreLastPlayback();""",
    ),
])
