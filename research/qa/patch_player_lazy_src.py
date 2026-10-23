import io

p = r'E:\Zilux2开发\web\src\ui\player.ts'
text = io.open(p, 'r', encoding='utf-8', newline='').read()
nl = '\r\n' if '\r\n' in text else '\n'


def sub(name, old, new):
    global text
    old = old.replace('\n', nl)
    new = new.replace('\n', nl)
    got = text.count(old)
    assert got == 1, '%s: expected 1, got %d' % (name, got)
    text = text.replace(old, new)


# 1) import onlineInfo
sub(
    'import onlineInfo',
    "import { streamUrl, checkLiked, addLikedTrack, recordRecent } from '../online/client';",
    "import { onlineInfo, streamUrl, checkLiked, addLikedTrack, recordRecent } from '../online/client';",
)

# 2) 记录当前 src 对应的宿主端口 + 恢复后不立刻设 src（等首次点击再取新地址）
sub(
    'src port state',
    "const MODE_KEY = 'zilux2.playMode';",
    """const MODE_KEY = 'zilux2.playMode';

/** 当前 audio.src 是用哪个宿主端口（含 token）拼出来的；宿主每次启动换端口，旧地址必然失效。 */
let srcPort = 0;
/** 恢复上次播放时暂存的进度（等用户点播放、拿到新地址后再 seek）。 */
let pendingResumeMs = 0;""",
)

sub(
    'restore no src',
    """    audio.preload = 'metadata';
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
    return true;""",
    """    audio.preload = 'metadata';
    // 注意：这里不能马上 audio.src = streamUrl(track)。
    // 宿主每次启动端口都变，这会儿在线端点往往还没推过来，拼出来的地址是坏的，
    // 之后点播放会一直失败。留到首次播放时再解析（见 ensureSource）。
    pendingResumeMs = resumeMs;
    setState({ durationMs: state.durationMs });
    emit();
    refreshLiked(track);
    return true;""",
)

# 3) 首次点击播放时解析地址（含端口刷新 + 续播进度）
sub(
    'ensureSource helper',
    "export function toggle(): void {\n  if (!state.track) {",
    """/** 懒加载音频地址：恢复出来的歌第一次播放时才拼 URL，并顺带校验宿主端口是否变了。 */
function ensureSource(): boolean {
  const track = state.track;
  if (!track) return false;
  const port = onlineInfo()?.port ?? 0;
  const same = audio.src.length > 0 && (track.source === 'local' || srcPort === port);
  if (same) return true;
  let url = '';
  try {
    url = streamUrl(track);
  } catch (err) {
    console.warn('[player] streamUrl failed', err);
    return false;
  }
  const keep = audio.currentTime > 0 && Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  audio.src = url;
  srcPort = port;
  audio.volume = state.volume;
  const resume = pendingResumeMs > 0 ? pendingResumeMs : keep * 1000;
  pendingResumeMs = 0;
  if (resume > 0) {
    const apply = (): void => {
      audio.removeEventListener('loadedmetadata', apply);
      try {
        audio.currentTime = startAt + resume / 1000;
      } catch {
        /* 忽略 */
      }
    };
    if (audio.readyState >= 1) apply();
    else audio.addEventListener('loadedmetadata', apply);
  }

  return true;
}

export function toggle(): void {
  if (!state.track) {""",
)

sub(
    'toggle ensureSource',
    """  if (audio.paused) {
    void audio
      .play()""",
    """  if (audio.paused) {
    if (!ensureSource()) {
      setState({ playing: false });
      return;
    }
    void audio
      .play()""",
)

# 4) load() 也记录 srcPort
sub(
    'load src port',
    """  audio.src = url;
  audio.volume = state.volume;
  if (autoplay) {""",
    """  audio.src = url;
  srcPort = onlineInfo()?.port ?? 0;
  pendingResumeMs = 0;
  audio.volume = state.volume;
  if (autoplay) {""",
)

# 5) onError 里若端口失效导致的错，不自动跳过（避免连锁跳歌）
sub(
    'onError port stale',
    """  const track = state.track;
  if (!track) return;
  setState({ playing: false, loading: false });""",
    """  const track = state.track;
  if (!track) return;
  setState({ playing: false, loading: false });
  const port = onlineInfo()?.port ?? 0;
  if (track.source !== 'local' && srcPort !== 0 && port !== 0 && srcPort !== port) {
    // 宿主换了端口：地址过期而已，下一次点击会重新解析，不要当成坏歌跳过
    srcPort = 0;
    audio.removeAttribute('src');
    return;
  }""",
)

io.open(p, 'w', encoding='utf-8', newline='').write(text)
print('player lazy source patch applied')
