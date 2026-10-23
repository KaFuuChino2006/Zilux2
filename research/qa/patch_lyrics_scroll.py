import io

p = r'E:\Zilux2开发\web\src\ui\lyrics.ts'
t = io.open(p, 'r', encoding='utf-8', newline='').read()


def sub(old, new, label, count=1):
    global t
    n = t.count(old)
    assert n == count, (label, n)
    t = t.replace(old, new)


# 1) fields
sub(
    '  private unsubscribe: (() => void) | null = null;',
    '''  private unsubscribe: (() => void) | null = null;
  private rightEl: HTMLDivElement;
  /** 自动居中后的位移（负值向上），滚轮浏览时作为基准。 */
  private autoOffset = 0;
  /** 用户手动浏览产生的额外位移。 */
  private manualShift = 0;
  private manualUntil = 0;
  private manualTimer = 0;''',
    'fields',
)

# 2) constructor dom + wheel binding
sub(
    "  constructor(private readonly onClose: () => void) {",
    "  constructor(private readonly onClose: () => void) {\n    this.rightEl = h('div', { class: 'lyrics-right' }, this.linesEl, this.emptyEl);",
    'rightEl assign',
)
sub(
    "        h('div', { class: 'lyrics-right' }, this.linesEl, this.emptyEl),",
    '        this.rightEl,',
    'rightEl usage',
)
sub(
    '''    this.unsubscribe = onPlayer((state) => {
      if (this.disposed) return;
      this.state = state;
      this.syncTrack();
      this.syncProgress();
      this.schedule();
    });''',
    '''    this.unsubscribe = onPlayer((state) => {
      if (this.disposed) return;
      this.state = state;
      this.syncTrack();
      this.syncProgress();
      this.schedule();
    });

    // 滚轮手动浏览歌词：临时脱离自动居中，停手几秒后回到当前行
    this.rightEl.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });''',
    'wheel binding',
)

# 3) render resets manual state
sub(
    '''    this.linesEl.style.transform = 'translateY(0px)';
    this.linesEl.style.transition = 'none';''',
    '''    this.linesEl.style.transform = 'translateY(0px)';
    this.linesEl.style.transition = 'none';
    this.autoOffset = 0;
    this.manualShift = 0;
    this.manualUntil = 0;
    window.clearTimeout(this.manualTimer);''',
    'render reset',
)

# 4) syncProgress offset via applyOffset
sub(
    '''      const activeEl = this.lineEls[nextIndex];
      if (activeEl) {
        // .lyrics-lines 自身就是 offsetParent（position:absolute），offsetTop 直接是行内偏移。
        const offset = activeEl.offsetTop + activeEl.offsetHeight / 2;
        this.linesEl.style.transform = `translateY(${-offset}px)`;
      }''',
    '''      const activeEl = this.lineEls[nextIndex];
      if (activeEl) {
        // .lyrics-lines 自身就是 offsetParent（position:absolute），offsetTop 直接是行内偏移。
        this.autoOffset = -(activeEl.offsetTop + activeEl.offsetHeight / 2);
        if (!this.browsing()) this.applyOffset(true);
      }''',
    'sync offset',
)

# 5) methods after schedule()
sub(
    '''  /** 点击歌词行跳转（便于手动对齐）。 */''',
    '''  /** 用户是否正在手动浏览歌词（此时不跟随自动居中）。 */
  private browsing(): boolean {
    return this.manualUntil > performance.now();
  }

  private applyOffset(animate: boolean): void {
    this.linesEl.style.transition = animate ? '' : 'none';
    this.linesEl.style.transform = `translateY(${this.autoOffset + this.manualShift}px)`;
  }

  private onWheel(event: WheelEvent): void {
    if (this.doc.lines.length === 0) return;
    event.preventDefault();
    const step = event.deltaMode === 1 ? event.deltaY * 18 : event.deltaY * 1.05;
    this.manualShift -= step;
    this.manualUntil = performance.now() + 3200;
    this.clampManual();
    this.applyOffset(false);
    window.clearTimeout(this.manualTimer);
    this.manualTimer = window.setTimeout(() => this.resumeAuto(), 3200);
  }

  private clampManual(): void {
    const viewH = this.rightEl.clientHeight || 0;
    const contentH = this.linesEl.scrollHeight || 0;
    const total = this.autoOffset + this.manualShift;
    const min = -(Math.max(0, contentH - Math.max(0, viewH) / 2));
    const max = Math.max(0, viewH) * 0.35;
    const clamped = Math.min(max, Math.max(min, total));
    this.manualShift = clamped - this.autoOffset;
  }

  /** 回到自动跟随当前歌词行。 */
  private resumeAuto(): void {
    window.clearTimeout(this.manualTimer);
    this.manualTimer = 0;
    this.manualShift = 0;
    this.manualUntil = 0;
    this.applyOffset(true);
  }

  /** 点击歌词行跳转（便于手动对齐）。 */''',
    'manual methods',
)

# 6) click seek: reset browse state
sub(
    '''      const line = this.doc.lines[index];
      if (line) seek(line.timeMs);''',
    '''      const line = this.doc.lines[index];
      if (line) {
        seek(line.timeMs);
        this.resumeAuto();
      }''',
    'click seek',
)

# 7) dispose clear timer
sub(
    '''    if (this.rafId) window.cancelAnimationFrame(this.rafId);
    this.root.remove();''',
    '''    if (this.rafId) window.cancelAnimationFrame(this.rafId);
    window.clearTimeout(this.manualTimer);
    this.root.remove();''',
    'dispose timer',
)

io.open(p, 'w', encoding='utf-8', newline='').write(t)

# CSS
p2 = r'E:\Zilux2开发\web\src\styles\app.css'
c = io.open(p2, 'r', encoding='utf-8', newline='').read()
ceol = '\r\n' if '\r\n' in c else '\n'
c += """
/* 歌词手动滚动：滚轮浏览、点行跳转 */
.lyrics-right {
  overscroll-behavior: contain;
}
.lyrics-right .lyric-line {
  cursor: pointer;
}
""".replace('\n', ceol)
io.open(p2, 'w', encoding='utf-8', newline='').write(c)
print('ok')
