import io
import re

css_path = r'E:\Zilux2开发\web\src\styles\app.css'
theme_path = r'E:\Zilux2开发\web\src\ui\theme.ts'
html_path = r'E:\Zilux2开发\web\index.html'


def load(path):
    with io.open(path, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def save(path, text):
    with io.open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


# ---------------- app.css：把写死的深色值换成主题令牌 ----------------
css = load(css_path)
lines = css.split('\n')
head = lines[:40]          # :root 令牌定义区保持原样
body = '\n'.join(lines[40:])

if '--ink-rgb' in css and 'var(--ink-rgb)' in body:
    print('css already tokenised')
else:
    rgba_map = [
        (r'rgba\(\s*6,\s*7,\s*10,\s*([0-9.]+)\s*\)', r'rgb(var(--ink-rgb) / \1)'),
        (r'rgba\(\s*4,\s*5,\s*8,\s*([0-9.]+)\s*\)', r'rgb(var(--ink-rgb) / \1)'),
        (r'rgba\(\s*255,\s*255,\s*255,\s*([0-9.]+)\s*\)', r'rgb(var(--overlay-rgb) / \1)'),
        (r'rgba\(\s*18,\s*19,\s*24,\s*0\.72\s*\)', r'var(--surface)'),
        (r'rgba\(\s*24,\s*25,\s*31,\s*0\.78\s*\)', r'var(--surface-strong)'),
        (r'rgba\(\s*34,\s*36,\s*45,\s*0\.92\s*\)', r'var(--surface-hover)'),
        (r'rgba\(\s*36,\s*37,\s*45,\s*0\.9\s*\)', r'var(--surface-strong)'),
        (r'rgba\(\s*34,\s*35,\s*43,\s*0\.9\s*\)', r'var(--surface-hover)'),
        (r'rgba\(\s*30,\s*31,\s*38,\s*0\.86\s*\)', r'var(--surface-strong)'),
        (r'rgba\(\s*38,\s*34,\s*24,\s*0\.8\s*\)', r'var(--surface-strong)'),
    ]
    for pattern, repl in rgba_map:
        body = re.sub(pattern, repl, body)

    hex_map = [
        ('#08090c', 'var(--bg)'),
        ('#06070a', 'var(--bg-soft)'),
        ('#0c0e13', 'var(--bg-soft)'),
        ('#14140f', 'var(--accent-contrast)'),
        ('#1a1b21', 'var(--surface-hover)'),
        ('#f2f3f6', 'var(--text)'),
        ('#efdcaf', 'var(--accent-strong)'),
        ('#cfb077', 'var(--accent)'),
        ('#e8b25a', 'var(--accent)'),
    ]
    for old, new in hex_map:
        body = body.replace(old, new)

    css = '\n'.join(head) + '\n' + body
    css = css.rstrip() + '''

/* 主题基础：浅色时让原生控件（滚动条 / 输入框 / 选择框）跟随 */
:root[data-theme='light'] { color-scheme: light; }
:root[data-theme='dark'] { color-scheme: dark; }
'''
    save(css_path, css)
    print('app.css tokenised')

# ---------------- theme.ts：补令牌 + 默认浅色 ----------------
theme = load(theme_path)
if '--ink-rgb' in theme:
    print('theme.ts already patched')
else:
    theme = theme.replace(
        "    '--accent-contrast': '#111218',",
        "    '--accent-strong': '#efdcaf',\n"
        "    '--accent-contrast': '#111218',\n"
        "    '--ink-rgb': '6 7 10',\n"
        "    '--overlay-rgb': '255 255 255',",
    )
    theme = theme.replace(
        "    '--accent-contrast': '#fffaf0',",
        "    '--accent-strong': '#c9a265',\n"
        "    '--accent-contrast': '#fffaf0',\n"
        "    '--ink-rgb': '250 249 246',\n"
        "    '--overlay-rgb': '24 26 32',",
    )
    theme = theme.replace(
        """  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light') return 'light';
  } catch {
    /* 忽略 */
  }
  return 'dark';""",
        """  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark') return 'dark';
    if (saved === 'light') return 'light';
  } catch {
    /* 忽略 */
  }
  return 'light';""",
    )
    theme = theme.replace(
        "  return (document.documentElement.dataset.theme as ThemeName | undefined) ?? 'dark';",
        "  return (document.documentElement.dataset.theme as ThemeName | undefined) ?? 'light';",
    )
    save(theme_path, theme)
    print('theme.ts patched')

# ---------------- index.html：首帧就是浅色，避免闪黑 ----------------
html = load(html_path)
if 'data-theme' in html:
    print('html already patched')
else:
    html = re.sub(r'<html([^>]*)>', r'<html\1 data-theme="light">', html, count=1)
    save(html_path, html)
    print('index.html patched')
