# -*- coding: utf-8 -*-
"""歌词颜色进度改为 shader 驱动：纹理只画一次字形，进度用 uniform 每帧混合，避免每帧重绘/上传纹理导致的卡顿。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# 1) 类型：材质换成 ShaderMaterial
old = """  plane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  texture: THREE.CanvasTexture;"""
new = """  plane: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  texture: THREE.CanvasTexture;"""
assert s.count(old) == 1, 'view type'
s = s.replace(old, new, 1)

# 2) paintLyricLine 只画白色字形（颜色/进度交给 shader）
a = s.index("  function paintLyricLine(view: LyricLineView")
b = s.index("\n  function ensureLyricLines(): void {", a)
new_paint = '''  function paintLyricLine(view: LyricLineView): void {
    const ctx = view.canvas.getContext('2d');
    if (!ctx) return;
    const W = view.canvas.width;
    const H = view.canvas.height;
    const hasTranslation = view.translation.trim().length > 0;
    const mainY = hasTranslation ? H * 0.38 : H * 0.5;
    ctx.clearRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // 字形只画一次（白色 + 柔光），已唱/未唱的明暗与扫过进度由 shader 每帧混合
    ctx.shadowColor = 'rgba(255,255,255,0.35)';
    ctx.shadowBlur = 16;
    ctx.fillStyle = 'rgba(255,255,255,1)';
    drawLyricText(ctx, view.text, W / 2, mainY, W * 0.94, 2, 56, 34, 700);
    if (hasTranslation) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      drawLyricText(ctx, view.translation, W / 2, H * 0.8, W * 0.9, 2, 28, 18, 500);
    }
    view.texture.needsUpdate = true;
  }
'''
s = s[:a] + new_paint + s[b:]

# 3) 平面材质改为 ShaderMaterial
old = """      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(3.2, 0.8),
        new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          depthTest: false,
        }),
      );"""
new = """      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(3.2, 0.8),
        new THREE.ShaderMaterial({
          uniforms: {
            uMap: { value: texture },
            uProgress: { value: 0 },
            uOpacity: { value: 0 },
          },
          vertexShader: [
            'varying vec2 vUv;',
            'void main() {',
            '  vUv = uv;',
            '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
            '}',
          ].join('\\n'),
          fragmentShader: [
            'varying vec2 vUv;',
            'uniform sampler2D uMap;',
            'uniform float uProgress;',
            'uniform float uOpacity;',
            'void main() {',
            '  vec4 tex = texture2D(uMap, vUv);',
            '  if (tex.a < 0.02) discard;',
            '  float unfilled = smoothstep(uProgress - 0.012, uProgress + 0.012, vUv.x);',
            '  float alpha = tex.a * mix(1.0, 0.26, unfilled) * uOpacity;',
            '  vec3 color = mix(vec3(1.0), vec3(0.76, 0.74, 0.9), unfilled);',
            '  gl_FragColor = vec4(color, alpha);',
            '}',
          ].join('\\n'),
          transparent: true,
          depthWrite: false,
          depthTest: false,
        }),
      );"""
assert s.count(old) == 1, 'material'
s = s.replace(old, new, 1)

# 4) updateLyrics：切句才重绘，进度/透明度走 uniform
start_marker = "  function updateLyrics(delta: number): void {"
end_marker = "  /* 详情磁贴"
a = s.index(start_marker)
b = s.index(end_marker, a)
new_func = '''  function updateLyrics(delta: number): void {
    const target = lyricVisible ? 1 : 0;
    lyricAmount += (target - lyricAmount) * Math.min(1, delta * 3.0);
    if (!lyricGroup) {
      if (lyricAmount > 0.01) ensureLyricLines();
      if (!lyricGroup) return;
    }
    lyricGroup.visible = lyricAmount > 0.02;
    if (!lyricGroup.visible) return;
    const ease = lyricAmount * lyricAmount * (3 - 2 * lyricAmount);
    const active = lyricActive;
    lyricSlotUsed.clear();
    if (active >= 0 && lyricData.length > 0) {
      const slot = active % LYRIC_POOL;
      const view = lyricLines[slot];
      const line = lyricData[active];
      if (view.index !== active) {
        view.index = active;
        view.active = true;
        view.text = line.text;
        view.translation = line.translation ?? '';
        paintLyricLine(view);
      }
      // 每句的固定落点由行号决定；只显示正在唱的这一句，已唱/未唱的都不显示
      lyricAnchor(active, lyricAnchorTemp);
      view.group.position.copy(lyricAnchorTemp);
      view.group.scale.setScalar(1);
      view.group.lookAt(camera.position);
      const material = view.plane.material;
      material.uniforms.uProgress!.value = lyricProgress;
      material.uniforms.uOpacity!.value = ease;
      lyricSlotUsed.add(slot);
    }
    lyricLines.forEach((view, k) => {
      if (!lyricSlotUsed.has(k)) view.plane.material.uniforms.uOpacity!.value = 0;
    });
    lyricGroup.position.x = 0;
    lyricGroup.position.y = 0;
    lyricGroup.rotation.z = 0;
    lyricGroup.rotation.y = 0;
  }

'''
s = s[:a] + new_func + s[b:]

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('lyrics: shader-driven color progress (smooth, no per-frame texture upload)')
