# -*- coding: utf-8 -*-
"""1) 顶部拖动改为根节点接管（透明顶栏后仍可拖）；2) 修背景模糊完成瞬间再变模糊；3) 字体辨识度。"""
import io

APP = r'E:\Zilux2开发\web\src\ui\app.ts'
CSS = r'E:\Zilux2开发\web\src\styles\app.css'
THEME = r'E:\Zilux2开发\web\src\ui\theme.ts'


def load(path):
    text = io.open(path, 'r', encoding='utf-8', newline='').read()
    return text, ('\r\n' if '\r\n' in text else '\n')


def save(path, text):
    io.open(path, 'w', encoding='utf-8', newline='').write(text)


app_text, ae = load(APP)
old = """    // 拖动窗口：空白处按下即请求宿主拖动
    topbar.addEventListener('pointerdown', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest('button, input, .win-btns, .pill')) return;
      if (event.button !== 0) return;
      host.drag();
    });"""
new = """    // 拖动窗口：透明顶栏后改由根节点统一接管顶部这条空白带，
    // 从窗口最上沿到搜索框之间任意空白处都能拖，不影响下方内容与控件。
    this.root.addEventListener('pointerdown', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (event.button !== 0) return;
      if (event.clientY > 84) return;
      if (
        target.closest(
          'button, input, textarea, select, .win-btns, .pill, .rail, .sheet, .lyrics-view, .playerbar, .upnext, .quick, .account-wrap',
        )
      ) {
        return;
      }
      host.drag();
    });"""
o, x = old.replace('\n', ae), new.replace('\n', ae)
assert app_text.count(o) == 1, 'drag anchor'
app_text = app_text.replace(o, x)
save(APP, app_text)

theme_text, te = load(THEME)
theme_text = theme_text.replace("'--muted': '#6b7078',", "'--muted': '#565c66',", 1)
theme_text = theme_text.replace("'--text-soft': '#4b5058',", "'--text-soft': '#3c4149',", 1)
theme_text = theme_text.replace("'--line': 'rgba(24, 26, 32, 0.1)',", "'--line': 'rgba(24, 26, 32, 0.14)',", 1)
theme_text = theme_text.replace("'--line-strong': 'rgba(24, 26, 32, 0.18)',", "'--line-strong': 'rgba(24, 26, 32, 0.24)',", 1)
save(THEME, theme_text)

css, ce = load(CSS)
css += """
/* 修「模糊过渡结束后又突然更糊」：父层不要再套一层模糊/缩放，
   子层固定为常驻合成层，避免动画结束时重新光栅化导致模糊量跳变。 */
.app-bg,
.app.is-app-bg .app-bg {
  filter: none;
  transform: none;
}
.app-bg-layer {
  will-change: opacity;
  backface-visibility: hidden;
  transform: translateZ(0) scale(1.15);
}
.app-bg::after {
  background: rgb(var(--overlay-rgb) / 0.46);
}

/* 字体辨识度：正文使用更强的灰阶对比与更清晰的字距 */
body,
.app {
  text-rendering: geometricPrecision;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
.app {
  letter-spacing: 0.002em;
}
.poster-name,
.track-title,
.row-name,
.quick-cell-title,
.wall-title {
  letter-spacing: 0.004em;
}
""".replace('\n', ce)
save(CSS, css + '')
print('ok')
