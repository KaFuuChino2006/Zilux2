# -*- coding: utf-8 -*-
"""歌词「分离聚合」出入场：把每句切成三段（几个字一组），从不同方向/旋转飞入拼合，退出时四散。"""
import io

fp = r"E:\Zilux2开发\web\src\three\floatScene.ts"
s = io.open(fp, "r", encoding="utf-8", newline="").read()

# 1) 类型加 5 种
old = "  | 'wave'\n  | 'vanish';"
new = "  | 'wave'\n  | 'vanish'\n  | 'split'\n  | 'split-wheel'\n  | 'split-bounce'\n  | 'split-scatter'\n  | 'split-spiral';"
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 2) LyricLineView 加 segs
old = "  /** 拼字动画：上次重绘时间（节流） */\n  strokePaintedAt: number;\n}"
new = "  /** 拼字动画：上次重绘时间（节流） */\n  strokePaintedAt: number;\n  /** 分离聚合：整行按三段切开渲染，可各自飞入/飞出 */\n  segs?: THREE.Mesh[];\n}"
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 3) material uniforms + fragment uv 偏移
old = "            uEnergy: { value: 0 },\n          },"
new = "            uEnergy: { value: 0 },\n            uUvOffset: { value: new THREE.Vector2(0, 0) },\n            uUvScale: { value: new THREE.Vector2(1, 1) },\n          },"
assert s.count(old) == 1
s = s.replace(old, new, 1)

# fragment 块内 vUv -> guv（先于插入 guv 行）
frag_start = s.index("          fragmentShader: [")
frag_end = s.index("        }),\n      );\n      // 歌词先于磁贴绘制", frag_start)
frag = s[frag_start:frag_end]
frag = frag.replace("vUv", "guv")
s = s[:frag_start] + frag + s[frag_end:]

old = "            'uniform float uEnergy;',"
new = "            'uniform float uEnergy;',\n            'uniform vec2 uUvOffset;',\n            'uniform vec2 uUvScale;',\n            'varying vec2 vUv;',"
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = "            '  vec4 tex = texture2D(uMap, guv);',"
new = "            '  vec2 guv = vUv * uUvScale + uUvOffset;',\n            '  vec4 tex = texture2D(uMap, guv);',"
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 4) material 抽出变量 + 三段 mesh
old = """      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(4.1, 1.02),
        new THREE.ShaderMaterial({"""
new = """      const lineMaterial = new THREE.ShaderMaterial({"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """        }),
      );
      // 歌词先于磁贴绘制：磁贴随后叠加，形成“歌词穿插在磁贴之间、被前面的磁贴遮挡”的效果"""
new = """        });
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(4.1, 1.02), lineMaterial);
      // 歌词先于磁贴绘制：磁贴随后叠加，形成“歌词穿插在磁贴之间、被前面的磁贴遮挡”的效果"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """      const group = new THREE.Group();
      group.add(plane);
      group.position.y = 0;
      group.scale.setScalar(0.9);
      lyricGroup.add(group);
      const view: LyricLineView = {"""
new = """      const group = new THREE.Group();
      group.add(plane);
      group.position.y = 0;
      group.scale.setScalar(0.9);
      const segs: THREE.Mesh[] = [];
      for (let k = 0; k < 3; k += 1) {
        const segMat = lineMaterial.clone() as THREE.ShaderMaterial;
        segMat.uniforms.uUvScale!.value = new THREE.Vector2(1 / 3, 1);
        segMat.uniforms.uUvOffset!.value = new THREE.Vector2(k / 3, 0);
        segMat.uniforms.uOpacity!.value = 0;
        const seg = new THREE.Mesh(new THREE.PlaneGeometry(4.1 / 3, 1.02), segMat);
        seg.position.x = (k - 1) * (4.1 / 3);
        seg.renderOrder = -1;
        seg.visible = false;
        group.add(seg);
        segs.push(seg);
      }
      lyricGroup.add(group);
      const view: LyricLineView = {"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """        strokePaintedAt: 0,
        amount: 0,
      };"""
new = """        strokePaintedAt: 0,
        amount: 0,
        segs,
      };"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 5) 分离样式辅助函数（插在 updateLyrics 之前）
anchor = "  function updateLyrics(delta: number): void {"
helpers = """  /** 分离聚合的方向表：每句切成 3 组，各组从不同地方飞入拼合 */
  function styleSegDirs(style: LyricEnterStyle): Array<[number, number]> {
    switch (style) {
      case 'split-wheel':
        return [[0, 0], [0, 0], [0, 0]];
      case 'split-bounce':
        return [[0, -3.0], [1.7, -2.4], [-1.7, -2.7]];
      case 'split-scatter':
        return [[2.9, -2.2], [-3.3, -1.5], [1.3, 3.0]];
      case 'split-spiral':
        return [[Math.cos(0.2) * 3.6, Math.sin(0.2) * 2.6], [Math.cos(2.3) * 3.6, Math.sin(2.3) * 2.6], [Math.cos(4.4) * 3.6, Math.sin(4.4) * 2.6]];
      default:
        return [[-3.1, -1.8], [3.2, 1.6], [0.2, 3.1]];
    }
  }

  function applySplitLine(view: LyricLineView, phase: number, style: LyricEnterStyle): void {
    const segs = view.segs;
    if (!segs || segs.length !== 3) return;
    view.plane.visible = false;
    const dirs = styleSegDirs(style);
    const w = 4.1 / 3;
    const p = Math.min(1, Math.max(0, phase));
    const src = view.plane.material.uniforms;
    for (let k = 0; k < 3; k += 1) {
      const seg = segs[k]!;
      seg.visible = true;
      const localE = Math.min(1, Math.max(0, (1 - p - k * 0.055) / 0.84));
      const e = localE * localE * (3 - 2 * localE);
      const dir = dirs[k]!;
      let px = (k - 1) * w + dir[0] * e;
      let py = dir[1] * e;
      let spin = (k - 1) * 0.5 * e;
      if (style === 'split-wheel') {
        const ang = k * 2.094 + e * 2.6;
        px = Math.cos(ang) * 2.2 * e + (k - 1) * w * (1 - e);
        py = Math.sin(ang) * 1.5 * e;
        spin = e * 1.5 * (k % 2 === 0 ? 1 : -1);
      } else if (style === 'split-spiral') {
        spin = -e * 2.2;
      } else if (style === 'split-scatter') {
        spin = (k - 1) * 0.9 * e;
      }
      seg.position.set(px, py, 0.012);
      seg.rotation.z = spin;
      const bounce = style === 'split-bounce' ? 1 + Math.sin(Math.min(1, 1 - p) * Math.PI) * 0.12 : 1;
      seg.scale.setScalar((0.7 + 0.3 * (1 - e)) * bounce);
      const mat = seg.material as THREE.ShaderMaterial;
      mat.uniforms.uOpacity!.value = 0.95 * Math.min(1, 0.2 + p * 0.95);
      mat.uniforms.uProgress!.value = src.uProgress!.value;
      mat.uniforms.uFill!.value = src.uFill!.value;
      mat.uniforms.uWrite!.value = src.uWrite!.value;
      mat.uniforms.uCharCount!.value = src.uCharCount!.value;
      mat.uniforms.uCharBox!.value = src.uCharBox!.value;
      mat.uniforms.uCharAlpha!.value = src.uCharAlpha!.value;
      mat.uniforms.uCharWrite!.value = src.uCharWrite!.value;
      mat.uniforms.uFlash!.value = src.uFlash!.value;
      mat.uniforms.uSweep!.value = src.uSweep!.value;
      mat.uniforms.uSweepKind!.value = src.uSweepKind!.value;
      mat.uniforms.uSweepStrength!.value = src.uSweepStrength!.value;
      applyLyricColorUniforms(mat);
    }
  }

  function hideSplitLine(view: LyricLineView): void {
    if (!view.segs) return;
    view.plane.visible = true;
    view.segs.forEach((seg) => {
      seg.visible = false;
    });
  }

  function updateLyrics(delta: number): void {"""
assert s.count(anchor) == 1
s = s.replace(anchor, helpers, 1)

# 6) 退场分支：split 样式处理 + 应用
old = """        prev.group.position.set(prevX, prevY, lyricAnchorTemp.z);
        prev.group.scale.setScalar(prevScale * lyricsScale);
        prev.group.lookAt(camera.position);"""
new = """        if (lyricEnterStyle.startsWith('split-')) {
          prevScale = 1;
        }
        prev.group.position.set(prevX, prevY, lyricAnchorTemp.z);
        prev.group.scale.setScalar(prevScale * lyricsScale);
        prev.group.lookAt(camera.position);
        if (lyricEnterStyle.startsWith('split-')) {
          applySplitLine(prev, prev.amount, lyricEnterStyle);
        } else {
          hideSplitLine(prev);
        }"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 7) 入场分支：split 样式处理 + 应用
old = """      view.group.position.set(enterX, enterY, lyricAnchorTemp.z);
      view.group.scale.setScalar(enterScale * lyricsScale);
      view.group.lookAt(camera.position);"""
new = """      if (lyricEnterStyle.startsWith('split-')) {
        enterScale = 1;
      }
      view.group.position.set(enterX, enterY, lyricAnchorTemp.z);
      view.group.scale.setScalar(enterScale * lyricsScale);
      view.group.lookAt(camera.position);
      if (lyricEnterStyle.startsWith('split-')) {
        applySplitLine(view, enter, lyricEnterStyle);
      } else {
        hideSplitLine(view);
      }"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

io.open(fp, "w", encoding="utf-8", newline="").write(s)
print("floatScene: split-* styles added")
