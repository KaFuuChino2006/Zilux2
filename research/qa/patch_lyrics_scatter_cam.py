# -*- coding: utf-8 -*-
"""3D 歌词：散落在空间各处 + 相机跟随当前句；歌词模式禁用磁贴鼠标检测。"""
import io

SCENE = r'E:\Zilux2开发\web\src\three\floatScene.ts'


def read(p):
    return io.open(p, 'r', encoding='utf-8', newline='').read()


def write(p, t):
    io.open(p, 'w', encoding='utf-8', newline='').write(t)


s = read(SCENE)

# 1) 歌词行改为空间中散布的锚点 + 相机跟随
old = """  function updateLyrics(delta: number): void {
    const target = lyricVisible ? 1 : 0;
    lyricAmount += (target - lyricAmount) * Math.min(1, delta * 4.5);
    if (!lyricGroup) {
      if (lyricAmount > 0.01) ensureLyricLines();
      if (!lyricGroup) return;
    }
    lyricGroup.visible = lyricAmount > 0.02;
    if (!lyricGroup.visible) return;
    const ease = lyricAmount * lyricAmount * (3 - 2 * lyricAmount);
    lyricLines.forEach((view, i) => {
      const offset = i - LYRIC_ACTIVE_SLOT;
      const dist = Math.abs(offset);
      const targetY = -offset * 1.32;
      view.group.position.y += (targetY - view.group.position.y) * Math.min(1, delta * 6);
      view.group.position.z = -dist * 0.42 - (1 - ease) * 0.7;
      const scale = (dist === 0 ? 1 : dist === 1 ? 0.8 : 0.64) * (0.9 + 0.1 * ease);
      view.group.scale.setScalar(scale);
      const baseOpacity = dist === 0 ? 1 : dist === 1 ? 0.4 : 0.16;
      view.plane.material.opacity = baseOpacity * ease;
    });
    lyricGroup.position.x = Math.sin(seconds * 0.32) * 0.34;
    lyricGroup.position.y = 0.25 + Math.sin(seconds * 0.52) * 0.07;
    lyricGroup.rotation.z = Math.sin(seconds * 0.21) * 0.014;
    lyricGroup.rotation.y = Math.sin(seconds * 0.17) * 0.02;
  }"""
new = """  const lyricAnchorTemp = new THREE.Vector3();
  const lyricCamPos = new THREE.Vector3();
  const lyricLookTarget = new THREE.Vector3();
  const lyricCamOffset = new THREE.Vector3(0.1, 0.08, 3.6);

  // 每句歌词在空间中的固定落点（同一句永远在同一处），镜头会在句子之间游走
  function lyricAnchor(index: number, out: THREE.Vector3): THREE.Vector3 {
    const safe = Math.max(0, index);
    const s1 = Math.sin(safe * 12.9898 + 4.7) * 43758.5453;
    const s2 = Math.sin(safe * 78.233 + 9.1) * 43758.5453;
    const s3 = Math.sin(safe * 39.425 + 2.3) * 43758.5453;
    const r1 = s1 - Math.floor(s1);
    const r2 = s2 - Math.floor(s2);
    const r3 = s3 - Math.floor(s3);
    return out.set((r1 - 0.5) * 5.6, (r2 - 0.5) * 2.8 + 0.35, (r3 - 0.5) * 3.4 + 0.6);
  }

  function updateLyrics(delta: number): void {
    const target = lyricVisible ? 1 : 0;
    lyricAmount += (target - lyricAmount) * Math.min(1, delta * 4.5);
    if (!lyricGroup) {
      if (lyricAmount > 0.01) ensureLyricLines();
      if (!lyricGroup) return;
    }
    lyricGroup.visible = lyricAmount > 0.02;
    if (!lyricGroup.visible) return;
    const ease = lyricAmount * lyricAmount * (3 - 2 * lyricAmount);
    lyricLines.forEach((view, i) => {
      const lineIndex = lyricActive + (i - LYRIC_ACTIVE_SLOT);
      const dist = Math.abs(i - LYRIC_ACTIVE_SLOT);
      // 每一句散落在空间不同位置：这里一句、那里一句
      lyricAnchor(lineIndex, lyricAnchorTemp);
      lyricAnchorTemp.y += Math.sin(seconds * 0.4 + lineIndex * 1.7) * 0.22;
      lyricAnchorTemp.x += Math.sin(seconds * 0.27 + lineIndex * 2.1) * 0.18;
      view.group.position.lerp(lyricAnchorTemp, Math.min(1, delta * 4.2));
      const scale = (dist === 0 ? 1 : dist === 1 ? 0.78 : 0.62) * (0.9 + 0.1 * ease);
      view.group.scale.setScalar(scale);
      view.group.lookAt(camera.position);
      const baseOpacity = dist === 0 ? 1 : dist === 1 ? 0.45 : 0.2;
      view.plane.material.opacity = view.text ? baseOpacity * ease : 0;
    });
    lyricGroup.position.x = 0;
    lyricGroup.position.y = 0;
    lyricGroup.rotation.z = 0;
    lyricGroup.rotation.y = 0;
  }"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 2) 歌词平面尺寸适配近距离阅读
old = """      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(7.7, 1.92),"""
new = """      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(4.0, 1.0),"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 3) 相机跟随当前歌词句
old = """    camera.position.x =
      panX + camFollowX + Math.sin(orbitYaw) * Math.cos(orbitPitch) * camDist;
    camera.position.y = 0.62 + panY + camFollowY + Math.sin(orbitPitch) * camDist;
    camera.position.z = Math.cos(orbitYaw) * Math.cos(orbitPitch) * camDist;
    camera.lookAt(lookTarget);"""
new = """    camera.position.x =
      panX + camFollowX + Math.sin(orbitYaw) * Math.cos(orbitPitch) * camDist;
    camera.position.y = 0.62 + panY + camFollowY + Math.sin(orbitPitch) * camDist;
    camera.position.z = Math.cos(orbitYaw) * Math.cos(orbitPitch) * camDist;
    // 歌词模式：镜头跟着当前这句歌词在空间里游走（这里一句、那里一句）
    if (lyricAmount > 0.001) {
      lyricAnchor(Math.max(0, lyricActive), lyricCamPos);
      const driftX = Math.sin(seconds * 0.24) * 0.3;
      const driftY = Math.sin(seconds * 0.33) * 0.16;
      lyricCamPos.set(
        lyricCamPos.x + lyricCamOffset.x + driftX,
        lyricCamPos.y + lyricCamOffset.y + driftY,
        lyricCamPos.z + lyricCamOffset.z,
      );
      camera.position.lerp(lyricCamPos, lyricAmount);
      lyricLookTarget.copy(lyricCamPos);
      lyricLookTarget.set(
        lyricCamPos.x - lyricCamOffset.x - driftX,
        lyricCamPos.y - lyricCamOffset.y - driftY,
        lyricCamPos.z - lyricCamOffset.z,
      );
      lookTarget.lerp(lyricLookTarget, lyricAmount);
    }
    camera.lookAt(lookTarget);"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 4) 歌词模式禁用磁贴鼠标检测
old = """  const onPointerMove = (event: PointerEvent): void => {
    hoverSuppressed = false;"""
new = """  const onPointerMove = (event: PointerEvent): void => {
    if (lyricVisible) return;
    hoverSuppressed = false;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """  const onPointerUp = (event: PointerEvent): void => {
    if (event.button === 1) {"""
new = """  const onPointerUp = (event: PointerEvent): void => {
    if (lyricVisible) return;
    if (event.button === 1) {"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """  const onPointerDown = (event: PointerEvent): void => {
    if (event.button === 1 && entered) {"""
new = """  const onPointerDown = (event: PointerEvent): void => {
    if (lyricVisible) return;
    if (event.button === 1 && entered) {"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """    let nextHover = hoverSuppressed ? -1 : tileIndexAtPointer();"""
new = """    let nextHover = hoverSuppressed || lyricVisible ? -1 : tileIndexAtPointer();"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 5) 进入歌词模式时清掉残留 hover / 聚焦
old = """    setLyricsView(visible: boolean) {
      lyricVisible = visible;
      if (visible) ensureLyricLines();
    },"""
new = """    setLyricsView(visible: boolean) {
      lyricVisible = visible;
      if (visible) {
        ensureLyricLines();
        hoveredTile = -1;
        selectedTile = -1;
        focusIndex = -1;
        pendingRestoreIndex = -1;
        tiles.forEach((tile) => {
          tile.hoverT = 0;
        });
      }
    },"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

write(SCENE, s)
print('floatScene: scattered 3D lyrics + camera follow + hover disabled')
