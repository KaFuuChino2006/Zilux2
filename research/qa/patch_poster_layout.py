# -*- coding: utf-8 -*-
"""封面显示方式切换：网格卡片 / 横条列表（与搜索结果同款列表）。

- app.ts：墙面统一加「网格 / 横条」切换；横条模式复用 buildSearchList。
- home.ts：热门歌单加同一组切换，列表模式按横条行渲染。
- 新建 ui/posterLayout.ts 作为共享偏好（localStorage key zilux2.posterLayout）。
"""
import io

BASE = r'E:\Zilux2开发'
APP = BASE + r'\web\src\ui\app.ts'
HOME = BASE + r'\web\src\ui\home.ts'
CSS = BASE + r'\web\src\styles\app.css'
LAYOUT = BASE + r'\web\src\ui\posterLayout.ts'

# ---------------------------------------------------------------- 共享偏好模块
io.open(LAYOUT, 'w', encoding='utf-8', newline='').write(
    """/**
 * 封面显示方式偏好：网格卡片 / 横条列表。
 *
 * 墙面（收藏/最近/歌单/本地）与首页热门歌单共用这一份设置，
 * 存 localStorage，重启后保持。
 */

export type PosterLayout = 'grid' | 'list';

const KEY = 'zilux2.posterLayout';

export function readPosterLayout(): PosterLayout {
  try {
    return localStorage.getItem(KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

export function writePosterLayout(layout: PosterLayout): void {
  try {
    localStorage.setItem(KEY, layout);
  } catch {
    /* 隐私模式下写不进去就算了 */
  }
}
""".replace('\n', '\r\n'))
print('ok: posterLayout.ts')


def load(path):
    text = io.open(path, 'r', encoding='utf-8', newline='').read()
    return text, ('\r\n' if '\r\n' in text else '\n')


def save(path, text):
    io.open(path, 'w', encoding='utf-8', newline='').write(text)


# ---------------------------------------------------------------- app.ts
text, eol = load(APP)


def rep(old, new, label):
    global text
    old = old.replace('\n', eol)
    new = new.replace('\n', eol)
    assert text.count(old) == 1, 'miss: ' + label
    text = text.replace(old, new)
    print('ok:', label)


rep("import { HomeView } from './home';",
    "import { HomeView } from './home';\nimport { readPosterLayout, writePosterLayout, type PosterLayout } from './posterLayout';",
    'import')

rep("  /** 我喜欢的音乐显示模式：融合（多平台）或单个平台 */\n  private likedMode: 'all' | OnlineSource = 'all';",
    "  /** 我喜欢的音乐显示模式：融合（多平台）或单个平台 */\n  private likedMode: 'all' | OnlineSource = 'all';\n  /** 封面显示方式：网格卡片 / 横条列表（与首页热门歌单共用偏好） */\n  private wallLayout: PosterLayout = readPosterLayout();",
    'field')

rep("    const { title, subtitle, tracks } = this.wall;\n    const actions: HTMLElement[] = [];",
    """    const { title, subtitle, tracks } = this.wall;
    const actions: HTMLElement[] = [];
    if (this.wall.kind !== 'search' && tracks.length > 0) {
      const seg = h('div', { class: 'seg seg-sm layout-modes' });
      ([['grid', '网格'], ['list', '横条']] as Array<[PosterLayout, string]>).forEach(([id, label]) => {
        const btn = h('button', {
          class: `seg-btn${this.wallLayout === id ? ' is-on' : ''}`,
          text: label,
          title: id === 'grid' ? '封面网格' : '横条列表（同搜索结果）',
        });
        btn.addEventListener('click', () => {
          if (this.wallLayout === id) return;
          this.wallLayout = id;
          writePosterLayout(id);
          this.renderWall();
        });
        seg.append(btn);
      });
      actions.push(seg);
    }""",
    'layout seg')

rep("      this.wallHost.append(h('div', { class: 'wall-empty', text: hint }));\n      return;\n    }\n\n    const grid = h('div', { class: 'wall-grid' });",
    """      this.wallHost.append(h('div', { class: 'wall-empty', text: hint }));
      return;
    }

    if (this.wallLayout === 'list') {
      this.wallHost.append(this.buildSearchList(tracks));
      return;
    }

    const grid = h('div', { class: 'wall-grid' });""",
    'list branch')

save(APP, text)
print('app.ts written')

# ---------------------------------------------------------------- home.ts
text, eol = load(HOME)


def rep2(old, new, label):
    global text
    old = old.replace('\n', eol)
    new = new.replace('\n', eol)
    assert text.count(old) == 1, 'miss: ' + label
    text = text.replace(old, new)
    print('ok:', label)


rep2("import { ui } from './theme';",
     "import { readPosterLayout, writePosterLayout, type PosterLayout } from './posterLayout';\nimport { ui } from './theme';",
     'home import')

rep2("  private readonly playerDispose: () => void;",
     "  private layout: PosterLayout = readPosterLayout();\n  private lastData: HomeData | null = null;\n  private readonly playerDispose: () => void;",
     'home fields')

rep2("  update(data: HomeData): void {\n    this.dailyTracks = data.daily;",
     "  update(data: HomeData): void {\n    this.lastData = data;\n    this.layout = readPosterLayout();\n    this.dailyTracks = data.daily;",
     'home update')

rep2("""    const section = h('section', { class: ui.section() });
    const head = h(
      'div',
      { class: ui.sectionHead() },
      h('h2', { class: ui.sectionTitle(), text: '热门歌单' }),
      h('button', { class: ui.sectionMore() }, h('span', { text: '全部歌单' })),
    );
    const more = head.querySelector('button');
    more?.addEventListener('click', () => this.callbacks.onRecommend());
""",
     """    const section = h('section', { class: ui.section() });
    const layoutSeg = h('div', { class: 'seg seg-sm layout-modes' });
    ([['grid', '卡片'], ['list', '横条']] as Array<[PosterLayout, string]>).forEach(([id, label]) => {
      const btn = h('button', {
        class: `seg-btn${this.layout === id ? ' is-on' : ''}`,
        text: label,
        title: id === 'grid' ? '封面卡片' : '横条列表',
      });
      btn.addEventListener('click', () => {
        if (this.layout === id) return;
        this.layout = id;
        writePosterLayout(id);
        if (this.lastData) this.update(this.lastData);
      });
      layoutSeg.append(btn);
    });
    const more = h('button', { class: ui.sectionMore() }, h('span', { text: '全部歌单' }));
    more.addEventListener('click', () => this.callbacks.onRecommend());
    const head = h(
      'div',
      { class: ui.sectionHead() },
      h('h2', { class: ui.sectionTitle(), text: '热门歌单' }),
      h('div', { class: 'section-tools' }, layoutSeg, more),
    );

    if (this.layout === 'list') {
      const list = h('div', { class: 'pl-list' });
      data.playlists.forEach((item) => {
        const cover =
          item.cover ??
          onlineArtwork({ id: item.id, title: item.title, artist: item.creator ?? '', album: '', cover: '' });
        const row = h(
          'button',
          { class: 'pl-row', title: item.title },
          h('span', { class: 'pl-cover' }, h('img', { src: cover, loading: 'lazy', alt: '' })),
          h(
            'span',
            { class: 'pl-body' },
            h('span', { class: 'pl-name', text: item.title }),
            h('span', { class: 'pl-meta', text: `${SOURCE_LABEL[item.source] ?? ''} · ${formatPlays(item.count)}` }),
          ),
        );
        row.addEventListener('click', () => this.callbacks.onPlaylist(item));
        list.append(row);
      });
      section.append(head, list);
      return section;
    }
""",
     'home playlist head+list')

save(HOME, text)
print('home.ts written')

# ---------------------------------------------------------------- CSS
css, ceol = load(CSS)
block = """
/* 封面显示方式切换（网格 / 横条） */
.section-tools {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}
.layout-modes {
  flex: none;
}
.pl-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 12px;
}
.pl-row {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 8px 12px;
  border-radius: var(--radius-m);
  background: var(--surface);
  border: 1px solid transparent;
  text-align: left;
  transition: background .18s var(--ease), border-color .18s var(--ease), transform .18s var(--ease);
}
.pl-row:hover {
  background: var(--surface-hover);
  border-color: var(--line);
  transform: translateY(-1px);
}
.pl-cover {
  flex: none;
  width: 46px;
  height: 46px;
  border-radius: 10px;
  overflow: hidden;
  background: var(--surface-hover);
}
.pl-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.pl-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.pl-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pl-meta {
  font-size: 12px;
  color: var(--muted);
}
""".replace('\n', ceol)
start = css.find('/* 封面显示方式切换（网格 / 横条） */')
if start >= 0:
    css = css[:start]
css += block
io.open(CSS, 'w', encoding='utf-8', newline='').write(css)
print('css written')
