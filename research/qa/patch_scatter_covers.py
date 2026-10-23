# -*- coding: utf-8 -*-
"""歌词散布：开关「散布时显示封面」。关闭时仍散布，但封面渐变消失/退场渐变出现。"""
import io

fs_path = r"E:\Zilux2开发\web\src\three\floatScene.ts"
ss_path = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"

# ---------- floatScene ----------
s = io.open(fs_path, "r", encoding="utf-8", newline="").read()

pairs = [
    ("  setTilesScattered(scattered: boolean): void;",
     "  setTilesScattered(scattered: boolean): void;\n  /** 散布时是否显示封面上浮（关闭则散布过程中封面淡出，退场时再淡入） */\n  setScatterCovers(visible: boolean): void;"),

    ("  let tileScatter = 0;", "  let tileScatter = 0;\n  let scatterCovers = true;"),

    ("      tile.plane.material.opacity = appear;",
     "      // 「散布封面」关闭时：散布过程中封面随散布进度淡出，回收时再随进度淡入\n      tile.plane.material.opacity = appear * (scatterCovers ? 1 : Math.max(0, 1 - scatterEase));"),

    ("""    setTilesScattered(scattered: boolean) {""",
     """    setScatterCovers(visible: boolean) {
      scatterCovers = visible;
      if (!visible) refreshTiles();
    },
    setTilesScattered(scattered: boolean) {"""),
]

for old, new in pairs:
    assert s.count(old) == 1, "floatScene anchor: " + old[:50]
    s = s.replace(old, new, 1)

io.open(fs_path, "w", encoding="utf-8", newline="").write(s)
print("floatScene scatter covers patched")

# ---------- spaceShell ----------
s = io.open(ss_path, "r", encoding="utf-8", newline="").read()

pairs = [
    # 默认值
    ("    lyricAnimOpen: true,", "    lyricAnimOpen: true,\n    scatterCovers: true,"),

    # 解析字段类型
    ("        lyricAnimOpen?: unknown;", "        lyricAnimOpen?: unknown;\n        scatterCovers?: unknown;"),

    # 解析值
    ("        lyricAnimOpen: parsed.lyricAnimOpen !== false,",
     "        lyricAnimOpen: parsed.lyricAnimOpen !== false,\n        scatterCovers: parsed.scatterCovers !== false,"),

    # 面板：在「出入场方式」字段后插入「散布封面」字段
    ("""                <p class="custom-tip">3D 歌词每一句进入、离开的方式</p>
              </div>""",
     """                <p class="custom-tip">3D 歌词每一句进入、离开的方式</p>
              </div>
              <div class="custom-field">
                <div class="custom-label"><span>散布封面</span><b data-scatter-covers-current>开</b></div>
                <div class="custom-seg" data-scatter-covers-seg>
                  <button class="custom-seg-btn is-on" data-scatter-covers="on" type="button">开</button>
                  <button class="custom-seg-btn" data-scatter-covers="off" type="button">关</button>
                </div>
                <p class="custom-tip">开：歌词模式里封面散落在空间中；关：磁贴仍会散开，但过程中封面渐渐淡出、退出时淡入</p>
              </div>"""),

    # 元素引用
    ("  const wordsWriteBtns = root.querySelectorAll<HTMLButtonElement>('[data-words-write]');",
     "  const wordsWriteBtns = root.querySelectorAll<HTMLButtonElement>('[data-words-write]');\n  const scatterCoversBtns = root.querySelectorAll<HTMLButtonElement>('[data-scatter-covers]');\n  const scatterCoversCurrent = root.querySelector<HTMLElement>('[data-scatter-covers-current]')!;"),

    # QA 参数
    ("  const qaWordsWrite = params.get('wordswrite');",
     "  const qaScatterCovers = params.get('scattercovers');\n  if (qaScatterCovers === '0') custom.scatterCovers = false;\n  if (qaScatterCovers === '1') custom.scatterCovers = true;\n  const qaWordsWrite = params.get('wordswrite');"),

    # applyCustom：调用
    ("    space?.setLyricEnterStyle(custom.lyricEnter);",
     "    space?.setLyricEnterStyle(custom.lyricEnter);\n    space?.setScatterCovers(custom.scatterCovers);"),

    # syncCustomUi
    ("    wordsFillCurrent.textContent = custom.wordsFill ? '开' : '关';",
     "    wordsFillCurrent.textContent = custom.wordsFill ? '开' : '关';\n    scatterCoversBtns.forEach((button) => {\n      button.classList.toggle('is-on', (button.dataset.scatterCovers === 'on') === custom.scatterCovers);\n    });\n    scatterCoversCurrent.textContent = custom.scatterCovers ? '开' : '关';"),

    # 事件监听：挂在 wordsWrite 监听之后
    ("""  wordsWriteBtns.forEach((button) => {
    button.addEventListener('click', () => {""",
     """  scatterCoversBtns.forEach((button) => {
    button.addEventListener('click', () => {
      custom.scatterCovers = button.dataset.scatterCovers === 'on';
      syncCustomUi();
      space?.setScatterCovers(custom.scatterCovers);
      persistCustom();
    });
  });
  wordsWriteBtns.forEach((button) => {
    button.addEventListener('click', () => {"""),
]

for old, new in pairs:
    assert s.count(old) == 1, "spaceShell anchor: " + old[:60]
    s = s.replace(old, new, 1)

io.open(ss_path, "w", encoding="utf-8", newline="").write(s)
print("spaceShell scatter covers patched")
