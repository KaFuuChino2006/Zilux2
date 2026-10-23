# -*- coding: utf-8 -*-
"""m09229：聚焦让位时给周围封面加 3D 层次（越近越下沉/后退/后仰），不再同一平面。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()


def rep(old, new, label):
    if s.count(old) != 1:
        raise SystemExit(f'{label}: count={s.count(old)}')
    return s.replace(old, new, 1)


# 1) 让位时记录 3D 层次强度
s = rep(
    """      // 聚焦时周围磁贴让位（径向推开 + 靠近的缩小）
      if (focusSlot && tile.index !== focusIndex && focusAmount > 0.01) {
        const fdx = slot.x - focusSlot.x;
        const fdy = slot.y - focusSlot.y;
        const fdist = Math.hypot(fdx, fdy) || 1;
        const freach = TILE_SIZE * layoutScale * 4.2;
        if (fdist < freach) {
          const famount = (1 - fdist / freach) * 1.25 * focusAmount;
          pushX += (fdx / fdist) * famount;
          pushY += (fdy / fdist) * famount;
        }
      }""",
    """      // 聚焦时周围磁贴让位（径向推开 + 3D 层次：越近的越下沉/后退/后仰）
      let focusLift = 0;
      if (focusSlot && tile.index !== focusIndex && focusAmount > 0.01) {
        const fdx = slot.x - focusSlot.x;
        const fdy = slot.y - focusSlot.y;
        const fdist = Math.hypot(fdx, fdy) || 1;
        const freach = TILE_SIZE * layoutScale * 4.2;
        if (fdist < freach) {
          const famount = (1 - fdist / freach) * 1.25 * focusAmount;
          pushX += (fdx / fdist) * famount;
          pushY += (fdy / fdist) * famount;
          focusLift = Math.min(1, famount);
        }
      }""",
    'focusLift detection',
)

# 2) 位置/旋转带上 3D 层次（下沉 + 后退 + 轻微后仰）
s = rep(
    """      tile.group.position.y = slot.y + tile.pushY + (1 - appear) * -0.5 + t * 0.05 + sel * 0.06;
      tile.group.position.z = 0.1 + t * 0.26 + sel * 0.22;
      tile.group.scale.setScalar(
        layoutScale * (0.94 + 0.06 * appear) * (1 + t * 0.11 + sel * 0.07),
      );""",
    """      tile.group.position.y =
        slot.y + tile.pushY + (1 - appear) * -0.5 + t * 0.05 + sel * 0.06 - focusLift * 0.34;
      tile.group.position.z = 0.1 + t * 0.26 + sel * 0.22 - focusLift * 1.05;
      tile.group.rotation.x = focusLift * 0.17;
      tile.group.scale.setScalar(
        layoutScale * (0.94 + 0.06 * appear) * (1 + t * 0.11 + sel * 0.07 - focusLift * 0.05),
      );""",
    'focusLift in position',
)

# 3) 聚焦磁贴抬得更高（顶层）
s = rep(
    """        tile.group.position.z = 0.1 + focusAmount * 1.15;
        tile.group.position.y += focusAmount * 0.06;""",
    """        tile.group.position.z = 0.1 + focusAmount * 1.15;
        tile.group.position.y += focusAmount * 0.16;""",
    'focus tile lift',
)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('3d focus layering applied')
