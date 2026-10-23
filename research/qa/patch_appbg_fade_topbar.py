# -*- coding: utf-8 -*-
"""1) 背景随封面改为双层交叉淡入淡出；2) 去掉顶栏那条色带。"""
import io

APP = r'E:\Zilux2开发\web\src\ui\app.ts'
CSS = r'E:\Zilux2开发\web\src\styles\app.css'


def load(path):
    text = io.open(path, 'r', encoding='utf-8', newline='').read()
    return text, ('\r\n' if '\r\n' in text else '\n')


def save(path, text):
    io.open(path, 'w', encoding='utf-8', newline='').write(text)


text, eol = load(APP)


def rep(old, new, label):
    global text
    o, x = old.replace('\n', eol), new.replace('\n', eol)
    count = text.count(o)
    assert count == 1, '%s count=%d' % (label, count)
    text = text.replace(o, x)


# 1) 字段：双层背景
rep(
    "  private appBgOn = readAppBgOn();\n  private appBgEl!: HTMLDivElement;",
    "  private appBgOn = readAppBgOn();\n  private appBgEl!: HTMLDivElement;\n  private appBgLayers: HTMLDivElement[] = [];\n  private appBgLayer = 0;\n  private appBgKey = '';",
    'fields',
)

# 2) 构造函数：两层
rep(
    "    this.appBgEl = h('div', { class: 'app-bg' });\n    this.root.append(this.appBgEl);",
    "    this.appBgEl = h('div', { class: 'app-bg' });\n    this.appBgLayers = [\n      h('div', { class: 'app-bg-layer' }),\n      h('div', { class: 'app-bg-layer' }),\n    ];\n    this.appBgEl.append(...this.appBgLayers);\n    this.root.append(this.appBgEl);",
    'cstr',
)

# 3) paintAppBg：交叉淡入淡出
rep(
    """  private paintAppBg(track: OnlineTrack | null): void {
    if (!track) {
      this.root.classList.remove('is-app-bg');
      return;
    }
    this.appBgEl.style.backgroundImage = `url("${onlineArtwork(track)}")`;
    this.root.classList.toggle('is-app-bg', this.appBgOn);
  }""",
    """  private paintAppBg(track: OnlineTrack | null): void {
    if (!track) {
      this.root.classList.remove('is-app-bg');
      return;
    }
    const bgKey = `${track.source}:${track.id}:${track.cover ?? ''}`;
    if (bgKey !== this.appBgKey) {
      // 双层交替：新图先铺到隐藏层，再交叉淡入淡出，避免切歌时背景硬切
      const next = this.appBgLayers[1 - this.appBgLayer];
      const prev = this.appBgLayers[this.appBgLayer];
      next.style.backgroundImage = `url("${onlineArtwork(track)}")`;
      next.classList.add('is-on');
      prev.classList.remove('is-on');
      this.appBgLayer = 1 - this.appBgLayer;
      this.appBgKey = bgKey;
    }
    this.root.classList.toggle('is-app-bg', this.appBgOn);
  }""",
    'paint',
)

# 4) 线上补到封面后，背景也跟着换一次
rep(
    """          this.pbCover.src = onlineArtwork(track);
          if (this.upnextCover && this.upnextTitle && this.upnextTitle.textContent) {""",
    """          this.pbCover.src = onlineArtwork(track);
          if (this.appBgOn) this.paintAppBg(track);
          if (this.upnextCover && this.upnextTitle && this.upnextTitle.textContent) {""",
    'coverlater',
)

save(APP, text)

css, ceol = load(CSS)
css += """
/* 背景随歌曲：双层交叉淡入淡出 */
.app-bg {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.7s var(--ease);
  filter: none;
  transform: none;
  background-image: none !important;
}
.app-bg-layer {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  filter: blur(64px) saturate(1.4);
  transform: scale(1.15);
  opacity: 0;
  transition: opacity 0.8s var(--ease);
}
.app-bg-layer.is-on {
  opacity: 1;
}
.app.is-app-bg .app-bg {
  opacity: 0.6;
}

/* 顶栏去掉那条独立的色带：透明，让背景/底色一路通到窗口顶部 */
.topbar {
  background: transparent;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  border-bottom: 0;
}
""".replace('\n', ceol)
save(CSS, css + css and '')
print('ok')
