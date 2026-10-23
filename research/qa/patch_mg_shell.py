# -*- coding: utf-8 -*-
"""spaceShell：MG 动画 + 歌词布局（随机落点 / 从下升起）的配置与面板接线。"""

import io

P = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
s = io.open(P, "r", encoding="utf-8", newline="").read()


def rep(old, new, count=1):
    global s
    assert s.count(old) == count, old[:90]
    s = s.replace(old, new, count)


# 1) DEFAULT_CUSTOM
rep(
    "    lyricSweep: true,\n",
    "    lyricSweep: true,\n    mgSweep: true,\n    mgLines: true,\n    lyricLayout: 'random' as 'random' | 'rise',\n",
)

# 2) parsed 类型
rep(
    "        lyricSweep?: unknown;",
    "        lyricSweep?: unknown;\n        mgSweep?: unknown;\n        mgLines?: unknown;\n        lyricLayout?: unknown;",
)

# 3) loadCustom 返回值
rep(
    "        lyricSweep: parsed.lyricSweep !== false,",
    """        lyricSweep: parsed.lyricSweep !== false,
        mgSweep: parsed.mgSweep !== false,
        mgLines: parsed.mgLines !== false,
        lyricLayout: parsed.lyricLayout === 'rise' ? 'rise' : 'random',""",
)

# 4) applyCustom
rep(
    "    space?.setScatterCovers(custom.scatterCovers);\n    space?.setLyricSweepEnabled(custom.lyricSweep);",
    """    space?.setScatterCovers(custom.scatterCovers);
    space?.setLyricSweepEnabled(custom.lyricSweep);
    space?.setLyricMg(custom.mgSweep, custom.mgLines);
    space?.setLyricLayout(custom.lyricLayout);""",
)

# 5) 模板：插在「几何划过」说明之后
rep(
    """                <p class="custom-tip">每换一句歌词，会有一道几何遮罩（斜带/圆环/菱形）划过文字</p>
              </div>""",
    """                <p class="custom-tip">每换一句歌词，会有一道几何遮罩（斜带/圆环/菱形）划过文字</p>
              </div>
              <div class="custom-field">
                <div class="custom-label"><span>歌词布局</span><b data-lyric-layout-current>随机落点</b></div>
                <div class="custom-seg" data-lyric-layout-seg>
                  <button class="custom-seg-btn is-on" data-lyric-layout="random" type="button">随机落点</button>
                  <button class="custom-seg-btn" data-lyric-layout="rise" type="button">从下升起</button>
                </div>
                <p class="custom-tip">从下升起：每句从画面下方升到落点，上一句被顶上去并淡出消失</p>
              </div>
              <div class="custom-field">
                <div class="custom-label"><span>MG 扫光</span><b data-mg-sweep-current>开</b></div>
                <div class="custom-seg" data-mg-sweep-seg>
                  <button class="custom-seg-btn is-on" data-mg-sweep="on" type="button">开</button>
                  <button class="custom-seg-btn" data-mg-sweep="off" type="button">关</button>
                </div>
                <p class="custom-tip">每换一句，3D 实色长条/斜带/竖条划过歌词（反差色）</p>
              </div>
              <div class="custom-field">
                <div class="custom-label"><span>MG 线条</span><b data-mg-lines-current>开</b></div>
                <div class="custom-seg" data-mg-lines-seg>
                  <button class="custom-seg-btn is-on" data-mg-lines="on" type="button">开</button>
                  <button class="custom-seg-btn" data-mg-lines="off" type="button">关</button>
                </div>
                <p class="custom-tip">每换一句，画面出现随机角度的几何线条装饰并淡出（MG PV 感）</p>
              </div>""",
)

# 6) 元素引用
rep(
    """  const lyricSweepBtns = root.querySelectorAll<HTMLButtonElement>('[data-lyric-sweep]');
  const lyricSweepCurrent = root.querySelector<HTMLElement>('[data-lyric-sweep-current]')!;""",
    """  const lyricSweepBtns = root.querySelectorAll<HTMLButtonElement>('[data-lyric-sweep]');
  const lyricSweepCurrent = root.querySelector<HTMLElement>('[data-lyric-sweep-current]')!;
  const lyricLayoutBtns = root.querySelectorAll<HTMLButtonElement>('[data-lyric-layout]');
  const lyricLayoutCurrent = root.querySelector<HTMLElement>('[data-lyric-layout-current]')!;
  const mgSweepBtns = root.querySelectorAll<HTMLButtonElement>('[data-mg-sweep]');
  const mgSweepCurrent = root.querySelector<HTMLElement>('[data-mg-sweep-current]')!;
  const mgLinesBtns = root.querySelectorAll<HTMLButtonElement>('[data-mg-lines]');
  const mgLinesCurrent = root.querySelector<HTMLElement>('[data-mg-lines-current]')!;""",
)

# 7) syncCustomUi
rep(
    "    lyricSweepCurrent.textContent = custom.lyricSweep ? '开' : '关';",
    """    lyricSweepCurrent.textContent = custom.lyricSweep ? '开' : '关';
    lyricLayoutBtns.forEach((button) => {
      button.classList.toggle('is-on', button.dataset.lyricLayout === custom.lyricLayout);
    });
    lyricLayoutCurrent.textContent = custom.lyricLayout === 'rise' ? '从下升起' : '随机落点';
    mgSweepBtns.forEach((button) => {
      button.classList.toggle('is-on', (button.dataset.mgSweep === 'on') === custom.mgSweep);
    });
    mgSweepCurrent.textContent = custom.mgSweep ? '开' : '关';
    mgLinesBtns.forEach((button) => {
      button.classList.toggle('is-on', (button.dataset.mgLines === 'on') === custom.mgLines);
    });
    mgLinesCurrent.textContent = custom.mgLines ? '开' : '关';""",
)

# 8) QA 参数
rep(
    """  const qaWallpaperPos = params.get('wallpaperpos');""",
    """  const qaLyricLayout = params.get('lyriclayout');
  if (qaLyricLayout === 'rise') custom.lyricLayout = 'rise';
  if (params.get('mgsweep') === '0') custom.mgSweep = false;
  if (params.get('mglines') === '0') custom.mgLines = false;
  const qaWallpaperPos = params.get('wallpaperpos');""",
)

# 9) 事件绑定（插在 lyricEnterBtns 绑定之前）
rep(
    """  lyricEnterBtns.forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.dataset.lyricEnter as LyricEnterStyle | undefined;""",
    """  lyricLayoutBtns.forEach((button) => {
    button.addEventListener('click', () => {
      custom.lyricLayout = button.dataset.lyricLayout === 'rise' ? 'rise' : 'random';
      syncCustomUi();
      space?.setLyricLayout(custom.lyricLayout);
      persistCustom();
    });
  });
  mgSweepBtns.forEach((button) => {
    button.addEventListener('click', () => {
      custom.mgSweep = button.dataset.mgSweep === 'on';
      syncCustomUi();
      space?.setLyricMg(custom.mgSweep, custom.mgLines);
      persistCustom();
    });
  });
  mgLinesBtns.forEach((button) => {
    button.addEventListener('click', () => {
      custom.mgLines = button.dataset.mgLines === 'on';
      syncCustomUi();
      space?.setLyricMg(custom.mgSweep, custom.mgLines);
      persistCustom();
    });
  });
  lyricEnterBtns.forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.dataset.lyricEnter as LyricEnterStyle | undefined;""",
)

io.open(P, "w", encoding="utf-8", newline="").write(s)
print("spaceShell MG/layout UI patched")
