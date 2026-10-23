import io

css_path = r'E:\Zilux2开发\web\src\styles\app.css'
with io.open(css_path, 'r', encoding='utf-8', newline='') as f:
    css = f.read()

if '.recent-strip { width: min(' in css or '.recent-strip {\r\n  width: min(' in css:
    print('already patched')
else:
    nl = '\r\n' if '\r\n' in css else '\n'
    extra = '''
/* 最近播放小条：收窄宽度 + 隐藏滚动条 */
.recent-strip {
  width: min(352px, 100%);
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.recent-strip::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}
'''
    with io.open(css_path, 'w', encoding='utf-8', newline='') as f:
        f.write(css.rstrip() + nl + extra.replace('\n', nl))
    print('recent strip narrowed + scrollbar hidden')
