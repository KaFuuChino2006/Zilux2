# -*- coding: utf-8 -*-
"""把 transmission 玻璃改成透明物理材质（稳定、可预测），并调整自定义通透度语义。"""
import io

p = r'E:\Zilux2开发\web\src\three\loginSpace.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# 1) 侧壁材质：半透明晶莹蓝白
old_side = """  const glassSideMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xeaf2ff,
    transmission: 0.8,
    roughness: 0.24,
    metalness: 0,
    ior: 1.46,
    thickness: glassThickness,
    attenuationColor: new THREE.Color(0xcfe0ff),
    attenuationDistance: 2.6,
    clearcoat: 0.5,
    clearcoatRoughness: 0.24,
    envMapIntensity: 1.15,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: true,
  });"""
new_side = """  const glassSideMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xe8f2ff,
    roughness: 0.2,
    metalness: 0,
    ior: 1.46,
    clearcoat: 0.9,
    clearcoatRoughness: 0.2,
    envMapIntensity: 1.25,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.62,
    depthWrite: true,
  });"""
assert s.count(old_side) == 1
s = s.replace(old_side, new_side, 1)
s = s.replace('    metalness: 0,\n    ior: 1.46,\n    clearcoat: 0.9,', '    metalness: 0,\n    ior: 1.46,\n    clearcoat: 0.9,', 1)

# 2) 顶面：透明高光玻璃（不再用 transmission）
old_top = """  const glassTopMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    transmission: glassTransmission,
    roughness: 0.1,
    metalness: 0,
    ior: 1.5,
    thickness: glassThickness,
    attenuationColor: new THREE.Color(0xdbeaff),
    attenuationDistance: 3.6,
    clearcoat: 1,
    clearcoatRoughness: 0.1,
    envMapIntensity: 1.35,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: true,
  });"""
new_top = """  const glassTopMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xf4f9ff,
    roughness: 0.06,
    metalness: 0,
    ior: 1.5,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
    envMapIntensity: 1.45,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.3,
    depthWrite: true,
  });"""
assert s.count(old_top) == 1
s = s.replace(old_top, new_top, 1)

# 3) 小玻璃顶/侧：更透更亮
old_chip_top = """  const chipTopMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    transmission: 0.92,
    roughness: 0.1,
    metalness: 0,
    ior: 1.5,
    thickness: CHIP_H,
    attenuationColor: new THREE.Color(0xdfeaff),
    attenuationDistance: 1.6,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    envMapIntensity: 1.35,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: true,
  });"""
new_chip_top = """  const chipTopMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.05,
    metalness: 0,
    ior: 1.5,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    envMapIntensity: 1.5,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.34,
    depthWrite: true,
  });"""
assert s.count(old_chip_top) == 1
s = s.replace(old_chip_top, new_chip_top, 1)

old_chip_side = """  const chipSideMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xe8f1ff,
    transmission: 0.8,
    roughness: 0.26,
    metalness: 0,
    ior: 1.46,
    thickness: CHIP_H,
    attenuationColor: new THREE.Color(0xcfe0ff),
    attenuationDistance: 1.4,
    clearcoat: 0.4,
    clearcoatRoughness: 0.2,
    envMapIntensity: 1.1,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: true,
  });"""
new_chip_side = """  const chipSideMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xe4efff,
    roughness: 0.2,
    metalness: 0,
    ior: 1.46,
    clearcoat: 0.85,
    clearcoatRoughness: 0.18,
    envMapIntensity: 1.3,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.55,
    depthWrite: true,
  });"""
assert s.count(old_chip_side) == 1
s = s.replace(old_chip_side, new_chip_side, 1)

# 4) 自定义通透度：改成控制透明度（0.3=偏磨砂不透明，1=通透）
old_apply = """  const applyGlassTransmission = (value: number): void => {
    glassTransmission = Math.min(1, Math.max(0.3, value));
    glassTopMaterial.transmission = glassTransmission;
    glassSideMaterial.transmission = Math.min(1, glassTransmission * 0.92);
  };"""
new_apply = """  const applyGlassTransmission = (value: number): void => {
    glassTransmission = Math.min(1, Math.max(0.3, value));
    // 通透度越高 → 玻璃本身越透明（0.3 偏磨砂，1 几乎全透）
    glassTopMaterial.opacity = 0.78 - glassTransmission * 0.55;
    glassSideMaterial.opacity = 0.92 - glassTransmission * 0.34;
    chipTopMaterial.opacity = 0.84 - glassTransmission * 0.56;
    chipSideMaterial.opacity = 0.95 - glassTransmission * 0.44;
  };"""
assert s.count(old_apply) == 1
s = s.replace(old_apply, new_apply, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('glass materials -> transparent physical')
