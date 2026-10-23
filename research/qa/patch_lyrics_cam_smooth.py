# -*- coding: utf-8 -*-
"""歌词模式：恢复拖拽旋转（绕当前句轨道）、相机平滑跟随、进出更柔和。"""
import io

SCENE = r'E:\Zilux2开发\web\src\three\floatScene.ts'


def read(p):
    return io.open(p, 'r', encoding='utf-8', newline='').read()


def write(p, t):
    io.open(p, 'w', encoding='utf-8', newline='').write(t)


s = read(SCENE)

# 1) 恢复拖拽：pointermove 不再整体拦截（hover 仍由 updateHover 内 lyricVisible 屏蔽）
old = """  const onPointerMove = (event: PointerEvent): void => {
    if (lyricVisible) return;
    hoverSuppressed = false;"""
new = """  const onPointerMove = (event: PointerEvent): void => {
    hoverSuppressed = false;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 2) pointerdown 恢复（左键旋转、中键平移照常）
old = """  const onPointerDown = (event: PointerEvent): void => {
    if (lyricVisible) return;
    if (event.button === 1 && entered) {"""
new = """  const onPointerDown = (event: PointerEvent): void => {
    if (event.button === 1 && entered) {"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 3) pointerup：只跳过磁贴点击/收起，保留轨道拖拽收尾
old = """  const onPointerUp = (event: PointerEvent): void => {
    if (lyricVisible) return;
    if (event.button === 1) {"""
new = """  const onPointerUp = (event: PointerEvent): void => {
    if (event.button === 1) {"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """    const moved = Math.abs(event.clientX - downX) + Math.abs(event.clientY - downY);
    if (moved > 8 || performance.now() - downTime > 700) return;
    // 用屏幕投影判定点击的磁贴（不依赖上一帧的 hoveredTile）
    const hitTile = tileIndexAtPointer();"""
new = """    const moved = Math.abs(event.clientX - downX) + Math.abs(event.clientY - downY);
    if (moved > 8 || performance.now() - downTime > 700) return;
    // 歌词模式：磁贴不参与点击/详情，只保留视角拖拽
    if (lyricVisible) return;
    // 用屏幕投影判定点击的磁贴（不依赖上一帧的 hoveredTile）
    const hitTile = tileIndexAtPointer();"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 4) 歌词相机：绕当前句轨道（拖拽生效）+ 独立平滑目标，不再瞬移
old = """  const lyricAnchorTemp = new THREE.Vector3();
  const lyricCamPos = new THREE.Vector3();
  const lyricLookTarget = new THREE.Vector3();
  const lyricCamOffset = new THREE.Vector3(0.1, 0.08, 3.6);"""
new = """  const lyricAnchorTemp = new THREE.Vector3();
  const lyricCamPos = new THREE.Vector3();
  const lyricLookTarget = new THREE.Vector3();
  const lyricCamSmooth = new THREE.Vector3();
  const lyricLookSmooth = new THREE.Vector3();
  let lyricCameraReady = false;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """    // 歌词模式：镜头跟着当前这句歌词在空间里游走（这里一句、那里一句）
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
new = """    // 歌词模式：镜头绕当前这句歌词平滑游走（拖拽可旋转视角，切句时缓慢飞过去）
    if (lyricAmount > 0.001) {
      lyricAnchor(Math.max(0, lyricActive), lyricLookTarget);
      lyricLookTarget.y += Math.sin(seconds * 0.33) * 0.16;
      const yaw = orbitYaw;
      const pitch = 0.24 + (orbitPitch - 0.42) * 0.7;
      const radius = 3.9;
      lyricCamPos.set(
        lyricLookTarget.x + Math.sin(yaw) * Math.cos(pitch) * radius + Math.sin(seconds * 0.24) * 0.3,
        lyricLookTarget.y + Math.sin(pitch) * radius,
        lyricLookTarget.z + Math.cos(yaw) * Math.cos(pitch) * radius,
      );
      if (!lyricCameraReady) {
        lyricCamSmooth.copy(camera.position);
        lyricLookSmooth.copy(lookTarget);
        lyricCameraReady = true;
      }
      lyricCamSmooth.lerp(lyricCamPos, Math.min(1, delta * 2.0));
      lyricLookSmooth.lerp(lyricLookTarget, Math.min(1, delta * 2.6));
      camera.position.lerp(lyricCamSmooth, lyricAmount);
      lookTarget.lerp(lyricLookSmooth, lyricAmount);
    } else {
      lyricCameraReady = false;
    }
    camera.lookAt(lookTarget);"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 5) 进出歌词的混合更柔和
old = """    const target = lyricVisible ? 1 : 0;
    lyricAmount += (target - lyricAmount) * Math.min(1, delta * 4.5);"""
new = """    const target = lyricVisible ? 1 : 0;
    lyricAmount += (target - lyricAmount) * Math.min(1, delta * 3.0);"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

write(SCENE, s)
print('floatScene: lyrics camera orbit + smooth follow')
