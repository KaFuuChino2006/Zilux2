# -*- coding: utf-8 -*-
"""「我喜欢」按需分批加载：翻到边界自动加载下一批/上一批，可翻到全部 5000+ 首。"""
import io

SHELL = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
SCENE = r'E:\Zilux2开发\web\src\three\floatScene.ts'

# ---------- floatScene.ts: 增加 setTilePage ----------
f = io.open(SCENE, 'r', encoding='utf-8', newline='').read()
old_iface = "  turnPage(direction: number): boolean;\n  pageInfo(): { page: number; total: number };"
new_iface = "  turnPage(direction: number): boolean;\n  pageInfo(): { page: number; total: number };\n  setTilePage(page: number): void;"
assert f.count(old_iface) == 1
f = f.replace(old_iface, new_iface, 1)

anchor = """    pageInfo() {
      const rows = Math.ceil(tileItems.length / TILE_COLS);
      const total = Math.max(1, Math.ceil(rows / TILE_ROWS));
      const page = Math.min(total, Math.floor(tileOffsetRows / TILE_ROWS) + 1);
      return { page, total };
    },"""
new_impl = """    pageInfo() {
      const rows = Math.ceil(tileItems.length / TILE_COLS);
      const total = Math.max(1, Math.ceil(rows / TILE_ROWS));
      const page = Math.min(total, Math.floor(tileOffsetRows / TILE_ROWS) + 1);
      return { page, total };
    },
    setTilePage(page) {
      const rows = Math.ceil(tileItems.length / TILE_COLS);
      const maxOffset = Math.max(0, rows - TILE_ROWS);
      const total = Math.max(1, Math.ceil(rows / TILE_ROWS));
      const target = Math.min(total, Math.max(1, Math.floor(page) || 1));
      tileOffsetRows = Math.min(maxOffset, (target - 1) * TILE_ROWS);
      refreshTiles();
      emitHover();
    },"""
assert f.count(anchor) == 1
f = f.replace(anchor, new_impl, 1)
io.open(SCENE, 'w', encoding='utf-8', newline='').write(f)
print('floatScene: setTilePage')

# ---------- spaceShell.ts ----------
s = io.open(SHELL, 'r', encoding='utf-8', newline='').read()

old_state = """  let likedViewOpen = false;
  let likedSource: MusicSource = 'netease';
  const LIKED_TILE_LIMIT = 300;"""
new_state = """  let likedViewOpen = false;
  let likedSource: MusicSource = 'netease';
  const LIKED_TILE_LIMIT = 300;
  let likedOffset = 0; // 当前磁贴批在「我喜欢的音乐」总列表中的起点
  let likedLoaded = 0; // 已加载到的绝对位置（offset + 本批数量）
  let likedTotal = 0; // 服务端给出的总数（未知时先用已加载数）
  let likedLoading = false;"""
assert s.count(old_state) == 1
s = s.replace(old_state, new_state, 1)

# 用新 loadLikedTiles 替换旧实现（按批加载）
start = s.index("  async function loadLikedTiles(): Promise<void> {")
end = s.index("  function markLikedSource(source: MusicSource): void {")
new_loader = """  function tilePayload(tracks: OnlineTrack[]): Array<{ title: string; artist: string; cover?: string }> {
    return tracks.map((track) => ({ title: track.title, artist: track.artist, cover: track.cover }));
  }

  function likedStatusText(): string {
    const label = likedLabel(likedSource);
    const info = space?.pageInfo();
    const pageText = info ? ` · 第 ${info.page}/${info.total} 页` : '';
    const moreText =
      likedTotal > likedLoaded ? ` · 共 ${likedTotal} 首（已加载 ${likedLoaded}）` : ` · 共 ${likedTotal} 首`;
    return `${label} · 我喜欢的音乐${moreText}${pageText} · 拖动旋转 / 滚轮缩放 / 翻页箭头`;
  }

  async function loadLikedTiles(): Promise<void> {
    if (!space) return;
    space.setTilesVisible(true);
    setStatus(`${likedLabel(likedSource)} · 我喜欢的音乐 · 正在读取…`);
    try {
      const detail = await fetchPlaylist(likedSource, 'liked', 0, LIKED_TILE_LIMIT, 'liked');
      const tracks = detail.tracks.slice(0, LIKED_TILE_LIMIT);
      likedOffset = 0;
      likedLoaded = tracks.length;
      likedTotal = detail.count > 0 ? detail.count : tracks.length;
      tileTracks = tracks;
      space.setTiles(tilePayload(tracks));
      if (tracks.length === 0) {
        setStatus(`${likedLabel(likedSource)} · 我喜欢的音乐 · 暂无歌曲（请先在账号里登录平台）`);
        return;
      }
      setStatus(likedStatusText());
    } catch (error) {
      console.warn('[liked] 读取失败', error);
      setStatus(`${likedLabel(likedSource)} · 我喜欢的音乐 · 读取失败，稍后重试`);
    }
  }

  /* 翻到当前批边界时，按需加载下一批（或上一批），从而能一直翻到全部歌曲 */
  async function loadLikedPage(direction: number): Promise<void> {
    if (!space || likedLoading) return;
    if (direction > 0 && likedLoaded >= likedTotal) {
      showToast('已经是最后一批了', 'info');
      return;
    }
    if (direction < 0 && likedOffset <= 0) {
      showToast('已经是第一页', 'info');
      return;
    }
    const nextOffset = direction > 0 ? likedLoaded : Math.max(0, likedOffset - LIKED_TILE_LIMIT);
    likedLoading = true;
    setStatus('正在加载更多歌曲…');
    try {
      const detail = await fetchPlaylist(
        likedSource,
        'liked',
        nextOffset,
        LIKED_TILE_LIMIT,
        'liked',
      );
      const tracks = detail.tracks.slice(0, LIKED_TILE_LIMIT);
      if (tracks.length === 0) {
        likedLoaded = likedTotal;
        showToast(direction > 0 ? '已经是最后一批了' : '已经是第一页', 'info');
        return;
      }
      likedOffset = nextOffset;
      likedLoaded = nextOffset + tracks.length;
      if (detail.count > 0) likedTotal = detail.count;
      tileTracks = tracks;
      space.setTiles(tilePayload(tracks));
      // 向后翻：显示新批第 1 页；向前翻：显示上一批最后一页
      space.setTilePage(direction > 0 ? 1 : Number.MAX_SAFE_INTEGER);
      setStatus(likedStatusText());
    } catch (error) {
      console.warn('[liked] 加载更多失败', error);
      showToast('加载失败，稍后重试', 'error');
    } finally {
      likedLoading = false;
    }
  }

"""
s = s[:start] + new_loader + s[end:]

# turnTiles 改为边界自动加载
old_turn = """  function turnTiles(direction: number): void {
    if (!space) return;
    const ok = space.turnPage(direction);
    if (!ok) {
      showToast(direction > 0 ? '已经是最后一页' : '已经是第一页', 'info');
      return;
    }
    const info = space.pageInfo();
    setStatus(`我喜欢的音乐 · 第 ${info.page}/${info.total} 页 · 点击封面看详情`);
  }"""
new_turn = """  function turnTiles(direction: number): void {
    if (!space) return;
    const before = space.pageInfo();
    if (direction > 0 && before.page >= before.total && likedViewOpen) {
      void loadLikedPage(1);
      return;
    }
    if (direction < 0 && before.page <= 1 && likedViewOpen) {
      void loadLikedPage(-1);
      return;
    }
    const ok = space.turnPage(direction);
    if (!ok) return;
    setStatus(likedStatusText());
  }"""
assert s.count(old_turn) == 1
s = s.replace(old_turn, new_turn, 1)
io.open(SHELL, 'w', encoding='utf-8', newline='').write(s)
print('spaceShell: paged liked loading')
