# -*- coding: utf-8 -*-
"""spaceShell：磁贴点击详情面板 + 再次点击/双击播放。"""
import io

p = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# 1) 模板：在 foot 前插入歌曲详情面板
old = """    <div class="space-foot">
      <span data-space-status>正在读取登录状态…</span>
    </div>"""
new = """    <aside class="tile-detail" data-tile-detail hidden>
      <div class="tile-detail-cover">
        <img data-tile-cover alt="" />
      </div>
      <div class="tile-detail-body">
        <h3 data-tile-title>—</h3>
        <p data-tile-artist>—</p>
        <p class="tile-detail-meta" data-tile-meta>—</p>
        <p class="tile-detail-tip">再次点击封面播放 · 双击播放 · Esc 关闭</p>
      </div>
    </aside>
    <div class="space-foot">
      <span data-space-status>正在读取登录状态…</span>
    </div>"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 2) 元素引用
old = "  const accountSheet = root.querySelector<HTMLElement>('[data-account-sheet]')!;"
new = """  const tileDetail = root.querySelector<HTMLElement>('[data-tile-detail]')!;
  const tileCover = root.querySelector<HTMLImageElement>('[data-tile-cover]')!;
  const tileTitle = root.querySelector<HTMLElement>('[data-tile-title]')!;
  const tileArtist = root.querySelector<HTMLElement>('[data-tile-artist]')!;
  const tileMeta = root.querySelector<HTMLElement>('[data-tile-meta]')!;
  const accountSheet = root.querySelector<HTMLElement>('[data-account-sheet]')!;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 3) 详情状态与函数（放在 island 创建之后、toggleLikedView 之前）
old = "  let tileTracks: OnlineTrack[] = [];"
new = """  let tileTracks: OnlineTrack[] = [];
  let detailIndex = -1;
  let lastTileClick = { index: -1, at: 0 };

  function hideTileDetail(): void {
    if (detailIndex < 0 && tileDetail.hidden) return;
    detailIndex = -1;
    tileDetail.classList.remove('is-open');
    tileDetail.hidden = true;
    space?.setSelectedTile(-1);
  }

  function showTileDetail(index: number): void {
    const track = tileTracks[index];
    if (!track) return;
    detailIndex = index;
    tileCover.src = track.cover || '';
    tileTitle.textContent = track.title || '未命名';
    tileArtist.textContent = track.artist || '未知歌手';
    tileMeta.textContent = [track.album, track.durationMs ? formatClock(track.durationMs) : '']
      .filter(Boolean)
      .join(' · ');
    tileDetail.hidden = false;
    requestAnimationFrame(() => tileDetail.classList.add('is-open'));
    space?.setSelectedTile(index);
    setStatus(`已选中《${track.title}》· 再次点击或双击播放`);
  }

  function handleTileClick(index: number): void {
    const now = performance.now();
    const isDouble = lastTileClick.index === index && now - lastTileClick.at < 430;
    lastTileClick = { index, at: now };
    if (isDouble || detailIndex === index) {
      const track = tileTracks[index];
      if (track) {
        island.play(track, tileTracks);
        showToast(`正在播放《${track.title}》`, 'ok');
      }
      hideTileDetail();
      return;
    }
    showTileDetail(index);
  }"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 4) onTileClick 改为走详情逻辑
old = """    onTileClick: (index) => {
      const track = tileTracks[index];
      if (!track) {
        showToast('这首暂时无法播放', 'warn');
        return;
      }
      island.play(track, tileTracks);
    },"""
new = """    onTileClick: (index) => {
      if (!tileTracks[index]) {
        showToast('这首暂时无法播放', 'warn');
        return;
      }
      handleTileClick(index);
    },"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 5) Esc：优先关闭详情
old = """  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && searchOpen) {"""
new = """  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && detailIndex >= 0) {
      event.preventDefault();
      hideTileDetail();
      return;
    }
    if (event.key === 'Escape' && searchOpen) {"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('spaceShell tile detail done')
