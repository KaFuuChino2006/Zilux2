import io

p = r'E:\Zilux2开发\web\src\three\settingsBoard.ts'
s = io.open(p, encoding='utf-8').read()

old = "  let dragDist = PANEL_DIST;\n"
new = ("  let dragDist = PANEL_DIST;\n"
       "  // 面板在空间里的固定朝向（打开时对准相机，之后不再跟随，才能显出 3D 透视）\n"
       "  let panelYaw = 0;\n")
assert s.count(old) == 1
s = s.replace(old, new)

old = """  function placePanelInFront(): void {
    camera.getWorldDirection(tmpVec);
    panelPos.copy(camera.position).addScaledVector(tmpVec, PANEL_DIST);
    clampPanelInSpace();
  }"""
new = """  function placePanelInFront(): void {
    camera.getWorldDirection(tmpVec);
    panelPos.copy(camera.position).addScaledVector(tmpVec, PANEL_DIST);
    clampPanelInSpace();
    // 只在打开那一刻对准相机，之后朝向固定（移动/缩放视角时能看到真实的透视与视差）
    panelYaw = Math.atan2(camera.position.x - panelPos.x, camera.position.z - panelPos.z);
  }"""
assert s.count(old) == 1
s = s.replace(old, new)

old = """    // 只绕 Y 轴转向相机：面板留在空间里的固定位置，转动视角能看出透视和视差
    const dx = camera.position.x - panelPos.x;
    const dz = camera.position.z - panelPos.z;
    group.rotation.set(0, Math.atan2(dx, dz), 0);"""
new = """    // 固定在空间中的朝向（打开时对准相机），略微后仰，像竖在场景里的一块悬浮屏
    group.rotation.set(-0.07, panelYaw, 0);"""
assert s.count(old) == 1
s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8').write(s)
print('patched')
