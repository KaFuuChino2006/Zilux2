# -*- coding: utf-8 -*-
"""搜索结果展开视图：一行一首（封面 + 歌名/作者 + VIP 标 + 平台角标 + 收藏按钮），收藏状态实时刷新。"""
import io

APP = r"E:\Zilux2开发\web\src\ui\app.ts"
CSS = r"E:\Zilux2开发\web\src\styles\app.css"


def load(path):
    with io.open(path, "r", encoding="utf-8", newline="") as fh:
        return fh.read()


def save(path, text):
    with io.open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


def apply(path, label, edits):
    text = load(path)
    E = "\r\n" if "\r\n" in text else "\n"
    for old, new in edits:
        o, n = old.replace("\n", E), new.replace("\n", E)
        assert text.count(o) == 1, f"{label}: {old.splitlines()[0][:60]} -> {text.count(o)}"
        text = text.replace(o, n)
    save(path, text)
    print(label, "OK")


apply(
    APP,
    "app.ts import + 字段",
    [
        (
            "import { fetchFeed, onlineReady, searchOnline } from '../online/client';",
            "import {\n"
            "  addLikedTrack,\n"
            "  checkLikedMany,\n"
            "  fetchFeed,\n"
            "  onlineReady,\n"
            "  removeLikedTrack,\n"
            "  searchOnline,\n"
            "} from '../online/client';",
        ),
        (
            "  private searchDockOpen = false;",
            "  private searchDockOpen = false;\n"
            "  /** 搜索结果收藏状态：key = source:id */\n"
            "  private searchLiked = new Map<string, boolean>();\n"
            "  private searchLikeBusy = new Set<string>();",
        ),
    ],
)

apply(
    APP,
    "app.ts commitSearch 预取收藏状态",
    [
        (
            "    this.closeSearchDock();\n"
            "    this.setRailActive('search');\n"
            "    this.renderWall();\n"
            "    this.wallHost.classList.remove('is-swap');\n"
            "    void this.wallHost.offsetWidth;\n"
            "    this.wallHost.classList.add('is-swap');\n"
            "    if (merged.length === 0) toast('没有找到相关歌曲');\n"
            "  }",
            "    this.searchLiked.clear();\n"
            "    this.closeSearchDock();\n"
            "    this.setRailActive('search');\n"
            "    this.renderWall();\n"
            "    this.wallHost.classList.remove('is-swap');\n"
            "    void this.wallHost.offsetWidth;\n"
            "    this.wallHost.classList.add('is-swap');\n"
            "    void this.prefetchSearchLiked(merged);\n"
            "    if (merged.length === 0) toast('没有找到相关歌曲');\n"
            "  }\n"
            "\n"
            "  /** 搜索结果收藏状态预取（各平台合并成一次批量请求）。 */\n"
            "  private async prefetchSearchLiked(tracks: OnlineTrack[]): Promise<void> {\n"
            "    const groups = new Map<string, string[]>();\n"
            "    tracks.forEach((track) => {\n"
            "      if (track.source === 'local') return;\n"
            "      const list = groups.get(track.source) ?? [];\n"
            "      list.push(track.id);\n"
            "      groups.set(track.source, list);\n"
            "    });\n"
            "    if (groups.size === 0) return;\n"
            "    let changed = false;\n"
            "    await Promise.all(\n"
            "      Array.from(groups.entries()).map(async ([source, ids]) => {\n"
            "        try {\n"
            "          const result = await checkLikedMany(source as OnlineSource, ids.slice(0, 60));\n"
            "          Object.entries(result).forEach(([id, liked]) => {\n"
            "            this.searchLiked.set(`${source}:${id}`, liked);\n"
            "            changed = true;\n"
            "          });\n"
            "        } catch (err) {\n"
            "          console.warn('[app] checkLikedMany failed', source, err);\n"
            "        }\n"
            "      }),\n"
            "    );\n"
            "    if (changed && this.wall.kind === 'search') this.syncSearchLiked();\n"
            "  }\n"
            "\n"
            "  /** 搜索结果行：封面 + 歌名/作者 + VIP + 平台角标 + 收藏。 */\n"
            "  private buildSearchList(tracks: OnlineTrack[]): HTMLDivElement {\n"
            "    const list = h('div', { class: 'track-list' });\n"
            "    if (tracks.length === 0) {\n"
            "      list.append(h('div', { class: 'wall-empty', text: '没有找到相关歌曲' }));\n"
            "      return list;\n"
            "    }\n"
            "    const current = playerState().track;\n"
            "    tracks.forEach((track, index) => {\n"
            "      const key = `${track.source}:${track.id}`;\n"
            "      const liked = this.searchLiked.get(key) === true;\n"
            "      const isCurrent = !!current && current.id === track.id && current.source === track.source;\n"
            "      const likeBtn = h('button', {\n"
            "        class: `track-like${liked ? ' is-liked' : ''}`,\n"
            "        title: liked ? '取消收藏' : '收藏到「我喜欢的音乐」',\n"
            "        'data-track-key': key,\n"
            "      });\n"
            "      likeBtn.append(icon(liked ? 'heartFill' : 'heart', 17));\n"
            "      if (track.source === 'local') {\n"
            "        likeBtn.disabled = true;\n"
            "        likeBtn.title = '本地歌曲暂不支持收藏';\n"
            "        likeBtn.classList.add('is-disabled');\n"
            "      } else {\n"
            "        likeBtn.addEventListener('click', (event) => {\n"
            "          event.stopPropagation();\n"
            "          void this.toggleSearchLiked(track, likeBtn);\n"
            "        });\n"
            "      }\n"
            "      const row = h(\n"
            "        'div',\n"
            "        {\n"
            "          class: `track-row${isCurrent ? ' is-current' : ''}`,\n"
            "          title: `${track.title} — ${track.artist}`,\n"
            "          'data-track-key': key,\n"
            "        },\n"
            "        h('div', { class: 'track-index', text: String(index + 1).padStart(2, '0') }),\n"
            "        h('div', { class: 'track-cover' }, h('img', { src: onlineArtwork(track), loading: 'lazy' })),\n"
            "        h(\n"
            "          'div',\n"
            "          { class: 'track-body' },\n"
            "          h(\n"
            "            'div',\n"
            "            { class: 'track-title-line' },\n"
            "            h('span', { class: 'track-title', text: track.title }),\n"
            "            track.vip === true ? h('span', { class: 'track-vip', text: 'VIP' }) : null,\n"
            "            track.vip !== true && track.playable === false\n"
            "              ? h('span', { class: 'track-vip is-muted', text: '暂不可播' })\n"
            "              : null,\n"
            "          ),\n"
            "          h('div', { class: 'track-artist', text: track.artist || '未知歌手' }),\n"
            "        ),\n"
            "        this.sourceTag(track.source),\n"
            "        h('div', { class: 'track-dur', text: fmtTime(track.durationMs) }),\n"
            "        likeBtn,\n"
            "      );\n"
            "      row.addEventListener('click', () => playQueue(tracks, index, true));\n"
            "      list.append(row);\n"
            "    });\n"
            "    return list;\n"
            "  }\n"
            "\n"
            "  /** 收藏 / 取消收藏（乐观更新，失败回滚）。 */\n"
            "  private async toggleSearchLiked(track: OnlineTrack, button: HTMLButtonElement): Promise<void> {\n"
            "    const key = `${track.source}:${track.id}`;\n"
            "    if (this.searchLikeBusy.has(key)) return;\n"
            "    const wasLiked = this.searchLiked.get(key) === true;\n"
            "    const next = !wasLiked;\n"
            "    this.searchLikeBusy.add(key);\n"
            "    this.applyLikeVisual(track, next, button);\n"
            "    try {\n"
            "      if (next) await addLikedTrack(track.source, track.id);\n"
            "      else await removeLikedTrack(track.source, track.id);\n"
            "      this.searchLiked.set(key, next);\n"
            "      this.likedCache.clear();\n"
            "      toast(next ? '已收藏到「我喜欢的音乐」' : '已取消收藏');\n"
            "    } catch (err) {\n"
            "      console.warn('[app] toggle like failed', err);\n"
            "      this.applyLikeVisual(track, wasLiked, button);\n"
            "      toast(err instanceof Error ? err.message : '收藏状态更新失败', 'error');\n"
            "    } finally {\n"
            "      this.searchLikeBusy.delete(key);\n"
            "    }\n"
            "  }\n"
            "\n"
            "  private applyLikeVisual(track: OnlineTrack, liked: boolean, button: HTMLButtonElement): void {\n"
            "    const key = `${track.source}:${track.id}`;\n"
            "    this.searchLiked.set(key, liked);\n"
            "    button.classList.toggle('is-liked', liked);\n"
            "    button.title = liked ? '取消收藏' : '收藏到「我喜欢的音乐」';\n"
            "    button.textContent = '';\n"
            "    button.append(icon(liked ? 'heartFill' : 'heart', 17));\n"
            "  }\n"
            "\n"
            "  /** 收藏状态到位后刷新已渲染的收藏按钮。 */\n"
            "  private syncSearchLiked(): void {\n"
            "    this.wallHost.querySelectorAll<HTMLButtonElement>('.track-like').forEach((button) => {\n"
            "      const key = button.dataset.trackKey ?? '';\n"
            "      const liked = this.searchLiked.get(key) === true;\n"
            "      button.classList.toggle('is-liked', liked);\n"
            "      button.title = liked ? '取消收藏' : '收藏到「我喜欢的音乐」';\n"
            "      button.textContent = '';\n"
            "      button.append(icon(liked ? 'heartFill' : 'heart', 17));\n"
            "    });\n"
            "  }",
        ),
    ],
)

apply(
    APP,
    "app.ts renderWall 搜索列表分支",
    [
        (
            "    this.wallHost.append(head);\n\n    if (tracks.length === 0) {",
            "    this.wallHost.append(head);\n"
            "\n"
            "    // 搜索结果：一行一首（封面/歌名/作者/VIP/平台/收藏），不再用大海报网格。\n"
            "    if (this.wall.kind === 'search') {\n"
            "      this.wallHost.append(this.buildSearchList(tracks));\n"
            "      return;\n"
            "    }\n"
            "\n"
            "    if (tracks.length === 0) {",
        ),
    ],
)

apply(
    APP,
    "app.ts syncPlayer 搜索行高亮 + 收藏同步",
    [
        (
            "    // 墙面高亮当前曲\n"
            "    const posters = this.wallHost.querySelectorAll('.poster');\n"
            "    posters.forEach((poster, index) => {\n"
            "      const item = this.wall.tracks[index];\n"
            "      poster.classList.toggle('is-playing', !!item && item.id === track.id);\n"
            "    });",
            "    // 墙面高亮当前曲\n"
            "    const posters = this.wallHost.querySelectorAll('.poster');\n"
            "    posters.forEach((poster, index) => {\n"
            "      const item = this.wall.tracks[index];\n"
            "      poster.classList.toggle('is-playing', !!item && item.id === track.id);\n"
            "    });\n"
            "    // 搜索结果行：高亮当前曲 + 同步收藏状态（切歌/收藏后即时刷新）\n"
            "    const rows = this.wallHost.querySelectorAll('.track-row');\n"
            "    rows.forEach((row, index) => {\n"
            "      const item = this.wall.tracks[index];\n"
            "      const same = !!item && item.id === track.id && item.source === track.source;\n"
            "      row.classList.toggle('is-current', same);\n"
            "      if (!same || !item) return;\n"
            "      this.searchLiked.set(`${item.source}:${item.id}`, state.liked);\n"
            "      const button = row.querySelector<HTMLButtonElement>('.track-like');\n"
            "      if (button) this.applyLikeVisual(item, state.liked, button);\n"
            "    });",
        ),
    ],
)

SEARCH_LIST_CSS = """
/* ------------------------------ 搜索结果列表（一行一首） ------------------------------ */
.track-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-bottom: 8px;
}

.track-row {
  display: grid;
  grid-template-columns: 34px 48px minmax(0, 1fr) auto auto 38px;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 13px;
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  transition: background 0.16s ease, border-color 0.16s ease;
}

.track-row:hover {
  background: var(--surface-hover);
  border-color: var(--line);
}

.track-row.is-current {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  border-color: color-mix(in srgb, var(--accent) 34%, transparent);
}

.track-index {
  color: var(--muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.track-row.is-current .track-index {
  color: var(--accent);
}

.track-cover {
  width: 48px;
  height: 48px;
  border-radius: 9px;
  overflow: hidden;
  background: var(--surface);
  flex: none;
}

.track-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.track-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.track-title-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.track-title {
  color: var(--text);
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.track-row.is-current .track-title {
  color: var(--accent);
}

.track-vip {
  flex: none;
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: 5px;
  border: 1px solid color-mix(in srgb, #e8b25a 48%, transparent);
  background: color-mix(in srgb, #e8b25a 14%, transparent);
  color: #e8b25a;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.track-vip.is-muted {
  border-color: var(--line-strong);
  background: transparent;
  color: var(--muted);
  letter-spacing: 0.02em;
}

.track-artist {
  color: var(--muted);
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.track-dur {
  color: var(--muted);
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  min-width: 40px;
  text-align: right;
}

.track-like {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: color 0.16s ease, background 0.16s ease, border-color 0.16s ease, transform 0.16s ease;
}

.track-like:hover {
  color: var(--accent);
  background: var(--surface-hover);
  border-color: var(--line);
}

.track-like:active {
  transform: scale(0.92);
}

.track-like.is-liked {
  color: var(--accent);
}

.track-like.is-disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
"""


def append_css():
    text = load(CSS)
    assert '.track-list' not in text, "CSS 已追加过"
    save(CSS, text + ("\r\n" if "\r\n" in text else "\n") + SEARCH_LIST_CSS)
    print("app.css OK")


append_css()
