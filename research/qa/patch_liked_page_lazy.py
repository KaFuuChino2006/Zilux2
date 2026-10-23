# -*- coding: utf-8 -*-
"""「我喜欢」改为分页懒加载：进入只加载第 1 页并预取第 2 页，翻到第 N 页再加载第 N+1 页。
配套 floatScene 增加 switchPage（换页时完整翻转动画）。"""
import io

SCENE = r'E:\Zilux2开发\web\src\three\floatScene.ts'
SHELL = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'

# ---------- floatScene ----------
s = io.open(SCENE, 'r', encoding='utf-8', newline='').read()

old = "  setTiles(list: Array<{ title: string; artist?: string; cover?: string }>): void;"
new = ("  setTiles(list: Array<{ title: string; artist?: string; cover?: string }>): void;\n"
       "  /** 换一整页内容：先播完整翻转动画，翻到 90° 处把新一页画到背面，翻回后显示 */\n"
       "  switchPage(list: Array<{ title: string; artist?: string; cover?: string }>): void;")
assert s.count(old) == 1, 'iface setTiles'
s = s.replace(old, new, 1)

old = "  let tileItems: TileItem[] = [];"
new = "  let tileItems: TileItem[] = [];\n  let pendingItems: TileItem[] | null = null;"
assert s.count(old) == 1, 'tileItems'
s = s.replace(old, new, 1)

# 翻转动画中读取待切换的一页
old = """        const row = Math.floor(tile.index / tileCols);
        const itemIndex = (tileOffsetRows + row) * tileCols + (tile.index % tileCols);
        const item = tileItems[itemIndex];"""
new = """        const row = Math.floor(tile.index / tileCols);
        const itemIndex = (tileOffsetRows + row) * tileCols + (tile.index % tileCols);
        const item = (pendingItems ?? tileItems)[itemIndex];"""
assert s.count(old) == 1, 'flip item'
s = s.replace(old, new, 1)

old = """      if (allDone) {
        flipping = false;
        tiles.forEach((tile) => {
          tile.group.rotation.y = 0;
          tile.backPlane.visible = false;
        });
      }"""
new = """      if (allDone) {
        flipping = false;
        if (pendingItems) {
          tileItems = pendingItems;
          pendingItems = null;
          tileOffsetRows = 0;
        }
        tiles.forEach((tile) => {
          tile.group.rotation.y = 0;
          tile.backPlane.visible = false;
        });
        refreshTiles();
      }"""
assert s.count(old) == 1, 'allDone'
s = s.replace(old, new, 1)

old = """    setSelectedTile(index: number) {"""
new = """    switchPage(list) {
      if (!tileVisible) return;
      pendingItems = list.slice(0, 20000);
      tileOffsetRows = 0;
      flipping = true;
      flipElapsed = 0;
      const count = Math.max(1, tiles.length);
      flipDelays = tiles.map((tile) =>
        flipMode === 'seq' ? (tile.index / count) * 0.5 : Math.random() * 0.5,
      );
      flipMode = flipMode === 'seq' ? 'rand' : 'seq';
      tiles.forEach((tile) => {
        tile.flipped = false;
        tile.committed = false;
        tile.backPlane.visible = false;
      });
    },
    setSelectedTile(index: number) {"""
assert s.count(old) == 1, 'add switchPage'
s = s.replace(old, new, 1)

io.open(SCENE, 'w', encoding='utf-8', newline='').write(s)
print('floatScene: switchPage ok')

# ---------- spaceShell ----------
t = io.open(SHELL, 'r', encoding='utf-8', newline='').read()

start = "  /* 默认视图：我喜欢的歌单（3D 磁贴墙：封面 + 封面靠下位置显示歌名） */"
end = "  /* 顶部搜索：点击按钮就在顶部展开成搜索栏，输入回车搜索，结果铺成磁贴墙 */"
a = t.index(start)
b = t.index(end, a)
new_block = '''  /* 默认视图：我喜欢的歌单（3D 磁贴墙）。分页懒加载：进入时加载第 1 页并预取第 2 页，翻到第 N 页时再取第 N+1 页 */
  let likedViewOpen = false;
  let likedSource: MusicSource = 'netease';
  let likedPage = 1;
  let likedTotal = 0;
  let likedPageBusy = false;
  const likedPages = new Map<number, OnlineTrack[]>();

  function likedLabel(source: MusicSource): string {
    return source === 'netease' ? '网易云' : 'QQ 音乐';
  }

  function tilePayload(tracks: OnlineTrack[]): Array<{ title: string; artist: string; cover?: string }> {
    return tracks.map((track) => ({ title: track.title, artist: track.artist, cover: track.cover }));
  }

  function likedPageCount(): number {
    if (likedTotal <= 0) return 1;
    return Math.max(1, Math.ceil(likedTotal / custom.tilePageSize));
  }

  function likedStatusText(): string {
    const label = likedLabel(likedSource);
    const countText = likedTotal > 0 ? ` · 共 ${likedTotal} 首` : '';
    return `${label} · 我喜欢的音乐${countText} · 第 ${likedPage}/${likedPageCount()} 页 · 拖动旋转 / 滚轮缩放 / 翻页箭头`;
  }

  async function ensureLikedPage(source: MusicSource, page: number): Promise<OnlineTrack[] | null> {
    const cached = likedPages.get(page);
    if (cached) return cached;
    const offset = (page - 1) * custom.tilePageSize;
    const detail = await fetchPlaylist(source, 'liked', offset, custom.tilePageSize, 'liked');
    if (likedSource !== source) return null;
    if (detail.count > 0) likedTotal = detail.count;
    const tracks = detail.tracks.slice(0, custom.tilePageSize);
    likedPages.set(page, tracks);
    return tracks;
  }

  function prefetchLikedPage(source: MusicSource, page: number): void {
    if (page < 1 || page > likedPageCount() || likedPages.has(page)) return;
    void ensureLikedPage(source, page).catch(() => undefined);
  }

  async function showLikedPage(page: number, animate: boolean): Promise<void> {
    if (!space) return;
    const source = likedSource;
    const target = Math.min(likedPageCount(), Math.max(1, page));
    if (likedPageBusy) return;
    likedPageBusy = true;
    try {
      if (!likedPages.has(target)) {
        setStatus(`${likedLabel(source)} · 我喜欢的音乐 · 正在加载第 ${target}/${likedPageCount()} 页…`);
      }
      const tracks = await ensureLikedPage(source, target);
      if (!tracks || likedSource !== source) return;
      likedPage = target;
      tileTracks = tracks;
      if (animate) {
        space.switchPage(tilePayload(tracks));
      } else {
        space.setTiles(tilePayload(tracks));
        space.setTilePage(1);
      }
      setStatus(likedStatusText());
      // 预取下一页：打开第 1 页就同时准备好第 2 页
      prefetchLikedPage(source, target + 1);
    } catch (error) {
      console.warn('[liked] 分页加载失败', error);
      setStatus(`${likedLabel(source)} · 我喜欢的音乐 · 第 ${target} 页加载失败，稍后重试`);
    } finally {
      likedPageBusy = false;
    }
  }

  async function loadLikedTiles(): Promise<void> {
    if (!space) return;
    space.setTilesVisible(true);
    likedPages.clear();
    likedPage = 1;
    likedTotal = 0;
    setStatus(`${likedLabel(likedSource)} · 我喜欢的音乐 · 正在读取…`);
    await showLikedPage(1, false);
  }

  function markLikedSource(source: MusicSource): void {
    root.querySelectorAll<HTMLElement>('[data-liked-source]').forEach((button) => {
      button.classList.toggle('is-on', button.dataset.likedSource === source);
    });
  }

  async function switchLikedSource(source: MusicSource): Promise<void> {
    if (!space) return;
    likedSource = source;
    markLikedSource(source);
    if (!likedViewOpen) {
      likedViewOpen = true;
      if (!entered) enterSpace(false);
    }
    await loadLikedTiles();
  }

  async function toggleLikedView(): Promise<void> {
    if (!space) return;
    if (!entered) enterSpace(false);
    likedViewOpen = true;
    await loadLikedTiles();
  }

  function exitLikedView(): void {
    if (!likedViewOpen) return;
    likedViewOpen = false;
    void loadLikedTiles();
  }

'''
t = t[:a] + new_block + t[b:]

old = """  function turnTiles(direction: number): void {
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
new = """  function turnTiles(direction: number): void {
    if (!space) return;
    // 翻页动画/加载中忽略点击（避免连点导致状态错乱）
    if (space.isFlipping() || likedPageBusy) return;
    if (!likedViewOpen) {
      // 搜索等临时列表仍用整面墙滚动翻页
      const ok = space.turnPage(direction);
      if (!ok) showToast(direction > 0 ? '已经是最后一页' : '已经是第一页', 'info');
      return;
    }
    const target = likedPage + direction;
    if (target < 1) {
      showToast('已经是第一页', 'info');
      return;
    }
    if (target > likedPageCount()) {
      showToast('已经是最后一页', 'info');
      return;
    }
    void showLikedPage(target, true);
  }"""
assert t.count(old) == 1, 'turnTiles'
t = t.replace(old, new, 1)

io.open(SHELL, 'w', encoding='utf-8', newline='').write(t)
print('spaceShell: liked paging (page 1 + prefetch 2) ok')
