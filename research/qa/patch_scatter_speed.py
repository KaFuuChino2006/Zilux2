# -*- coding: utf-8 -*-
"""磁贴散开速度自定义。"""
import io

# ---------- floatScene ----------
p = r"E:\Zilux2开发\web\src\three\floatScene.ts"
s = io.open(p, 'r', encoding='utf-8', newline='').read()

old = "  setTilesScattered(scattered: boolean): void;"
assert s.count(old) == 1
s = s.replace(old, old + "\n  setScatterSpeed(speed: number): void;", 1)

old = "  let tileScatter = 0;"
assert s.count(old) == 1
s = s.replace(old, "  let tileScatter = 0;\n  let scatterSpeed = 1;", 1)

old = "    tileScatter += (tileScatterTarget - tileScatter) * Math.min(1, delta * 3.2);"
assert s.count(old) == 1
s = s.replace(
    old,
    "    tileScatter +=\n      (tileScatterTarget - tileScatter) * Math.min(1, delta * 3.2 * Math.max(0.2, Math.min(4, scatterSpeed)));",
    1,
)

# handle 实现：放在 setTilesScattered 实现后面
old = """    setTilesScattered(scattered: boolean) {"""
assert s.count(old) == 1
s = s.replace(old, """    setScatterSpeed(speed) {
      scatterSpeed = speed;
    },
    setTilesScattered(scattered: boolean) {""", 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('floatScene scatter speed')

# ---------- spaceShell ----------
p = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# 1) 面板滑块（插在散布封面之后）
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
old = """  const scatterCoversBtns = root.querySelectorAll<HTMLButtonElement>('[data-scatter-covers]');"""
assert s.count(old) == 1
s = s.replace(
    old,
    """  const scatterCoversBtns = root.querySelectorAll<HTMLButtonElement>('[data-scatter-covers]');
  const scatterSpeedInput = root.querySelector<HTMLInputElement>('[data-scatter-speed]')!;
  const scatterSpeedCurrent = root.querySelector<HTMLElement>('[data-scatter-speed-current]')!;""",
    1,
)

# 3) DEFAULT_CUSTOM / 解析
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

# 4) applyCustom
old = "    space?.setScatterCovers(custom.scatterCovers);"
assert s.count(old) == 1
s = s.replace(old, "    space?.setScatterCovers(custom.scatterCovers);\n    space?.setScatterSpeed(custom.scatterSpeed);", 1)

# 5) syncCustomUi
old = """    scatterCoversCurrent.textContent = custom.scatterCovers ? '开' : '关';"""
assert s.count(old) == 1
s = s.replace(
    old,
    """    scatterCoversCurrent.textContent = custom.scatterCovers ? '开' : '关';
    scatterSpeedInput.value = String(custom.scatterSpeed);
    scatterSpeedCurrent.textContent = `${custom.scatterSpeed.toFixed(1)}×`;""",
    1,
)

# 6) 事件绑定：跟在 scatterCovers 监听块之后
old = """  scatterCoversBtns.forEach((button) => {
    button.addEventListener('click', () => {
      custom.scatterCovers = button.dataset.scatterCovers === 'on';
      scatterCoversBtns.forEach((item) => item.classList.toggle('is-on', item === button));
      scatterCoversCurrent.textContent = custom.scatterCovers ? '开' : '关';
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

# 7) QA 参数
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
