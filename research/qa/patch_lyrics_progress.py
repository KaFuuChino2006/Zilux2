# -*- coding: utf-8 -*-
"""歌词：句子间距加大、只显示正在唱的一句（前后句隐藏）、当前句下方加播放进度条。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# 1) 状态：进度
old = """  let lyricActive = -1;"""
new = """  let lyricActive = -1;
  let lyricProgress = 0;
  let lyricProgressMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null = null;"""
assert s.count(old) == 1, 'state'
s = s.replace(old, new, 1)

# 2) 创建进度条（在 ensureLyricLines 的循环之后、函数结尾前）
old = """      paintLyricLine(view);
      lyricLines.push(view);
    }
  }"""
new = """      paintLyricLine(view);
      lyricLines.push(view);
    }
    // 当前句下方的播放进度条（从左往右长）
    const progressGeo = new THREE.PlaneGeometry(1, 0.042);
    progressGeo.translate(0.5, 0, 0);
    const progressMat = new THREE.MeshBasicMaterial({
      color: 0xbda8ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
    });
    lyricProgressMesh = new THREE.Mesh(progressGeo, progressMat);
    lyricProgressMesh.renderOrder = 42;
    lyricGroup.add(lyricProgressMesh);
  }"""
assert s.count(old) == 1, 'ensure lyric lines tail'
s = s.replace(old, new, 1)

# 3) 句子间距加大
old = """    // 顺序蜿蜒走廊：相邻句紧挨着（约 1.2~1.6 单位），镜头逐句平滑推进，不会来回乱晃
    const angle = safe * 0.55;
    const drift = Math.sin(safe * 0.13) * 0.55;
    return out.set(
      Math.cos(angle) * 2.5 + drift,
      Math.sin(angle) * 0.85 + 0.35 + Math.sin(safe * 0.21) * 0.22,
      -safe * 0.17 + Math.sin(angle * 0.6) * 0.9,
    );"""
new = """    // 顺序蜿蜒走廊：相邻句拉开到约 2.5~3 单位，镜头逐句平滑推进，前后句各自有固定位置
    const angle = safe * 0.8;
    const drift = Math.sin(safe * 0.13) * 0.7;
    return out.set(
      Math.cos(angle) * 3.2 + drift,
      Math.sin(angle) * 1.0 + 0.35 + Math.sin(safe * 0.21) * 0.3,
      -safe * 0.24 + Math.sin(angle * 0.6) * 1.0,
    );"""
assert s.count(old) == 1, 'anchor'
s = s.replace(old, new, 1)

# 4) updateLyrics：只显示当前句 + 进度条
start_marker = "  function updateLyrics(delta: number): void {"
end_marker = "  /* 详情磁贴"
a = s.index(start_marker)
b = s.index(end_marker, a)
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
      const slot = active % LYRIC_POOL;
      const view = lyricLines[slot];
      const line = lyricData[active];
      if (view.index !== active) {
        view.index = active;
        view.active = true;
        view.text = line.text;
        view.translation = line.translation ?? '';
        paintLyricLine(view);
      }
      // 每句的固定落点由行号决定；只显示正在唱的这一句，已唱/未唱的都不显示
      lyricAnchor(active, lyricAnchorTemp);
      view.group.position.copy(lyricAnchorTemp);
      view.group.scale.setScalar(1);
      view.group.lookAt(camera.position);
      view.plane.material.opacity = ease;
      lyricSlotUsed.add(slot);
      // 进度条：贴着这句下方，按屏幕左右方向从左往右生长
      if (lyricProgressMesh) {
        const width = 3.0;
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        lyricProgressMesh.quaternion.copy(camera.quaternion);
        lyricProgressMesh.position.copy(lyricAnchorTemp);
        lyricProgressMesh.position.y -= 0.52;
        lyricProgressMesh.position.addScaledVector(right, -width * 0.47);
        lyricProgressMesh.scale.set(width * Math.max(0.02, Math.min(1, lyricProgress)), 1, 1);
        lyricProgressMesh.material.opacity = 0.9 * ease;
        lyricProgressMesh.visible = true;
      }
    }
    if (!lyricProgressMesh || !lyricSlotUsed.size) {
      if (lyricProgressMesh) lyricProgressMesh.material.opacity = 0;
    }
    lyricLines.forEach((view, k) => {
      if (!lyricSlotUsed.has(k)) view.plane.material.opacity = 0;
    });
    lyricGroup.position.x = 0;
    lyricGroup.position.y = 0;
    lyricGroup.rotation.z = 0;
    lyricGroup.rotation.y = 0;
  }

'''
s = s[:a] + new_func + s[b:]

# 5) setLyricsTime 计算进度
old = """    setLyricsTime(current: number) {
      if (!lyricVisible || lyricData.length === 0) return;
      let active = -1;
      for (let i = 0; i < lyricData.length; i += 1) {
        if (lyricData[i].startTime <= current + 0.05) active = i;
        else break;
      }
      if (active !== lyricActive) {
        lyricActive = active;
      }
    },"""
new = """    setLyricsTime(current: number) {
      if (!lyricVisible || lyricData.length === 0) return;
      let active = -1;
      for (let i = 0; i < lyricData.length; i += 1) {
        if (lyricData[i].startTime <= current + 0.05) active = i;
        else break;
      }
      if (active !== lyricActive) {
        lyricActive = active;
        lyricProgress = 0;
      }
      const line = active >= 0 ? lyricData[active] : null;
      const next = active >= 0 ? lyricData[active + 1] : null;
      if (line) {
        const start = line.startTime;
        const end = next ? next.startTime : start + 4;
        lyricProgress = end > start ? Math.min(1, Math.max(0, (current - start) / (end - start))) : 0;
      }
    },"""
assert s.count(old) == 1, 'setLyricsTime'
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('lyrics: wider spacing, active-only, progress bar')
