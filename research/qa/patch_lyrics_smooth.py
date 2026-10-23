import io

p = r'E:\Zilux2开发\web\src\ui\lyrics.ts'
t = io.open(p, 'r', encoding='utf-8', newline='').read()


def sub(old, new, label):
    global t
    n = t.count(old)
    assert n == 1, (label, n)
    t = t.replace(old, new)


# fields: add target + raf
sub(
    '''  private manualUntil = 0;
  private manualTimer = 0;''',
    '''  private manualUntil = 0;
  private manualTimer = 0;
  /** 手动滚动的目标位移（缓动追踪它，做出丝滑惯性）。 */
  private manualTarget = 0;
  private manualRaf = 0;
  private manualLastTs = 0;''',
    'fields',
)

# reset in render
sub(
    '''    this.autoOffset = 0;
    this.manualShift = 0;
    this.manualUntil = 0;
    window.clearTimeout(this.manualTimer);''',
    '''    this.autoOffset = 0;
    this.manualShift = 0;
    this.manualTarget = 0;
    this.manualUntil = 0;
    window.clearTimeout(this.manualTimer);
    if (this.manualRaf) {
      window.cancelAnimationFrame(this.manualRaf);
      this.manualRaf = 0;
    }''',
    'render reset',
)

# replace wheel + clamp + resume block
old_block = '''  private onWheel(event: WheelEvent): void {
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
'''
new_block = '''  private onWheel(event: WheelEvent): void {
    if (this.doc.lines.length === 0) return;
    event.preventDefault();
    const step = event.deltaMode === 1 ? event.deltaY * 18 : event.deltaY * 1.05;
    this.manualTarget -= step;
    this.clampManual();
    this.manualUntil = performance.now() + 3200;
    window.clearTimeout(this.manualTimer);
    this.manualTimer = window.setTimeout(() => this.resumeAuto(), 3200);
    this.startManualLoop();
  }

  /** 手动滚动的缓动循环：每帧向目标位移靠拢，跟手又有惯性。 */
  private startManualLoop(): void {
    if (this.manualRaf) return;
    this.manualLastTs = performance.now();
    const step = (now: number): void => {
      this.manualRaf = 0;
      if (this.disposed) return;
      const dt = Math.max(1, now - this.manualLastTs);
      this.manualLastTs = now;
      const diff = this.manualTarget - this.manualShift;
      if (Math.abs(diff) < 0.4) {
        this.manualShift = this.manualTarget;
        this.applyOffset(false);
        return;
      }
      // 时间相关的指数缓动，高刷新率/低帧率观感一致
      const k = 1 - Math.pow(0.0009, dt / 1000);
      this.manualShift += diff * k;
      this.applyOffset(false);
      this.manualRaf = window.requestAnimationFrame(step);
    };
    this.manualRaf = window.requestAnimationFrame(step);
  }

  private clampManual(): void {
    const viewH = this.rightEl.clientHeight || 0;
    const contentH = this.linesEl.scrollHeight || 0;
    const total = this.autoOffset + this.manualTarget;
    const min = -(Math.max(0, contentH - Math.max(0, viewH) / 2));
    const max = Math.max(0, viewH) * 0.35;
    const clamped = Math.min(max, Math.max(min, total));
    this.manualTarget = clamped - this.autoOffset;
  }

  /** 回到自动跟随当前歌词行。 */
  private resumeAuto(): void {
    window.clearTimeout(this.manualTimer);
    this.manualTimer = 0;
    if (this.manualRaf) {
      window.cancelAnimationFrame(this.manualRaf);
      this.manualRaf = 0;
    }
    this.manualShift = 0;
    this.manualTarget = 0;
    this.manualUntil = 0;
    this.applyOffset(true);
  }
'''
sub(old_block, new_block, 'wheel block')

# dispose cancel raf
sub(
    '''    window.clearTimeout(this.manualTimer);
    this.root.remove();''',
    '''    window.clearTimeout(this.manualTimer);
    if (this.manualRaf) {
      window.cancelAnimationFrame(this.manualRaf);
      this.manualRaf = 0;
    }
    this.root.remove();''',
    'dispose',
)

io.open(p, 'w', encoding='utf-8', newline='').write(t)

# CSS: 平滑的跟随位移（自动回位用 transition 更柔和），并让滚轮容器更跟手
p2 = r'E:\Zilux2开发\web\src\styles\app.css'
c = io.open(p2, 'r', encoding='utf-8', newline='').read()
ceol = '\r\n' if '\r\n' in c else '\n'
c += """
/* 歌词滚动手感：自动归位更柔和 */
.lyrics-right .lyrics-lines {
  transition: transform .42s cubic-bezier(0.22, 1, 0.36, 1);
}
""".replace('\n', ceol)
io.open(p2, 'w', encoding='utf-8', newline='').write(c)
print('ok')
