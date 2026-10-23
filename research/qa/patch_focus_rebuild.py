# -*- coding: utf-8 -*-
"""m09360：重做磁贴点击突出/收回动画——统一一条 easeInOutCubic 时间线，磁贴与相机同步完成。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()


def rep(old, new, label):
    if s.count(old) != 1:
        raise SystemExit(f'{label}: count={s.count(old)}')
    return s.replace(old, new, 1)


# 1) 统一曲线（easeInOutCubic），进入 0.5s / 收回 0.6s；磁贴与相机共用同一进度
s = rep(
    """    const focusDur = focusTargetT > focusT ? 0.6 : 0.85;
    focusT = Math.min(
      1,
      Math.max(0, focusT + (focusTargetT > focusT ? 1 : -1) * (delta / focusDur)),
    );""",
    """    const focusDur = focusTargetT > focusT ? 0.5 : 0.6;
    focusT = Math.min(
      1,
      Math.max(0, focusT + (focusTargetT > focusT ? 1 : -1) * (delta / focusDur)),
    );""",
    'focus duration',
)

s = rep(
    """    // 相机用较柔的缓动；磁贴缩放用更快到位的曲线（先放大/先缩小，相机随后跟随/回位）
    focusAmount = focusT * focusT * (3 - 2 * focusT);
    focusScale = focusT * (2 - focusT);""",
    """    // 统一 easeInOutCubic：磁贴与相机同一条时间线、同步完成
    focusAmount =
      focusT < 0.5
        ? 4 * focusT * focusT * focusT
        : 1 - Math.pow(-2 * focusT + 2, 3) / 2;
    focusScale = focusAmount;""",
    'focus curve',
)

# 2) 让位段：单一权重、后退为主 + 轻微下沉
s = rep(
    """    const focusSlot = focusTile ? tileSlot(focusTile.index) : null;""",
    """    const focusSlot = focusTile ? tileSlot(focusTile.index) : null;""",
    'noop',
)

start = s.index('      // 聚焦时周围磁贴让位（径向推开 + 3D 层次：越近的越下沉/后退/后仰）')
end = s.index('      tile.pushX += (pushX - tile.pushX) * Math.min(1, delta * 12);', start)
new_block = """      // 聚焦让位：按到焦点的距离加权，邻居后退 + 轻微下沉 + 变暗（与聚焦同一曲线，同步完成）
      let focusWeight = 0;
      if (focusSlot && tile.index !== focusIndex && focusAmount > 0.001) {
        const fdx = slot.x - focusSlot.x;
        const fdy = slot.y - focusSlot.y;
        const fdist = Math.hypot(fdx, fdy) || 1;
        const freach = TILE_SIZE * layoutScale * 4.2;
        if (fdist < freach) {
          focusWeight = (1 - fdist / freach) * focusAmount;
          pushX += (fdx / fdist) * focusWeight * 0.55;
          pushY += (fdy / fdist) * focusWeight * 0.55;
        }
      }
"""
s = s[:start] + new_block + s[end:]

# 3) 位置/旋转/缩放：用 focusWeight
s = rep(
    """      tile.pushX += (pushX - tile.pushX) * Math.min(1, delta * 12);
      tile.pushY += (pushY - tile.pushY) * Math.min(1, delta * 12);
      tile.group.position.x = slot.x + tile.pushX;
      tile.group.position.y =
        slot.y + tile.pushY + (1 - appear) * -0.5 + t * 0.05 + sel * 0.06 - focusLift * 0.42;
      tile.group.position.z = 0.1 + t * 0.26 + sel * 0.22 - focusLift * 0.4;
      tile.group.rotation.x = focusLift * 0.12;
      tile.group.scale.setScalar(
        layoutScale * (0.94 + 0.06 * appear) * (1 + t * 0.11 + sel * 0.07 - focusLift * 0.05),
      );""",
    """      tile.pushX += (pushX - tile.pushX) * Math.min(1, delta * 14);
      tile.pushY += (pushY - tile.pushY) * Math.min(1, delta * 14);
      tile.group.position.x = slot.x + tile.pushX;
      tile.group.position.y =
        slot.y + tile.pushY + (1 - appear) * -0.5 + t * 0.05 + sel * 0.06 - focusWeight * 0.28;
      tile.group.position.z = 0.1 + t * 0.26 + sel * 0.22 - focusWeight * 0.85;
      tile.group.rotation.x = focusWeight * 0.1;
      tile.group.scale.setScalar(
        layoutScale * (0.94 + 0.06 * appear) * (1 + t * 0.11 + sel * 0.07 - focusWeight * 0.06),
      );""",
    'tile transform',
)

# 4) 聚焦磁贴本体：用同一曲线，前移 + 适度放大
s = rep(
    """      if (isFocusTarget && focusScale > 0.001) {
        const grow = 1 + focusScale * 0.55;
        tile.group.scale.setScalar(layoutScale * grow * (0.94 + 0.06 * appear));
        tile.group.position.z = 0.1 + focusScale * 1.15;
        tile.group.position.y += focusScale * 0.16;
      }
      const dim = focusScale * (isFocused ? 0 : 0.6);
      tile.plane.material.opacity = isFocused ? appear : appear * (1 - dim);
      tile.plane.material.color.setScalar(
        isFocused ? 1 : (1 + t * 0.28 - sel * 0.05) * (1 - dim * 0.5),
      );""",
    """      if (isFocusTarget && focusAmount > 0.001) {
        const grow = 1 + focusAmount * 0.5;
        tile.group.scale.setScalar(layoutScale * grow * (0.94 + 0.06 * appear));
        tile.group.position.z = 0.1 + focusAmount * 0.95;
        tile.group.position.y += focusAmount * 0.07;
      }
      const dim = focusWeight * 0.55;
      tile.plane.material.opacity = isFocused ? appear : appear * (1 - dim);
      tile.plane.material.color.setScalar(
        isFocused ? 1 : (1 + t * 0.28 - sel * 0.05) * (1 - dim * 0.4),
      );""",
    'focus tile visual',
)

# 5) 相机：距离略近一点（5.0），与磁贴同曲线
s = rep(
    """    const focusDist = 5.8;""",
    """    const focusDist = 5.0;""",
    'focus dist',
)

# 6) 聚焦时禁用 hover，避免叠加抖动
old_hover = "      if (pointer.x < 900 && tileVisible && !dragging) {"
if s.count(old_hover) == 1:
    s = s.replace(old_hover, "      if (pointer.x < 900 && tileVisible && !dragging && focusIndex < 0) {", 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('focus animation rebuilt')
