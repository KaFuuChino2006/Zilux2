# -*- coding: utf-8 -*-
"""把「我喜欢的音乐」叠放卡片改成独立组件（不复用 .daily-card 规则），修白框/错位。"""
import io

HOME = r'E:\Zilux2开发\web\src\ui\home.ts'
CSS = r'E:\Zilux2开发\web\src\styles\app.css'

text = io.open(HOME, 'r', encoding='utf-8', newline='').read()
eol = '\r\n' if '\r\n' in text else '\n'


def rep(old, new, label):
    global text
    old = old.replace('\n', eol)
    new = new.replace('\n', eol)
    assert text.count(old) == 1, 'anchor miss: ' + label
    text = text.replace(old, new)
    print('ok:', label)


rep("    const deck = h('div', { class: 'daily-deck' });\n    this.likedDeckEl = deck;",
    "    const deck = h('div', { class: 'liked-deck' });\n    this.likedDeckEl = deck;",
    'deck class')

rep("""    const card = h(
      'div',
      { class: 'daily-card liked-deck' },
      deck,
      h(
        'div',
        { class: 'daily-body' },
        h('div', { class: 'daily-kicker', text: '我喜欢的音乐' }),
        h('div', { class: 'daily-title', text: '我的红心收藏' }),
        h('div', { class: 'daily-meta', text: `共 ${data.likedCount} 首 · 自动同步` }),
      ),
    );
    return card;""",
    """    const card = h(
      'div',
      { class: 'liked-card' },
      deck,
      h(
        'div',
        { class: 'liked-body' },
        h('div', { class: 'liked-kicker', text: '我喜欢的音乐' }),
        h('div', { class: 'liked-title', text: '我的红心收藏' }),
        h('div', { class: 'liked-meta', text: `共 ${data.likedCount} 首 · 自动同步` }),
      ),
    );
    return card;""",
    'card markup')

io.open(HOME, 'w', encoding='utf-8', newline='').write(text)

css = io.open(CSS, 'r', encoding='utf-8', newline='').read()
ceol = '\r\n' if '\r\n' in css else '\n'
block = """
/* ==================== 我喜欢的音乐（独立叠放卡片，不复用 daily-card） ==================== */
.home-split {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 352px));
  align-items: start;
  gap: 18px;
}
.home-split > .ui-section {
  min-width: 0;
}
.liked-card {
  display: flex;
  align-items: center;
  gap: 24px;
  box-sizing: border-box;
  width: 100%;
  max-width: 352px;
  height: 156px;
  padding: 18px 22px;
  border-radius: var(--radius-l);
  background: var(--surface-strong);
  box-shadow: var(--shadow-1);
  overflow: hidden;
}
.liked-deck {
  position: relative;
  flex: none;
  width: 104px;
  height: 104px;
  margin-left: 6px;
}
.liked-deck .daily-cover {
  position: absolute;
  inset: 0;
  border-radius: 10px;
  transform-origin: 0% 100%;
  overflow: hidden;
  box-shadow: 0 10px 22px rgba(20, 18, 14, 0.18);
  background: var(--surface-hover);
}
.liked-deck .daily-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.liked-deck .daily-cover.is-empty {
  display: grid;
  place-items: center;
  color: var(--muted);
}
.liked-deck .daily-cover-0 {
  transform: none;
  z-index: 5;
}
.liked-deck .daily-cover-1 {
  transform: translate3d(10px, -7px, 0) rotate(3deg) scale(0.955);
  z-index: 4;
}
.liked-deck .daily-cover-2 {
  transform: translate3d(19px, -13px, 0) rotate(6deg) scale(0.91);
  z-index: 3;
}
.liked-deck .daily-cover-3 {
  transform: translate3d(27px, -18px, 0) rotate(9deg) scale(0.87);
  z-index: 2;
}
.liked-deck .daily-cover-4 {
  transform: translate3d(34px, -22px, 0) rotate(12deg) scale(0.83);
  z-index: 1;
}
.liked-deck .daily-cover.is-ghost {
  z-index: 9;
  animation: daily-ghost-out 0.62s var(--ease) both;
}
.liked-deck .daily-play {
  position: absolute;
  right: 6px;
  bottom: 6px;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--accent);
  color: var(--accent-contrast);
  opacity: 1;
  transform: none;
  z-index: 6;
  cursor: pointer;
}
.liked-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  margin-left: 26px;
}
.liked-kicker {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: var(--accent);
}
.liked-title {
  font-size: 20px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.liked-meta {
  font-size: 12px;
  color: var(--muted);
}
""".replace('\n', ceol)
if '我喜欢的音乐（独立叠放卡片' not in css:
    css += block
    io.open(CSS, 'w', encoding='utf-8', newline='').write(css)
    print('css appended')
else:
    print('css already')

print('done')
