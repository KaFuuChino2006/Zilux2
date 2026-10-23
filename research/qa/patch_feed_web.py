# -*- coding: utf-8 -*-
"""Web 侧「发现」面板：最近播放 / 每日推荐接入 /api/library/feed。"""
import io

ROOT = r"E:\Zilux2开发\web\src"

def patch(path, pairs):
    full = ROOT + "\\" + path
    with io.open(full, "r", encoding="utf-8", newline="") as f:
        s = f.read()
    for old, new in pairs:
        if s.count(old) != 1:
            raise SystemExit(f"[fail] {path}: anchor count={s.count(old)} for {old[:70]!r}")
        s = s.replace(old, new, 1)
    with io.open(full, "w", encoding="utf-8", newline="") as f:
        f.write(s)
    print(f"[ok] {path}")


# 1) client.ts：fetchFeed
patch(r"online\client.ts", [(
    "/** 查询歌曲是否已在对应平台「我喜欢的音乐」中。 */\n",
    """/** 发现面板：最近播放 / 每日推荐（/api/library/feed）。 */
export async function fetchFeed(
  source: OnlineSource,
  kind: 'recent' | 'daily',
  limit = 60,
): Promise<{ source: OnlineSource; kind: 'recent' | 'daily'; tracks: OnlineTrack[] }> {
  if (mockMode) {
    const label = kind === 'daily' ? '每日推荐' : '最近播放';
    const platform = source === 'qq' ? 'QQ 音乐' : '网易云音乐';
    const tracks: OnlineTrack[] = Array.from({ length: 8 }, (_, index) => ({
      source,
      id: `mock-feed-${kind}-${index}`,
      title: `${label} ${String(index + 1).padStart(2, '0')}`,
      artist: platform,
      album: '',
      durationMs: 180_000 + index * 12_000,
      cover: '',
      playable: true,
    }));
    return { source, kind, tracks };
  }
  return api<{ source: OnlineSource; kind: 'recent' | 'daily'; tracks: OnlineTrack[] }>('/api/library/feed', {
    source,
    kind,
    limit: String(limit),
  });
}

/** 查询歌曲是否已在对应平台「我喜欢的音乐」中。 */
""",
)])

# 2) 模板：发现胶囊后面加 feed 弹层
patch(r"ui\spaceShell.ts", [(
    """          <button class="space-discover-item" data-discover-item="daily" type="button">${icon('sparkles', 13)}<span>每日推荐</span></button>
        </div>
      </div>
    </div>
""",
    """          <button class="space-discover-item" data-discover-item="daily" type="button">${icon('sparkles', 13)}<span>每日推荐</span></button>
        </div>
      </div>
      <div class="feed-pop" data-feed-pop hidden>
        <div class="feed-pop-head">
          <span class="feed-pop-heading" data-feed-title>发现</span>
          <button class="feed-pop-close" data-feed-close type="button" aria-label="关闭">×</button>
        </div>
        <div class="feed-pop-list" data-feed-list></div>
      </div>
    </div>
""",
)])

# 3) import fetchFeed
patch(r"ui\spaceShell.ts", [(
    "  fetchLyric,\n",
    "  fetchFeed,\n  fetchLyric,\n",
)])

# 4) 逻辑：把「即将开放」替换为真实数据
patch(r"ui\spaceShell.ts", [(
    """  root.querySelectorAll<HTMLButtonElement>('[data-discover-item]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const label = btn.dataset.discoverItem === 'daily' ? '每日推荐' : '最近播放';
      setStatus(`${discoverSourceLabel()} · ${label} 功能即将开放`);
      showToast(`${discoverSourceLabel()} · ${label} 即将开放`, 'info');
    });
  });
""",
    """  const feedPop = root.querySelector<HTMLElement>('[data-feed-pop]')!;
  const feedTitle = root.querySelector<HTMLElement>('[data-feed-title]')!;
  const feedList = root.querySelector<HTMLElement>('[data-feed-list]')!;
  let feedBusy = false;

  function closeFeed(): void {
    feedPop.classList.remove('is-open');
    feedPop.hidden = true;
    feedList.replaceChildren();
  }

  function feedNote(text: string): void {
    const note = document.createElement('p');
    note.className = 'feed-pop-note';
    note.textContent = text;
    feedList.append(note);
  }

  function renderFeed(
    tracks: OnlineTrack[],
    kind: 'recent' | 'daily',
    platform: string,
  ): void {
    feedList.replaceChildren();
    const head = document.createElement('p');
    head.className = 'feed-pop-note';
    head.textContent = `${platform} · ${kind === 'daily' ? '每日推荐' : '最近播放'} · ${tracks.length} 首`;
    feedList.append(head);
    tracks.forEach((track, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'feed-pop-row';
      const num = document.createElement('span');
      num.className = 'feed-pop-index';
      num.textContent = String(index + 1).padStart(2, '0');
      const cover = document.createElement('img');
      cover.alt = '';
      cover.loading = 'lazy';
      if (track.cover) cover.src = track.cover;
      const meta = document.createElement('span');
      meta.className = 'feed-pop-meta2';
      const title = document.createElement('span');
      title.className = 'feed-pop-title';
      title.textContent = track.title;
      const artist = document.createElement('span');
      artist.className = 'feed-pop-artist';
      artist.textContent = track.artist || '未知艺人';
      meta.append(title, artist);
      const tail = document.createElement('span');
      tail.className = 'feed-pop-tail';
      tail.textContent = formatTrackDuration(track.durationMs);
      row.append(num, cover, meta, tail);
      row.addEventListener('click', () => {
        void island.play(track, tracks);
        showToast(`正在播放《${track.title}》`, 'ok');
        closeFeed();
      });
      feedList.append(row);
    });
  }

  async function loadFeed(kind: 'recent' | 'daily'): Promise<void> {
    if (feedBusy) return;
    feedBusy = true;
    feedList.replaceChildren();
    feedNote('正在加载…');
    try {
      const feed = await fetchFeed(discoverSource, kind, 60);
      const platform = discoverSource === 'qq' ? 'QQ 音乐' : '网易云音乐';
      if (feed.tracks.length === 0) {
        feedList.replaceChildren();
        feedNote('暂时没有内容');
        return;
      }
      renderFeed(feed.tracks, kind, platform);
    } catch (error) {
      feedList.replaceChildren();
      feedNote(error instanceof Error ? error.message : '加载失败，请稍后重试');
    } finally {
      feedBusy = false;
    }
  }

  function openFeed(kind: 'recent' | 'daily'): void {
    discoverEl.classList.remove('is-open');
    feedTitle.textContent = discoverSourceLabel();
    feedPop.hidden = false;
    window.requestAnimationFrame(() => feedPop.classList.add('is-open'));
    void loadFeed(kind);
  }

  root.querySelector<HTMLElement>('[data-feed-close]')?.addEventListener('click', closeFeed);

  root.querySelectorAll<HTMLButtonElement>('[data-discover-item]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.discoverItem === 'daily' ? 'daily' : 'recent';
      if (discoverSource === 'qq' && kind === 'recent') {
        showToast('QQ 音乐不支持最近播放，可以先看每日推荐', 'info');
        return;
      }
      openFeed(kind);
    });
  });
""",
)])

# 5) 点外部关闭 + Esc 关闭
patch(r"ui\spaceShell.ts", [(
    """    if (!discoverEl.contains(event.target as Node)) discoverEl.classList.remove('is-open');
""",
    """    if (!discoverEl.contains(event.target as Node)) discoverEl.classList.remove('is-open');
    if (!feedPop.hidden && !feedPop.contains(event.target as Node)) closeFeed();
""",
)])

patch(r"ui\spaceShell.ts", [(
    """    if (event.key === 'Escape' && !likedPopEl.hidden) {
""",
    """    if (event.key === 'Escape' && !feedPop.hidden) {
      event.preventDefault();
      closeFeed();
      return;
    }
    if (event.key === 'Escape' && !likedPopEl.hidden) {
""",
)])

# 6) QA：?feed=daily 打开发现面板
patch(r"ui\spaceShell.ts", [(
    """  // QA：?play=1 自动播放我喜欢的歌单第一首（验证灵动岛播放器）
""",
    """  // QA：?feed=daily|recent 自动打开「发现」面板（验证最近播放/每日推荐）
  const feedParam = params.get('feed');
  if (feedParam === 'daily' || feedParam === 'recent') {
    window.setTimeout(() => {
      if (!disposed) openFeed(feedParam);
    }, 2600);
  }

  // QA：?play=1 自动播放我喜欢的歌单第一首（验证灵动岛播放器）
""",
)])

print("feed web patch done")
