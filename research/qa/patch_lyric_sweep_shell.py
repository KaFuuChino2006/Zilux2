# -*- coding: utf-8 -*-
"""歌词几何遮罩划过：spaceShell 侧（面板/持久化/应用）。"""
import io

ss_path = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
s = io.open(ss_path, "r", encoding="utf-8", newline="").read()

pairs = [
    ("    scatterCovers: true,", "    scatterCovers: true,\n    lyricSweep: true,"),
    ("        scatterCovers?: unknown;", "        scatterCovers?: unknown;\n        lyricSweep?: unknown;"),
    ("        scatterCovers: parsed.scatterCovers !== false,",
     "        scatterCovers: parsed.scatterCovers !== false,\n        lyricSweep: parsed.lyricSweep !== false,"),
    ("""                <p class="custom-tip">开：歌词模式里封面散落在空间中；关：磁贴仍会散开，但过程中封面渐渐淡出、退出时淡入</p>
              </div>""",
     """                <p class="custom-tip">开：歌词模式里封面散落在空间中；关：磁贴仍会散开，但过程中封面渐渐淡出、退出时淡入</p>
              </div>
              <div class="custom-field">
                <div class="custom-label"><span>几何划过</span><b data-lyric-sweep-current>开</b></div>
                <div class="custom-seg" data-lyric-sweep-seg>
                  <button class="custom-seg-btn is-on" data-lyric-sweep="on" type="button">开</button>
                  <button class="custom-seg-btn" data-lyric-sweep="off" type="button">关</button>
                </div>
                <p class="custom-tip">每换一句歌词，会有一道几何遮罩（斜带/圆环/菱形）划过文字</p>
              </div>"""),
    ("  const scatterCoversCurrent = root.querySelector<HTMLElement>('[data-scatter-covers-current]')!;",
     "  const scatterCoversCurrent = root.querySelector<HTMLElement>('[data-scatter-covers-current]')!;\n  const lyricSweepBtns = root.querySelectorAll<HTMLButtonElement>('[data-lyric-sweep]');\n  const lyricSweepCurrent = root.querySelector<HTMLElement>('[data-lyric-sweep-current]')!;"),
    ("  const qaScatterCovers = params.get('scattercovers');",
     "  const qaLyricSweep = params.get('lyricsweep');\n  if (qaLyricSweep === '0') custom.lyricSweep = false;\n  if (qaLyricSweep === '1') custom.lyricSweep = true;\n  const qaScatterCovers = params.get('scattercovers');"),
    ("    scatterCoversCurrent.textContent = custom.scatterCovers ? '开' : '关';",
     "    scatterCoversCurrent.textContent = custom.scatterCovers ? '开' : '关';\n    lyricSweepBtns.forEach((button) => {\n      button.classList.toggle('is-on', (button.dataset.lyricSweep === 'on') === custom.lyricSweep);\n    });\n    lyricSweepCurrent.textContent = custom.lyricSweep ? '开' : '关';"),
    ("""  wordsWriteBtns.forEach((button) => {
    button.addEventListener('click', () => {""",
     """  lyricSweepBtns.forEach((button) => {
    button.addEventListener('click', () => {
      custom.lyricSweep = button.dataset.lyricSweep === 'on';
      syncCustomUi();
      space?.setLyricSweepEnabled(custom.lyricSweep);
      persistCustom();
    });
  });
  wordsWriteBtns.forEach((button) => {
    button.addEventListener('click', () => {"""),
]

for old, new in pairs:
    assert s.count(old) >= 1, "spaceShell anchor: " + old[:60]
    s = s.replace(old, new, 1)

# applyCustom 里的 setScatterCovers 之后补 setLyricSweepEnabled（取第一个出现处）
anchor = "    space?.setScatterCovers(custom.scatterCovers);"
idx = s.index(anchor)
s = s[:idx] + anchor + "\n    space?.setLyricSweepEnabled(custom.lyricSweep);" + s[idx + len(anchor):]

io.open(ss_path, "w", encoding="utf-8", newline="").write(s)
print("spaceShell lyric sweep patched")
