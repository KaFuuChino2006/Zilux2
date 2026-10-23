# -*- coding: utf-8 -*-
"""1) 修复浅色主题下逐词高亮变白看不见（旧规则写死 #fff / #ffe6b0）；
2) 我喜欢的音乐卡片改用干净的 grid 布局，去掉造成错位的 margin-left 叠加。"""
import io

CSS = r'E:\Zilux2开发\web\src\styles\app.css'
css = io.open(CSS, 'r', encoding='utf-8', newline='').read()
eol = '\r\n' if '\r\n' in css else '\n'
print('eol', repr(eol))

block = """
/* ==================== 逐词高亮：用主题令牌（浅色下不再变白隐身） ==================== */
.lyric-line.is-active {
  color: var(--text);
  text-shadow: none;
}
.lyric-line.is-active .lyric-char {
  color: rgb(var(--overlay-rgb) / 0.4);
}
.lyric-line.is-active .lyric-char.is-sung {
  color: var(--text);
  text-shadow: 0 0 20px color-mix(in srgb, var(--accent) 26%, transparent);
}
.lyric-line.is-active .lyric-char.is-hot {
  color: var(--accent-strong);
  text-shadow:
    0 0 14px color-mix(in srgb, var(--accent) 72%, transparent),
    0 0 40px color-mix(in srgb, var(--accent) 38%, transparent);
}

/* ==================== 我喜欢的音乐卡片：固定 grid，杜绝 margin 叠加错位 ==================== */
.home-split > .liked-card {
  display: grid;
  grid-template-columns: 112px minmax(0, 1fr);
  align-items: center;
  gap: 20px;
  box-sizing: border-box;
  width: 100%;
  max-width: 352px;
  height: 156px;
  margin: 0;
  padding: 16px 18px;
  border-radius: var(--radius-l);
  background: var(--surface-strong);
  box-shadow: var(--shadow-1);
  overflow: hidden;
}
.home-split > .liked-card .liked-deck {
  position: relative;
  width: 112px;
  height: 112px;
  margin: 0;
}
.home-split > .liked-card .liked-body {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
  min-width: 0;
  margin: 0;
  padding: 0;
}
.home-split > .liked-card .liked-kicker {
  margin: 0;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.14em;
  line-height: 1.2;
  color: var(--accent);
}
.home-split > .liked-card .liked-title {
  max-width: 100%;
  margin: 0;
  font-size: 19px;
  font-weight: 700;
  line-height: 1.25;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.home-split > .liked-card .liked-meta {
  margin: 0;
  font-size: 12px;
  line-height: 1.3;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
""".replace('\n', eol)

marker = '逐词高亮：用主题令牌'
if marker in css:
    # 移除上一次追加的同名块，再重新追加
    start = css.index('/* ==================== ' + marker)
    css = css[:start]
    print('replaced old block')
css += block
io.open(CSS, 'w', encoding='utf-8', newline='').write(css)
print('done, css length', len(css))
