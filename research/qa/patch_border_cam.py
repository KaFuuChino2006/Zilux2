# -*- coding: utf-8 -*-
"""m09188：去掉封面磁贴的白框；并修正聚焦相机目标（用基准网格位置，磁贴真正滑到屏幕中心）。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()


def rep(old, new, label):
    if s.count(old) != 1:
        raise SystemExit(f'{label}: count={s.count(old)}')
    return s.replace(old, new, 1)


# 1) 去掉磁贴白描边
s = rep(
    """    ctx.restore();
    roundRect(ctx, 1.5, 1.5, S - 3, S - 3, radius);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2.6;
    ctx.stroke();
    tile.texture.needsUpdate = true;""",
    """    ctx.restore();
    tile.texture.needsUpdate = true;""",
    'tile white border',
)

# 2) 聚焦相机用基准网格位置（不含放大/让位位移），磁贴才能滑到屏幕中心
s = rep(
    """    const focusTile = focusIndex >= 0 ? tiles[focusIndex] : null;
    const focusX = focusTile ? focusTile.group.position.x : 0;
    const focusY = focusTile ? focusTile.group.position.y - 0.72 : 0;""",
    """    const focusTile = focusIndex >= 0 ? tiles[focusIndex] : null;
    const focusSlot = focusTile ? tileSlot(focusTile.index) : null;
    const focusX = focusSlot ? focusSlot.x : 0;
    const focusY = focusSlot ? focusSlot.y - 0.72 : 0;""",
    'focus target slot',
)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('tile border removed + focus target fixed')
