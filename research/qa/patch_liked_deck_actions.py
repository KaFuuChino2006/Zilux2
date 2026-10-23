# -*- coding: utf-8 -*-
"""我喜欢的音乐卡片：去掉「播放全部 / 查看全部」，改成封面右下角常驻播放角标；
同时修 .home-split 错位（flex -> grid）、限制白条长度；统一搜索药丸与播放条的展开动画令牌。"""
import io

BASE = r'E:\Zilux2开发\web\src'
HOME = BASE + r'\ui\home.ts'
CSS = BASE + r'\styles\app.css'
THEME = BASE + r'\ui\theme.ts'


def read(path):
    return io.open(path, 'r', encoding='utf-8', newline='').read()


def write(path, text):
    io.open(path, 'w', encoding='utf-8', newline='').write(text)


def nl(text):
    return '\r\n' if '\r\n' in text else '\n'


# ---------------------------------------------------------------------------
# 1) home.ts：去掉 daily-actions
# ---------------------------------------------------------------------------
home = read(HOME)
eol = nl(home)
old_actions = (
    "        h(\n"
    "          'div',\n"
    "          { class: 'daily-actions' },\n"
    "          (() => {\n"
    "            const btn = h('button', { class: 'btn is-primary' }, icon('play', 16), h('span', { text: '播放全部' }));\n"
    "            btn.addEventListener('click', () => this.callbacks.onPlay(data.liked, 0));\n"
    "            return btn;\n"
    "          })(),\n"
    "          (() => {\n"
    "            const btn = h('button', { class: 'btn' }, h('span', { text: '查看全部' }));\n"
    "            btn.addEventListener('click', () => this.callbacks.onLiked());\n"
    "            return btn;\n"
    "          })(),\n"
    "        ),\n"
).replace('\n', eol)
if old_actions in home:
    home = home.replace(old_actions, '')
    print('home.ts: removed daily-actions')
else:
    print('home.ts: daily-actions block NOT found (check)')
write(HOME, home)

# ---------------------------------------------------------------------------
# 2) theme.ts：动画节奏令牌（以后所有动效统一引用）
# ---------------------------------------------------------------------------
theme = read(THEME)
if "'--dur-pop'" not in theme:
    teol = nl(theme)
    anchor = "  '--dur-slow': '420ms',\n};".replace('\n', teol)
    addition = (
        "  '--dur-slow': '420ms',\n"
        "  /* 统一展开/收起动效：搜索药丸、播放条、面板弹出都引用这一组 */\n"
        "  '--dur-pop': '600ms',\n"
        "  '--ease-pop': 'cubic-bezier(0.22, 1.28, 0.36, 1)',\n"
        "};"
    ).replace('\n', teol)
    assert theme.count(anchor) == 1, 'theme token anchor'
    theme = theme.replace(anchor, addition)
    write(THEME, theme)
    print('theme.ts: motion tokens added')
else:
    print('theme.ts: tokens already present')

# ---------------------------------------------------------------------------
# 3) app.css：布局修 + 白条限宽 + 动画统一
# ---------------------------------------------------------------------------
css = read(CSS)
css_eol = nl(css)
append = """
/* ==================== 我喜欢的音乐：去掉按钮，封面右下角常驻播放角标 ==================== */
.home-split {
  display: grid;
  grid-template-columns: min(352px, 40vw) minmax(0, 1fr);
  align-items: start;
  gap: 18px;
}
.home-split > .liked-deck {
  width: 100%;
  max-width: 660px;
  min-height: 168px;
  overflow: hidden;
}
.home-split > .liked-deck .daily-body {
  flex: 1 1 auto;
}
.home-split > .liked-deck .daily-actions {
  display: none;
}
.home-split > .liked-deck .daily-play {
  left: auto;
  right: 12px;
  width: 34px;
  height: 34px;
  opacity: 1;
  transform: none;
  border-color: rgb(255 255 255 / 30%);
  background: rgb(12 13 16 / 58%);
}
.home-split > .liked-deck .daily-play:hover {
  background: var(--accent);
  color: var(--accent-contrast);
}

/* ==================== 全局动画节奏：搜索药丸 / 播放条共用同一组令牌 ==================== */
.search-dock {
  transition:
    width var(--dur-pop) var(--ease-pop),
    background var(--dur-mid) ease,
    border-color var(--dur-mid) ease,
    box-shadow var(--dur-mid) ease;
}
.playerbar {
  transition:
    width var(--dur-pop) var(--ease-pop),
    border-radius var(--dur-pop) var(--ease),
    background var(--dur-mid) var(--ease),
    transform var(--dur-mid) var(--ease),
    opacity var(--dur-mid) var(--ease);
}
.playerbar .pb-cover {
  transition:
    max-width var(--dur-pop) var(--ease-pop),
    opacity var(--dur-mid) var(--ease),
    margin-right var(--dur-pop) var(--ease);
}
""".replace('\n', css_eol)
if '我喜欢的音乐：去掉按钮' not in css:
    css = css + append
    write(CSS, css)
    print('app.css: appended')
else:
    print('app.css: already appended')

print('done')
