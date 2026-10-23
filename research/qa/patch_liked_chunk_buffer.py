# -*- coding: utf-8 -*-
"""第一批就取大块（300 首）并按当前网格本地分页：磁贴数量只影响每页铺开数，不再影响首次加载量。"""
import io

p = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

def rep(old, new, cnt=1):
    global s
    assert s.count(old) == cnt, (s.count(old), old[:80])
    s = s.replace(old, new, cnt)

# 1) 状态：本地缓冲 + 分块加载
rep("""  let likedPageBusy = false;
  const likedPages = new Map<number, OnlineTrack[]>();""",
"""  let likedPageBusy = false;
  const likedPages = new Map<number, OnlineTrack[]>();
  // 首次打开先取一大块（300 首）放进本地缓冲，再按「每页磁贴数量」在本地切页。
  // 这样用户把列/行调小时首屏也还是 300 首可翻，不会变成“只加载了几首”。
  const LIKED_CHUNK_SIZE = 300;
  let likedBuffer: OnlineTrack[] = [];
  let likedBufferComplete = false;
  let likedBufferBusy: Promise<void> | null = null;""")

# 2) 缓冲填充 + ensureLikedPage 改为本地切片
rep("""  async function ensureLikedPage(source: MusicSource, page: number): Promise<OnlineTrack[] | null> {
    const cached = likedPages.get(page);
    if (cached) return cached;
    const offset = (page - 1) * tilePageSize();
    const detail = await fetchPlaylist(source, 'liked', offset, tilePageSize(), 'liked');
    if (likedSource !== source) return null;
    if (detail.count > 0) likedTotal = detail.count;
    const tracks = detail.tracks.slice(0, tilePageSize());
    likedPages.set(page, tracks);
    return tracks;
  }""",
"""  async function fillLikedBuffer(): Promise<void> {
    if (likedBufferComplete) return;
    if (likedBufferBusy) return likedBufferBusy;
    const source = likedSource;
    likedBufferBusy = (async () => {
      const offset = likedBuffer.length;
      const detail = await fetchPlaylist(source, 'liked', offset, LIKED_CHUNK_SIZE, 'liked');
      if (likedSource !== source) return;
      if (detail.count > 0) likedTotal = detail.count;
      const known = new Set(likedBuffer.map((track) => track.id));
      for (const track of detail.tracks) {
        if (!known.has(track.id)) {
          known.add(track.id);
          likedBuffer.push(track);
        }
      }
      if (detail.tracks.length < LIKED_CHUNK_SIZE) likedBufferComplete = true;
      if (likedTotal > 0 && likedBuffer.length >= likedTotal) likedBufferComplete = true;
    })().finally(() => {
      likedBufferBusy = null;
    });
    return likedBufferBusy;
  }

  async function ensureLikedPage(source: MusicSource, page: number): Promise<OnlineTrack[] | null> {
    const cached = likedPages.get(page);
    if (cached) return cached;
    const perPage = Math.max(1, tilePageSize());
    const start = (page - 1) * perPage;
    // 缓冲不够这一页就继续取块；取满或确认取完为止
    for (let guard = 0; guard < 12; guard += 1) {
      if (likedBuffer.length >= start + perPage || likedBufferComplete) break;
      await fillLikedBuffer();
      if (likedSource !== source) return null;
    }
    if (likedBuffer.length === 0 && !likedBufferComplete) return null;
    const tracks = likedBuffer.slice(start, start + perPage);
    likedPages.set(page, tracks);
    // 首屏之后后台悄悄补一块，翻页更顺滑
    if (!likedBufferComplete && likedBuffer.length < likedTotal) void fillLikedBuffer().catch(() => undefined);
    return tracks;
  }""")

# 3) 状态栏补充"已加载"信息
rep("""  function likedStatusText(): string {
    const label = likedLabel(likedSource);
    const countText = likedTotal > 0 ? ` · 共 ${likedTotal} 首` : '';
    return `${label} · 我喜欢的音乐${countText} · 第 ${likedPage}/${likedPageCount()} 页 · 拖动旋转 / 滚轮缩放 / 翻页箭头`;
  }""",
"""  function likedStatusText(): string {
    const label = likedLabel(likedSource);
    const countText = likedTotal > 0 ? ` · 共 ${likedTotal} 首` : '';
    const loadedText = likedTotal > 0 && likedBuffer.length < likedTotal ? `（已加载 ${likedBuffer.length}）` : '';
    return `${label} · 我喜欢的音乐${countText}${loadedText} · 第 ${likedPage}/${likedPageCount()} 页 · 拖动旋转 / 滚轮缩放 / 翻页箭头`;
  }""")

# 4) loadLikedTiles 重置缓冲
rep("""    space.setTilesVisible(true);
    likedPages.clear();
    likedPage = 1;
    likedTotal = 0;""",
"""    space.setTilesVisible(true);
    likedPages.clear();
    likedBuffer = [];
    likedBufferComplete = false;
    likedBufferBusy = null;
    likedPage = 1;
    likedTotal = 0;""")

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('liked chunk buffer paging applied')
