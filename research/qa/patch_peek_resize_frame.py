import io

app_path = r'E:\Zilux2开发\web\src\ui\app.ts'
css_path = r'E:\Zilux2开发\web\src\styles\app.css'
xaml_path = r'E:\Zilux2开发\src\Zilux2\MainWindow.xaml'


def load(p):
    with io.open(p, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def save(p, text):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


def sub(text, name, old, new, nl):
    old = old.replace('\n', nl)
    new = new.replace('\n', nl)
    got = text.count(old)
    assert got == 1, '%s: expected 1, got %d' % (name, got)
    return text.replace(old, new)


app = load(app_path)
nl = '\r\n' if '\r\n' in app else '\n'

app = sub(
    app,
    'topbar right peek',
    """    const topbar = h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'topbar-left' }, brand),
      h('div', { class: 'topbar-center' }, searchWrap),
      h('div', { class: 'topbar-right' }, this.accountBtn, winBtns),
    );""",
    """    const topbarRight = h('div', { class: 'topbar-right' }, this.accountBtn, winBtns);
    const topbar = h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'topbar-left' }, brand),
      h('div', { class: 'topbar-center' }, searchWrap),
      topbarRight,
    );

    // 顶栏右侧（账号 + 窗口按钮）默认收在屏幕上方，鼠标靠近顶部时下拉展示
    const peek = h('div', { class: 'top-peek' });
    let peekTimer = 0;
    const showPeek = (): void => {
      window.clearTimeout(peekTimer);
      topbar.classList.add('is-peek');
    };
    const hidePeek = (): void => {
      window.clearTimeout(peekTimer);
      peekTimer = window.setTimeout(() => {
        if (topbarRight.matches(':hover') || topbarRight.contains(document.activeElement)) return;
        topbar.classList.remove('is-peek');
      }, 460);
    };
    peek.addEventListener('pointerenter', showPeek);
    peek.addEventListener('pointerleave', hidePeek);
    topbarRight.addEventListener('pointerenter', showPeek);
    topbarRight.addEventListener('pointerleave', hidePeek);
    this.root.append(peek);""",
    nl,
)

# 窗口边缘拖拽缩放：8 个不可见热区 → 宿主发 WM_NCLBUTTONDOWN 让系统接管
app = sub(
    app,
    'resize edges',
    """    this.root.append(topbar);
  }""",
    """    this.root.append(topbar);

    // 无边框窗口的边缘缩放：WebView2 铺满后系统收不到 WM_NCHITTEST，
    // 所以由页面在 6px 边缘热区拦下 pointerdown，让宿主把指针交回系统缩放循环。
    const edges: Array<[string, string]> = [
      ['top', 'nwse-resize'],
      ['bottom', 'nwse-resize'],
      ['left', 'ew-resize'],
      ['right', 'ew-resize'],
    ];
    for (const [edge, cursor] of edges) {
      const zone = h('div', { class: `edge-resize is-${edge}` });
      zone.style.cursor = cursor;
      zone.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        host.resize(edge);
      });
      this.root.append(zone);
    }
  }""",
    nl,
)
save(app_path, app)
print('app.ts topbar peek + resize edges')

# CSS
css = load(css_path)
nlc = '\r\n' if '\r\n' in css else '\n'
if '.top-peek {' not in css:
    extra = '''
/* ==================== 顶栏右侧：收在屏幕上方，靠近顶部下拉 ==================== */
.topbar-right {
  transform: translateY(-150%);
  opacity: 0;
  pointer-events: none;
  transition:
    transform 0.46s cubic-bezier(0.22, 1.42, 0.36, 1),
    opacity 0.26s var(--ease);
}
.topbar.is-peek .topbar-right {
  transform: none;
  opacity: 1;
  pointer-events: auto;
}
.top-peek {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 18px;
  z-index: 90;
}

/* ==================== 无边框窗口的边缘缩放热区 ==================== */
.edge-resize {
  position: fixed;
  z-index: 95;
  -webkit-app-region: no-drag;
}
.edge-resize.is-top {
  top: 0;
  left: 0;
  right: 0;
  height: 6px;
}
.edge-resize.is-bottom {
  bottom: 0;
  left: 0;
  right: 0;
  height: 6px;
}
.edge-resize.is-left {
  top: 0;
  bottom: 0;
  left: 0;
  width: 6px;
}
.edge-resize.is-right {
  top: 0;
  bottom: 0;
  right: 0;
  width: 6px;
}
'''
    save(css_path, css.rstrip() + nlc + extra.replace('\n', nlc))
    print('css topbar peek + edge zones')

# XAML：去掉 6px 外框留白
xaml = load(xaml_path)
nlx = '\r\n' if '\r\n' in xaml else '\n'
xaml = sub(
    xaml,
    'xaml margin',
    '<wv2:WebView2 x:Name="Browser" Margin="6" />',
    '<wv2:WebView2 x:Name="Browser" Margin="0" />',
    nlx,
)
xaml = xaml.replace('Background="#F2F4FA"', 'Background="#F3F1EA"')
xaml = xaml.replace('<Grid x:Name="RootGrid" Background="#F2F4FA">', '<Grid x:Name="RootGrid" Background="#F3F1EA">')
save(xaml_path, xaml)
print('MainWindow.xaml margin 0 + bg')
