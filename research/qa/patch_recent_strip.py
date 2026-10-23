import io

home_path = r'E:\Zilux2开发\web\src\ui\home.ts'
css_path = r'E:\Zilux2开发\web\src\styles\app.css'


def load(p):
    with io.open(p, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def save(p, text):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


text = load(home_path)
nl = '\r\n' if '\r\n' in text else '\n'
old = """    const scroller = h('div', { class: ui.scroller() });
    data.recent.forEach((track, index) => {
      const tile = h(
        'button',
        { class: ui.tile(), title: `${track.title} - ${track.artist}` },
        h('span', { class: ui.tileCover() }, h('img', { src: onlineArtwork(track), loading: 'lazy', alt: '' })),
        h('span', { class: ui.tileName(), text: track.title }),
        h('span', { class: ui.tileMeta(), text: track.artist || '未知歌手' }),
      );
      tile.addEventListener('click', () => this.callbacks.onPlay(data.recent, index));
      scroller.append(tile);
    });
    section.append(head, scroller);
    return section;""".replace('\n', nl)
new = """    // 最近播放：不做大封面卡片，只做一个「封面 + 歌名」的可滚动小条，
    // 高度固定约等于一个封面，占用空间小。
    const strip = h('div', { class: 'recent-strip' });
    data.recent.forEach((track, index) => {
      const row = h(
        'button',
        { class: 'recent-item', title: `${track.title} - ${track.artist || '未知歌手'}` },
        h('img', { class: 'recent-thumb', src: onlineArtwork(track), loading: 'lazy', alt: '' }),
        h('span', { class: 'recent-name', text: track.title }),
        h('span', { class: 'recent-artist', text: track.artist || '未知歌手' }),
      );
      row.addEventListener('click', () => this.callbacks.onPlay(data.recent, index));
      strip.append(row);
    });
    section.append(head, strip);
    return section;""".replace('\n', nl)
assert text.count(old) == 1, 'recent section anchor not found: %d' % text.count(old)
text = text.replace(old, new)
save(home_path, text)
print('home.ts recent strip patched')

css = load(css_path)
if '.recent-strip {' in css:
    print('css already patched')
else:
    nlc = '\r\n' if '\r\n' in css else '\n'
    extra = '''
/* ==================== 最近播放：只占一个封面高度的滚动小条 ==================== */
.recent-strip {
  height: 156px;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-radius: var(--radius-l);
  border: 1px solid var(--line);
  background: var(--surface);
  scrollbar-width: thin;
}
.recent-strip::-webkit-scrollbar { width: 6px; }
.recent-strip::-webkit-scrollbar-thumb { background: rgb(var(--overlay-rgb) / .18); border-radius: 999px; }
.recent-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 8px;
  border-radius: 10px;
  color: var(--text);
  text-align: left;
  transition: background .16s var(--ease);
}
.recent-item:hover { background: rgb(var(--overlay-rgb) / .06); }
.recent-thumb {
  width: 38px;
  height: 38px;
  flex: none;
  border-radius: 8px;
  object-fit: cover;
  background: var(--surface-hover);
}
.recent-name {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.recent-artist {
  margin-left: auto;
  max-width: 42%;
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
'''
    save(css_path, css.rstrip() + nlc + extra.replace('\n', nlc))
    print('css patched')
