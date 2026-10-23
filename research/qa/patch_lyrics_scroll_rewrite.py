# -*- coding: utf-8 -*-
"""重写歌词行的滚动定位：不再用 offsetTop 相对未知父级 + bodyHeight 的半吊子算法，
改成 .lyrics-lines 绝对定位在右侧栏垂直中心、用自己的 offsetTop 算偏移（只在换行时更新）。"""
import io

LYR = r'E:\Zilux2开发\web\src\ui\lyrics.ts'
CSS = r'E:\Zilux2开发\web\src\styles\app.css'

text = io.open(LYR, 'r', encoding='utf-8', newline='').read()
eol = '\r\n' if '\r\n' in text else '\n'


def rep(old, new, label):
    global text
    old = old.replace('\n', eol)
    new = new.replace('\n', eol)
    assert text.count(old) == 1, 'anchor miss: ' + label
    text = text.replace(old, new)
    print('ok:', label)


rep("""    if (nextIndex !== this.activeIndex || force) {
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
    }""",
    """    if (nextIndex !== this.activeIndex || force) {
      const prev = this.activeIndex;
      this.activeIndex = nextIndex;
      if (prev >= 0) this.lineEls[prev]?.classList.remove('is-active', 'is-near');
      this.lineEls.forEach((el, index) => {
        el.classList.toggle('is-active', index === nextIndex);
        el.classList.toggle('is-near', index === nextIndex - 1 || index === nextIndex + 1);
      });
      const activeEl = this.lineEls[nextIndex];
      if (activeEl) {
        // .lyrics-lines 自身就是 offsetParent（position:absolute），offsetTop 直接是行内偏移。
        const offset = activeEl.offsetTop + activeEl.offsetHeight / 2;
        this.linesEl.style.transform = `translateY(${-offset}px)`;
      }
    }""",
    'scroll math')

io.open(LYR, 'w', encoding='utf-8', newline='').write(text)

css = io.open(CSS, 'r', encoding='utf-8', newline='').read()
ceol = '\r\n' if '\r\n' in css else '\n'
block = """
/* ==================== 歌词滚动：右侧栏垂直居中容器 ==================== */
.lyrics-right {
  position: relative;
  display: block;
  overflow: hidden;
  mask-image: linear-gradient(180deg, transparent 0%, #000 14%, #000 86%, transparent 100%);
  -webkit-mask-image: linear-gradient(180deg, transparent 0%, #000 14%, #000 86%, transparent 100%);
}
.lyrics-lines {
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 0;
  transition: transform 0.54s cubic-bezier(0.22, 1.28, 0.36, 1);
  will-change: transform;
}
.lyrics-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
}
""".replace('\n', ceol)
if '歌词滚动：右侧栏垂直居中容器' not in css:
    css += block
    io.open(CSS, 'w', encoding='utf-8', newline='').write(css)
    print('css appended')
else:
    print('css already')

print('done')
