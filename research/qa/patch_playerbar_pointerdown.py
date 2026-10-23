import io

p = r'E:\Zilux2开发\web\src\ui\app.ts'
t = io.open(p, 'r', encoding='utf-8', newline='').read()


def sub(old, new, label):
    global t
    n = t.count(old)
    assert n == 1, (label, n)
    t = t.replace(old, new)


# 播放条悬停展开时按钮一直在位移，click 的 mouseup 容易落到别处 → 统一改用 pointerdown
sub(
    '''    prevBtn.addEventListener('click', () => prev());''',
    '''    // 悬停展开的 0.98s 里按钮仍在位移，用 pointerdown 保证按下即生效
    prevBtn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      prev();
    });''',
    'prev',
)
sub(
    '''    this.pbPlayBtn.addEventListener('click', () => toggle());''',
    '''    this.pbPlayBtn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggle();
    });''',
    'play',
)
sub(
    '''    nextBtn.addEventListener('click', () => next());''',
    '''    nextBtn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      next();
    });''',
    'next',
)
sub(
    '''    lyricsBtn.addEventListener('click', () => this.openLyrics());''',
    '''    lyricsBtn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openLyrics();
    });''',
    'lyrics',
)

io.open(p, 'w', encoding='utf-8', newline='').write(t)
print('ok')
