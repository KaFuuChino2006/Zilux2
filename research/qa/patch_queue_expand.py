import io

def load(p):
    return io.open(p, 'r', encoding='utf-8', newline='').read()

def save(p, t):
    io.open(p, 'w', encoding='utf-8', newline='').write(t)

# 1) player.ts: replaceQueue
p = r'E:\Zilux2开发\web\src\ui\player.ts'
t = load(p)
anchor = '''/** 播放单曲（队列只有它）。 */'''
new = '''/**
 * 用更完整的列表替换队列（保持当前曲目与播放进度，不重载音频）。
 * 首页卡片一开始只有预览用的少量曲目，进入播放后会异步补全整张列表，
 * 否则列表循环时会「播几首就绕回第一首」。
 */
export function replaceQueue(tracks: OnlineTrack[]): void {
  if (tracks.length === 0) return;
  const track = state.track;
  if (!track) {
    playQueue(tracks, 0);
    return;
  }
  const index = tracks.findIndex((item) => item.source === track.source && item.id === track.id);
  if (index < 0) return;
  state = { ...state, queue: tracks.slice(), index };
  setState({ queue: state.queue, index });
}

'''
assert t.count(anchor) == 1, ('player anchor', t.count(anchor))
t = t.replace(anchor, new + anchor)
save(p, t)

# 2) home.ts: PlayScope + call sites
p = r'E:\Zilux2开发\web\src\ui\home.ts'
t = load(p)
old_iface = '  onPlay(tracks: OnlineTrack[], index: number): void;'
new_iface = '  onPlay(tracks: OnlineTrack[], index: number, scope: PlayScope): void;'
assert t.count(old_iface) == 1, ('home iface', t.count(old_iface))
t = t.replace(old_iface, new_iface)

anchor2 = 'export interface HomeCallbacks {'
assert t.count(anchor2) == 1
t = t.replace(anchor2, "export type PlayScope = 'daily' | 'recent' | 'liked';\n\n" + anchor2)

subs = [
    ('this.callbacks.onPlay(data.daily, 0)', "this.callbacks.onPlay(data.daily, 0, 'daily')"),
    ('this.callbacks.onPlay(this.dailyTracks, Math.max(0, index))', "this.callbacks.onPlay(this.dailyTracks, Math.max(0, index), 'daily')"),
    ('this.callbacks.onPlay(data.recent, index)', "this.callbacks.onPlay(data.recent, index, 'recent')"),
    ('this.callbacks.onPlay(data.liked, 0)', "this.callbacks.onPlay(data.liked, 0, 'liked')"),
]
for a, b in subs:
    n = t.count(a)
    assert n >= 1, ('home sub', a, n)
    t = t.replace(a, b)
save(p, t)

# 3) app.ts
p = r'E:\Zilux2开发\web\src\ui\app.ts'
t = load(p)
old_imp = '''  refreshCurrentLiked,
  cycleMode,'''
new_imp = '''  refreshCurrentLiked,
  replaceQueue,
  cycleMode,'''
assert t.count(old_imp) == 1, ('app import', t.count(old_imp))
t = t.replace(old_imp, new_imp)

old_import = "import { HomeView } from './home';"
new_import = "import { HomeView } from './home';\nimport type { PlayScope } from './home';"
assert t.count(old_import) == 1, ('app home import', t.count(old_import))
t = t.replace(old_import, new_import)

old_cb = '      onPlay: (tracks, index) => playQueue(tracks, index),'
new_cb = '      onPlay: (tracks, index, scope) => this.playFromHome(tracks, index, scope),'
assert t.count(old_cb) == 1, ('app cb', t.count(old_cb))
t = t.replace(old_cb, new_cb)

anchor3 = '  /** 立即播放指定曲目（供快捷键）。 */'
method = '''  /**
   * 首页点播放：先用卡片里的预览列表立即开播，再异步补全整张列表，
   * 避免列表循环很快绕回第一首。
   */
  private playFromHome(tracks: OnlineTrack[], index: number, scope: PlayScope): void {
    const safeIndex = Math.max(0, Math.min(index, Math.max(0, tracks.length - 1)));
    const start = tracks[safeIndex];
    playQueue(tracks, safeIndex);
    if (!start) return;
    void (async () => {
      let full: OnlineTrack[] | null = null;
      try {
        if (scope === 'liked') {
          full = await this.fetchLikedTracks(this.preferredSource() ?? start.source);
        } else if (scope === 'recent') {
          full = await fetchRecentMerged(300);
        } else {
          full = (await this.fetchDailyMerged(80)).tracks;
        }
      } catch (err) {
        console.warn('[app] expand queue failed', err);
      }
      if (full && full.length > tracks.length) replaceQueue(full);
    })();
  }

'''
assert t.count(anchor3) == 1, ('app method anchor', t.count(anchor3))
t = t.replace(anchor3, method + anchor3)
save(p, t)
print('ok')
