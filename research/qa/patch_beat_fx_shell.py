# -*- coding: utf-8 -*-
"""鼓点特效：外观面板项 + 触发逻辑（宿主 beat / 低音阈值）。"""
import io

path = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
s = io.open(path, "r", encoding="utf-8", newline="").read()

pairs = [
    # 1) 默认值
    ("    lyricSweep: true,", "    lyricSweep: true,\n    beatEffect: 'firework',\n    beatThreshold: 0.55,"),

    # 2) 解析类型
    ("        lyricSweep?: unknown;", "        lyricSweep?: unknown;\n        beatEffect?: unknown;\n        beatThreshold?: unknown;"),

    # 3) 解析值（紧随 lyricSweep 解析行）
    ("        lyricSweep: parsed.lyricSweep !== false,",
     """        lyricSweep: parsed.lyricSweep !== false,
        beatEffect:
          parsed.beatEffect === 'off' || parsed.beatEffect === 'ring' || parsed.beatEffect === 'firework'
            ? parsed.beatEffect
            : 'firework',
        beatThreshold:
          typeof parsed.beatThreshold === 'number'
            ? Math.min(0.95, Math.max(0.2, parsed.beatThreshold))
            : 0.55,"""),

    # 4) 面板：背景换色之后插入鼓点特效
    ("""              <p class="custom-tip">「封面」用当前歌曲封面取色；「节奏」会跟着鼓点随机换色（约 3 秒最多一次）</p>
            </div>""",
     """              <p class="custom-tip">「封面」用当前歌曲封面取色；「节奏」会跟着鼓点随机换色（约 3 秒最多一次）</p>
            </div>
            <div class="custom-field">
              <div class="custom-label"><span>鼓点特效</span><b data-beat-effect-current>烟花</b></div>
              <div class="custom-seg" data-beat-effect-seg>
                <button class="custom-seg-btn" data-beat-effect="off" type="button">关闭</button>
                <button class="custom-seg-btn" data-beat-effect="ring" type="button">圆环</button>
                <button class="custom-seg-btn is-on" data-beat-effect="firework" type="button">烟花</button>
              </div>
              <div class="custom-label"><span>低音阈值</span><b data-beat-threshold-current>55%</b></div>
              <input class="custom-slider" data-beat-threshold type="range" min="20" max="95" step="1" value="55" aria-label="鼓点触发阈值" />
              <p class="custom-tip">识别到鼓点、或低音能量超过阈值时，在背景里绽放圆环 / 烟花（跟着封面或节奏配色）</p>
            </div>"""),

    # 5) 元素引用
    ("  const lyricSweepCurrent = root.querySelector<HTMLElement>('[data-lyric-sweep-current]')!;",
     """  const lyricSweepCurrent = root.querySelector<HTMLElement>('[data-lyric-sweep-current]')!;
  const beatEffectBtns = root.querySelectorAll<HTMLButtonElement>('[data-beat-effect]');
  const beatEffectCurrent = root.querySelector<HTMLElement>('[data-beat-effect-current]')!;
  const beatThresholdInput = root.querySelector<HTMLInputElement>('[data-beat-threshold]')!;
  const beatThresholdCurrent = root.querySelector<HTMLElement>('[data-beat-threshold-current]')!;"""),

    # 6) QA 参数
    ("  const qaLyricSweep = params.get('lyricsweep');",
     """  const qaBeatEffect = params.get('beateffect');
  if (qaBeatEffect === 'off' || qaBeatEffect === 'ring' || qaBeatEffect === 'firework') {
    custom.beatEffect = qaBeatEffect;
  }
  const qaBeatThreshold = Number.parseFloat(params.get('beatthreshold') ?? '');
  if (Number.isFinite(qaBeatThreshold)) custom.beatThreshold = Math.min(0.95, Math.max(0.2, qaBeatThreshold));
  const qaLyricSweep = params.get('lyricsweep');"""),

    # 7) syncCustomUi
    ("    lyricSweepCurrent.textContent = custom.lyricSweep ? '开' : '关';",
     """    lyricSweepCurrent.textContent = custom.lyricSweep ? '开' : '关';
    beatEffectBtns.forEach((button) => {
      button.classList.toggle('is-on', button.dataset.beatEffect === custom.beatEffect);
    });
    beatEffectCurrent.textContent =
      custom.beatEffect === 'ring' ? '圆环' : custom.beatEffect === 'firework' ? '烟花' : '关闭';
    beatThresholdInput.value = String(Math.round(custom.beatThreshold * 100));
    beatThresholdCurrent.textContent = `${Math.round(custom.beatThreshold * 100)}%`;"""),

    # 8) 事件监听：lyricSweep 监听之后
    ("""  lyricSweepBtns.forEach((button) => {
    button.addEventListener('click', () => {""",
     """  beatEffectBtns.forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.dataset.beatEffect;
      if (value === 'off' || value === 'ring' || value === 'firework') custom.beatEffect = value;
      syncCustomUi();
      persistCustom();
    });
  });
  beatThresholdInput.addEventListener('input', () => {
    custom.beatThreshold = Math.min(0.95, Math.max(0.2, Number(beatThresholdInput.value) / 100));
    beatThresholdCurrent.textContent = `${Math.round(custom.beatThreshold * 100)}%`;
    persistCustom();
  });
  lyricSweepBtns.forEach((button) => {
    button.addEventListener('click', () => {"""),

    # 9) 状态变量（tintVariant 附近）
    ("  let tintVariant = 0;", "  let tintVariant = 0;\n  let lastBass = 0;\n  let lastBeatFxAt = 0;"),

    # 10) 音频回调内触发
    ("""    onAudioFrame((frame) => {
      space?.setAudioEnergy(frame.level);
      if (custom.bgColor === 'rhythm' && frame.beat) evaluateRhythmTint();
    });""",
     """    onAudioFrame((frame) => {
      space?.setAudioEnergy(frame.level);
      if (custom.bgColor === 'rhythm' && frame.beat) evaluateRhythmTint();
      // 鼓点识别：宿主 beat 标记，或低音能量越过自定义阈值（带上升沿 + 冷却）
      const bass = frame.bands.length > 0 ? (frame.bands[0] ?? frame.level) : frame.level;
      const now = performance.now();
      const crossed = bass >= custom.beatThreshold && bass > lastBass + 0.015;
      lastBass = bass;
      if (
        custom.beatEffect !== 'off' &&
        colorPlaying &&
        (frame.beat || crossed) &&
        now - lastBeatFxAt > 260
      ) {
        lastBeatFxAt = now;
        const pal =
          (custom.bgColor === 'rhythm' && rhythmColors) ||
          paletteColors ||
          ['#8b7bff', '#5df2ff', '#ff6ea9'];
        space?.triggerBeatEffect(custom.beatEffect, Math.max(0.45, Math.min(1.6, bass)), pal);
      }
    });"""),

    # 11) QA beattest
    ("  const qaBeatEffect = params.get('beateffect');",
     """  if (params.get('beattest') === '1') {
    window.setInterval(() => {
      if (disposed) return;
      const pal =
        (custom.bgColor === 'rhythm' && rhythmColors) ||
        paletteColors ||
        ['#8b7bff', '#5df2ff', '#ff6ea9'];
      space?.triggerBeatEffect(custom.beatEffect === 'off' ? 'firework' : custom.beatEffect, 1.1, pal);
    }, 1100);
  }
  const qaBeatEffect = params.get('beateffect');"""),
]

for old, new in pairs:
    assert s.count(old) >= 1, "spaceShell anchor: " + old[:70]
    s = s.replace(old, new, 1)

io.open(path, "w", encoding="utf-8", newline="").write(s)
print("spaceShell beat effects patched")
