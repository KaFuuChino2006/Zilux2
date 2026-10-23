# -*- coding: utf-8 -*-
"""背景粒子层（星点/连线/三角）+ 歌词字体悬停预览；一次性补丁。"""
import io, sys

ROOT = r"E:/Zilux2开发/web/src"
JS = ROOT + "/ui/spaceShell.ts"
CSS = ROOT + "/styles/space.css"

def load(p):
    with io.open(p, encoding="utf-8") as f:
        return f.read()

def save(p, s):
    with io.open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(s)

def rep(s, old, new, label):
    n = s.count(old)
    if n != 1:
        print("FAIL", label, "count=", n)
        sys.exit(1)
    return s.replace(old, new)

js = load(JS)
css = load(CSS)

# ---------- 1. 背景粒子 canvas ----------
js = rep(
    js,
    '    <div class="space-bg" data-space-bg></div>\n',
    '    <div class="space-bg" data-space-bg></div>\n    <canvas class="space-fx" data-space-fx aria-hidden="true"></canvas>\n',
    "fx canvas",
)

# ---------- 2. 歌词字体：自定义下拉（悬停预览） ----------
old_font = '''                <div class="custom-row">
                  <div class="custom-label"><span>歌词字体</span><b data-lyric-font-current>默认</b></div>
                  <select class="custom-select" data-lyric-font>
                    <option value="">默认（系统黑体）</option>
                  </select>
                  <p class="custom-tip">使用本机已安装字体，切换后当前歌词立即重绘</p>
                </div>'''
new_font = '''                <div class="custom-row custom-font-row">
                  <div class="custom-label"><span>歌词字体</span><b data-lyric-font-current>默认</b></div>
                  <div class="custom-fontpicker" data-font-picker>
                    <button class="custom-font-trigger" data-font-trigger type="button" aria-expanded="false">
                      <span data-font-value>默认（系统黑体）</span>
                      <i class="custom-font-caret">▾</i>
                    </button>
                    <div class="custom-font-menu" data-font-menu hidden>
                      <div class="custom-font-list" data-font-list></div>
                    </div>
                  </div>
                  <div class="custom-font-preview" data-font-preview>让每一句歌词，都长成你喜欢的样子</div>
                  <p class="custom-tip">鼠标移到字体上即可预览效果，点一下应用</p>
                </div>'''
js = rep(js, old_font, new_font, "font field html")

# ---------- 3. 背景粒子选项（空间节末尾） ----------
old_tail = '''            <div class="custom-field">
              <div class="custom-label"><span>壁纸位置</span><b data-wallpaper-pos-current>填充</b></div>
              <div class="custom-seg" data-wallpaper-pos-seg>
                <button class="custom-seg-btn is-on" data-wallpaper-pos="cover" type="button">填充</button>
                <button class="custom-seg-btn" data-wallpaper-pos="contain" type="button">适应</button>
                <button class="custom-seg-btn" data-wallpaper-pos="center" type="button">居中</button>
              </div>
              <p class="custom-tip">空间背景图的铺放方式（选了自定义背景图后生效）</p>
            </div>
          </section>'''
new_tail = '''            <div class="custom-field">
              <div class="custom-label"><span>壁纸位置</span><b data-wallpaper-pos-current>填充</b></div>
              <div class="custom-seg" data-wallpaper-pos-seg>
                <button class="custom-seg-btn is-on" data-wallpaper-pos="cover" type="button">填充</button>
                <button class="custom-seg-btn" data-wallpaper-pos="contain" type="button">适应</button>
                <button class="custom-seg-btn" data-wallpaper-pos="center" type="button">居中</button>
              </div>
              <p class="custom-tip">空间背景图的铺放方式（选了自定义背景图后生效）</p>
            </div>
            <div class="custom-field">
              <div class="custom-label"><span>背景粒子</span><b data-fx-current>关闭</b></div>
              <div class="custom-seg" data-fx-seg>
                <button class="custom-seg-btn is-on" data-fx="off" type="button">关</button>
                <button class="custom-seg-btn" data-fx="stars" type="button">星点</button>
                <button class="custom-seg-btn" data-fx="links" type="button">连线</button>
                <button class="custom-seg-btn" data-fx="triangles" type="button">三角</button>
              </div>
              <div class="custom-sub" data-fx-options hidden>
                <div class="custom-label"><span>数量</span><b data-fx-count-current>90</b></div>
                <input class="custom-slider" data-fx-count type="range" min="16" max="200" step="2" value="90" aria-label="背景粒子数量" />
                <div class="custom-label"><span>速度</span><b data-fx-speed-current>1.0x</b></div>
                <input class="custom-slider" data-fx-speed type="range" min="0.2" max="2.4" step="0.1" value="1" aria-label="背景粒子速度" />
                <div class="custom-label"><span>大小</span><b data-fx-size-current>1.0x</b></div>
                <input class="custom-slider" data-fx-size type="range" min="0.4" max="2.4" step="0.1" value="1" aria-label="背景粒子大小" />
                <div class="custom-label"><span>透明度</span><b data-fx-opacity-current>70%</b></div>
                <input class="custom-slider" data-fx-opacity type="range" min="10" max="100" step="5" value="70" aria-label="背景粒子透明度" />
                <div class="custom-label"><span>连线距离</span><b data-fx-link-current>140</b></div>
                <input class="custom-slider" data-fx-link type="range" min="60" max="280" step="10" value="140" aria-label="连线触发距离" />
              </div>
              <p class="custom-tip">磁贴后方的粒子层：星点漂浮 / 近距离自动连线 / 漂浮三角</p>
            </div>
          </section>'''
js = rep(js, old_tail, new_tail, "fx controls")

# ---------- 4. CSS ----------
css += '''
/* ---------- 歌词字体：自定义下拉，悬停即预览 ---------- */
.custom-font-row {
  align-items: flex-start;
}
.custom-fontpicker {
  position: relative;
}
.custom-font-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  height: 30px;
  padding: 0 10px;
  border-radius: 9px;
  border: 1px solid rgba(23, 26, 33, 0.14);
  background: #fff;
  color: #2a2f3c;
  font-size: 12px;
  cursor: pointer;
}
.custom-font-trigger:hover {
  border-color: rgba(23, 26, 33, 0.26);
}
.custom-font-caret {
  font-style: normal;
  font-size: 10px;
  opacity: 0.5;
}
.custom-font-menu {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100% + 6px);
  z-index: 20;
  max-height: 260px;
  overflow-y: auto;
  padding: 6px;
  border-radius: 12px;
  border: 1px solid rgba(23, 26, 33, 0.12);
  background: #fff;
  box-shadow: 0 18px 40px rgba(23, 26, 33, 0.18);
}
.custom-font-menu[hidden] {
  display: none !important;
}
.custom-font-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.custom-font-item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 8px;
  border: 0;
  border-radius: 8px;
  background: none;
  color: #2a2f3c;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.custom-font-item:hover,
.custom-font-item.is-active {
  background: rgba(216, 183, 74, 0.18);
}
.custom-font-name {
  flex: none;
}
.custom-font-sample {
  color: #6b7280;
  font-size: 12px;
  white-space: nowrap;
}
.custom-font-preview {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.5);
  border: 1px dashed rgba(23, 26, 33, 0.14);
  color: #2a2f3c;
  font-size: 15px;
  line-height: 1.4;
}
.space-shell.theme-gold .custom-font-trigger {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(212, 175, 55, 0.28);
  color: #f0e7d2;
}
.space-shell.theme-gold .custom-font-menu {
  background: rgba(24, 21, 14, 0.98);
  border-color: rgba(212, 175, 55, 0.28);
}
.space-shell.theme-gold .custom-font-item {
  color: #efe6cf;
}
.space-shell.theme-gold .custom-font-item:hover,
.space-shell.theme-gold .custom-font-item.is-active {
  background: rgba(216, 183, 74, 0.22);
}
.space-shell.theme-gold .custom-font-sample {
  color: #bdb29a;
}
.space-shell.theme-gold .custom-font-preview {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(212, 175, 55, 0.22);
  color: #f2e9d3;
}

/* ---------- 背景粒子层 ---------- */
.space-fx {
  position: absolute;
  inset: 0;
  z-index: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.space-fx[hidden] {
  display: none !important;
}
'''

save(JS, js)
save(CSS, css)
print("OK part1")
