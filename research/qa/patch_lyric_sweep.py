# -*- coding: utf-8 -*-
"""歌词几何遮罩划过：斜带 / 圆环 / 菱形掠影，每换一句触发一次，可在外观面板关闭。"""
import io

fs_path = r"E:\Zilux2开发\web\src\three\floatScene.ts"
ss_path = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"

# ============ floatScene ============
s = io.open(fs_path, "r", encoding="utf-8", newline="").read()

pairs = [
    # 1) 接口
    ("  flashLyricColor(): void;",
     "  flashLyricColor(): void;\n  /** 歌词几何遮罩划过（斜带/圆环/菱形掠影），默认开 */\n  setLyricSweepEnabled(enabled: boolean): void;"),

    # 2) 状态变量
    ("  let lyricColorFlash = 0;",
     """  let lyricColorFlash = 0;
  // 几何遮罩：uSweep < 0 表示空闲；每次换句触发一次，三种几何形轮换
  let lyricSweep = -1;
  let lyricSweepKind = 0;
  let lyricSweepStrength = 0;
  let lyricSweepEnabled = true;"""),

    # 3) uniforms
    ("            uFlash: { value: 0 },",
     "            uFlash: { value: 0 },\n            uSweep: { value: -1 },\n            uSweepKind: { value: 0 },\n            uSweepStrength: { value: 0 },"),

    # 4) shader uniform 声明
    ("            'uniform float uFlash;',",
     "            'uniform float uFlash;',\n            'uniform float uSweep;',\n            'uniform float uSweepKind;',\n            'uniform float uSweepStrength;',"),

    # 5) fragment：几何遮罩效果（放在 flash 之后、gl_FragColor 之前）
    ("""            '  alpha = clamp(alpha * (1.0 + uFlash * 0.16), 0.0, 1.0);',
            '  gl_FragColor = vec4(color, alpha);',""",
     """            '  alpha = clamp(alpha * (1.0 + uFlash * 0.16), 0.0, 1.0);',
            '  // 几何遮罩划过：斜向色带 / 扩散圆环 / 菱形掠影（只在字形上生效）',
            '  if (uSweep >= 0.0) {',
            '    float p = clamp(uSweep, 0.0, 1.0);',
            '    float sweepMask = 0.0;',
            '    if (uSweepKind < 0.5) {',
            '      float band = vUv.x * 0.78 + vUv.y * 0.22;',
            '      float center = -0.18 + p * 1.38;',
            '      sweepMask = 1.0 - smoothstep(0.015, 0.1, abs(band - center));',
            '    } else if (uSweepKind < 1.5) {',
            '      vec2 ringCenter = vec2(-0.1 + p * 1.2, 0.5);',
            '      float dist = length((vUv - ringCenter) * vec2(1.0, 1.7));',
            '      sweepMask = 1.0 - smoothstep(0.02, 0.085, abs(dist - 0.22));',
            '    } else {',
            '      float diamond = abs(vUv.x - (-0.12 + p * 1.24)) * 1.85 + abs(vUv.y - 0.5);',
            '      sweepMask = 1.0 - smoothstep(0.14, 0.22, diamond);',
            '    }',
            '    sweepMask *= uSweepStrength * (1.0 - unfilled * 0.4);',
            '    color = mix(color, vec3(1.0), clamp(sweepMask, 0.0, 1.0));',
            '    alpha = clamp(alpha + sweepMask * 0.22, 0.0, 1.0);',
            '  }',
            '  gl_FragColor = vec4(color, alpha);',"""),

    # 6) uniform 写入
    ("    uniforms.uFlash!.value = lyricColorFlash;",
     "    uniforms.uFlash!.value = lyricColorFlash;\n    uniforms.uSweep!.value = lyricSweepEnabled ? lyricSweep : -1;\n    uniforms.uSweepKind!.value = lyricSweepKind;\n    uniforms.uSweepStrength!.value = lyricSweepStrength;"),

    # 7) 每帧推进
    ("    if (lyricColorFlash > 0) lyricColorFlash = Math.max(0, lyricColorFlash - delta * 2.1);",
     """    if (lyricColorFlash > 0) lyricColorFlash = Math.max(0, lyricColorFlash - delta * 2.1);
    if (lyricSweep >= 0) {
      lyricSweep += delta / 0.62;
      if (lyricSweep > 1.35) lyricSweep = -1;
    }"""),

    # 8) 换句触发
    ("      if (active !== lyricActive) {\n        if (lyricActive >= 0) lyricPrev = lyricActive;\n        lyricActive = active;\n        lyricProgress = 0;\n      }",
     """      if (active !== lyricActive) {
        if (lyricActive >= 0) lyricPrev = lyricActive;
        lyricActive = active;
        lyricProgress = 0;
        // 每换一句触发一次几何遮罩划过（三种几何形轮换，带一点随机）
        if (lyricSweepEnabled && active >= 0) {
          lyricSweep = 0;
          lyricSweepKind = Math.floor(Math.random() * 3);
          lyricSweepStrength = 0.62 + Math.random() * 0.26;
        }
      }"""),

    # 9) handle 实现
    ("    flashLyricColor() {\n      lyricColorFlash = 1;\n    },",
     """    flashLyricColor() {
      lyricColorFlash = 1;
    },
    setLyricSweepEnabled(enabled) {
      lyricSweepEnabled = enabled;
      if (!enabled) lyricSweep = -1;
    },"""),
]

for old, new in pairs:
    assert s.count(old) == 1, "floatScene anchor: " + old[:60]
    s = s.replace(old, new, 1)

io.open(fs_path, "w", encoding="utf-8", newline="").write(s)
print("floatScene lyric sweep patched")

# ============ spaceShell ============
s = io.open(ss_path, "r", encoding="utf-8", newline="").read()

pairs = [
    ("    scatterCovers: true,", "    scatterCovers: true,\n    lyricSweep: true,"),
    ("        scatterCovers?: unknown;", "        scatterCovers?: unknown;\n        lyricSweep?: unknown;"),
    ("        scatterCovers: parsed.scatterCovers !== false,",
     "        scatterCovers: parsed.scatterCovers !== false,\n        lyricSweep: parsed.lyricSweep !== false,"),

    # 面板行：散布封面之后
    ("""                <p class="custom-tip">开：歌词模式里封面散落在空间中；关：磁贴仍会散开，但过程中封面渐渐淡出、退出时淡入</p>
              </div>""",
     """                <p class="custom-tip">开：歌词模式里封面散落在空间中；关：磁贴仍会散开，但过程中封面渐渐淡出、退出时淡入</p>
              </div>
              <div class="custom-field">
                <div class="custom-label"><span>几何划过</span><b data-lyric-sweep-current>开</b></div>
                <div class="custom-seg" data-lyric-sweep-seg>
                  <button class="custom-seg-btn is-on" data-lyric-sweep="on" type="button">开</button>
                  <button class="custom-seg-btn" data-lyric-sweep="off" type="button">关</button>
                </div>
                <p class="custom-tip">每换一句歌词，会有一道几何遮罩（斜带/圆环/菱形）划过文字</p>
              </div>"""),

    ("  const scatterCoversCurrent = root.querySelector<HTMLElement>('[data-scatter-covers-current]')!;",
     "  const scatterCoversCurrent = root.querySelector<HTMLElement>('[data-scatter-covers-current]')!;\n  const lyricSweepBtns = root.querySelectorAll<HTMLButtonElement>('[data-lyric-sweep]');\n  const lyricSweepCurrent = root.querySelector<HTMLElement>('[data-lyric-sweep-current]')!;"),

    ("  const qaScatterCovers = params.get('scattercovers');",
     "  const qaLyricSweep = params.get('lyricsweep');\n  if (qaLyricSweep === '0') custom.lyricSweep = false;\n  if (qaLyricSweep === '1') custom.lyricSweep = true;\n  const qaScatterCovers = params.get('scattercovers');"),

    ("    space?.setScatterCovers(custom.scatterCovers);",
     "    space?.setScatterCovers(custom.scatterCovers);\n    space?.setLyricSweepEnabled(custom.lyricSweep);"),

    ("    scatterCoversCurrent.textContent = custom.scatterCovers ? '开' : '关';",
     "    scatterCoversCurrent.textContent = custom.scatterCovers ? '开' : '关';\n    lyricSweepBtns.forEach((button) => {\n      button.classList.toggle('is-on', (button.dataset.lyricSweep === 'on') === custom.lyricSweep);\n    });\n    lyricSweepCurrent.textContent = custom.lyricSweep ? '开' : '关';"),

    ("""  wordsWriteBtns.forEach((button) => {
    button.addEventListener('click', () => {""",
     """  lyricSweepBtns.forEach((button) => {
    button.addEventListener('click', () => {
      custom.lyricSweep = button.dataset.lyricSweep === 'on';
      syncCustomUi();
      space?.setLyricSweepEnabled(custom.lyricSweep);
      persistCustom();
    });
  });
  wordsWriteBtns.forEach((button) => {
    button.addEventListener('click', () => {"""),
]

for old, new in pairs:
    assert s.count(old) == 1, "spaceShell anchor: " + old[:60]
    s = s.replace(old, new, 1)

io.open(ss_path, "w", encoding="utf-8", newline="").write(s)
print("spaceShell lyric sweep patched")
