# -*- coding: utf-8 -*-
"""m09297：让位 3D 层次方向修正；磁贴缩放先行、相机平滑滞后（不再相机先回位）；动画曲线更柔和。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()


def rep(old, new, label):
    if s.count(old) != 1:
        raise SystemExit(f'{label}: count={s.count(old)}')
    return s.replace(old, new, 1)


# 1) focusScale 声明
s = rep(
    """  let focusAmount = 0;
  let focusT = 0;""",
    """  let focusAmount = 0;
  let focusScale = 0;
  let focusT = 0;""",
    'focusScale decl',
)

# 2) frame：相机用平滑曲线，磁贴缩放用“先走”的曲线
s = rep(
    """    focusAmount = focusT * focusT * (3 - 2 * focusT);""",
    """    // 相机用较柔的缓动；磁贴缩放用更快到位的曲线（先放大/先缩小，相机随后跟随/回位）
    focusAmount = focusT * focusT * (3 - 2 * focusT);
    focusScale = focusT * (2 - focusT);""",
    'focus curves',
)

# 3) 时长：进入 0.6s / 收回 0.85s
s = rep(
    """    const focusDur = focusTargetT > focusT ? 0.55 : 0.8;""",
    """    const focusDur = focusTargetT > focusT ? 0.6 : 0.85;""",
    'focus duration',
)

# 4) 让位强度用 focusScale；3D 层次方向修正（明显下沉、少量后退）
s = rep(
    """      if (focusSlot && tile.index !== focusIndex && focusAmount > 0.01) {
        const fdx = slot.x - focusSlot.x;
        const fdy = slot.y - focusSlot.y;
        const fdist = Math.hypot(fdx, fdy) || 1;
        const freach = TILE_SIZE * layoutScale * 4.2;
        if (fdist < freach) {
          const famount = (1 - fdist / freach) * 1.25 * focusAmount;""",
    """      if (focusSlot && tile.index !== focusIndex && focusScale > 0.01) {
        const fdx = slot.x - focusSlot.x;
        const fdy = slot.y - focusSlot.y;
        const fdist = Math.hypot(fdx, fdy) || 1;
        const freach = TILE_SIZE * layoutScale * 4.2;
        if (fdist < freach) {
          const famount = (1 - fdist / freach) * 1.25 * focusScale;""",
    'push calc',
)

# 5) 位置/层次：下沉更多、后退更少（避免透视导致的上移错觉）
s = rep(
    """      tile.group.position.y =
        slot.y + tile.pushY + (1 - appear) * -0.5 + t * 0.05 + sel * 0.06 - focusLift * 0.34;
      tile.group.position.z = 0.1 + t * 0.26 + sel * 0.22 - focusLift * 1.05;
      tile.group.rotation.x = focusLift * 0.17;""",
    """      tile.group.position.y =
        slot.y + tile.pushY + (1 - appear) * -0.5 + t * 0.05 + sel * 0.06 - focusLift * 0.55;
      tile.group.position.z = 0.1 + t * 0.26 + sel * 0.22 - focusLift * 0.4;
      tile.group.rotation.x = focusLift * 0.12;""",
    'layer direction',
)

# 6) 聚焦磁贴本身：缩放/位置改用 focusScale
s = rep(
    """      if (isFocusTarget && focusAmount > 0.001) {
        const grow = 1 + focusAmount * 1.18;""",
    """      if (isFocusTarget && focusScale > 0.001) {
        const grow = 1 + focusScale * 1.18;""",
    'focus tile grow',
)
s = rep(
    """        tile.group.position.z = 0.1 + focusAmount * 1.15;
        tile.group.position.y += focusAmount * 0.16;""",
    """        tile.group.position.z = 0.1 + focusScale * 1.15;
        tile.group.position.y += focusScale * 0.16;""",
    'focus tile pos',
)

# 7) 压暗也用 focusScale（与缩放同步）
s = rep(
    """      const dim = focusAmount * (isFocused ? 0 : 0.6);""",
    """      const dim = focusScale * (isFocused ? 0 : 0.6);""",
    'dim',
)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('focus motion reworked')
