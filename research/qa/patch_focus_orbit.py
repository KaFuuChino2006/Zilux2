# -*- coding: utf-8 -*-
"""m09337：聚焦封面不要放太大；聚焦时仍可自由拖动视角（围绕被点封面环绕）；点击时平滑转正。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()


def rep(old, new, label):
    if s.count(old) != 1:
        raise SystemExit(f'{label}: count={s.count(old)}')
    return s.replace(old, new, 1)


# 1) 聚焦磁贴放大倍率减小
s = rep(
    """        const grow = 1 + focusScale * 1.18;""",
    """        const grow = 1 + focusScale * 0.55;""",
    'grow',
)

# 2) 让位下沉稍收（放大幅度变小后避免过度）
s = rep(
    """        slot.y + tile.pushY + (1 - appear) * -0.5 + t * 0.05 + sel * 0.06 - focusLift * 0.55;""",
    """        slot.y + tile.pushY + (1 - appear) * -0.5 + t * 0.05 + sel * 0.06 - focusLift * 0.42;""",
    'lift',
)

# 3) 相机段：聚焦时相机围绕「被点封面」旋转（拖拽依然有效），距离拉远避免过大
s = rep(
    """    // 相机：从当前轨道视角平滑飞到被点封面的正前方（正视，无论当前是什么角度），
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
    camera.lookAt(lookTarget);""",
    """    // 相机：普通状态围绕空间中心；聚焦时锚点换成被点的封面（距离拉远、放大不过度），
    // 并且相机仍按 orbitYaw/orbitPitch 计算 —— 聚焦状态下拖动鼠标可以绕封面自由环绕。
    const focusTile = focusIndex >= 0 ? tiles[focusIndex] : null;
    const focusSlot = focusTile ? tileSlot(focusTile.index) : null;
    const orbitDist = ORBIT_RADIUS * zoom;
    const orbitCamX = panX + Math.sin(orbitYaw) * Math.cos(orbitPitch) * orbitDist;
    const orbitCamY = 0.62 + panY + Math.sin(orbitPitch) * orbitDist;
    const orbitCamZ = Math.cos(orbitYaw) * Math.cos(orbitPitch) * orbitDist;
    const orbitLookX = panX;
    const orbitLookY = 0.72 + panY;
    const focusDist = 5.8;
    const anchorX = focusSlot ? focusSlot.x : 0;
    const anchorY = focusSlot ? focusSlot.y : 0.72;
    const focusCamX = anchorX + Math.sin(orbitYaw) * Math.cos(orbitPitch) * focusDist;
    const focusCamY = anchorY + Math.sin(orbitPitch) * focusDist;
    const focusCamZ = Math.cos(orbitYaw) * Math.cos(orbitPitch) * focusDist;
    camera.position.set(
      orbitCamX + (focusCamX - orbitCamX) * focusAmount,
      orbitCamY + (focusCamY - orbitCamY) * focusAmount,
      orbitCamZ + (focusCamZ - orbitCamZ) * focusAmount,
    );
    lookTarget.set(
      orbitLookX + (anchorX - orbitLookX) * focusAmount,
      orbitLookY + (anchorY - orbitLookY) * focusAmount,
      focusAmount * 0.06,
    );
    camera.lookAt(lookTarget);""",
    'camera orbit anchor',
)

# 4) 点击封面时把视角平滑转正（之后可继续拖动环绕）
s = rep(
    """    focusTile(index: number, info: TileDetailInfo) {
      const previous = focusIndex >= 0 ? focusIndex : pendingRestoreIndex;""",
    """    focusTile(index: number, info: TileDetailInfo) {
      // 点击时平滑转正到正面（之后仍可拖动环绕封面）
      orbitYawTarget = 0;
      orbitPitchTarget = 0.16;
      yawVelocity = 0;
      pitchVelocity = 0;
      const previous = focusIndex >= 0 ? focusIndex : pendingRestoreIndex;""",
    'focus tile reset view',
)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('focus size + orbit drag applied')
