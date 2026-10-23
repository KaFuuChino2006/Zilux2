import io

p = r'E:\Zilux2开发\web\src\three\settingsBoard.ts'
s = io.open(p, encoding='utf-8').read()

# 1) 打开时精确放在相机正前方（不再被空间 clamp 拉远/推近）
old = """  function placePanelInFront(): void {
    camera.getWorldDirection(tmpVec);
    panelPos.copy(camera.position).addScaledVector(tmpVec, PANEL_DIST);
    clampPanelInSpace();
    // 只在打开那一刻对准相机，之后朝向固定（移动/缩放视角时能看到真实的透视与视差）
    panelYaw = Math.atan2(camera.position.x - panelPos.x, camera.position.z - panelPos.z);
  }"""
new = """  function placePanelInFront(): void {
    camera.getWorldDirection(tmpVec);
    panelPos.copy(camera.position).addScaledVector(tmpVec, PANEL_DIST);
    // 只在打开那一刻对准相机，之后朝向固定（移动/缩放视角时能看到真实的透视与视差）
    panelYaw = Math.atan2(camera.position.x - panelPos.x, camera.position.z - panelPos.z);
  }"""
assert s.count(old) == 1
s = s.replace(old, new)

# 2) 拖动范围放宽（房间尺度）
old = """    panelPos.x = clamp(panelPos.x, -5.6, 5.6);
    panelPos.y = clamp(panelPos.y, -2.2, 3.2);
    panelPos.z = clamp(panelPos.z, 0.2, 6.6);"""
new = """    panelPos.x = clamp(panelPos.x, -7, 7);
    panelPos.y = clamp(panelPos.y, -2.5, 4.5);
    panelPos.z = clamp(panelPos.z, -0.5, 14);"""
assert s.count(old) == 1
s = s.replace(old, new)

old = """    } else if (dist > 12) {
      panelPos.copy(camera.position).addScaledVector(tmpVec2.normalize(), 12);
    }"""
new = """    } else if (dist > 20) {
      panelPos.copy(camera.position).addScaledVector(tmpVec2.normalize(), 20);
    }"""
assert s.count(old) == 1
s = s.replace(old, new)

# 3) 调试出口补一个面板像素坐标 → 屏幕比例的换算，供 QA 点控件/关窗
old = """      panelScreenH: (() => {"""
new = """      panelToScreen: (px: number, py: number) => {
        const local = new THREE.Vector3(
          (px / W - 0.5) * PLANE_W,
          (0.5 - py / H) * PLANE_H,
          0,
        );
        local.applyMatrix4(group.matrixWorld).project(camera);
        return { x: local.x * 0.5 + 0.5, y: -local.y * 0.5 + 0.5 };
      },
      panelScreenH: (() => {"""
assert s.count(old) == 1
s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8').write(s)
print('patched')
