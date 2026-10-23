import io

p = r'E:\Zilux2开发\web\src\three\settingsBoard.ts'
s = io.open(p, encoding='utf-8').read()

old = """      panelPos: { x: panelPos.x, y: panelPos.y, z: panelPos.z },
      camPos: { x: camera.position.x, y: camera.position.y, z: camera.position.z },"""
new = """      panelPos: { x: panelPos.x, y: panelPos.y, z: panelPos.z },
      camPos: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      panelScreen: (() => {
        const p = panelPos.clone().project(camera);
        return { x: p.x * 0.5 + 0.5, y: -p.y * 0.5 + 0.5 };
      })(),
      panelScreenH: (() => {
        const halfH = (PLANE_H * group.scale.x) / 2;
        const top = new THREE.Vector3(0, halfH, 0).applyQuaternion(group.quaternion).add(panelPos).project(camera);
        const bottom = new THREE.Vector3(0, -halfH, 0).applyQuaternion(group.quaternion).add(panelPos).project(camera);
        return Math.abs(top.y - bottom.y) * 0.5;
      })(),"""
assert s.count(old) == 1
s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8').write(s)
print('patched debug')
