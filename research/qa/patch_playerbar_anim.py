import io

css_path = r'E:\Zilux2开发\web\src\styles\app.css'
with io.open(css_path, 'r', encoding='utf-8', newline='') as f:
    css = f.read()

if '.playerbar:hover,' in css and 'border-radius: var(--radius-pill);' in css:
    print('already patched')
else:
    nl = '\r\n' if '\r\n' in css else '\n'
    extra = '''
/* ==================== 播放条：和搜索框同款弹出动效（速度 0.7x → 0.66s） ==================== */
.playerbar {
  width: 372px;
  border-radius: var(--radius-pill);
  transition:
    width 0.66s cubic-bezier(0.22, 1.62, 0.36, 1),
    border-radius 0.52s var(--ease),
    background 0.2s var(--ease),
    transform 0.3s var(--ease),
    opacity 0.3s var(--ease);
}
.playerbar:hover,
.playerbar:focus-within {
  width: min(1020px, 88vw);
  border-radius: 20px;
}
.playerbar .pb-meta {
  width: auto;
  flex: 1;
  min-width: 0;
}
.playerbar:hover .pb-meta,
.playerbar:focus-within .pb-meta {
  width: 190px;
  flex: none;
}
.playerbar .pb-progress,
.playerbar .pb-extra {
  max-width: 0;
  opacity: 0;
  overflow: hidden;
  pointer-events: none;
}
.playerbar .pb-progress {
  flex: 0 1 auto;
}
.playerbar:hover .pb-progress,
.playerbar:focus-within .pb-progress {
  max-width: 900px;
  flex: 1 1 auto;
  opacity: 1;
  pointer-events: auto;
}
.playerbar:hover .pb-extra,
.playerbar:focus-within .pb-extra {
  max-width: 500px;
  opacity: 1;
  pointer-events: auto;
}
'''
    with io.open(css_path, 'w', encoding='utf-8', newline='') as f:
        f.write(css.rstrip() + nl + extra.replace('\n', nl))
    print('playerbar pill animation added')
