# -*- coding: utf-8 -*-
"""快捷设置「封面」页新增「背景：关闭 / 随歌曲封面」选项。"""
import io

APP = r'E:\Zilux2开发\web\src\ui\app.ts'
CSS = r'E:\Zilux2开发\web\src\styles\app.css'


def load(path):
    text = io.open(path, 'r', encoding='utf-8', newline='').read()
    eol = '\r\n' if '\r\n' in text else '\n'
    return text, eol


def save(path, text):
    io.open(path, 'w', encoding='utf-8', newline='').write(text)


def nl(text, eol):
    return text.replace('\n', eol)


text, eol = load(APP)


def rep(old, new, label, count=1):
    global text
    o = nl(old, eol)
    x = nl(new, eol)
    found = text.count(o)
    assert found == count, '%s count=%d' % (label, found)
    text = text.replace(o, x)


# 1) 文件级常量与读取函数（放在 import 之后、export class App 之前）
rep(
    "export class App {",
    """const APP_BG_KEY = 'zilux2.appCoverBg';

/** 是否用当前歌曲封面做整个界面的模糊背景（默认开启）。 */
function readAppBgOn(): boolean {
  try {
    return localStorage.getItem(APP_BG_KEY) !== '0';
  } catch {
    return true;
  }
}

export class App {""",
    'helper',
)

# 2) 字段
rep(
    "  private lastQualityKey = '';",
    "  private lastQualityKey = '';\n  private appBgOn = readAppBgOn();\n  private appBgEl!: HTMLDivElement;",
    'fields',
)

# 3) 构造函数里建背景层（root 之后）
rep(
    "    this.root = h('div', { class: 'app' });",
    "    this.root = h('div', { class: 'app' });\n    this.appBgEl = h('div', { class: 'app-bg' });\n    this.root.append(this.appBgEl);",
    'cstr',
)

# 4) 无曲目时清掉背景层
rep(
    """    if (!track) {
      this.playerbar.classList.remove('is-hidden');""",
    """    if (!track) {
      this.root.classList.remove('is-app-bg');
      this.playerbar.classList.remove('is-hidden');""",
    'idle',
)

# 5) 换歌时更新背景
rep(
    "      this.pbCover.src = onlineArtwork(track);\n      if (!track.cover) {",
    "      this.pbCover.src = onlineArtwork(track);\n      this.paintAppBg(track);\n      if (!track.cover) {",
    'syncbg',
)

# 6) 新方法（放在 syncQuickBody 之前）
rep(
    "  private syncQuickBody(): void {",
    """  private paintAppBg(track: OnlineTrack | null): void {
    if (!track) {
      this.root.classList.remove('is-app-bg');
      return;
    }
    this.appBgEl.style.backgroundImage = `url("${onlineArtwork(track)}")`;
    this.root.classList.toggle('is-app-bg', this.appBgOn);
  }

  private setAppBg(on: boolean): void {
    this.appBgOn = on;
    try {
      localStorage.setItem(APP_BG_KEY, on ? '1' : '0');
    } catch {
      /* 忽略隐私模式写入失败 */
    }
    this.paintAppBg(playerState().track);
  }

  private syncQuickBody(): void {""",
    'methods',
)

# 7) 「封面」页底部加「背景」分段
rep(
    """      );
      return;
    }
    if (this.quickTab === 'lyrics') {""",
    """      );
      const bgThumb = h('div', { class: 'quick-seg-thumb' });
      const bgBtns: HTMLButtonElement[] = [];
      const paintBg = (): void => {
        const index = this.appBgOn ? 1 : 0;
        const button = bgBtns[index];
        if (!button) return;
        bgThumb.style.width = `${button.offsetWidth}px`;
        bgThumb.style.transform = `translateX(${button.offsetLeft}px)`;
        bgBtns.forEach((item, i) => item.classList.toggle('is-on', i === index));
      };
      const bgBtn = (label: string, on: boolean): HTMLButtonElement => {
        const button = h('button', { class: 'quick-seg-btn', type: 'button', text: label });
        button.addEventListener('click', () => {
          this.setAppBg(on);
          paintBg();
        });
        bgBtns.push(button);
        return button;
      };
      const bgSeg = h(
        'div',
        { class: 'quick-seg-slider' },
        bgThumb,
        bgBtn('关闭', false),
        bgBtn('随歌曲封面', true),
      );
      body.append(
        h(
          'div',
          { class: 'quick-cell is-wide' },
          h('div', { class: 'quick-cell-title', text: '背景' }),
          bgSeg,
        ),
      );
      window.requestAnimationFrame(paintBg);
      return;
    }
    if (this.quickTab === 'lyrics') {""",
    'bgui',
)

save(APP, text)

css, ceol = load(CSS)
add = """
/* 快捷设置「封面」页：随歌曲封面做整屏模糊背景 */
.app-bg {
  position: absolute;
  inset: 0;
  z-index: 0;
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  filter: blur(64px) saturate(1.4);
  transform: scale(1.15);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.7s var(--ease);
}
.app-bg::after {
  content: '';
  position: absolute;
  inset: 0;
  background: rgb(var(--overlay-rgb) / 0.38);
}
.app.is-app-bg .app-bg {
  opacity: 0.6;
}
.app > .main {
  position: relative;
  z-index: 1;
}
""".replace('\n', ceol)
save(CSS, css + add)
print('ok')
