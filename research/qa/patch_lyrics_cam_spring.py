# -*- coding: utf-8 -*-
"""歌词镜头改为弹簧阻尼跟随：切句时从静止起步、慢慢加速再减速，不会瞬间加速。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

old = """  const lyricCamSmooth = new THREE.Vector3();
  const lyricLookSmooth = new THREE.Vector3();
  let lyricCameraReady = false;"""
new = """  const lyricCamSmooth = new THREE.Vector3();
  const lyricLookSmooth = new THREE.Vector3();
  const lyricCamVel = new THREE.Vector3();
  const lyricLookVel = new THREE.Vector3();
  const lyricAccel = new THREE.Vector3();
  let lyricCameraReady = false;"""
assert s.count(old) == 1, 'fields'
s = s.replace(old, new, 1)

old = """      if (!lyricCameraReady) {
        lyricCamSmooth.copy(camera.position);
        lyricLookSmooth.copy(lookTarget);
        lyricCameraReady = true;
      }
      lyricCamSmooth.lerp(lyricCamPos, Math.min(1, delta * 2.6));
      lyricLookSmooth.lerp(lyricLookTarget, Math.min(1, delta * 3.2));
      camera.position.lerp(lyricCamSmooth, lyricAmount);
      lookTarget.lerp(lyricLookSmooth, lyricAmount);
    } else {
      lyricCameraReady = false;
    }"""
new = """      if (!lyricCameraReady) {
        lyricCamSmooth.copy(camera.position);
        lyricLookSmooth.copy(lookTarget);
        lyricCamVel.set(0, 0, 0);
        lyricLookVel.set(0, 0, 0);
        lyricCameraReady = true;
      }
      // 弹簧阻尼跟随：切句瞬间速度仍为 0，先缓慢加速、接近目标再自然减速（不会一上来就猛冲）
      const camStiffness = 7.4;
      const camDamping = 5.9;
      const dt = Math.min(delta, 0.05);
      lyricAccel
        .subVectors(lyricCamPos, lyricCamSmooth)
        .multiplyScalar(camStiffness)
        .addScaledVector(lyricCamVel, -camDamping);
      lyricCamVel.addScaledVector(lyricAccel, dt);
      lyricCamSmooth.addScaledVector(lyricCamVel, dt);
      lyricAccel
        .subVectors(lyricLookTarget, lyricLookSmooth)
        .multiplyScalar(camStiffness)
        .addScaledVector(lyricLookVel, -camDamping);
      lyricLookVel.addScaledVector(lyricAccel, dt);
      lyricLookSmooth.addScaledVector(lyricLookVel, dt);
      camera.position.lerp(lyricCamSmooth, lyricAmount);
      lookTarget.lerp(lyricLookSmooth, lyricAmount);
    } else {
      lyricCameraReady = false;
      lyricCamVel.set(0, 0, 0);
      lyricLookVel.set(0, 0, 0);
    }"""
assert s.count(old) == 1, 'camera block'
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('lyric camera: spring-damped follow (ease-in start)')
