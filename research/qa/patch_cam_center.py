# -*- coding: utf-8 -*-
"""聚焦时让磁贴真正移到屏幕中心：相机位置只跟随一部分，lookAt 完全跟随；速度再快一点。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()


def rep(old, new, label):
    if s.count(old) != 1:
        raise SystemExit(f'{label}: count={s.count(old)}')
    return s.replace(old, new, 1)


s = rep(
    """    const focusDur = focusTargetT > focusT ? 0.48 : 0.62;""",
    """    const focusDur = focusTargetT > focusT ? 0.42 : 0.52;""",
    'focus duration',
)

s = rep(
    """    const camDist = ORBIT_RADIUS * zoom * (1 - 0.26 * focusAmount);
    const focusYaw = orbitYaw + 0.05 * focusAmount;
    const focusPitch = orbitPitch + 0.055 * focusAmount;
    lookTarget.set(panX + focusX * focusAmount, 0.72 + panY + focusY * focusAmount, 0);
    camera.position.x =
      panX + focusX * focusAmount + Math.sin(focusYaw) * Math.cos(focusPitch) * camDist;
    camera.position.y =
      0.62 + panY + focusY * focusAmount + Math.sin(focusPitch) * camDist;
    camera.position.z = Math.cos(focusYaw) * Math.cos(focusPitch) * camDist;
    camera.lookAt(lookTarget);""",
    """    // 相机位置只跟随 45%，视线目标完全跟随 → 聚焦磁贴平滑滑到屏幕中心并放大
    const camDist = ORBIT_RADIUS * zoom * (1 - 0.32 * focusAmount);
    const focusYaw = orbitYaw + 0.045 * focusAmount;
    const focusPitch = orbitPitch + 0.05 * focusAmount;
    const followX = focusX * 0.45 * focusAmount;
    const followY = focusY * 0.45 * focusAmount;
    lookTarget.set(panX + focusX * focusAmount, 0.72 + panY + focusY * focusAmount, 0);
    camera.position.x =
      panX + followX + Math.sin(focusYaw) * Math.cos(focusPitch) * camDist;
    camera.position.y =
      0.62 + panY + followY + Math.sin(focusPitch) * camDist;
    camera.position.z = Math.cos(focusYaw) * Math.cos(focusPitch) * camDist;
    camera.lookAt(lookTarget);""",
    'camera follow',
)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('camera centering applied')
