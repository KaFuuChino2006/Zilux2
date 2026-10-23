# -*- coding: utf-8 -*-
"""歌词尺寸缩小：文字更小、相机拉远，整句完整落在画面里。"""
import io

SCENE = r'E:\Zilux2开发\web\src\three\floatScene.ts'


def read(p):
    return io.open(p, 'r', encoding='utf-8', newline='').read()


def write(p, t):
    io.open(p, 'w', encoding='utf-8', newline='').write(t)


s = read(SCENE)

# 1) 歌词面片缩小
old = """      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(4.0, 1.0),"""
new = """      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(3.2, 0.8),"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 2) 字号整体调小
old = """      view.active ? 96 : 72,
      view.active ? 56 : 44,
      700,
    );"""
new = """      view.active ? 84 : 62,
      view.active ? 50 : 40,
      700,
    );"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """        view.active ? 46 : 36,
        view.active ? 30 : 24,
        500,
      );"""
new = """        view.active ? 40 : 32,
        view.active ? 26 : 22,
        500,
      );"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 3) 相机拉远一点、稍微降低俯角，整句居中留白
old = """      const yaw = orbitYaw;
      const pitch = 0.24 + (orbitPitch - 0.42) * 0.7;
      const radius = 3.9;"""
new = """      const yaw = orbitYaw;
      const pitch = 0.2 + (orbitPitch - 0.42) * 0.7;
      const radius = 4.6;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

write(SCENE, s)
print('floatScene: lyrics smaller + camera pulled back')
