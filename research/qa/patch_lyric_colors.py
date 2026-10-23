# -*- coding: utf-8 -*-
"""floatScene：歌词颜色模式（白/流动渐变/封面色/音频节奏）。"""
import io

P = r"E:\Zilux2开发\web\src\three\floatScene.ts"

with io.open(P, "r", encoding="utf-8", newline="") as f:
    s = f.read()


def sub(old, new, label):
    global s
    if s.count(old) != 1:
        raise SystemExit(f"[fail] {label}: count={s.count(old)}")
    s = s.replace(old, new, 1)
    print(f"[ok] {label}")


# 1) 状态
sub(
    "  let wordWrite = false;\n",
    "  let wordWrite = false;\n"
    "  // 歌词颜色模式：white 纯白 / flow 流动渐变 / cover 封面取色渐变 / rhythm 跟随音频节奏\n"
    "  let lyricColorMode: 'white' | 'flow' | 'cover' | 'rhythm' = 'white';\n"
    "  let lyricColorClock = 0;\n"
    "  let audioEnergyLevel = 0;\n"
    "  let lyricPalette: [string, string, string] = ['#ffffff', '#ffffff', '#ffffff'];\n",
    "state",
)

# 2) 接口
sub(
    "  setLyricWordOptions(options: { fill?: boolean; appear?: 'off' | 'fade'; write?: boolean }): void;\n",
    "  setLyricWordOptions(options: { fill?: boolean; appear?: 'off' | 'fade'; write?: boolean }): void;\n"
    "  setLyricColorMode(mode: 'white' | 'flow' | 'cover' | 'rhythm', palette?: [string, string, string] | null): void;\n"
    "  setAudioEnergy(level: number): void;\n",
    "interface",
)

# 3) uniforms
sub(
    """            uCharWrite: { value: new Float32Array(48) },
          },""",
    """            uCharWrite: { value: new Float32Array(48) },
            uColorMode: { value: 0 },
            uColorA: { value: new THREE.Color('#ffffff') },
            uColorB: { value: new THREE.Color('#ffffff') },
            uColorC: { value: new THREE.Color('#ffffff') },
            uTime: { value: 0 },
            uEnergy: { value: 0 },
          },""",
    "uniforms",
)

# 4) 片元着色器：颜色模式
sub(
    """            '  float alpha = tex.a * mix(1.0, 0.34, unfilled) * uOpacity * charAlpha * written;',
            '  vec3 color = mix(vec3(1.0), vec3(0.76, 0.74, 0.9), unfilled);',
            '  gl_FragColor = vec4(color, alpha);',""",
    """            '  float alpha = tex.a * mix(1.0, 0.34, unfilled) * uOpacity * charAlpha * written;',
            '  vec3 baseColor = vec3(1.0);',
            '  if (uColorMode > 0.5) {',
            '    float phase = vUv.x * 1.35 + uTime * 0.42;',
            '    vec3 flow = mix(uColorA, uColorB, 0.5 + 0.5 * sin(phase));',
            '    flow = mix(flow, uColorC, 0.5 + 0.5 * sin(phase * 1.7 + 2.1));',
            '    baseColor = flow;',
            '  }',
            '  if (uColorMode > 2.5) {',
            '    float pulse = clamp(uEnergy * 1.45, 0.0, 1.0);',
            '    vec3 beatColor = mix(uColorA, uColorB, pulse);',
            '    beatColor = mix(beatColor, uColorC, 0.35 * (0.5 + 0.5 * sin(uTime * 3.2)));',
            '    baseColor = mix(baseColor, beatColor, 0.85);',
            '  }',
            '  vec3 unfilledColor = mix(baseColor, vec3(0.78, 0.79, 0.86), 0.72);',
            '  vec3 color = mix(baseColor, unfilledColor, unfilled);',
            '  gl_FragColor = vec4(color, alpha);',""",
    "fragment",
)

# 5) 片元 uniforms 声明
sub(
    "            'uniform float uCharWrite[48];',\n",
    "            'uniform float uCharWrite[48];',\n"
    "            'uniform float uColorMode;',\n"
    "            'uniform vec3 uColorA;',\n"
    "            'uniform vec3 uColorB;',\n"
    "            'uniform vec3 uColorC;',\n"
    "            'uniform float uTime;',\n"
    "            'uniform float uEnergy;',\n",
    "fragment uniforms",
)

# 6) 每帧：time / energy / 调色板推进
sub(
    """  function updateLyrics(delta: number): void {
""",
    """  function applyLyricColorUniforms(material: THREE.ShaderMaterial): void {
    const uniforms = material.uniforms;
    uniforms.uTime!.value = lyricColorClock;
    uniforms.uEnergy!.value = audioEnergyLevel;
    uniforms.uColorMode!.value =
      lyricColorMode === 'flow' ? 1 : lyricColorMode === 'cover' ? 2 : lyricColorMode === 'rhythm' ? 3 : 0;
    (uniforms.uColorA!.value as THREE.Color).set(lyricPalette[0]);
    (uniforms.uColorB!.value as THREE.Color).set(lyricPalette[1]);
    (uniforms.uColorC!.value as THREE.Color).set(lyricPalette[2]);
  }

  function updateLyrics(delta: number): void {
    lyricColorClock += delta;
""",
    "updateLyrics head",
)

# 7) prev 与 active 两处 uOpacity 之后同步颜色 uniform
sub(
    """        prev.plane.material.uniforms.uOpacity!.value = ease * prev.amount * 0.8;""",
    """        prev.plane.material.uniforms.uOpacity!.value = ease * prev.amount * 0.8;
        applyLyricColorUniforms(prev.plane.material);""",
    "prev color uniforms",
)

sub(
    """      material.uniforms.uOpacity!.value = ease * enter;""",
    """      material.uniforms.uOpacity!.value = ease * enter;
      applyLyricColorUniforms(material);""",
    "active color uniforms",
)

# 8) handle 实现
sub(
    """    setLyricsTime(current: number) {
""",
    """    setLyricColorMode(mode, palette) {
      lyricColorMode = mode;
      if (palette) {
        lyricPalette = palette;
      }
    },
    setAudioEnergy(level) {
      audioEnergyLevel = Math.max(0, Math.min(1, level));
    },
    setLyricsTime(current: number) {
""",
    "handle impl",
)

with io.open(P, "w", encoding="utf-8", newline="") as f:
    f.write(s)
print("floatScene lyric colors patched")
