import io

app_path = r'E:\Zilux2开发\web\src\ui\app.ts'
css_path = r'E:\Zilux2开发\web\src\styles\app.css'


def load(path):
    with io.open(path, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def save(path, text):
    with io.open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


def apply(path, label, edits):
    text = load(path)
    nl = '\r\n' if '\r\n' in text else '\n'
    for name, old, new in edits:
        old = old.replace('\n', nl)
        new = new.replace('\n', nl)
        count = text.count(old)
        assert count == 1, '%s / %s: expected 1 match, got %d' % (label, name, count)
        text = text.replace(old, new)
    save(path, text)
    print('%s OK (%d edits)' % (label, len(edits)))


apply(app_path, 'app.ts track-swap', [
    (
        'fields',
        "  private pbCover!: HTMLImageElement;\n  private pbTitle!: HTMLDivElement;",
        "  private pbCover!: HTMLImageElement;\n  private pbCoverWrap!: HTMLDivElement;\n  private pbMeta!: HTMLDivElement;\n  private pbTrackKey = '';\n  private pbTitle!: HTMLDivElement;",
    ),
    (
        'buildPlayerBar cover',
        "    this.pbCover = h('img', {});\n    this.pbTitle = h('div', { class: 'pb-title', text: '未在播放' });\n    this.pbArtist = h('div', { class: 'pb-artist', text: '' });\n\n    const coverWrap = h('div', { class: 'pb-cover' }, this.pbCover);",
        "    this.pbCover = h('img', { class: 'pb-cover-img' });\n    this.pbTitle = h('div', { class: 'pb-title', text: '未在播放' });\n    this.pbArtist = h('div', { class: 'pb-artist', text: '' });\n\n    this.pbCoverWrap = h('div', { class: 'pb-cover' }, this.pbCover);\n    this.pbMeta = h('div', { class: 'pb-meta' }, this.pbTitle, this.pbArtist);",
    ),
    (
        'buildPlayerBar meta usage',
        "      h('div', { class: 'pb-meta' }, this.pbTitle, this.pbArtist),",
        "      this.pbMeta,",
    ),
    (
        'syncPlayer track swap',
        "    this.playerbar.classList.toggle('is-hidden', !track);\n    if (!track) return;\n    this.pbCover.src = onlineArtwork(track);\n    this.pbTitle.textContent = track.title;\n    this.pbArtist.textContent = track.artist || '未知歌手';",
        "    this.playerbar.classList.toggle('is-hidden', !track);\n    if (!track) return;\n    const trackKey = `${track.source}:${track.id}`;\n    const trackChanged = trackKey !== this.pbTrackKey;\n    if (trackChanged) {\n      if (this.pbTrackKey !== '') this.captureTrackGhosts();\n      this.pbTrackKey = trackKey;\n    }\n    this.pbCover.src = onlineArtwork(track);\n    this.pbTitle.textContent = track.title;\n    this.pbArtist.textContent = track.artist || '未知歌手';\n    if (trackChanged) this.playTrackEnter();",
    ),
    (
        'swap helpers',
        "  private syncSettingsUi(): void {",
        """  /** 切歌前把当前封面/文字复制一份留着做「滑出」动画。 */
  private captureTrackGhosts(): void {
    const ghost = this.pbCover.cloneNode() as HTMLImageElement;
    ghost.className = 'pb-cover-img is-ghost';
    ghost.src = this.pbCover.getAttribute('src') ?? '';
    this.pbCoverWrap.append(ghost);
    window.setTimeout(() => ghost.remove(), 620);

    const ghostMeta = this.pbMeta.cloneNode(true) as HTMLDivElement;
    ghostMeta.classList.add('pb-meta-ghost');
    this.pbMeta.parentElement?.append(ghostMeta);
    window.setTimeout(() => ghostMeta.remove(), 620);
  }

  /** 新封面从右侧推入、新歌名从下方淡入。 */
  private playTrackEnter(): void {
    for (const element of [this.pbCover, this.pbMeta]) {
      element.classList.remove('is-incoming');
      void (element as HTMLElement).offsetWidth;
      element.classList.add('is-incoming');
      window.setTimeout(() => element.classList.remove('is-incoming'), 620);
    }
  }

  private syncSettingsUi(): void {""",
    ),
])

css = '''
/* ==================== 播放条切歌：封面滑出 / 推入 + 歌名渐变 ==================== */
.pb-cover { position: relative; }
.pb-cover-img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.pb-cover-img.is-incoming { animation: pb-cover-in .46s cubic-bezier(.22, 1, .36, 1) both; }
.pb-cover-img.is-ghost {
  position: absolute;
  inset: 0;
  z-index: 2;
  animation: pb-cover-out .46s cubic-bezier(.4, 0, .6, 1) both;
  pointer-events: none;
}
@keyframes pb-cover-in {
  from { transform: translateX(66%) scale(.84) rotate(4deg); opacity: .15; }
  to { transform: none; opacity: 1; }
}
@keyframes pb-cover-out {
  from { transform: none; opacity: 1; }
  to { transform: translateX(-74%) scale(.84) rotate(-6deg); opacity: 0; }
}
.pb-meta { position: relative; }
.pb-meta.is-incoming { animation: pb-meta-in .42s cubic-bezier(.22, 1, .36, 1) both; }
.pb-meta-ghost {
  position: absolute;
  inset: 0;
  z-index: 2;
  animation: pb-meta-out .42s cubic-bezier(.4, 0, .6, 1) both;
  pointer-events: none;
}
@keyframes pb-meta-in {
  from { transform: translateY(10px); opacity: 0; }
  to { transform: none; opacity: 1; }
}
@keyframes pb-meta-out {
  from { transform: none; opacity: 1; }
  to { transform: translateY(-10px); opacity: 0; }
}
'''

text = load(css_path)
if '.pb-cover-img.is-incoming' in text:
    print('css already patched')
else:
    nl = '\r\n' if '\r\n' in text else '\n'
    save(css_path, text.rstrip() + nl + css.replace('\n', nl))
    print('css appended')
