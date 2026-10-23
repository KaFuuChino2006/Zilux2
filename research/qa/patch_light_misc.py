import io

path = r'E:\Zilux2开发\web\src\styles\app.css'
with io.open(path, 'r', encoding='utf-8', newline='') as f:
    css = f.read()

pairs = [
    ('  color: #10110f;\n  background: linear-gradient(135deg, #f0dcae, #c9a96a);',
     '  color: var(--accent-contrast);\n  background: linear-gradient(135deg, var(--accent-strong), var(--accent));'),
    ('  background: #15161b;', '  background: var(--surface-hover);'),
    ('  background: #0e0f13;', '  background: var(--panel-solid);'),
    ('  background: #191b21;', '  background: var(--surface-hover);'),
    ('  color: #f5f6f8;', '  color: var(--text);'),
    ('  color: #ffd9d9;', '  color: var(--danger);'),
]

nl = '\r\n' if '\r\n' in css else '\n'
for old, new in pairs:
    old = old.replace('\n', nl)
    new = new.replace('\n', nl)
    assert old in css, 'missing: %r' % old
    css = css.replace(old, new)

with io.open(path, 'w', encoding='utf-8', newline='') as f:
    f.write(css)
print('remaining dark hex values tokenised')
