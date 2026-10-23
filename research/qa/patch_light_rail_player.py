import io
import re

theme_path = r'E:\Zilux2开发\web\src\ui\theme.ts'
css_path = r'E:\Zilux2开发\web\src\styles\app.css'


def load(p):
    with io.open(p, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def save(p, text):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


# ---------------- theme.ts：补齐旧组件用的令牌 ----------------
theme = load(theme_path)
if "--panel-solid" in theme and "#ffffff" in theme:
    print('theme legacy tokens already present')
else:
    theme = theme.replace(
        "    '--ink-rgb': '6 7 10',",
        "    '--panel': 'rgba(18, 19, 24, 0.72)',\n"
        "    '--panel-solid': '#121318',\n"
        "    '--panel-raised': 'rgba(30, 31, 38, 0.86)',\n"
        "    '--text-soft': '#c3c6ce',\n"
        "    '--shadow': '0 18px 48px rgba(0, 0, 0, 0.55)',\n"
        "    '--danger': '#ff6b6b',\n"
        "    '--ink-rgb': '6 7 10',",
    )
    theme = theme.replace(
        "    '--ink-rgb': '250 249 246',",
        "    '--panel': 'rgba(255, 255, 255, 0.74)',\n"
        "    '--panel-solid': '#ffffff',\n"
        "    '--panel-raised': 'rgba(255, 255, 255, 0.9)',\n"
        "    '--text-soft': '#4b5058',\n"
        "    '--shadow': '0 18px 44px rgba(60, 48, 28, 0.16)',\n"
        "    '--danger': '#d64545',\n"
        "    '--ink-rgb': '250 249 246',",
    )
    save(theme_path, theme)
    print('theme.ts legacy tokens added')

# ---------------- app.css：剩余写死深色值 → 令牌 ----------------
css = load(css_path)
if '.rail-btn.is-active { color: var(--accent); background: var(--accent-soft); }' in css:
    print('css already patched')
else:
    pairs = [
        ('background: rgba(22, 23, 29, 0.66);', 'background: var(--panel);'),
        ('background: rgba(16, 17, 22, 0.82);', 'background: var(--panel);'),
        ('background: rgba(18, 19, 24, 0.82);', 'background: var(--panel);'),
        ('background: rgba(24, 25, 31, 0.94);', 'background: var(--panel-solid);'),
        ('background: rgba(240, 226, 192, 0.94);', 'background: var(--accent-strong);'),
        ('background: linear-gradient(90deg, #f1e0b8, #cbaa72);', 'background: linear-gradient(90deg, var(--accent-strong), var(--accent));'),
        ('background: linear-gradient(135deg, #f2e2ba, #d3b57d);', 'background: linear-gradient(135deg, var(--accent-strong), var(--accent));'),
        ('box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);', 'box-shadow: var(--shadow-2);'),
    ]
    for old, new in pairs:
        assert old in css, 'missing: %s' % old
        css = css.replace(old, new)

    css = css.rstrip() + '''

/* ==================== 侧栏颜色 + 展开动画（浅色/深色都走令牌） ==================== */
.rail {
  background: var(--panel-solid);
  border-right: 1px solid var(--line);
  transition: width .3s var(--ease), box-shadow .3s var(--ease);
}
.rail:hover,
.rail:focus-within {
  width: 196px;
  background: var(--panel-solid);
  border-right-color: var(--line);
  box-shadow: var(--shadow);
}
.rail-btn {
  background: transparent;
  border-color: transparent;
  color: var(--muted);
  transition: background .18s var(--ease), color .18s var(--ease), border-color .18s var(--ease);
}
.rail-btn:hover {
  background: rgb(var(--overlay-rgb) / .07);
  color: var(--text);
  transform: none;
}
.rail-btn.is-active {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 38%, transparent);
}
.rail-label { transition: opacity .2s var(--ease); }

/* ==================== 播放进度 / 音量 / 主播放按钮颜色 ==================== */
.track-rail { background: rgb(var(--overlay-rgb) / .13); }
.track-fill { background: linear-gradient(90deg, var(--accent-strong), var(--accent)); }
.volume-rail { background: rgb(var(--overlay-rgb) / .14); }
.volume-fill { background: rgb(var(--overlay-rgb) / .5); }
.pb-btn.is-main { background: linear-gradient(135deg, var(--accent-strong), var(--accent)); color: var(--accent-contrast); }
'''
    save(css_path, css)
    print('app.css patched')
