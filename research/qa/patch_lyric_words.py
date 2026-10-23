# -*- coding: utf-8 -*-
"""逐字动画选项：逐字点亮 / 逐字出现（淡入） / 书写动画（逐字笔序浮现）。"""
import io


def patch_file(path, pairs):
    s = io.open(path, 'r', encoding='utf-8', newline='').read()
    for old, new, label in pairs:
        assert s.count(old) == 1, f"anchor miss {label}: {old[:80]!r}"
        s = s.replace(old, new, 1)
    io.open(path, 'w', encoding='utf-8', newline='').write(s)
    print('patched', path)


THREE = r"E:\Zilux2开发\web\src\three\floatScene.ts"
UI = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"

# ---------------- floatScene.ts ----------------
patch_file(
    THREE,
    [
        (
            """  let lyricProgress = 0;
  let lyricClock = 0;""",
            """  let lyricProgress = 0;
  let lyricClock = 0;
  // 逐字动画开关（外观面板「歌词」分组）
  let wordFill = true;
  let wordAppear: 'off' | 'fade' = 'fade';
  let wordWrite = false;""",
            "word state",
        ),
        (
            """  setLyricEnterStyle(style: LyricEnterStyle): void;""",
            """  setLyricEnterStyle(style: LyricEnterStyle): void;
  /** 逐字动画选项：点亮 / 逐字出现 / 书写效果 */
  setLyricWordOptions(options: { fill?: boolean; appear?: 'off' | 'fade'; write?: boolean }): void;""",
            "handle interface",
        ),
        (
            """    setLyricEnterStyle(style: LyricEnterStyle) {
      lyricEnterStyle = style;
    },""",
            """    setLyricEnterStyle(style: LyricEnterStyle) {
      lyricEnterStyle = style;
    },
    setLyricWordOptions(options) {
      if (typeof options.fill === 'boolean') wordFill = options.fill;
      if (options.appear === 'off' || options.appear === 'fade') wordAppear = options.appear;
      if (typeof options.write === 'boolean') wordWrite = options.write;
    },""",
            "handle impl",
        ),
        (
            """            uMap: { value: texture },
            uProgress: { value: 0 },
            uOpacity: { value: 0 },
          },""",
            """            uMap: { value: texture },
            uProgress: { value: 0 },
            uOpacity: { value: 0 },
            uFill: { value: 1 },
            uWrite: { value: 0 },
            uCharCount: { value: 0 },
            uCharBox: { value: new Float32Array(96) },
            uCharAlpha: { value: new Float32Array(48) },
            uCharWrite: { value: new Float32Array(48) },
          },""",
            "uniforms",
        ),
        (
            """          fragmentShader: [
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
          ].join('\\n'),""",
            """          fragmentShader: [
            'varying vec2 vUv;',
            'uniform sampler2D uMap;',
            'uniform float uProgress;',
            'uniform float uOpacity;',
            'uniform float uFill;',
            'uniform float uWrite;',
            'uniform int uCharCount;',
            'uniform float uCharBox[96];',
            'uniform float uCharAlpha[48];',
            'uniform float uCharWrite[48];',
            'void main() {',
            '  vec4 tex = texture2D(uMap, vUv);',
            '  if (tex.a < 0.02) discard;',
            '  float unfilled = smoothstep(uProgress - 0.012, uProgress + 0.012, vUv.x);',
            '  if (uFill < 0.5) unfilled = 0.0;',
            '  float charAlpha = 1.0;',
            '  float written = 1.0;',
            '  for (int i = 0; i < 48; i++) {',
            '    if (i >= uCharCount) break;',
            '    float x0 = uCharBox[i * 2];',
            '    float x1 = uCharBox[i * 2 + 1];',
            '    if (vUv.x >= x0 - 0.0015 && vUv.x <= x1 + 0.0015) {',
            '      charAlpha = uCharAlpha[i];',
            '      if (uWrite > 0.5) {',
            '        float localX = clamp((vUv.x - x0) / max(0.0001, x1 - x0), 0.0, 1.0);',
            '        float localY = clamp((vUv.y - 0.12) / 0.68, 0.0, 1.0);',
            '        float edge = localX * 0.58 + localY * 0.42;',
            '        written = step(edge, uCharWrite[i]);',
            '      }',
            '      break;',
            '    }',
            '  }',
            '  float alpha = tex.a * mix(1.0, 0.26, unfilled) * uOpacity * charAlpha * written;',
            '  vec3 color = mix(vec3(1.0), vec3(0.76, 0.74, 0.9), unfilled);',
            '  gl_FragColor = vec4(color, alpha);',
            '}',
          ].join('\\n'),""",
            "fragment shader",
        ),
        (
            """      const material = view.plane.material;
      material.uniforms.uProgress!.value = lyricRevealFor(view);
      material.uniforms.uOpacity!.value = ease * enter;""",
            """      const material = view.plane.material;
      const chars = line.chars;
      const boxes = view.charBoxes;
      const charCount = chars && boxes.length === chars.length ? Math.min(chars.length, 48) : 0;
      const boxArr = material.uniforms.uCharBox!.value as Float32Array;
      const alphaArr = material.uniforms.uCharAlpha!.value as Float32Array;
      const writeArr = material.uniforms.uCharWrite!.value as Float32Array;
      for (let i = 0; i < charCount; i += 1) {
        const box = boxes[i];
        boxArr[i * 2] = box.x0;
        boxArr[i * 2 + 1] = box.x1;
        const char = chars![i];
        if (wordAppear === 'fade') {
          const t = Math.min(1, Math.max(0, (lyricClock - char.start) / 0.26));
          alphaArr[i] = t * t * (3 - 2 * t);
        } else {
          alphaArr[i] = 1;
        }
        const span = Math.max(0.16, char.end - char.start);
        writeArr[i] = Math.min(1, Math.max(0, (lyricClock - char.start) / span));
      }
      material.uniforms.uCharCount!.value = charCount;
      material.uniforms.uWrite!.value = wordWrite && charCount > 0 ? 1 : 0;
      material.uniforms.uFill!.value = wordFill ? 1 : 0;
      material.uniforms.uProgress!.value = wordFill ? lyricRevealFor(view) : 1;
      material.uniforms.uOpacity!.value = ease * enter;""",
            "per char uniforms",
        ),
    ],
)

# ---------------- spaceShell.ts ----------------
patch_file(
    UI,
    [
        (
            """    tileBend: 0.35,
    lyricEnter: 'fade' as LyricEnterStyle,
  };""",
            """    tileBend: 0.35,
    lyricEnter: 'fade' as LyricEnterStyle,
    wordsFill: true,
    wordsAppear: 'fade' as 'off' | 'fade',
    wordsWrite: false,
  };""",
            "defaults",
        ),
        (
            """        tileBend?: unknown;
        lyricEnter?: unknown;
      };""",
            """        tileBend?: unknown;
        lyricEnter?: unknown;
        wordsFill?: unknown;
        wordsAppear?: unknown;
        wordsWrite?: unknown;
      };""",
            "parsed fields",
        ),
        (
            """      return { image, tileCols, tileRows, tileBend, lyricEnter };""",
            """      return {
        image,
        tileCols,
        tileRows,
        tileBend,
        lyricEnter,
        wordsFill: parsed.wordsFill !== false && parsed.wordsFill !== 'off',
        wordsAppear: parsed.wordsAppear === 'off' ? 'off' : 'fade',
        wordsWrite: parsed.wordsWrite === true || parsed.wordsWrite === 'on',
      };""",
            "loadCustom return",
        ),
        (
            """  const custom = loadCustom();
  let customSaveTimer = 0;""",
            """  const custom = loadCustom();
  // QA：?wordsfill=0/1&wordsappear=off|fade&wordswrite=0/1 临时覆盖逐字选项（不写 localStorage）
  const qaWordsFill = params.get('wordsfill');
  if (qaWordsFill === '0') custom.wordsFill = false;
  if (qaWordsFill === '1') custom.wordsFill = true;
  const qaWordsAppear = params.get('wordsappear');
  if (qaWordsAppear === 'off' || qaWordsAppear === 'fade') custom.wordsAppear = qaWordsAppear;
  const qaWordsWrite = params.get('wordswrite');
  if (qaWordsWrite === '0') custom.wordsWrite = false;
  if (qaWordsWrite === '1') custom.wordsWrite = true;
  let customSaveTimer = 0;""",
            "qa word overrides",
        ),
        (
            """  const applyCustom = (): void => {
    space?.setUnderlayImage(custom.image);
    space?.setTileBend(custom.tileBend);
    space?.setLyricEnterStyle(custom.lyricEnter);
  };""",
            """  const applyCustom = (): void => {
    space?.setUnderlayImage(custom.image);
    space?.setTileBend(custom.tileBend);
    space?.setLyricEnterStyle(custom.lyricEnter);
    space?.setLyricWordOptions({
      fill: custom.wordsFill,
      appear: custom.wordsAppear,
      write: custom.wordsWrite,
    });
  };""",
            "applyCustom words",
        ),
        (
            """              <p class="custom-tip">只在 3D 歌词播放界面生效，仅影响本机</p>
            </div>
          </section>""",
            """              <p class="custom-tip">只在 3D 歌词播放界面生效，仅影响本机</p>
            </div>
          </section>
          <section class="custom-section">
            <header class="custom-section-head">
              <span class="custom-kicker">逐字</span>
              <div>
                <h3>歌词逐字动画</h3>
                <p>逐字点亮、逐字出现与书写效果</p>
              </div>
            </header>
            <div class="custom-field custom-words">
              <div class="custom-label"><span>逐字点亮</span><b data-words-fill-current>开</b></div>
              <div class="custom-seg" data-words-fill-seg>
                <button class="custom-seg-btn is-on" data-words-fill="on" type="button">开</button>
                <button class="custom-seg-btn" data-words-fill="off" type="button">关</button>
              </div>
              <p class="custom-tip">唱到哪个字，哪个字变亮</p>
            </div>
            <div class="custom-field custom-words">
              <div class="custom-label"><span>逐字出现</span><b data-words-appear-current>淡入</b></div>
              <div class="custom-seg" data-words-appear-seg>
                <button class="custom-seg-btn" data-words-appear="off" type="button">无</button>
                <button class="custom-seg-btn is-on" data-words-appear="fade" type="button">淡入</button>
              </div>
              <p class="custom-tip">每个字在自己的时间点单独淡入</p>
            </div>
            <div class="custom-field custom-words">
              <div class="custom-label"><span>书写动画</span><b data-words-write-current>关</b></div>
              <div class="custom-seg" data-words-write-seg>
                <button class="custom-seg-btn" data-words-write="on" type="button">开</button>
                <button class="custom-seg-btn is-on" data-words-write="off" type="button">关</button>
              </div>
              <p class="custom-tip">每个字按笔画走势逐段浮现（逐字时间来自网易云逐字歌词，没有时按整句均分）</p>
            </div>
          </section>""",
            "words section markup",
        ),
        (
            """  const lyricEnterBtns = root.querySelectorAll<HTMLButtonElement>('[data-lyric-enter]');
  const lyricEnterLabel = root.querySelector<HTMLElement>('[data-lyric-enter-label]')!;""",
            """  const lyricEnterBtns = root.querySelectorAll<HTMLButtonElement>('[data-lyric-enter]');
  const lyricEnterLabel = root.querySelector<HTMLElement>('[data-lyric-enter-label]')!;
  const wordsFillBtns = root.querySelectorAll<HTMLButtonElement>('[data-words-fill]');
  const wordsAppearBtns = root.querySelectorAll<HTMLButtonElement>('[data-words-appear]');
  const wordsWriteBtns = root.querySelectorAll<HTMLButtonElement>('[data-words-write]');
  const wordsFillCurrent = root.querySelector<HTMLElement>('[data-words-fill-current]')!;
  const wordsAppearCurrent = root.querySelector<HTMLElement>('[data-words-appear-current]')!;
  const wordsWriteCurrent = root.querySelector<HTMLElement>('[data-words-write-current]')!;""",
            "words refs",
        ),
        (
            """    lyricEnterLabel.textContent = LYRIC_ENTER_LABELS[custom.lyricEnter];""",
            """    lyricEnterLabel.textContent = LYRIC_ENTER_LABELS[custom.lyricEnter];
    wordsFillBtns.forEach((button) => {
      button.classList.toggle('is-on', (button.dataset.wordsFill === 'on') === custom.wordsFill);
    });
    wordsAppearBtns.forEach((button) => {
      button.classList.toggle('is-on', button.dataset.wordsAppear === custom.wordsAppear);
    });
    wordsWriteBtns.forEach((button) => {
      button.classList.toggle('is-on', (button.dataset.wordsWrite === 'on') === custom.wordsWrite);
    });
    wordsFillCurrent.textContent = custom.wordsFill ? '开' : '关';
    wordsAppearCurrent.textContent = custom.wordsAppear === 'fade' ? '淡入' : '无';
    wordsWriteCurrent.textContent = custom.wordsWrite ? '开' : '关';""",
            "syncCustomUi words",
        ),
        (
            """    custom.tileBend = DEFAULT_CUSTOM.tileBend;""",
            """    custom.tileBend = DEFAULT_CUSTOM.tileBend;
    custom.wordsFill = DEFAULT_CUSTOM.wordsFill;
    custom.wordsAppear = DEFAULT_CUSTOM.wordsAppear;
    custom.wordsWrite = DEFAULT_CUSTOM.wordsWrite;""",
            "reset words",
        ),
        (
            """  customOpenBtn.addEventListener('click', openCustomSheet);""",
            """  wordsFillBtns.forEach((button) => {
    button.addEventListener('click', () => {
      custom.wordsFill = button.dataset.wordsFill === 'on';
      syncCustomUi();
      space?.setLyricWordOptions({ fill: custom.wordsFill });
      persistCustom();
    });
  });
  wordsAppearBtns.forEach((button) => {
    button.addEventListener('click', () => {
      custom.wordsAppear = button.dataset.wordsAppear === 'off' ? 'off' : 'fade';
      syncCustomUi();
      space?.setLyricWordOptions({ appear: custom.wordsAppear });
      persistCustom();
    });
  });
  wordsWriteBtns.forEach((button) => {
    button.addEventListener('click', () => {
      custom.wordsWrite = button.dataset.wordsWrite === 'on';
      syncCustomUi();
      space?.setLyricWordOptions({ write: custom.wordsWrite });
      persistCustom();
    });
  });
  customOpenBtn.addEventListener('click', openCustomSheet);""",
            "words events",
        ),
        (
            """  // QA：?panel=custom 直接打开自定义外观面板""",
            """  // QA：?wordstest=1 进入 3D 歌词界面并塞入带逐字时间轴的测试歌词（验收逐字动画）
  if (params.get('wordstest') === '1') {
    window.setTimeout(() => {
      if (disposed) return;
      void enterSpace(true);
      window.setTimeout(() => {
        if (disposed) return;
        const text = '逐字歌词测试效果';
        const glyphs = Array.from(text);
        const chars = glyphs.map((char, i) => ({
          text: char,
          start: 0.2 + i * 0.32,
          end: 0.2 + i * 0.32 + 0.3,
        }));
        lyricsOpen = true;
        lyricsBtn.classList.add('is-on');
        lyricsDim.classList.add('is-on');
        space?.setLyrics([{ text, startTime: 0.2, chars }]);
        space?.setLyricsView(true);
        space?.setTilesScattered(true);
        window.cancelAnimationFrame(lyricsTimer);
        const started = performance.now();
        const tick = (): void => {
          if (disposed || !lyricsOpen) return;
          const elapsed = (performance.now() - started) / 1000;
          space?.setLyricsTime(0.2 + (elapsed % 5));
          lyricsTimer = window.requestAnimationFrame(tick);
        };
        tick();
      }, 2400);
    }, 800);
  }

  // QA：?panel=custom 直接打开自定义外观面板""",
            "wordstest qa",
        ),
    ],
)
print('words animation patch done')
