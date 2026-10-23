# -*- coding: utf-8 -*-
"""spaceShell：接入经典歌词布局（左词右封面）选项。"""
import io

p = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# 1) 类型/默认值/解析
s = s.replace("    lyricLayout: 'random' as 'random' | 'rise',", "    lyricLayout: 'random' as 'random' | 'rise' | 'classic',", 1)
s = s.replace(
    "        lyricLayout: parsed.lyricLayout === 'rise' ? 'rise' : 'random',",
    "        lyricLayout:\n          parsed.lyricLayout === 'rise'\n            ? 'rise'\n            : parsed.lyricLayout === 'classic'\n              ? 'classic'\n              : 'random',",
    1,
)

# 2) 面板按钮：增加第三种
old = """                  <button class="custom-seg-btn" data-lyric-layout="rise" type="button">从下升起</button>
                </div>"""
assert s.count(old) == 1
s = s.replace(
    old,
    """                  <button class="custom-seg-btn" data-lyric-layout="rise" type="button">从下升起</button>
                  <button class="custom-seg-btn" data-lyric-layout="classic" type="button">左词右封面</button>
                </div>""",
    1,
)

# 3) 文案提示
s = s.replace(
    "<p class=\"custom-tip\">从下升起：每句从画面下方升到落点，上一句被顶上去并淡出消失</p>",
    "<p class=\"custom-tip\">从下升起：每句从画面下方升到落点；左词右封面：左侧竖排滚动歌词 + 右侧悬浮封面（经典播放器样式）</p>",
    1,
)

# 4) syncCustomUi 文案
s = s.replace(
    "    lyricLayoutCurrent.textContent = custom.lyricLayout === 'rise' ? '从下升起' : '随机落点';",
    "    lyricLayoutCurrent.textContent =\n      custom.lyricLayout === 'rise' ? '从下升起' : custom.lyricLayout === 'classic' ? '左词右封面' : '随机落点';",
    1,
)

# 5) 事件：解析值
s = s.replace(
    "      custom.lyricLayout = button.dataset.lyricLayout === 'rise' ? 'rise' : 'random';",
    "      custom.lyricLayout =\n        button.dataset.lyricLayout === 'rise'\n          ? 'rise'\n          : button.dataset.lyricLayout === 'classic'\n            ? 'classic'\n            : 'random';",
    1,
)

# 6) QA 参数支持 classic
s = s.replace(
    "  if (qaLyricLayout === 'rise') custom.lyricLayout = 'rise';",
    "  if (qaLyricLayout === 'rise') custom.lyricLayout = 'rise';\n  if (qaLyricLayout === 'classic') custom.lyricLayout = 'classic';",
    1,
)

# 7) 进入歌词：经典模式设置封面；退出清除
old = """    space?.unfocusTile();
    setMgCornersVisible(true);
    await loadLyrics3d(track);"""
assert s.count(old) == 1
s = s.replace(
    old,
    """    space?.unfocusTile();
    setMgCornersVisible(true);
    space?.setClassicCover(custom.lyricLayout === 'classic' ? track.cover ?? null : null);
    await loadLyrics3d(track);""",
    1,
)

old = """  function exitLyricsView(): void {
    setMgCornersVisible(false);"""
assert s.count(old) == 1
s = s.replace(
    old,
    """  function exitLyricsView(): void {
    setMgCornersVisible(false);
    space?.setClassicCover(null);""",
    1,
)

# 8) 换歌时（歌词打开且经典模式）更新右侧封面：挂到 onTrack
old = """    onTrack: (track) => {
      void refreshLikedState(track);"""
if s.count(old) == 1:
    s = s.replace(
        old,
        """    onTrack: (track) => {
      void refreshLikedState(track);
      if (lyricsOpen && custom.lyricLayout === 'classic') {
        space?.setClassicCover(track.cover ?? null);
      }""",
        1,
    )
else:
    print('WARN onTrack anchor missing')

# 9) applyCustom 切换布局时同步封面
old = "    space?.setLyricLayout(custom.lyricLayout);"
assert s.count(old) >= 1
s = s.replace(
    old,
    """    space?.setLyricLayout(custom.lyricLayout);
    space?.setClassicCover(
      lyricsOpen && custom.lyricLayout === 'classic' ? island?.currentTrack()?.cover ?? null : null,
    );""",
    1,
)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('spaceShell classic option wired')
