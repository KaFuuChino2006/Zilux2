# -*- coding: utf-8 -*-
"""歌词页 2.0：播放条「词」字按钮 + 左封面右歌词 + 逐词发散辉光。"""
import io
import re

BASE = r'E:\Zilux2开发\web\src'
APP = BASE + r'\ui\app.ts'
LYR = BASE + r'\ui\lyrics.ts'
CSS = BASE + r'\styles\app.css'


def read(p):
    return io.open(p, 'r', encoding='utf-8', newline='').read()


def write(p, t):
    io.open(p, 'w', encoding='utf-8', newline='').write(t)


# ---------------------------------------------------------------------------
# 1) app.ts：歌词按钮改成「词」字
# ---------------------------------------------------------------------------
app = read(APP)
eol = '\r\n' if '\r\n' in app else '\n'
old_btn = "    const lyricsBtn = h('button', { class: 'pb-btn', title: '歌词' }, icon('lyrics'));".replace('\n', eol)
new_btn = "    const lyricsBtn = h(\n      'button',\n      { class: 'pb-btn pb-btn-lyrics', title: '歌词' },\n      h('span', { class: 'pb-glyph', text: '词' }),\n    );".replace('\n', eol)
assert app.count(old_btn) == 1, 'lyrics button anchor'
app = app.replace(old_btn, new_btn)
write(APP, app)
print('app.ts: lyrics button -> 词')

# ---------------------------------------------------------------------------
# 2) lyrics.ts：重写 LyricsView 类（左封面 + 右逐词歌词）
# ---------------------------------------------------------------------------
lyr = read(LYR)
leol = '\r\n' if '\r\n' in lyr else '\n'
head = lyr.split('export class LyricsView {')[0]
assert head != lyr, 'class anchor'

body = """
export class LyricsView {
  readonly root: HTMLDivElement;

  private linesEl: HTMLDivElement;
  private bgEl: HTMLDivElement;
  private coverEl: HTMLImageElement;
  private titleEl: HTMLDivElement;
  private artistEl: HTMLDivElement;
  private emptyEl: HTMLDivElement;

  private doc: LyricDoc = EMPTY;
  private state: PlayerState | null = null;
  private lineEls: HTMLDivElement[] = [];
  private charEls: HTMLSpanElement[][] = [];
  private activeIndex = -1;
  private rafId = 0;
  private disposed = false;
  private loadToken = 0;
  private lastTrackKey = '';
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly onClose: () => void) {
    this.bgEl = h('div', { class: 'lyrics-bg' });
    this.coverEl = h('img', { class: 'lyrics-cover', alt: '' });
    this.titleEl = h('div', { class: 'lyrics-title', text: '未在播放' });
    this.artistEl = h('div', { class: 'lyrics-artist', text: '' });
    this.linesEl = h('div', { class: 'lyrics-lines' });
    this.emptyEl = h('div', { class: 'lyrics-empty', text: '这首歌还没有歌词' });

    const closeBtn = h('button', { class: 'lyrics-close', title: '返回' }, icon('close'));
    closeBtn.addEventListener('click', () => this.onClose());

    this.root = h(
      'div',
      { class: 'lyrics-view' },
      this.bgEl,
      h('div', { class: 'lyrics-scrim' }),
      closeBtn,
      h(
        'div',
        { class: 'lyrics-frame' },
        h(
          'div',
          { class: 'lyrics-left' },
          h('div', { class: 'lyrics-cover-wrap' }, this.coverEl),
          h('div', { class: 'lyrics-meta' }, this.titleEl, this.artistEl),
        ),
        h('div', { class: 'lyrics-right' }, this.linesEl, this.emptyEl),
      ),
    );

    this.unsubscribe = onPlayer((state) => {
      if (this.disposed) return;
      this.state = state;
      this.syncTrack();
      this.syncProgress();
      this.schedule();
    });
  }

  private syncTrack(): void {
    const track = this.state?.track ?? null;
    const key = trackKeyOf(track);
    const coverUrl = track ? onlineArtwork(track) : '';
    this.bgEl.style.backgroundImage = coverUrl ? `url("${coverUrl}")` : 'none';
    this.coverEl.src = coverUrl;
    this.titleEl.textContent = track?.title ?? '未在播放';
    this.artistEl.textContent = track?.artist ?? '';
    if (key === this.lastTrackKey) return;
    this.lastTrackKey = key;
    void this.reload(track);
  }

  private async reload(track: OnlineTrack | null): Promise<void> {
    const token = ++this.loadToken;
    const doc = await loadLyricDoc(track);
    if (this.disposed || token !== this.loadToken) return;
    this.doc = doc;
    this.render();
  }

  private render(): void {
    this.linesEl.textContent = '';
    this.lineEls = [];
    this.charEls = [];
    this.activeIndex = -1;
    this.linesEl.style.transform = 'translateY(0px)';
    this.emptyEl.style.display = this.doc.lines.length === 0 ? '' : 'none';
    if (this.doc.lines.length === 0) return;

    for (const line of this.doc.lines) {
      const lineEl = h('div', { class: 'lyric-line' });
      const chars: HTMLSpanElement[] = [];
      if (line.words.length > 0) {
        for (const word of line.words) {
          const span = h('span', { class: 'lyric-char', text: word.text });
          chars.push(span);
          lineEl.append(span);
        }
      } else {
        lineEl.textContent = line.text || ' ';
      }
      if (line.translation) {
        lineEl.append(h('span', { class: 'lyric-trans', text: line.translation }));
      }
      this.lineEls.push(lineEl);
      this.charEls.push(chars);
      this.linesEl.append(lineEl);
    }
    this.syncProgress(true);
  }

  private syncProgress(force = false): void {
    const state = this.state;
    if (!state || this.doc.lines.length === 0) return;
    const nextIndex = activeIndexOf(this.doc.lines, state.positionMs);
    if (nextIndex !== this.activeIndex || force) {
      const prev = this.activeIndex;
      this.activeIndex = nextIndex;
      if (prev >= 0) this.lineEls[prev]?.classList.remove('is-active', 'is-near');
      this.lineEls.forEach((el, index) => {
        el.classList.toggle('is-active', index === nextIndex);
        el.classList.toggle('is-near', index === nextIndex - 1 || index === nextIndex + 1);
      });
    }
    const activeEl = this.lineEls[this.activeIndex];
    if (activeEl) {
      const body = this.root.querySelector('.lyrics-right');
      const bodyHeight = body instanceof HTMLElement ? body.clientHeight : 0;
      const offset = activeEl.offsetTop + activeEl.offsetHeight / 2 - bodyHeight / 2;
      this.linesEl.style.transform = `translateY(${-offset}px)`;
    }
    const activeLine = this.doc.lines[this.activeIndex];
    if (activeLine && activeLine.words.length > 0) {
      const states = charStates(activeLine, state.positionMs);
      const spans = this.charEls[this.activeIndex] ?? [];
      states.forEach((value, index) => {
        const span = spans[index];
        if (!span) return;
        span.classList.toggle('is-sung', value >= 1);
        span.classList.toggle('is-hot', value === 2);
      });
    }
  }

  private schedule(): void {
    if (this.rafId || this.disposed) return;
    this.rafId = window.requestAnimationFrame(() => {
      this.rafId = 0;
      this.syncProgress();
      this.schedule();
    });
  }

  /** 点击歌词行跳转（便于手动对齐）。 */
  bindSeek(): void {
    this.linesEl.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const lineEl = target.closest('.lyric-line');
      if (!(lineEl instanceof HTMLElement)) return;
      const index = this.lineEls.indexOf(lineEl as HTMLDivElement);
      const line = this.doc.lines[index];
      if (line) seek(line.timeMs);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.rafId) window.cancelAnimationFrame(this.rafId);
    this.root.remove();
  }
}
""".replace('\n', leol)
write(LYR, head + body)
print('lyrics.ts: LyricsView rewritten')

# ---------------------------------------------------------------------------
# 3) app.css：歌词页 2.0 样式
# ---------------------------------------------------------------------------
css = read(CSS)
ceol = '\r\n' if '\r\n' in css else '\n'
if '歌词页 2.0' not in css:
    block = """
/* ==================== 歌词页 2.0：左封面 + 右逐词歌词（发散辉光） ==================== */
.lyrics-view {
  display: block;
  animation: lyrics-enter 0.5s var(--ease-pop) both;
}
@keyframes lyrics-enter {
  from { opacity: 0; transform: scale(1.015); }
  to { opacity: 1; transform: none; }
}

.lyrics-close {
  position: absolute;
  top: 22px;
  right: 26px;
  z-index: 6;
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1px solid rgb(var(--overlay-rgb) / 0.16);
  background: rgb(var(--ink-rgb) / 0.34);
  color: var(--text);
  cursor: pointer;
  transition: background var(--dur-mid) var(--ease), transform var(--dur-mid) var(--ease);
}
.lyrics-close:hover {
  background: rgb(var(--overlay-rgb) / 0.16);
  transform: rotate(90deg);
}

.lyrics-frame {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: clamp(36px, 5vw, 92px);
  height: 100%;
  padding: 6vh 6vw 7vh 5vw;
  box-sizing: border-box;
}
.lyrics-left {
  flex: 0 0 auto;
  width: clamp(220px, 26vw, 380px);
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.lyrics-cover-wrap {
  width: 100%;
  aspect-ratio: 1;
  border-radius: 22px;
  overflow: hidden;
  box-shadow: 0 30px 70px rgb(var(--ink-rgb) / 0.55);
  animation: lyrics-cover-in 0.6s var(--ease-pop) both;
}
@keyframes lyrics-cover-in {
  from { opacity: 0; transform: translateY(18px) scale(0.96); }
  to { opacity: 1; transform: none; }
}
.lyrics-cover {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.lyrics-meta { min-height: 62px; padding-left: 2px; }
.lyrics-meta .lyrics-title {
  font-size: clamp(20px, 1.5vw, 26px);
  font-weight: 650;
  color: var(--text);
}
.lyrics-meta .lyrics-artist {
  margin-top: 6px;
  font-size: 13px;
  color: rgb(var(--overlay-rgb) / 0.58);
}

.lyrics-right {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  align-self: stretch;
  display: flex;
  align-items: center;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(180deg, transparent, #000 14%, #000 86%, transparent);
  mask-image: linear-gradient(180deg, transparent, #000 14%, #000 86%, transparent);
}
.lyrics-right .lyrics-lines {
  width: 100%;
  align-items: flex-start;
  gap: 16px;
}
.lyrics-right .lyric-line {
  width: 100%;
  text-align: left;
  font-size: clamp(20px, 2.05vw, 31px);
  font-weight: 600;
  line-height: 1.52;
  letter-spacing: 0.01em;
  color: rgb(var(--overlay-rgb) / 0.32);
  transform-origin: 0% 50%;
  transition: color var(--dur-mid) var(--ease), opacity var(--dur-mid) var(--ease);
}
.lyrics-right .lyric-line.is-near { color: rgb(var(--overlay-rgb) / 0.5); }
.lyrics-right .lyric-line.is-active { color: var(--text); }
.lyrics-right .lyric-trans {
  display: block;
  margin-top: 7px;
  font-size: 0.56em;
  font-weight: 500;
  color: rgb(var(--overlay-rgb) / 0.52);
}
.lyrics-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--muted);
  font-size: 15px;
}

/* 逐词：已唱变亮，正在唱的词带向外扩散的辉光 */
.lyric-char {
  position: relative;
  display: inline-block;
  transition:
    color 0.3s var(--ease),
    transform 0.32s var(--ease-pop),
    text-shadow 0.45s var(--ease),
    opacity 0.3s var(--ease);
}
.lyric-char.is-sung { color: var(--text); }
.lyric-char.is-hot {
  color: var(--accent-strong);
  transform: translateY(-2px) scale(1.06);
  animation: lyric-word-glow 1.75s ease-in-out infinite;
}
@keyframes lyric-word-glow {
  0%, 100% {
    text-shadow:
      0 0 10px color-mix(in srgb, var(--accent) 62%, transparent),
      0 0 26px color-mix(in srgb, var(--accent) 38%, transparent);
  }
  50% {
    text-shadow:
      0 0 16px color-mix(in srgb, var(--accent) 92%, transparent),
      0 0 44px color-mix(in srgb, var(--accent) 62%, transparent),
      0 0 92px color-mix(in srgb, var(--accent) 42%, transparent);
  }
}
.lyric-char.is-hot::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 240%;
  height: 260%;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: radial-gradient(closest-side, color-mix(in srgb, var(--accent) 34%, transparent), transparent 72%);
  filter: blur(7px);
  z-index: -1;
  pointer-events: none;
  animation: lyric-word-halo 1.75s ease-in-out infinite;
}
@keyframes lyric-word-halo {
  0%, 100% { opacity: 0.45; transform: translate(-50%, -50%) scale(0.9); }
  50% { opacity: 0.9; transform: translate(-50%, -50%) scale(1.16); }
}

/* 播放条「词」字按钮 */
.pb-btn-lyrics .pb-glyph {
  font-size: 15px;
  font-weight: 650;
  line-height: 1;
  color: inherit;
  font-family: var(--font-ui);
}

@media (max-width: 900px) {
  .lyrics-frame {
    flex-direction: column;
    justify-content: center;
    gap: 24px;
    padding: 5vh 7vw 8vh;
  }
  .lyrics-left {
    width: clamp(150px, 38vw, 220px);
    flex-direction: row;
    align-items: center;
    gap: 16px;
  }
  .lyrics-cover-wrap { width: 108px; flex: none; border-radius: 16px; }
  .lyrics-right { align-self: stretch; }
}
""".replace('\n', ceol)
    css = css + block
    write(CSS, css)
    print('app.css: lyrics 2.0 appended')
else:
    print('app.css: already appended')

print('done')
