# -*- coding: utf-8 -*-
"""一次性加载全部「我喜欢」歌曲（后台渐进追加），去掉「批」概念；翻页始终有动画。"""
import io

SCENE = r'E:\Zilux2开发\web\src\three\floatScene.ts'
SHELL = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'

# 1) 追加歌曲时保留当前页位置
f = io.open(SCENE, 'r', encoding='utf-8', newline='').read()
old = """    setTiles(list) {
      tileItems = list.slice(0, 20000);
      tileOffsetRows = 0;
      refreshTiles();
    },"""
new = """    setTiles(list) {
      tileItems = list.slice(0, 20000);
      // 保留当前页位置：后台追加歌曲时不跳页
      const rows = Math.ceil(tileItems.length / tileCols);
      const maxOffset = Math.max(0, rows - tileRows);
      tileOffsetRows = Math.min(maxOffset, Math.max(0, tileOffsetRows));
      refreshTiles();
    },"""
assert f.count(old) == 1
f = f.replace(old, new, 1)
io.open(SCENE, 'w', encoding='utf-8', newline='').write(f)
print('floatScene: keep page on append')

s = io.open(SHELL, 'r', encoding='utf-8', newline='').read()

start = s.index('  async function loadLikedTiles(): Promise<void> {')
end = s.index('  function markLikedSource(source: MusicSource): void {')
new_block = """  let likedTrackIds = new Set<string>();
  let likedTracksAll: OnlineTrack[] = [];

  function appendLikedTracks(tracks: OnlineTrack[]): void {
    const seen = new Set(likedTrackIds);
    const fresh: OnlineTrack[] = [];
    for (const track of tracks) {
      const key = track.id ?? `${track.title}|${track.artist}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(track);
    }
    if (fresh.length === 0) return;
    likedTracksAll = likedTracksAll.concat(fresh);
    likedTrackIds = seen;
    likedLoaded = likedTracksAll.length;
    tileTracks = likedTracksAll;
    space?.setTiles(tilePayload(likedTracksAll));
  }

  /** 后台把「我喜欢」全部歌曲按 300 首一批追加进来，页数随加载增长，界面不跳页 */
  async function loadAllLikedTracks(source: MusicSource): Promise<void> {
    if (likedLoading) return;
    likedLoading = true;
    try {
      while (likedSource === source) {
        const offset = likedTracksAll.length;
        if (offset >= likedTotal) break;
        const detail = await fetchPlaylist(source, 'liked', offset, 300, 'liked');
        const batch = detail.tracks.slice(0, 300);
        if (detail.count > 0) likedTotal = detail.count;
        if (batch.length === 0) break;
        appendLikedTracks(batch);
        setStatus(likedStatusText());
      }
    } catch (error) {
      console.warn('[liked] 后台加载失败', error);
    } finally {
      likedLoading = false;
      if (likedSource === source) setStatus(likedStatusText());
    }
  }

  async function loadLikedTiles(): Promise<void> {
    if (!space) return;
    space.setTilesVisible(true);
    const source = likedSource;
    likedTracksAll = [];
    likedTrackIds = new Set();
    likedLoaded = 0;
    setStatus(`${likedLabel(source)} · 我喜欢的音乐 · 正在读取…`);
    try {
      const detail = await fetchPlaylist(source, 'liked', 0, 300, 'liked');
      const tracks = detail.tracks.slice(0, 300);
      likedTotal = detail.count > 0 ? detail.count : tracks.length;
      if (tracks.length === 0) {
        setStatus(`${likedLabel(source)} · 我喜欢的音乐 · 暂无歌曲（请先在账号里登录平台）`);
        return;
      }
      appendLikedTracks(tracks);
      space.setTilePage(1);
      setStatus(likedStatusText());
      void loadAllLikedTracks(source);
    } catch (error) {
      console.warn('[liked] 读取失败', error);
      setStatus(`${likedLabel(source)} · 我喜欢的音乐 · 读取失败，稍后重试`);
    }
  }

"""
s = s[:start] + new_block + s[end:]

# 2) likedStatusText：去掉「批」，显示页码（基于已加载）+ 加载进度
old_status = """  function likedStatusText(): string {
    const label = likedLabel(likedSource);
    const info = space?.pageInfo();
    const pageText = info ? ` · 第 ${info.page}/${info.total} 页` : '';
    const moreText =
      likedTotal > likedLoaded ? ` · 共 ${likedTotal} 首（已加载 ${likedLoaded}）` : ` · 共 ${likedTotal} 首`;
    const batchNo = Math.floor(likedOffset / Math.max(1, likedTileLimit())) + 1;
    const batchText = likedTotal > likedLoaded ? ` · 第 ${batchNo} 批` : '';
    return `${label} · 我喜欢的音乐${moreText}${batchText}${pageText} · 拖动旋转 / 滚轮缩放 / 翻页箭头`;
  }"""
new_status = """  function likedStatusText(): string {
    const label = likedLabel(likedSource);
    const info = space?.pageInfo();
    const pageText = info ? ` · 第 ${info.page}/${info.total} 页` : '';
    const countText =
      likedLoaded < likedTotal
        ? ` · 已加载 ${likedLoaded}/${likedTotal} 首`
        : ` · 共 ${likedTotal} 首`;
    return `${label} · 我喜欢的音乐${countText}${pageText} · 拖动旋转 / 滚轮缩放 / 翻页箭头`;
  }"""
assert s.count(old_status) == 1
s = s.replace(old_status, new_status, 1)

# 3) turnTiles：纯翻页；加载中提示，加载完 toast 最后一页
start2 = s.index('  function turnTiles(direction: number): void {')
end2 = s.index('  window.addEventListener', start2) if 'window.addEventListener' in s[start2:start2 + 2000] else -1
# 用花括号定位函数结束
brace = s.index('{', start2)
depth = 0
pos = brace
while pos < len(s):
    if s[pos] == '{':
        depth += 1
    elif s[pos] == '}':
        depth -= 1
        if depth == 0:
            break
    pos += 1
old_turn = s[start2:pos + 1]
new_turn = """  function turnTiles(direction: number): void {
    if (!space) return;
    // 翻页动画进行中忽略点击（避免连点导致状态错乱）
    if (space.isFlipping()) return;
    const ok = space.turnPage(direction);
    if (!ok) {
      if (likedViewOpen && likedLoaded < likedTotal) {
        setStatus('正在加载更多歌曲…');
        return;
      }
      showToast(direction > 0 ? '已经是最后一页' : '已经是第一页', 'info');
      return;
    }
    setStatus(likedStatusText());
  }"""
s = s[:start2] + new_turn + s[pos + 1:]
io.open(SHELL, 'w', encoding='utf-8', newline='').write(s)
print('spaceShell: one-shot load all liked + page-only status')
