# -*- coding: utf-8 -*-
"""歌词模式景深：Bokeh 后处理，焦点锁定当前歌词这行，远处磁贴模糊（保留画布透明通道）"""
import io

P = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(P, 'r', encoding='utf-8', newline='').read()

# 1) imports
old_imp = "import { pickPixelRatio } from './quality';\n"
new_imp = """import { pickPixelRatio } from './quality';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
"""
assert s.count(old_imp) == 1
s = s.replace(old_imp, new_imp, 1)

# 2) composer state + ensureComposer
old_anchor = "  const lookTarget = new THREE.Vector3(0, 0.62, 0);\n"
new_anchor = """  const lookTarget = new THREE.Vector3(0, 0.62, 0);
  // 歌词模式景深：焦点跟当前这句歌词，离它越远的磁贴越模糊
  let composer: EffectComposer | null = null;
  let bokehPass: BokehPass | null = null;
  const lyricFocusPoint = new THREE.Vector3();

  function ensureComposer(): void {
    if (composer) return;
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    bokehPass = new BokehPass(scene, camera, { focus: 8, aperture: 0.0022, maxblur: 0.012 });
    // BokehShader 默认把 alpha 写成 1，会把画布下方的空间背景挡住；这里改成保留场景 alpha
    bokehPass.materialBokeh.fragmentShader = bokehPass.materialBokeh.fragmentShader
      .replace('gl_FragColor = col / 41.0;', 'gl_FragColor = vec4( col / 41.0, texture2D( tColor, vUv ).a );')
      .replace('gl_FragColor.a = 1.0;', '');
    bokehPass.materialBokeh.needsUpdate = true;
    composer.addPass(bokehPass);
  }
"""
assert s.count(old_anchor) == 1
s = s.replace(old_anchor, new_anchor, 1)

# 3) frame 渲染：歌词模式走 Bokeh 合成
old_render = "    renderer.render(scene, camera);\n\n    if (running && !disposed) raf = requestAnimationFrame(frame);\n"
new_render = """    if (lyricAmount > 0.03 && lyricLines.length > 0) {
      ensureComposer();
      const slot = ((lyricActive % LYRIC_POOL) + LYRIC_POOL) % LYRIC_POOL;
      const activeView = lyricActive >= 0 ? lyricLines[slot] : null;
      let focusDistance = camera.position.length();
      if (activeView && activeView.index === lyricActive) {
        activeView.plane.getWorldPosition(lyricFocusPoint);
        focusDistance = camera.position.distanceTo(lyricFocusPoint);
      }
      if (composer && bokehPass) {
        bokehPass.uniforms['focus'].value = focusDistance;
        bokehPass.uniforms['maxblur'].value = 0.018 * lyricAmount * lyricAmount;
        composer.render();
      } else {
        renderer.render(scene, camera);
      }
    } else {
      renderer.render(scene, camera);
    }

    if (running && !disposed) raf = requestAnimationFrame(frame);
"""
assert s.count(old_render) == 1
s = s.replace(old_render, new_render, 1)

# 4) resize：同步 composer 尺寸与像素比
old_resize = """    renderer.setPixelRatio(pr);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
"""
new_resize = """    renderer.setPixelRatio(pr);
    renderer.setSize(width, height, false);
    if (composer) {
      composer.setPixelRatio(pr);
      composer.setSize(width, height);
    }
    camera.aspect = width / height;
"""
assert s.count(old_resize) == 1
s = s.replace(old_resize, new_resize, 1)

io.open(P, 'w', encoding='utf-8', newline='').write(s)
print('bokeh dof patched')
