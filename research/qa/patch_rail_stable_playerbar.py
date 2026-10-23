import io

app_path = r'E:\Zilux2开发\web\src\ui\app.ts'
css_path = r'E:\Zilux2开发\web\src\styles\app.css'


def load(p):
    with io.open(p, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def save(p, text):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


app = load(app_path)
nl = '\r\n' if '\r\n' in app else '\n'


def sub(name, old, new, count=1):
    global app
    old = old.replace('\n', nl)
    new = new.replace('\n', nl)
    got = app.count(old)
    assert got == count, '%s: expected %d, got %d' % (name, count, got)
    app = app.replace(old, new)


# 1) rail 展开/收起改由 JS 的 is-open 类驱动（只动容器宽度，按钮不参与动画 → 不再弹一下）
sub(
    'rail open class',
    "    const rail = h('nav', { class: 'rail' });",
    """    const rail = h('nav', { class: 'rail' });
    let railCloseTimer = 0;
    const openRail = (): void => {
      window.clearTimeout(railCloseTimer);
      rail.classList.add('is-open');
    };
    const closeRail = (): void => {
      window.clearTimeout(railCloseTimer);
      railCloseTimer = window.setTimeout(() => {
        if (!rail.matches(':focus-within')) rail.classList.remove('is-open');
      }, 90);
    };
    rail.addEventListener('pointerenter', openRail);
    rail.addEventListener('pointerleave', closeRail);
    rail.addEventListener('focusin', openRail);
    rail.addEventListener('focusout', closeRail);""",
)

# 2) 播放条常驻：没有当前曲时也显示占位，而不是隐藏
sub(
    'playerbar always visible',
    """  private syncPlayer(state: PlayerState): void {
    const track = state.track;
    this.playerbar.classList.toggle('is-hidden', !track);
    if (!track) return;""",
    """  private syncPlayer(state: PlayerState): void {
    const track = state.track;
    if (!track) {
      this.playerbar.classList.remove('is-hidden');
      this.playerbar.classList.add('is-idle');
      this.pbTrackKey = '';
      this.pbTitle.textContent = '未在播放';
      this.pbArtist.textContent = '点一首歌开始播放';
      this.pbPlayBtn.textContent = '';
      this.pbPlayBtn.append(icon('play', 20));
      this.pbFill.style.width = '0%';
      this.pbCur.textContent = '00:00';
      this.pbDur.textContent = '00:00';
      this.pbLikeBtn.textContent = '';
      this.pbLikeBtn.append(icon('heart'));
      this.pbLikeBtn.classList.remove('is-liked');
      this.pbModeBtn.textContent = '';
      this.pbModeBtn.append(icon(state.mode === 'single' ? 'repeatOne' : state.mode === 'shuffle' ? 'shuffle' : 'repeat'));
      this.pbModeBtn.title = '列表循环（点击切换）';
      this.upnextRoot.classList.add('is-hidden');
      return;
    }
    this.playerbar.classList.remove('is-idle');""",
)

save(app_path, app)
print('app.ts rail class + playerbar always-on patched')

css = load(css_path)
if '.rail.is-open {' in css:
    print('css already patched')
else:
    nlc = '\r\n' if '\r\n' in css else '\n'
    extra = '''
/* ==================== 侧栏收起不再弹一下：只动容器宽度 ==================== */
.rail {
  width: var(--rail-w);
  transition: width .28s cubic-bezier(.4, 0, .2, 1);
}
.rail:hover,
.rail:focus-within {
  width: var(--rail-w);
  box-shadow: none;
}
.rail.is-open,
.rail.is-open:hover,
.rail.is-open:focus-within {
  width: 196px;
  box-shadow: var(--shadow);
}
.rail-btn {
  width: 100%;
  max-width: 172px;
  align-self: stretch;
  padding: 0 13px;
  justify-content: flex-start;
  gap: 11px;
  transition: background .18s var(--ease), color .18s var(--ease), border-color .18s var(--ease);
}
.rail:hover .rail-btn,
.rail:focus-within .rail-btn {
  width: 100%;
  max-width: 172px;
  padding: 0 13px;
  justify-content: flex-start;
  gap: 11px;
}
.rail-label {
  max-width: 132px;
  opacity: 0;
  transition: opacity .18s var(--ease);
}
.rail.is-open .rail-label {
  opacity: 1;
}

/* ==================== 播放条常驻占位 ==================== */
.playerbar.is-idle .pb-cover {
  background: var(--surface-hover);
  box-shadow: none;
}
.playerbar.is-idle .pb-cover-img { opacity: 0; }
.playerbar.is-idle .pb-title { color: var(--muted); }
.playerbar.is-idle .pb-artist { color: var(--muted); opacity: .8; }
.playerbar.is-idle .pb-progress { opacity: .55; }
'''
    save(css_path, css.rstrip() + nlc + extra.replace('\n', nlc))
    print('css patched')
