import io

css_path = r'E:\Zilux2开发\web\src\styles\app.css'
with io.open(css_path, 'r', encoding='utf-8', newline='') as f:
    css = f.read()

if '/* 播放条收起态：歌名 + 播放按钮 + 时间 */' in css:
    print('already patched')
else:
    nl = '\r\n' if '\r\n' in css else '\n'
    extra = '''
/* ==================== 播放条收起态：歌名 + 播放按钮 + 时间（弹出更慢） ==================== */
.playerbar {
  width: 334px;
  border-radius: var(--radius-pill);
  transition:
    width 0.98s cubic-bezier(0.22, 1.28, 0.36, 1),
    border-radius 0.72s var(--ease),
    background 0.24s var(--ease),
    transform 0.3s var(--ease),
    opacity 0.3s var(--ease);
}
.playerbar:hover,
.playerbar:focus-within {
  width: min(1020px, 88vw);
  border-radius: 20px;
}

/* 收起态隐藏：封面、歌手、上一首/下一首、进度条拖动手柄、右侧附加控件 */
.playerbar .pb-cover {
  max-width: 0;
  opacity: 0;
  overflow: hidden;
  margin-right: -14px;
  transition:
    max-width 0.9s cubic-bezier(0.22, 1.28, 0.36, 1),
    opacity 0.28s var(--ease),
    margin-right 0.6s var(--ease);
}
.playerbar:hover .pb-cover,
.playerbar:focus-within .pb-cover {
  max-width: 52px;
  opacity: 1;
  margin-right: 0;
}
.playerbar .pb-artist {
  max-height: 0;
  opacity: 0;
  margin-top: 0;
  transition:
    max-height 0.5s var(--ease),
    opacity 0.28s var(--ease),
    margin-top 0.4s var(--ease);
}
.playerbar:hover .pb-artist,
.playerbar:focus-within .pb-artist {
  max-height: 20px;
  opacity: 1;
  margin-top: 3px;
}
.playerbar .pb-controls .pb-btn:not(.is-main) {
  max-width: 0;
  opacity: 0;
  overflow: hidden;
  pointer-events: none;
  transition:
    max-width 0.6s cubic-bezier(0.22, 1.28, 0.36, 1),
    opacity 0.26s var(--ease);
}
.playerbar:hover .pb-controls .pb-btn:not(.is-main),
.playerbar:focus-within .pb-controls .pb-btn:not(.is-main) {
  max-width: 38px;
  opacity: 1;
  pointer-events: auto;
}
.playerbar .track {
  display: none;
}
.playerbar:hover .track,
.playerbar:focus-within .track {
  display: flex;
}
.playerbar .pb-progress {
  min-width: 0;
  gap: 6px;
  max-width: none;
  opacity: 1;
}
.playerbar:hover .pb-progress,
.playerbar:focus-within .pb-progress {
  gap: 10px;
}
.playerbar .pb-progress .pb-time:last-child::before {
  content: '/ ';
  color: var(--muted);
}
'''
    with io.open(css_path, 'w', encoding='utf-8', newline='') as f:
        f.write(css.rstrip() + nl + extra.replace('\n', nl))
    print('collapsed playerbar + slower pop patched')
