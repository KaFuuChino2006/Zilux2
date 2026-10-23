# -*- coding: utf-8 -*-
"""m09320：点击封面时相机平滑飞到该封面正前方（正视），退出时飞回原视角；聚焦距离固定，不再随 zoom 叠加放大。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

old = """    // 恢复此前已验证的手感：相机与视线目标同步跟随聚焦磁贴，磁贴保持屏幕位置平滑拉近放大
    const focusTile = focusIndex >= 0 ? tiles[focusIndex] : null;
    const focusSlot = focusTile ? tileSlot(focusTile.index) : null;
    const focusX = focusSlot ? focusSlot.x : 0;
    const focusY = focusSlot ? focusSlot.y - 0.72 : 0;
    const camDist = ORBIT_RADIUS * zoom * (1 - 0.3 * focusAmount);
    lookTarget.set(panX + focusX * focusAmount, 0.72 + panY + focusY * focusAmount, 0);
    camera.position.x =
      panX + focusX * focusAmount + Math.sin(orbitYaw) * Math.cos(orbitPitch) * camDist;
    camera.position.y =
      0.62 + panY + focusY * focusAmount + Math.sin(orbitPitch) * camDist;
    camera.position.z = Math.cos(orbitYaw) * Math.cos(orbitPitch) * camDist;
    camera.lookAt(lookTarget);"""
new = """    // 相机：从当前轨道视角平滑飞到被点封面的正前方（正视，无论当前是什么角度），
    // 退出时再飞回原来的视角。聚焦距离固定，不随滚轮 zoom 叠加放大。
    const focusTile = focusIndex >= 0 ? tiles[focusIndex] : null;
    const focusSlot = focusTile ? tileSlot(focusTile.index) : null;
    const camDist = ORBIT_RADIUS * zoom;
    const orbitCamX = panX + Math.sin(orbitYaw) * Math.cos(orbitPitch) * camDist;
    const orbitCamY = 0.62 + panY + Math.sin(orbitPitch) * camDist;
    const orbitCamZ = Math.cos(orbitYaw) * Math.cos(orbitPitch) * camDist;
    const orbitLookX = panX;
    const orbitLookY = 0.72 + panY;
    const focusCamX = focusSlot ? focusSlot.x : 0;
    const focusCamY = focusSlot ? focusSlot.y + 0.02 : 0;
    const focusCamZ = 3.45;
    const focusLookX = focusCamX;
    const focusLookY = focusCamY;
    camera.position.set(
      orbitCamX + (focusCamX - orbitCamX) * focusAmount,
      orbitCamY + (focusCamY - orbitCamY) * focusAmount,
      orbitCamZ + (focusCamZ - orbitCamZ) * focusAmount,
    );
    lookTarget.set(
      orbitLookX + (focusLookX - orbitLookX) * focusAmount,
      orbitLookY + (focusLookY - orbitLookY) * focusAmount,
      focusAmount * 0.06,
    );
    camera.lookAt(lookTarget);"""
assert s.count(old) == 1, 'camera block missing'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('camera fly-to-front implemented')
