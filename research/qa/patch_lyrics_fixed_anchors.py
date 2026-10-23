# -*- coding: utf-8 -*-
"""歌词改为「每句在空间里有自己的固定落点」：19 片环形池、窗口随播放滑动，各句位置不随切句移动。"""
import io

SCENE = r'E:\Zilux2开发\web\src\three\floatScene.ts'
p = SCENE
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# 1) 常量
old = """  const LYRIC_SLOTS = 7;
  const LYRIC_ACTIVE_SLOT = 3;"""
new = """  const LYRIC_POOL = 19;
  const LYRIC_WINDOW = 8;
  const lyricSlotUsed = new Set<number>();"""
assert s.count(old) == 1, 'consts'
s = s.replace(old, new, 1)

# 2) 类型加 index
old = """export interface LyricLineView {
  group: THREE.Group;"""
new = """export interface LyricLineView {
  index: number;
  group: THREE.Group;"""
assert s.count(old) == 1, 'interface'
s = s.replace(old, new, 1)

# 3) 池循环（ensureLyricLines 与 syncLyricSlots 各一处）
old = "    for (let i = 0; i < LYRIC_SLOTS; i += 1) {"
new = "    for (let i = 0; i < LYRIC_POOL; i += 1) {"
assert s.count(old) == 2, 'loops'
s = s.replace(old, new)

# 4) canvas 尺寸
old = """      canvas.width = 1536;
      canvas.height = 384;"""
new = """      canvas.width = 1024;
      canvas.height = 256;"""
assert s.count(old) == 1, 'canvas'
s = s.replace(old, new, 1)

# 5) 初始不排序（落点由行号决定）
old = "      group.position.y = (LYRIC_ACTIVE_SLOT - i) * 1.32;"
new = "      group.position.y = 0;"
assert s.count(old) == 1, 'group y'
s = s.replace(old, new, 1)

# 6) view 初始化加 index
old = """      const view: LyricLineView = {
        group,"""
new = """      const view: LyricLineView = {
        index: -1,
        group,"""
assert s.count(old) == 1, 'view init'
s = s.replace(old, new, 1)

# 7) 字号（1024 宽画布）
pairs = [
    ("      view.active ? 84 : 62,\n      view.active ? 50 : 40,", "      view.active ? 56 : 42,\n      view.active ? 34 : 28,"),
    ("        view.active ? 40 : 32,\n        view.active ? 26 : 22,", "        view.active ? 28 : 22,\n        view.active ? 18 : 15,"),
]
for old, new in pairs:
    assert s.count(old) == 1, old[:40]
    s = s.replace(old, new, 1)

# 8) 落点更开阔（x/y/纵深）
old = "    return out.set((r1 - 0.5) * 5.6, (r2 - 0.5) * 2.8 + 0.35, (r3 - 0.5) * 3.4 + 0.6);"
new = "    return out.set((r1 - 0.5) * 7.2, (r2 - 0.5) * 3.6 + 0.4, (r3 - 0.5) * 6.4 - 0.6);"
assert s.count(old) == 1, 'anchor'
s = s.replace(old, new, 1)

# 9) 重写 updateLyrics
start_marker = "  function updateLyrics(delta: number): void {"
end_marker = "\n  }\n\n  /* 详情磁贴"
i = s.index(start_marker)
j = s.index(end_marker, i)
new_func = '''  function updateLyrics(delta: number): void {
    const target = lyricVisible ? 1 : 0;
    lyricAmount += (target - lyricAmount) * Math.min(1, delta * 3.0);
    if (!lyricGroup) {
      if (lyricAmount > 0.01) ensureLyricLines();
      if (!lyricGroup) return;
    }
    lyricGroup.visible = lyricAmount > 0.02;
    if (!lyricGroup.visible) return;
    const ease = lyricAmount * lyricAmount * (3 - 2 * lyricAmount);
    const active = lyricActive;
    lyricSlotUsed.clear();
    if (active >= 0 && lyricData.length > 0) {
      const start = Math.max(0, active - LYRIC_WINDOW);
      const end = Math.min(lyricData.length - 1, active + LYRIC_WINDOW);
      for (let index = start; index <= end; index += 1) {
        const slot = index % LYRIC_POOL;
        const view = lyricLines[slot];
        const line = lyricData[index];
        const isActive = index === active;
        if (view.index !== index || view.active !== isActive) {
          view.index = index;
          view.active = isActive;
          view.text = line.text;
          view.translation = line.translation ?? '';
          paintLyricLine(view);
        }
        // 每句在空间里的落点由行号决定：同一句永远在同一处，镜头逐个飞过去对准
        lyricAnchor(index, lyricAnchorTemp);
        view.group.position.copy(lyricAnchorTemp);
        const dist = Math.abs(index - active);
        const scale = isActive ? 1 : dist <= 2 ? 0.7 : dist <= 5 ? 0.5 : 0.36;
        view.group.scale.setScalar(scale);
        view.group.lookAt(camera.position);
        const alpha = isActive ? 1 : dist <= 2 ? 0.5 : dist <= 5 ? 0.26 : 0.12;
        view.plane.material.opacity = alpha * ease;
        lyricSlotUsed.add(slot);
      }
    }
    lyricLines.forEach((view, k) => {
      if (!lyricSlotUsed.has(k)) view.plane.material.opacity = 0;
    });
    lyricGroup.position.x = 0;
    lyricGroup.position.y = 0;
    lyricGroup.rotation.z = 0;
    lyricGroup.rotation.y = 0;
  }'''
s = s[:i] + new_func + s[j:]

# 10) 删除 syncLyricSlots 函数
a = s.index("  function syncLyricSlots(): void {")
b = s.index("\n  const lyricAnchorTemp", a)
s = s[:a] + s[b + 1:]

# 11) 删除调用点
old = """      lyricData = lines;
      lyricActive = -1;
      ensureLyricLines();
      syncLyricSlots();"""
new = """      lyricData = lines;
      lyricActive = -1;
      ensureLyricLines();"""
assert s.count(old) == 1, 'setLyrics'
s = s.replace(old, new, 1)

old = """      if (active !== lyricActive) {
        lyricActive = active;
        syncLyricSlots();
      }"""
new = """      if (active !== lyricActive) {
        lyricActive = active;
      }"""
assert s.count(old) == 1, 'setLyricsTime'
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('floatScene: per-line fixed lyric anchors (pool 19, window 8)')
