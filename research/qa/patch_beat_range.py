# -*- coding: utf-8 -*-
"""鼓点识别：可自定义检测频段（低频/中频/高频/全频）。"""
import io

path = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
s = io.open(path, "r", encoding="utf-8", newline="").read()

pairs = [
    # 默认值
    ("    beatThreshold: 0.55,", "    beatThreshold: 0.55,\n    beatRange: 'low',"),

    # 类型
    ("        beatThreshold?: unknown;", "        beatThreshold?: unknown;\n        beatRange?: unknown;"),

    # 解析
    ("""        beatThreshold:
          typeof parsed.beatThreshold === 'number'
            ? Math.min(0.95, Math.max(0.2, parsed.beatThreshold))
            : 0.55,""",
     """        beatThreshold:
          typeof parsed.beatThreshold === 'number'
            ? Math.min(0.95, Math.max(0.2, parsed.beatThreshold))
            : 0.55,
        beatRange:
          parsed.beatRange === 'low' ||
          parsed.beatRange === 'mid' ||
          parsed.beatRange === 'high' ||
          parsed.beatRange === 'full'
            ? parsed.beatRange
            : 'low',"""),

    # 面板：鼓点阈值之后加频段选择
    ("""              <div class="custom-label"><span>低音阈值</span><b data-beat-threshold-current>55%</b></div>
              <input class="custom-slider" data-beat-threshold type="range" min="20" max="95" step="1" value="55" aria-label="鼓点触发阈值" />
              <p class="custom-tip">识别到鼓点、或低音能量超过阈值时，在背景里绽放圆环 / 烟花（跟着封面或节奏配色）</p>""",
     """              <div class="custom-label"><span>低音阈值</span><b data-beat-threshold-current>55%</b></div>
              <input class="custom-slider" data-beat-threshold type="range" min="20" max="95" step="1" value="55" aria-label="鼓点触发阈值" />
              <div class="custom-label"><span>检测频段</span><b data-beat-range-current>低频 40–250Hz</b></div>
              <div class="custom-seg" data-beat-range-seg>
                <button class="custom-seg-btn is-on" data-beat-range="low" type="button">低频</button>
                <button class="custom-seg-btn" data-beat-range="mid" type="button">中频</button>
                <button class="custom-seg-btn" data-beat-range="high" type="button">高频</button>
                <button class="custom-seg-btn" data-beat-range="full" type="button">全频</button>
              </div>
              <p class="custom-tip">只统计所选频段的能量：低频 40–250Hz（鼓点/贝斯）、中频 250–1kHz、高频 1k–4kHz、全频 40Hz–16kHz</p>"""),

    # 元素引用
    ("  const beatThresholdCurrent = root.querySelector<HTMLElement>('[data-beat-threshold-current]')!;",
     """  const beatThresholdCurrent = root.querySelector<HTMLElement>('[data-beat-threshold-current]')!;
  const beatRangeBtns = root.querySelectorAll<HTMLButtonElement>('[data-beat-range]');
  const beatRangeCurrent = root.querySelector<HTMLElement>('[data-beat-range-current]')!;"""),

    # QA
    ("  const qaBeatThreshold = Number.parseFloat(params.get('beatthreshold') ?? '');",
     """  const qaBeatRange = params.get('beatrange');
  if (qaBeatRange === 'low' || qaBeatRange === 'mid' || qaBeatRange === 'high' || qaBeatRange === 'full') {
    custom.beatRange = qaBeatRange;
  }
  const qaBeatThreshold = Number.parseFloat(params.get('beatthreshold') ?? '');"""),

    # sync UI
    ("    beatThresholdCurrent.textContent = `${Math.round(custom.beatThreshold * 100)}%`;",
     """    beatThresholdCurrent.textContent = `${Math.round(custom.beatThreshold * 100)}%`;
    beatRangeBtns.forEach((button) => {
      button.classList.toggle('is-on', button.dataset.beatRange === custom.beatRange);
    });
    beatRangeCurrent.textContent =
      custom.beatRange === 'low'
        ? '低频 40–250Hz'
        : custom.beatRange === 'mid'
          ? '中频 250–1kHz'
          : custom.beatRange === 'high'
            ? '高频 1k–4kHz'
            : '全频 40Hz–16kHz';"""),

    # 事件监听
    ("""  beatThresholdInput.addEventListener('input', () => {""",
     """  beatRangeBtns.forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.dataset.beatRange;
      if (value === 'low' || value === 'mid' || value === 'high' || value === 'full') {
        custom.beatRange = value;
      }
      syncCustomUi();
      persistCustom();
    });
  });
  beatThresholdInput.addEventListener('input', () => {"""),

    # 检测：按频段取平均能量
    ("""      // 鼓点识别：宿主 beat 标记，或低音能量越过自定义阈值（带上升沿 + 冷却）
      const bass = frame.bands.length > 0 ? (frame.bands[0] ?? frame.level) : frame.level;""",
     """      // 鼓点识别：宿主 beat 标记，或所选频段能量越过自定义阈值（带上升沿 + 冷却）
      const range: [number, number] =
        custom.beatRange === 'low'
          ? [0, 19]
          : custom.beatRange === 'mid'
            ? [20, 32]
            : custom.beatRange === 'high'
              ? [33, 46]
              : [0, 63];
      let bass = frame.level;
      if (frame.bins.length > 4) {
        let sum = 0;
        let n = 0;
        for (let i = range[0]; i <= Math.min(range[1], frame.bins.length - 1); i += 1) {
          sum += frame.bins[i] ?? 0;
          n += 1;
        }
        if (n > 0) bass = sum / n;
      } else if (frame.bands.length > 0) {
        bass = frame.bands[0] ?? frame.level;
      }"""),
]

for old, new in pairs:
    assert s.count(old) >= 1, "anchor: " + old[:70]
    s = s.replace(old, new, 1)

io.open(path, "w", encoding="utf-8", newline="").write(s)
print("beat frequency range patched")
