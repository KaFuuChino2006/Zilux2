# -*- coding: utf-8 -*-
"""歌词：纵深穿插磁贴 + 60fps 进度 + 出入场动画。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

def rep(old, new, cnt=1):
    global s
    assert s.count(old) == cnt, (s.count(old), old[:70])
    s = s.replace(old, new, cnt)

# 1) 视图加 amount（出入场动画权重）
rep("""  plane: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  texture: THREE.CanvasTexture;""",
"""  plane: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  texture: THREE.CanvasTexture;
  amount: number;""")

# 2) 初始化 amount + 上一句状态
rep("""        text: '',
        translation: '',
        active: false,
      };""",
"""        text: '',
        translation: '',
        active: false,
        amount: 0,
      };""")
rep("""  let lyricActive = -1;
  let lyricProgress = 0;""",
"""  let lyricActive = -1;
  let lyricPrev = -1;
  let lyricProgress = 0;""")

# 3) 纵深：每句固定落点在磁贴墙前后穿插
rep("""    return out.set(
      Math.cos(angle) * 3.2 + drift,
      Math.sin(angle) * 1.0 + 0.35 + Math.sin(safe * 0.21) * 0.3,
      -safe * 0.24 + Math.sin(angle * 0.6) * 1.0,
    );""",
"""    // 纵深穿插：z 在磁贴墙前后 ±4 之间起伏，镜头穿行时歌词会从左邻右舍的封面之间钻出来
    const depth = Math.sin(safe * 0.77) * 3.2 + Math.sin(safe * 0.29) * 1.1;
    return out.set(
      Math.cos(angle) * 3.2 + drift,
      Math.sin(angle) * 1.0 + 0.35 + Math.sin(safe * 0.21) * 0.3,
      0.4 + depth,
    );""")

# 4) 深度测试打开（磁贴遮挡歌词 → 真正穿插）；仍不写深度
rep("""          transparent: true,
          depthWrite: false,
          depthTest: false,
        }),
      );
      plane.renderOrder = 40;""",
"""          transparent: true,
          depthWrite: false,
          depthTest: true,
        }),
      );
      plane.renderOrder = 40;""")

# 5) 重写 updateLyrics：上一句淡出上浮 + 当前句淡入上浮 + 每帧进度 uniform
start = s.index("  function updateLyrics(delta: number): void {")
end = s.index("  /* 详情磁贴", start)
new_fn = '''  function updateLyrics(delta: number): void {
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
    // 上一句：淡出 + 轻微上浮 + 缩一点，营造「飘走」的过渡
    if (lyricPrev >= 0 && lyricPrev !== active) {
      const prevSlot = ((lyricPrev % LYRIC_POOL) + LYRIC_POOL) % LYRIC_POOL;
      const prev = lyricLines[prevSlot];
      if (prev.index === lyricPrev && prev.amount > 0.01) {
        prev.amount = Math.max(0, prev.amount - delta * 2.8);
        lyricAnchor(lyricPrev, lyricAnchorTemp);
        prev.group.position.set(
          lyricAnchorTemp.x,
          lyricAnchorTemp.y + (1 - prev.amount) * 0.3,
          lyricAnchorTemp.z,
        );
        prev.group.scale.setScalar(0.94 + prev.amount * 0.06);
        prev.group.lookAt(camera.position);
        prev.plane.material.uniforms.uProgress!.value = 1;
        prev.plane.material.uniforms.uOpacity!.value = ease * prev.amount * 0.8;
        lyricSlotUsed.add(prevSlot);
        if (prev.amount <= 0.01) lyricPrev = -1;
      } else {
        lyricPrev = -1;
      }
    }
    // 当前句：淡入 + 从下方轻微上浮到固定落点
    if (active >= 0 && lyricData.length > 0) {
      const slot = active % LYRIC_POOL;
      const view = lyricLines[slot];
      const line = lyricData[active];
      if (view.index !== active) {
        view.index = active;
        view.active = true;
        view.text = line.text;
        view.translation = line.translation ?? '';
        view.amount = 0;
        paintLyricLine(view);
      }
      view.amount = Math.min(1, view.amount + delta * 3.4);
      const enter = view.amount * view.amount * (3 - 2 * view.amount);
      lyricAnchor(active, lyricAnchorTemp);
      view.group.position.set(
        lyricAnchorTemp.x,
        lyricAnchorTemp.y - (1 - enter) * 0.24,
        lyricAnchorTemp.z,
      );
      view.group.scale.setScalar(0.93 + enter * 0.07);
      view.group.lookAt(camera.position);
      const material = view.plane.material;
      material.uniforms.uProgress!.value = lyricProgress;
      material.uniforms.uOpacity!.value = ease * enter;
      lyricSlotUsed.add(slot);
    }
    lyricLines.forEach((view, k) => {
      if (!lyricSlotUsed.has(k)) {
        const material = view.plane.material;
        material.uniforms.uOpacity!.value = 0;
        if (view.index !== active && view.index !== lyricPrev) view.amount = 0;
      }
    });
    lyricGroup.position.x = 0;
    lyricGroup.position.y = 0;
    lyricGroup.rotation.z = 0;
    lyricGroup.rotation.y = 0;
  }

'''
s = s[:start] + new_fn + s[end:]

# 6) setLyricsTime：记录上一句，供淡出使用
rep("""      if (active !== lyricActive) {
        lyricActive = active;
        lyricProgress = 0;
      }""",
"""      if (active !== lyricActive) {
        if (lyricActive >= 0) lyricPrev = lyricActive;
        lyricActive = active;
        lyricProgress = 0;
      }""")

# 7) setLyrics 重置上一句
rep("""    setLyrics(lines: LyricLineData[]) {
      lyricData = lines;
      lyricActive = -1;
      ensureLyricLines();
    },""",
"""    setLyrics(lines: LyricLineData[]) {
      lyricData = lines;
      lyricActive = -1;
      lyricPrev = -1;
      ensureLyricLines();
    },""")

io.open(p, 'w', encoding='utf-8', newline='').write(s)

# 8) spaceShell：进度从 10fps 的 setInterval 改成每帧 rAF
q = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
t = io.open(q, 'r', encoding='utf-8', newline='').read()

def rep2(old, new, cnt=1):
    global t
    assert t.count(old) == cnt, (t.count(old), old[:70])
    t = t.replace(old, new, cnt)

rep2("""  let lyricsOpen = false;
  let lyricsTimer = 0;
  let lyricsTrackKey = '';""",
"""  let lyricsOpen = false;
  let lyricsTimer = 0;
  let lyricsTrackKey = '';

  // 歌词进度用 rAF 每帧同步（原来的 100ms 定时器只有 10fps，颜色变化会一顿一顿）
  function stepLyricsClock(): void {
    if (!lyricsOpen) return;
    space?.setLyricsTime(island.currentTime());
    lyricsTimer = window.requestAnimationFrame(stepLyricsClock);
  }""")

rep2("""    window.clearInterval(lyricsTimer);
    lyricsTimer = window.setInterval(() => {
      space?.setLyricsTime(island.currentTime());
    }, 100);""",
"""    window.cancelAnimationFrame(lyricsTimer);
    stepLyricsClock();""")

rep2("""    if (!lyricsOpen) return;
    lyricsOpen = false;
    window.clearInterval(lyricsTimer);
    lyricsTimer = 0;""",
"""    if (!lyricsOpen) return;
    lyricsOpen = false;
    window.cancelAnimationFrame(lyricsTimer);
    lyricsTimer = 0;""")

io.open(q, 'w', encoding='utf-8', newline='').write(t)
print('lyrics: depth interleave + 60fps progress + enter/exit animation')
