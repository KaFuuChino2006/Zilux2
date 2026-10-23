"""墙面滚动加载更多（我喜欢 / 歌单）：新增 WallPager 状态 + 增量追加封面。"""
import io

PATH = r'E:\Zilux2开发\web\src\ui\app.ts'
text = io.open(PATH, 'r', encoding='utf-8', newline='').read()
eol = '\r\n' if '\r\n' in text else '\n'


def apply(label, old, new, expect=1):
    global text
    count = text.count(old)
    assert count == expect, f'{label}: found {count}, expected {expect}'
    text = text.replace(old, new)
    print(f'ok {label}')


# 1. 分页类型
apply(
    'types',
    'interface SheetHandle {',
    '''interface WallPagerEntry {
  source: OnlineSource;
  id: string;
  special: 'liked' | null;
}

interface WallPager {
  entries: WallPagerEntry[];
  offset: number;
  pageSize: number;
  hasMore: boolean;
}

interface SheetHandle {''',
)

# 2. 字段
apply(
    'fields',
    '  private wallHost: HTMLDivElement;\n',
    '  private wallHost: HTMLDivElement;\n  private wallPager: WallPager | null = null;\n  private wallLoadingMore = false;\n',
)

# 3. 滚动监听
apply(
    'constructor scroll',
    "    this.wallHost = h('div', { class: 'wall' });\n",
    "    this.wallHost = h('div', { class: 'wall' });\n"
    "    this.wallHost.addEventListener('scroll', () => this.maybeLoadMoreWall(), { passive: true });\n",
)

# 4. 网格渲染抽成 posterNode/appendPosters + 分页方法
old_loop = """    const grid = h('div', { class: `wall-grid${skipEnter ? '' : ' is-reveal'}` });
    const current = playerState().track;
    tracks.forEach((track, index) => {
      const coverImg = h('img', { src: onlineArtwork(track), loading: 'eager' });
      if (!track.cover) {
        void lookupCover(track).then((found) => {
          if (!found) return;
          track.cover = found;
          coverImg.src = onlineArtwork(track);
        });
      }
      const poster = h(
        'div',
        { class: `poster${current && current.id === track.id ? ' is-playing' : ''}`, title: `${track.title} — ${track.artist}` },
        coverImg,
        h('div', { class: 'poster-badge', text: String(index + 1).padStart(2, '0') }),
        this.wall.kind === 'search' || (this.wall.kind === 'liked' && this.likedMode === 'all')
          ? h('div', {
              class: 'poster-src',
              style: `--src-accent:${sourceMeta(track.source).accent}`,
              text: sourceMeta(track.source).short,
            })
          : null,
        h('div', { class: 'poster-foot' }, h('div', { class: 'poster-name', text: track.title }), h('div', { class: 'poster-artist', text: track.artist || '未知歌手' })),
      );
      const playBtn = h('button', { class: 'poster-play', title: '播放' }, icon('play', 18));
      playBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        playQueue(tracks, index, true);
      });
      poster.append(playBtn);
      poster.addEventListener('click', () => playQueue(tracks, index, true));
      grid.append(poster);
    });
    this.wallHost.append(grid);
  }
"""

new_loop = """    const grid = h('div', { class: `wall-grid${skipEnter ? '' : ' is-reveal'}` });
    this.appendPosters(grid, tracks, 0, tracks);
    this.wallHost.append(grid);
  }

  /** 生成一张封面海报（首次渲染与分页追加共用）。 */
  private posterNode(track: OnlineTrack, index: number, queue: OnlineTrack[]): HTMLElement {
    const coverImg = h('img', { src: onlineArtwork(track), loading: 'eager' });
    if (!track.cover) {
      void lookupCover(track).then((found) => {
        if (!found) return;
        track.cover = found;
        coverImg.src = onlineArtwork(track);
      });
    }
    const current = playerState().track;
    const poster = h(
      'div',
      { class: `poster${current && current.id === track.id ? ' is-playing' : ''}`, title: `${track.title} — ${track.artist}` },
      coverImg,
      h('div', { class: 'poster-badge', text: String(index + 1).padStart(2, '0') }),
      this.wall.kind === 'search' || (this.wall.kind === 'liked' && this.likedMode === 'all')
        ? h('div', {
            class: 'poster-src',
            style: `--src-accent:${sourceMeta(track.source).accent}`,
            text: sourceMeta(track.source).short,
          })
        : null,
      h('div', { class: 'poster-foot' }, h('div', { class: 'poster-name', text: track.title }), h('div', { class: 'poster-artist', text: track.artist || '未知歌手' })),
    );
    const playBtn = h('button', { class: 'poster-play', title: '播放' }, icon('play', 18));
    playBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      playQueue(queue, index, true);
    });
    poster.append(playBtn);
    poster.addEventListener('click', () => playQueue(queue, index, true));
    return poster;
  }

  private appendPosters(grid: HTMLElement, tracks: OnlineTrack[], startIndex: number, queue: OnlineTrack[]): void {
    tracks.forEach((track, offset) => {
      grid.append(this.posterNode(track, startIndex + offset, queue));
    });
  }

  /** 墙面滚动接近底部时自动拉下一页。 */
  private maybeLoadMoreWall(): void {
    const pager = this.wallPager;
    if (!pager || !pager.hasMore || this.wallLoadingMore) return;
    const host = this.wallHost;
    if (host.scrollTop + host.clientHeight < host.scrollHeight - 700) return;
    void this.loadMoreWall();
  }

  /** 用首页概览里各平台的「我喜欢的音乐」歌单 id 建分页器。 */
  private async primeLikedPager(sources: OnlineSource[], offset: number): Promise<void> {
    try {
      const overview = await fetchLibraryOverview();
      const entries: WallPagerEntry[] = [];
      for (const source of sources) {
        const state = overview.sources.find((item) => item.source === source);
        if (state?.liked) entries.push({ source, id: state.liked.id, special: 'liked' });
      }
      this.wallPager = entries.length > 0 ? { entries, offset, pageSize: 200, hasMore: offset >= 200 } : null;
    } catch (err) {
      console.warn('[app] prime liked pager failed', err);
      this.wallPager = null;
    }
  }

  private async loadMoreWall(): Promise<void> {
    const pager = this.wallPager;
    if (!pager || !pager.hasMore || this.wallLoadingMore) return;
    const entries = pager.entries.filter((entry) => entry.id.length > 0);
    if (entries.length === 0) return;
    this.wallLoadingMore = true;
    try {
      const offset = pager.offset;
      const pages = await Promise.all(
        entries.map(async (entry) => {
          try {
            return await fetchPlaylist(entry.source, entry.id, offset, pager.pageSize, entry.special === 'liked' ? 'liked' : undefined);
          } catch (err) {
            console.warn('[app] load more failed', entry.source, err);
            return null;
          }
        }),
      );
      const known = new Set(this.wall.tracks.map((item) => `${item.source}:${item.id}`));
      const fresh: OnlineTrack[] = [];
      const push = (track: OnlineTrack | undefined): void => {
        if (!track) return;
        const key = `${track.source}:${track.id}`;
        if (known.has(key)) return;
        known.add(key);
        fresh.push(track);
      };
      if (pages.length === 1) {
        for (const track of pages[0]?.tracks ?? []) push(track);
      } else {
        const longest = Math.max(0, ...pages.map((page) => page?.tracks.length ?? 0));
        for (let index = 0; index < longest; index += 1) {
          for (const page of pages) push(page?.tracks[index]);
        }
      }
      pager.offset = offset + pager.pageSize;
      pager.hasMore = pages.some((page) => (page?.hasMore ?? false) || (page?.tracks.length ?? 0) >= pager.pageSize);
      if (fresh.length === 0) return;
      this.wall.tracks.push(...fresh);
      if (this.wallLayout === 'list') {
        this.wallHost.querySelector('.track-list')?.remove();
        this.wallHost.append(this.buildSearchList(this.wall.tracks));
      } else {
        const grid = this.wallHost.querySelector('.wall-grid');
        if (grid) this.appendPosters(grid as HTMLElement, fresh, this.wall.tracks.length - fresh.length, this.wall.tracks);
      }
      const sub = this.wallHost.querySelector('.wall-sub');
      if (sub) {
        const text = sub.textContent ?? '';
        const count = this.wall.tracks.length;
        sub.textContent = /\\d+\\s*首/.test(text) ? text.replace(/\\d+\\s*首/, `${count} 首`) : `${text} · ${count} 首`;
      }
    } finally {
      this.wallLoadingMore = false;
    }
  }
"""

apply('grid loop -> pager', old_loop, new_loop)

# 5. loadLikedMerged：建分页器
apply(
    'merged pager',
    """    const label = available.map((item) => SOURCE_LABEL[item.source]).join(' + ');
    this.wall = {
      kind: 'liked',
      title: '我喜欢的音乐',
      subtitle: `${label} · 融合 · ${merged.length} 首`,
      tracks: merged,
    };
    this.renderWall();""",
    """    const label = available.map((item) => SOURCE_LABEL[item.source]).join(' + ');
    this.wall = {
      kind: 'liked',
      title: '我喜欢的音乐',
      subtitle: `${label} · 融合 · ${merged.length} 首`,
      tracks: merged,
    };
    await this.primeLikedPager(available.map((item) => item.source), merged.length);
    this.renderWall();""",
)

# 6. loadLiked 缓存分支：异步补分页器
apply(
    'cached liked pager',
    """    const cached = this.likedCache.get(source);
    if (cached && cached.length > 0) {
      this.wall = {""",
    """    const cached = this.likedCache.get(source);
    if (cached && cached.length > 0) {
      void this.primeLikedPager([source], cached.length);
      this.wall = {""",
)

# 7. loadLiked 新拉分支：设置分页器
apply(
    'fresh liked pager',
    """      const detail = await fetchPlaylist(source, state.liked.id, 0, 200, 'liked');
      this.likedCache.set(source, detail.tracks);
      this.wall = {
        kind: 'liked',
        title: '我喜欢的音乐',
        subtitle: `${SOURCE_LABEL[source]} · ${detail.tracks.length} 首`,
        tracks: detail.tracks,
      };""",
    """      const detail = await fetchPlaylist(source, state.liked.id, 0, 200, 'liked');
      this.likedCache.set(source, detail.tracks);
      this.wallPager = { entries: [{ source, id: state.liked.id, special: 'liked' }], offset: detail.tracks.length, pageSize: 200, hasMore: detail.hasMore };
      this.wall = {
        kind: 'liked',
        title: '我喜欢的音乐',
        subtitle: `${SOURCE_LABEL[source]} · ${detail.tracks.length} 首`,
        tracks: detail.tracks,
      };""",
)

# 8. showPlaylist：设置分页器
apply(
    'playlist pager',
    """      const detail = await fetchPlaylist(item.source, item.id, 0, 200, special);
      this.wall = {
        ...this.wall,""",
    """      const detail = await fetchPlaylist(item.source, item.id, 0, 200, special);
      this.wallPager = { entries: [{ source: item.source as OnlineSource, id: item.id, special: special ?? null }], offset: detail.tracks.length, pageSize: 200, hasMore: detail.hasMore };
      this.wall = {
        ...this.wall,""",
)

# 9. 其它墙面清空分页器
for label, anchor in [
    ('showHome', '  private async showHome(): Promise<void> {\n'),
    ('showRecentWall', '  private async showRecentWall(): Promise<void> {\n'),
    ('showDailyWall', '  private async showDailyWall(qqDaily = false): Promise<void> {\n'),
    ('showLocal', '  private showLocal(): void {\n'),
    ('commitSearch', '  private async commitSearch(): Promise<void> {\n'),
    ('showLiked', '  private async showLiked(mode?: \'all\' | OnlineSource): Promise<void> {\n'),
]:
    apply(label + ' clear pager', anchor, anchor + '    this.wallPager = null;\n')

io.open(PATH, 'w', encoding='utf-8', newline='').write(text)
print('saved app.ts')
