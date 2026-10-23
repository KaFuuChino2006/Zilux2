import io

app_path = r'E:\Zilux2开发\web\src\ui\app.ts'
theme_path = r'E:\Zilux2开发\web\src\ui\theme.ts'
css_path = r'E:\Zilux2开发\web\src\styles\app.css'


def load(p):
    with io.open(p, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def save(p, text):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


app = load(app_path)
nl = '\r\n' if '\r\n' in app else '\n'
old = "    const brandMark = h('div', { class: 'brand-mark', text: 'Z' });\n    const brand = h('div', { class: 'brand' }, brandMark, h('div', { class: 'brand-name', text: 'ZILUX' }));"
new = "    const brand = h('div', { class: 'brand' }, h('div', { class: 'brand-name', text: 'ZILUX' }));"
old = old.replace('\n', nl)
new = new.replace('\n', nl)
assert app.count(old) == 1, 'brand anchor not found'
app = app.replace(old, new)
save(app_path, app)
print('app.ts brand icon removed')

theme = load(theme_path)
if "'--rail-bg'" in theme:
    print('theme rail token exists')
else:
    theme = theme.replace(
        "    '--panel': 'rgba(18, 19, 24, 0.72)',",
        "    '--rail-bg': 'rgba(18, 19, 24, 0.58)',\n    '--panel': 'rgba(18, 19, 24, 0.72)',",
    )
    theme = theme.replace(
        "    '--panel': 'rgba(255, 255, 255, 0.74)',",
        "    '--rail-bg': 'rgba(255, 255, 255, 0.62)',\n    '--panel': 'rgba(255, 255, 255, 0.74)',",
    )
    save(theme_path, theme)
    print('theme.ts rail token added')

css = load(css_path)
if '.rail {\n  background: var(--rail-bg);' in css or '.rail {\r\n  background: var(--rail-bg);' in css:
    print('css already patched')
else:
    nlc = '\r\n' if '\r\n' in css else '\n'
    extra = '''
/* ==================== 左侧栏：玻璃模糊 ==================== */
.rail {
  background: var(--rail-bg);
  backdrop-filter: blur(26px) saturate(1.35);
  -webkit-backdrop-filter: blur(26px) saturate(1.35);
}
.rail:hover,
.rail:focus-within {
  background: var(--rail-bg);
  backdrop-filter: blur(30px) saturate(1.45);
  -webkit-backdrop-filter: blur(30px) saturate(1.45);
}
.brand-mark { display: none; }
'''
    save(css_path, css.rstrip() + nlc + extra.replace('\n', nlc))
    print('css patched')
