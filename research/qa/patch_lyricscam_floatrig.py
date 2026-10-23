# -*- coding: utf-8 -*-
"""歌词镜头加旋转轴 + 磁贴漂浮随机旋转/漂动 + 点击命中改用射线（修改网格后聚焦飘走）"""
import io

P = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(P, 'r', encoding='utf-8', newline='').read()

# ---------- 1) 歌词镜头：旋转轴 + 滚转 ----------
old_state = "  let lyricCameraReady = false;\n"
new_state = """  let lyricCameraReady = false;
  // 歌词镜头的“旋转轴”：每换一句绕当前歌词换一个方位角，并叠加缓慢漂移、俯仰与画面滚转
  let lyricOrbit = 0;
  let lyricOrbitTarget = 0;
  let lyricPitchExtra = 0;
  let lyricPitchExtraTarget = 0;
  let lyricRoll = 0;
  let lyricRollTarget = 0;
"""
assert s.count(old_state) == 1
s = s.replace(old_state, new_state, 1)

old_block = """      const yaw = orbitYaw;
      const pitch = 0.2 + (orbitPitch - 0.42) * 0.7;
      const radius = 4.6 / Math.max(0.5, Math.min(1.8, zoom));
      lyricCamPos.set(
        lyricLookTarget.x + Math.sin(yaw) * Math.cos(pitch) * radius + Math.sin(seconds * 0.24) * 0.12,
        lyricLookTarget.y + Math.sin(pitch) * radius,
        lyricLookTarget.z + Math.cos(yaw) * Math.cos(pitch) * radius,
      );
"""
new_block = """      // 旋转轴目标：按句号错开方位角（每句镜头绕这句转到不同侧），再叠一点时间漂移
      const lyricIndex = Math.max(0, lyricActive);
      lyricOrbitTarget = Math.sin(lyricIndex * 0.92) * 0.55 + Math.sin(seconds * 0.16) * 0.22;
      lyricPitchExtraTarget = Math.sin(lyricIndex * 0.55) * 0.07;
      lyricRollTarget = Math.sin(lyricIndex * 0.7) * 0.045 + Math.sin(seconds * 0.28) * 0.008;
      lyricOrbit += (lyricOrbitTarget - lyricOrbit) * Math.min(1, delta * 2.2);
      lyricPitchExtra += (lyricPitchExtraTarget - lyricPitchExtra) * Math.min(1, delta * 2.2);
      lyricRoll += (lyricRollTarget - lyricRoll) * Math.min(1, delta * 1.9);
      const yaw = orbitYaw + lyricOrbit;
      const pitch = Math.max(0.02, Math.min(1.2, 0.2 + (orbitPitch - 0.42) * 0.7 + lyricPitchExtra));
      const radius = 4.6 / Math.max(0.5, Math.min(1.8, zoom));
      lyricCamPos.set(
        lyricLookTarget.x + Math.sin(yaw) * Math.cos(pitch) * radius + Math.sin(seconds * 0.24) * 0.12,
        lyricLookTarget.y + Math.sin(pitch) * radius,
        lyricLookTarget.z + Math.cos(yaw) * Math.cos(pitch) * radius,
      );
      camera.up.set(Math.sin(lyricRoll), Math.cos(lyricRoll), 0);
"""
assert s.count(old_block) == 1
s = s.replace(old_block, new_block, 1)

old_else = """    } else {
      lyricCameraReady = false;
      lyricCamVel.set(0, 0, 0);
      lyricLookVel.set(0, 0, 0);
    }
"""
new_else = """    } else {
      lyricCameraReady = false;
      lyricCamVel.set(0, 0, 0);
      lyricLookVel.set(0, 0, 0);
      lyricOrbit = 0;
      lyricOrbitTarget = 0;
      lyricPitchExtra = 0;
      lyricPitchExtraTarget = 0;
      lyricRoll = 0;
      lyricRollTarget = 0;
      camera.up.set(0, 1, 0);
    }
"""
assert s.count(old_else) == 1
s = s.replace(old_else, new_else, 1)

# ---------- 2) 磁贴漂浮：随机漂动 + 轻微随机旋转 ----------
old_pos = """      tile.group.position.x = slot.x + tile.pushX + jitterX * scatterEase + bendX;
      tile.group.position.y =
        slot.y + tile.pushY + (1 - appear) * -0.5 + t * 0.05 + sel * 0.06 + jitterY * scatterEase;
      tile.group.position.z =
        0.1 + t * 0.26 + sel * 0.22 - focusAmount * 0.45 + jitterZ * scatterEase * 1.8 + bendZ;
      tile.group.rotation.x = scatterEase * jitterY * 0.14;
      tile.group.rotation.z = -scatterEase * jitterX * 0.05;
"""
new_pos = """      // 漂浮感：每块磁贴有自己的慢速漂动与轻微随机旋转，聚焦/歌词模式自动减弱
      const idleSeed = tile.index * 1.618 + 0.37;
      const idleAmp = (1 - focusAmount * 0.8) * (1 - scatterEase);
      const idleX = Math.sin(seconds * 0.37 + idleSeed * 1.3) * 0.04 * idleAmp;
      const idleY = Math.sin(seconds * 0.52 + idleSeed * 2.1) * 0.06 * idleAmp;
      const idleZ = Math.cos(seconds * 0.29 + idleSeed * 0.7) * 0.07 * idleAmp;
      const idleRotX = Math.sin(seconds * 0.41 + idleSeed * 1.9) * 0.06 * idleAmp;
      const idleRotZ = Math.cos(seconds * 0.34 + idleSeed * 2.7) * 0.045 * idleAmp;
      tile.group.position.x = slot.x + tile.pushX + jitterX * scatterEase + bendX + idleX;
      tile.group.position.y =
        slot.y +
        tile.pushY +
        (1 - appear) * -0.5 +
        t * 0.05 +
        sel * 0.06 +
        jitterY * scatterEase +
        idleY;
      tile.group.position.z =
        0.1 +
        t * 0.26 +
        sel * 0.22 -
        focusAmount * 0.45 +
        jitterZ * scatterEase * 1.8 +
        bendZ +
        idleZ;
      tile.group.rotation.x = scatterEase * jitterY * 0.14 + idleRotX;
      tile.group.rotation.z = -scatterEase * jitterX * 0.05 + idleRotZ;
"""
assert s.count(old_pos) == 1
s = s.replace(old_pos, new_pos, 1)

# ---------- 3) 点击命中改用射线：命中真实变换后的磁贴，改行列数后不再错位 ----------
old_hit_fn = "  function tileIndexAtPointer(): number {\n"
new_hit_fn = """  function tileAtPointer(): number {
    if (!tileVisible) return -1;
    raycaster.setFromCamera(pointer, camera);
    const probes: THREE.Object3D[] = [];
    tiles.forEach((tile) => {
      if (tile.group.visible) probes.push(tile.hit);
    });
    const hits = raycaster.intersectObjects(probes, false);
    for (let i = 0; i < hits.length; i += 1) {
      const object = hits[i].object;
      const tile = tiles.find((candidate) => candidate.hit === object);
      if (tile) return tile.index;
    }
    return -1;
  }

  function tileIndexAtPointer(): number {
"""
assert s.count(old_hit_fn) == 1
s = s.replace(old_hit_fn, new_hit_fn, 1)

old_click = "    const hitTile = tileIndexAtPointer();\n"
new_click = "    const hitTile = tileAtPointer();\n"
assert s.count(old_click) == 1
s = s.replace(old_click, new_click, 1)

io.open(P, 'w', encoding='utf-8', newline='').write(s)
print('patched floatScene.ts')
