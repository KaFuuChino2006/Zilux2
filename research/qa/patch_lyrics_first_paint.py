# -*- coding: utf-8 -*-
"""首次渲染歌词时不要过渡（避免一进歌词页整列向上滑一下），稳定后再恢复过渡动画。"""
import io

LYR = r'E:\Zilux2开发\web\src\ui\lyrics.ts'
text = io.open(LYR, 'r', encoding='utf-8', newline='').read()
eol = '\r\n' if '\r\n' in text else '\n'


def rep(old, new, label):
    global text
    old = old.replace('\n', eol)
    new = new.replace('\n', eol)
    assert text.count(old) == 1, 'anchor miss: ' + label
    text = text.replace(old, new)
    print('ok:', label)


rep("""    this.linesEl.style.transform = 'translateY(0px)';
    this.emptyEl.style.display = this.doc.lines.length === 0 ? '' : 'none';""",
    """    this.linesEl.style.transform = 'translateY(0px)';
    this.linesEl.style.transition = 'none';
    this.emptyEl.style.display = this.doc.lines.length === 0 ? '' : 'none';""",
    'render no-transition')

rep("""    this.syncProgress(true);
  }

  private syncProgress(force = false): void {""",
    """    this.syncProgress(true);
    window.requestAnimationFrame(() => {
      if (!this.disposed) this.linesEl.style.transition = '';
    });
  }

  private syncProgress(force = false): void {""",
    'restore transition')

io.open(LYR, 'w', encoding='utf-8', newline='').write(text)
print('done')
