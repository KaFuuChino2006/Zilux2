# -*- coding: utf-8 -*-
"""spaceShell：磁贴散开速度设置（floatScene 已单独打好）。"""
import io

p = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# 1) 面板滑块
old = """                <p class="custom-tip">开：歌词模式里封面散落在空间中；关：磁贴仍会散开，但过程中封面渐渐淡出、退出时淡入</p>
              </div>"""
assert s.count(old) == 1
s = s.replace(
    old,
    """                <p class="custom-tip">开：歌词模式里封面散落在空间中；关：磁贴仍会散开，但过程中封面渐渐淡出、退出时淡入</p>
              </div>
              <div class="custom-row">
                <div class="custom-label"><span>磁贴散开速度</span><b data-scatter-speed-current>1.0×</b></div>
                <input class="custom-slider" data-scatter-speed type="range" min="0.3" max="3" step="0.1" value="1" aria-label="磁贴散开速度" />
                <p class="custom-tip">进入/退出歌词时磁贴飞散的快慢（数值越大越快）</p>
              </div>""",
    1,
)

# 2) 元素引用
old = "  const scatterCoversBtns = root.querySelectorAll<HTMLButtonElement>('[data-scatter-covers]');"
assert s.count(old) == 1
s = s.replace(
    old,
    old
    + "\n  const scatterSpeedInput = root.querySelector<HTMLInputElement>('[data-scatter-speed]')!;"
    + "\n  const scatterSpeedCurrent = root.querySelector<HTMLElement>('[data-scatter-speed-current]')!;",
    1,
)

# 3) 默认值与解析
old = "    scatterCovers: true,"
assert s.count(old) == 1
s = s.replace(old, "    scatterCovers: true,\n    scatterSpeed: 1,", 1)

old = "        scatterCovers: parsed.scatterCovers !== false,"
assert s.count(old) == 1
s = s.replace(
    old,
    "        scatterCovers: parsed.scatterCovers !== false,\n        scatterSpeed:\n          typeof parsed.scatterSpeed === 'number'\n            ? Math.max(0.3, Math.min(3, parsed.scatterSpeed))\n            : 1,",
    1,
)

# 4) applyCustom（唯一上下文）
old = """    space?.setScatterCovers(custom.scatterCovers);
    space?.setLyricMg(custom.mgSweep, custom.mgLines);"""
assert s.count(old) == 1
s = s.replace(
    old,
    """    space?.setScatterCovers(custom.scatterCovers);
    space?.setScatterSpeed(custom.scatterSpeed);
    space?.setLyricMg(custom.mgSweep, custom.mgLines);""",
    1,
)

# 5) syncCustomUi
old = "    scatterCoversCurrent.textContent = custom.scatterCovers ? '开' : '关';"
assert s.count(old) == 1
s = s.replace(
    old,
    "    scatterCoversCurrent.textContent = custom.scatterCovers ? '开' : '关';\n"
    "    scatterSpeedInput.value = String(custom.scatterSpeed);\n"
    "    scatterSpeedCurrent.textContent = `${custom.scatterSpeed.toFixed(1)}×`;",
    1,
)

# 6) 事件
old = """  scatterCoversBtns.forEach((button) => {
    button.addEventListener('click', () => {
      custom.scatterCovers = button.dataset.scatterCovers === 'on';
      syncCustomUi();
      space?.setScatterCovers(custom.scatterCovers);
      persistCustom();
    });
  });"""
assert s.count(old) == 1
s = s.replace(
    old,
    old
    + """

  scatterSpeedInput.addEventListener('input', () => {
    const value = Number.parseFloat(scatterSpeedInput.value);
    if (!Number.isFinite(value)) return;
    custom.scatterSpeed = Math.max(0.3, Math.min(3, value));
    scatterSpeedCurrent.textContent = `${custom.scatterSpeed.toFixed(1)}×`;
    space?.setScatterSpeed(custom.scatterSpeed);
    persistCustom();
  });""",
    1,
)

# 7) QA
old = "  if (qaScatterCovers === '0') custom.scatterCovers = false;"
assert s.count(old) == 1
s = s.replace(
    old,
    old
    + """
  const qaScatterSpeed = Number.parseFloat(params.get('scatterspeed') ?? '');
  if (Number.isFinite(qaScatterSpeed)) {
    custom.scatterSpeed = Math.max(0.3, Math.min(3, qaScatterSpeed));
  }""",
    1,
)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('spaceShell scatter speed wired')
