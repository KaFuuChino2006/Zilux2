# -*- coding: utf-8 -*-
"""m09155：重做磁贴放大/收回动画 + 相机运动（更快更顺），翻页改为逐块顺序/随机翻转。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()


def rep(old, new, label):
    if s.count(old) != 1:
        raise SystemExit(f'pattern not unique/missing: {label} (count={s.count(old)})')
    return s.replace(old, new, 1)


# 1) 状态：时间驱动的 focusT + 翻页模式/延迟
s = rep(
    """  let focusAmount = 0;
  // 翻页：flipT 0→1 做一次翻转动画，中点换页；pendingFlipOffset 待应用的目标行偏移
  let flipT = 1;""",
    """  let focusAmount = 0;
  let focusT = 0;
  // 翻页：flipT 0→1；前 25% 所有磁贴一起翻到侧面，25% 换页，之后按顺序/随机依次翻回
  let flipT = 1;
  let flipMode: 'seq' | 'rand' = 'seq';
  let flipDelays: number[] = [];""",
    'focus/flip state',
)

# 2) focus 平滑 → 时间驱动缓动
s = rep(
    """    const focusTarget = focusIndex >= 0 ? 1 : 0;
    // 进入聚焦快一些，收回放慢（避免"一抽就回去"）
    focusAmount +=
      (focusTarget - focusAmount) *
      Math.min(1, delta * (focusTarget > focusAmount ? 6.5 : 1.9));""",
    """    // 时间驱动缓动：进入 480ms、收回 620ms（不再用过慢的指数平滑）
    const focusTargetT = focusIndex >= 0 ? 1 : 0;
    const focusDur = focusTargetT > focusT ? 0.48 : 0.62;
    focusT = Math.min(
      1,
      Math.max(0, focusT + (focusTargetT > focusT ? 1 : -1) * (delta / focusDur)),
    );
    focusAmount = focusT * focusT * (3 - 2 * focusT);""",
    'focus smoothing',
)

# 3) 相机：拉近 + 轻微俯冲/转向，目标点跟随磁贴
s = rep(
    """    const camDist = ORBIT_RADIUS * zoom * (1 - 0.3 * focusAmount);
    lookTarget.set(panX + focusX * focusAmount, 0.72 + panY + focusY * focusAmount, 0);
    camera.position.x =
      panX + focusX * focusAmount + Math.sin(orbitYaw) * Math.cos(orbitPitch) * camDist;
    camera.position.y =
      0.62 + panY + focusY * focusAmount + Math.sin(orbitPitch) * camDist;
    camera.position.z = Math.cos(orbitYaw) * Math.cos(orbitPitch) * camDist;
    camera.lookAt(lookTarget);""",
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
    'camera focus',
)

# 4) flip 进度：0.9s，25% 处换页
s = rep(
    """    if (flipT < 1) {
      const prevFlip = flipT;
      flipT = Math.min(1, flipT + delta / 0.55);
      if (prevFlip < 0.5 && flipT >= 0.5 && pendingFlipOffset >= 0) {""",
    """    if (flipT < 1) {
      const prevFlip = flipT;
      flipT = Math.min(1, flipT + delta / 0.9);
      if (prevFlip < 0.25 && flipT >= 0.25 && pendingFlipOffset >= 0) {""",
    'flip progress',
)

# 5) 每块磁贴翻转角：先齐翻到侧面，再按 delay 依次翻回（顺序/随机）
s = rep(
    """      if (flipT < 1) {
        const flipAngle = (flipT < 0.5 ? flipT * 2 : (1 - flipT) * 2) * (Math.PI / 2);
        tile.group.rotation.y = flipAngle;
      } else if (tile.group.rotation.y !== 0) {""",
    """      if (flipT < 1) {
        let flipAngle = 0;
        if (flipT < 0.25) {
          // 前半段：所有磁贴一起翻到侧面（此时看不见内容，便于换页）
          flipAngle = (flipT / 0.25) * (Math.PI / 2);
        } else {
          // 后半段：按顺序（第一块→最后一块）或随机顺序逐块翻回，显出下一页封面
          const delay = flipDelays[tile.index] ?? 0;
          const local = Math.min(1, Math.max(0, (flipT - 0.25 - delay) / 0.4));
          flipAngle = (1 - local * local * (3 - 2 * local)) * (Math.PI / 2);
        }
        tile.group.rotation.y = flipAngle;
      } else if (tile.group.rotation.y !== 0) {""",
    'tile flip angle',
)

# 6) turnPage：生成每块延迟，顺序/随机轮换
s = rep(
    """      pendingFlipOffset = next;
      flipT = 0;
      return true;""",
    """      pendingFlipOffset = next;
      // 翻转顺序：一次「第一块→最后一块」顺序翻转，下一次随机顺序，轮换进行
      flipDelays = tiles.map((tile) =>
        flipMode === 'seq' ? (tile.index / Math.max(1, tiles.length)) * 0.3 : Math.random() * 0.3,
      );
      flipMode = flipMode === 'seq' ? 'rand' : 'seq';
      flipT = 0;
      return true;""",
    'turnPage delays',
)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('animation rework applied')
