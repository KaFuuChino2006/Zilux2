# -*- coding: utf-8 -*-
"""已播歌词彩色渐变：颜色模式增加 rainbow，并让所有彩色模式叠加彩虹流动渐变。"""
import io

fs_path = r"E:\Zilux2开发\web\src\three\floatScene.ts"
ss_path = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"

s = io.open(fs_path, "r", encoding="utf-8", newline="").read()

# handle 类型
old = "  setLyricColorMode(mode: 'white' | 'flow' | 'cover' | 'rhythm', palette?: [string, string, string] | null): void;"
new = "  setLyricColorMode(mode: 'white' | 'flow' | 'cover' | 'rhythm' | 'rainbow', palette?: [string, string, string] | null): void;"
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 映射：rainbow -> 4
old = """    uniforms.uColorMode!.value =
      lyricColorMode === 'flow' ? 1 : lyricColorMode === 'cover' ? 2 : lyricColorMode === 'rhythm' ? 3 : 0;"""
new = """    uniforms.uColorMode!.value =
      lyricColorMode === 'flow'
        ? 1
        : lyricColorMode === 'cover'
          ? 2
          : lyricColorMode === 'rhythm'
            ? 3
            : lyricColorMode === 'rainbow'
              ? 4
              : 0;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# shader：彩虹流动 + 彩色模式叠加，未唱部分更暗以突出渐变
old = """            '  vec3 baseColor = vec3(1.0);',
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
            '  vec3 unfilledColor = mix(baseColor, vec3(0.78, 0.79, 0.86), 0.72);',"""
new = """            '  vec3 baseColor = vec3(1.0);',
            '  // 彩色渐变的彩虹色带：沿句子横向铺开并随时间流动',
            '  float rainbowPhase = vUv.x * 2.15 + uTime * 0.42;',
            '  vec3 rainbow = 0.5 + 0.5 * cos(6.28318 * (rainbowPhase + vec3(0.0, 0.33, 0.67)));',
            '  rainbow = mix(rainbow, vec3(1.0), 0.12);',
            '  if (uColorMode > 3.5) {',
            '    baseColor = rainbow;',
            '  } else if (uColorMode > 0.5) {',
            '    float phase = vUv.x * 1.35 + uTime * 0.42;',
            '    vec3 flow = mix(uColorA, uColorB, 0.5 + 0.5 * sin(phase));',
            '    flow = mix(flow, uColorC, 0.5 + 0.5 * sin(phase * 1.7 + 2.1));',
            '    baseColor = mix(flow, rainbow, 0.58);',
            '  }',
            '  if (uColorMode > 2.5 && uColorMode < 3.5) {',
            '    float pulse = clamp(uEnergy * 1.45, 0.0, 1.0);',
            '    vec3 beatColor = mix(uColorA, uColorB, pulse);',
            '    beatColor = mix(beatColor, uColorC, 0.35 * (0.5 + 0.5 * sin(uTime * 3.2)));',
            '    baseColor = mix(baseColor, beatColor, 0.55);',
            '  }',
            '  vec3 unfilledColor = mix(baseColor, vec3(0.78, 0.79, 0.86), 0.82);',"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

io.open(fs_path, "w", encoding="utf-8", newline="").write(s)
print("floatScene rainbow shader patched")

# ---------- spaceShell：类型、默认值、解析、面板、标签、QA ----------
s = io.open(ss_path, "r", encoding="utf-8", newline="").read()

old = "    lyricColor: 'white' as 'white' | 'flow' | 'cover' | 'rhythm',"
new = "    lyricColor: 'rainbow' as 'white' | 'flow' | 'cover' | 'rhythm' | 'rainbow',"
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """        lyricColor:
          parsed.lyricColor === 'flow' || parsed.lyricColor === 'cover' || parsed.lyricColor === 'rhythm'
            ? parsed.lyricColor
            : 'white',"""
new = """        lyricColor:
          parsed.lyricColor === 'flow' ||
          parsed.lyricColor === 'cover' ||
          parsed.lyricColor === 'rhythm' ||
          parsed.lyricColor === 'rainbow'
            ? parsed.lyricColor
            : DEFAULT_CUSTOM.lyricColor,"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 面板加「彩色」选项（放在「流动」后）
old = """                <button class="custom-seg-btn" data-lyric-color="flow" type="button">流动</button>"""
new = """                <button class="custom-seg-btn" data-lyric-color="flow" type="button">流动</button>
                <button class="custom-seg-btn" data-lyric-color="rainbow" type="button">彩色</button>"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# QA 参数允许 rainbow
old = """  const qaLyricColor = params.get('lyriccolor');
  if (qaLyricColor === 'flow' || qaLyricColor === 'cover' || qaLyricColor === 'rhythm') custom.lyricColor = qaLyricColor;"""
new = """  const qaLyricColor = params.get('lyriccolor');
  if (qaLyricColor === 'flow' || qaLyricColor === 'cover' || qaLyricColor === 'rhythm' || qaLyricColor === 'rainbow') {
    custom.lyricColor = qaLyricColor;
  }"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 标签文字
old = """    lyricColorCurrent.textContent =
      custom.lyricColor === 'flow' ? '流动' : custom.lyricColor === 'cover' ? '封面' : custom.lyricColor === 'rhythm' ? '节奏' : '白';"""
new = """    lyricColorCurrent.textContent =
      custom.lyricColor === 'flow'
        ? '流动'
        : custom.lyricColor === 'cover'
          ? '封面'
          : custom.lyricColor === 'rhythm'
            ? '节奏'
            : custom.lyricColor === 'rainbow'
              ? '彩色'
              : '白';"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 颜色选项点击处理中 lyricColor 赋值类型
old = """      const value = button.dataset.lyricColor;
      custom.lyricColor =
        value === 'flow' || value === 'cover' || value === 'rhythm' ? value : 'white';"""
assert s.count(old) == 1, "lyric color click handler anchor"
new = """      const value = button.dataset.lyricColor;
      custom.lyricColor =
        value === 'flow' || value === 'cover' || value === 'rhythm' || value === 'rainbow' ? value : 'white';"""
s = s.replace(old, new, 1)

io.open(ss_path, "w", encoding="utf-8", newline="").write(s)
print("spaceShell rainbow option patched")
