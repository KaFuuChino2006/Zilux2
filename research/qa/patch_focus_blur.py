# -*- coding: utf-8 -*-
"""m09386：聚焦时周围封面位置不变（模糊由页面层负责）；被点封面轻微放大 + 相机小幅拉近不改位置；移除 3D 详情纹理避免重刷新。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()


def rep(old, new, label):
    if s.count(old) != 1:
        raise SystemExit(f'{label}: count={s.count(old)}')
    return s.replace(old, new, 1)


# 1) 让位改为「不动」
start = s.index('      // 聚焦让位：按到焦点的距离加权，邻居后退 + 轻微下沉 + 变暗（与聚焦同一曲线，同步完成）')
end = s.index('      tile.pushX += (pushX - tile.pushX) * Math.min(1, delta * 14);', start)
s = s[:start] + '      const focusWeight = 0;\n' + s[end:]

# 2) 聚焦磁贴：轻微放大（不再大动作），周围不变暗
s = rep(
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
    """      if (isFocusTarget && focusAmount > 0.001) {
        const grow = 1 + focusAmount * 0.12;
        tile.group.scale.setScalar(layoutScale * grow * (0.94 + 0.06 * appear));
        tile.group.position.z = 0.1 + focusAmount * 0.16;
        tile.group.position.y += focusAmount * 0.02;
      }
      tile.plane.material.opacity = appear;
      tile.plane.material.color.setScalar(isFocused ? 1 : 1 + t * 0.28 - sel * 0.05);""",
    'focus tile subtle',
)

# 3) 相机：只做小幅拉近（8%），位置和朝向都不变
start = s.index('    // 相机：普通状态围绕空间中心；聚焦时锚点换成被点的封面')
end = s.index('    camera.lookAt(lookTarget);', start) + len('    camera.lookAt(lookTarget);')
new_cam = """    // 相机：聚焦时只做小幅拉近（约 8%），位置与朝向都不变
    const camDist = ORBIT_RADIUS * zoom * (1 - 0.08 * focusAmount);
    lookTarget.set(panX, 0.72 + panY, 0);
    camera.position.x = panX + Math.sin(orbitYaw) * Math.cos(orbitPitch) * camDist;
    camera.position.y = 0.62 + panY + Math.sin(orbitPitch) * camDist;
    camera.position.z = Math.cos(orbitYaw) * Math.cos(orbitPitch) * camDist;
    camera.lookAt(lookTarget);"""
s = s[:start] + new_cam + s[end:]

# 4) 删除 3D 详情纹理相关代码（避免点击时替换纹理 = 重刷新）
start = s.index('  const detailCanvas = document.createElement(\'canvas\');')
fn_start = s.index('  function drawDetailTile(): void {', start)
fn_end = s.index('\n  }\n', fn_start) + len('\n  }\n')
s = s[:start] + s[fn_end:]

# 5) focusTile：不再加载/替换详情纹理
start = s.index('    focusTile(index: number, info: TileDetailInfo) {')
end = s.index('\n    },\n', start) + len('\n    },\n')
new_focus = """    focusTile(index: number, info: TileDetailInfo) {
      void info;
      focusIndex = index;
      selectedTile = index;
    },
"""
s = s[:start] + new_focus + s[end:]

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('focus blur-friendly applied')
