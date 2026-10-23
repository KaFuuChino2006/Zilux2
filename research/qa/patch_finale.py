"""批量补丁：鼓点白闪可自定义 + 累计拍数整屏扫光换色 + 封面色切换丝滑 + 歌词进出场流畅可打断。"""
from pathlib import Path

ROOT = Path(r"E:\Zilux2开发")
SHELL = ROOT / "web/src/ui/spaceShell.ts"
SCENE = ROOT / "web/src/three/floatScene.ts"
CSS = ROOT / "web/src/styles/space.css"
ok = []


def edit(path: Path, old: str, new: str, tag: str, count: int = 1):
    text = path.read_text(encoding="utf-8")
    assert text.count(old) == count, f"{tag}: expected {count} match, got {text.count(old)}"
    path.write_text(text.replace(old, new), encoding="utf-8")
    ok.append(tag)


# ---------------- spaceShell.ts ----------------
shell = SHELL.read_text(encoding="utf-8")

# 1) 扫光层
edit(
    SHELL,
    '    <div class="space-flash" data-space-flash></div>',
    '    <div class="space-flash" data-space-flash></div>\n    <div class="space-sweep" data-space-sweep></div>',
    "sweep-layer",
)

# 2) 鼓点白闪控件
edit(
    SHELL,
    """                <button class="custom-seg-btn is-on" data-beat-effect="firework" type="button">烟花</button>
              </div>
              <div class="custom-label"><span>低音阈值</span>""",
    """                <button class="custom-seg-btn is-on" data-beat-effect="firework" type="button">烟花</button>
              </div>
              <div class="custom-label"><span>鼓点白闪</span><b data-beat-flash-current>开</b></div>
              <div class="custom-seg" data-beat-flash-seg>
                <button class="custom-seg-btn" data-beat-flash="0" type="button">关</button>
                <button class="custom-seg-btn is-on" data-beat-flash="1" type="button">开</button>
              </div>
              <div class="custom-sub" data-beat-flash-options>
                <div class="custom-label"><span>白闪强度</span><b data-beat-flash-strength-current>42%</b></div>
                <input class="custom-slider" data-beat-flash-strength type="range" min="5" max="100" step="1" value="42" aria-label="鼓点白闪强度" />
                <div class="custom-label"><span>白闪时长</span><b data-beat-flash-dur-current>0.95s</b></div>
                <input class="custom-slider" data-beat-flash-dur type="range" min="0.25" max="2.4" step="0.05" value="0.95" aria-label="鼓点白闪时长" />
                <div class="custom-label"><span>白闪颜色</span><b data-beat-flash-color-current>白</b></div>
                <div class="custom-seg" data-beat-flash-color-seg>
                  <button class="custom-seg-btn is-on" data-beat-flash-color="white" type="button">白</button>
                  <button class="custom-seg-btn" data-beat-flash-color="cover" type="button">封面</button>
                  <button class="custom-seg-btn" data-beat-flash-color="theme" type="button">主题</button>
                  <button class="custom-seg-btn" data-beat-flash-color="warm" type="button">暖光</button>
                </div>
              </div>
              <div class="custom-label"><span>低音阈值</span>""",
    "beat-flash-html",
)

# 3) 累计拍数扫光控件（渐变选项之后）
edit(
    SHELL,
    """                <p class="custom-tip">渐变会跟着「灯光 · 背景随之变暗」一起压暗，不再是一层独立亮色</p>
              </div>
            </div>""",
    """                <p class="custom-tip">渐变会跟着「灯光 · 背景随之变暗」一起压暗，不再是一层独立亮色</p>
              </div>
              <div class="custom-sub" data-sweep-options>
                <div class="custom-label"><span>累计换色</span><b data-sweep-current>关</b></div>
                <div class="custom-seg" data-sweep-seg>
                  <button class="custom-seg-btn is-on" data-sweep="0" type="button">关</button>
                  <button class="custom-seg-btn" data-sweep="1" type="button">开</button>
                </div>
                <div class="custom-label"><span>累计拍数</span><b data-sweep-every-current>16 拍</b></div>
                <input class="custom-slider" data-sweep-every type="range" min="4" max="64" step="1" value="16" aria-label="累计多少拍换一次背景色" />
                <div class="custom-label"><span>换色样式</span><b data-sweep-style-current>扫光</b></div>
                <div class="custom-seg" data-sweep-style-seg>
                  <button class="custom-seg-btn is-on" data-sweep-style="swipe" type="button">扫光</button>
                  <button class="custom-seg-btn" data-sweep-style="fade" type="button">淡变</button>
                  <button class="custom-seg-btn" data-sweep-style="ripple" type="button">波纹</button>
                  <button class="custom-seg-btn" data-sweep-style="flash" type="button">闪白</button>
                </div>
                <p class="custom-tip">累计到指定拍数后整屏扫光换一次背景色；背景换色为「渐变/节奏」时换色最明显</p>
              </div>
            </div>""",
    "sweep-html",
)

# 4) 查询 + flashBackground 重写
edit(
    SHELL,
    """  const sheenLayer = root.querySelector<HTMLElement>('[data-space-sheen]')!;
  const flashLayer = root.querySelector<HTMLElement>('[data-space-flash]')!;
  const flashBackground = (strength = 1): void => {
    const alpha = Math.min(0.92, Math.max(0.08, 0.92 * strength));
    flashLayer.style.transition = 'none';
    flashLayer.style.opacity = String(alpha);
    void flashLayer.offsetWidth;
    flashLayer.style.transition = 'opacity 0.95s cubic-bezier(0.22, 0.8, 0.28, 1)';
    flashLayer.style.opacity = '0';
  };
""",
    """  const sheenLayer = root.querySelector<HTMLElement>('[data-space-sheen]')!;
  const flashLayer = root.querySelector<HTMLElement>('[data-space-flash]')!;
  const sweepLayer = root.querySelector<HTMLElement>('[data-space-sweep]')!;
  const flashBackground = (strength = 1, beat = false): void => {
    if (beat && !custom.beatFlash) return;
    const scale = Math.max(0.06, custom.beatFlashStrength / 42);
    const alpha = Math.min(0.92, Math.max(0.03, 0.92 * strength * scale));
    const accent =
      custom.beatFlashColor === 'cover'
        ? (paletteColors?.[0] ?? '#ffffff')
        : custom.beatFlashColor === 'theme'
          ? (root.classList.contains('theme-gold') ? '#f4e2a4' : '#cfe3ff')
          : custom.beatFlashColor === 'warm'
            ? '#ffe2b0'
            : '#ffffff';
    flashLayer.style.background = `radial-gradient(120% 92% at 50% 42%, ${withAlpha(accent, 0.98)} 0%, ${withAlpha(accent, 0.5)} 48%, ${withAlpha(accent, 0)} 80%)`;
    flashLayer.style.transition = 'none';
    flashLayer.style.opacity = String(alpha);
    void flashLayer.offsetWidth;
    flashLayer.style.transition = `opacity ${custom.beatFlashDur.toFixed(2)}s cubic-bezier(0.22, 0.8, 0.28, 1)`;
    flashLayer.style.opacity = '0';
  };
  const playColorSweep = (): void => {
    sweepLayer.className = `space-sweep is-${custom.sweepStyle}`;
    void sweepLayer.offsetWidth;
    sweepLayer.classList.add('is-play');
  };
  const triggerColorSweep = (): void => {
    playColorSweep();
    const next = gradientRandomColors();
    if (custom.bgColor === 'gradient') {
      startGradientTransition(next, false);
    } else if (custom.bgColor === 'rhythm') {
      regenerateRhythmColors();
      applyBgColorSetting(false);
    } else if (custom.bgColor === 'solid') {
      custom.solidColor = next[0];
      applyBgColorSetting(false);
    } else if (custom.bgColor === 'coverTone' || custom.bgColor === 'cover') {
      tintVariant += 1;
      applyBgColorSetting(false);
    }
  };
""",
    "flash-rewrite",
)

# 5) 白闪相关查询（放在 flash 查询后面）
edit(
    SHELL,
    """  const spectrumSmooth: number[] = [];
  const bgBlurInput""",
    """  const beatFlashBtns = root.querySelectorAll<HTMLButtonElement>('[data-beat-flash]');
  const beatFlashCurrent = root.querySelector<HTMLElement>('[data-beat-flash-current]')!;
  const beatFlashOptions = root.querySelector<HTMLElement>('[data-beat-flash-options]')!;
  const beatFlashStrengthInput = root.querySelector<HTMLInputElement>('[data-beat-flash-strength]')!;
  const beatFlashStrengthCurrent = root.querySelector<HTMLElement>('[data-beat-flash-strength-current]')!;
  const beatFlashDurInput = root.querySelector<HTMLInputElement>('[data-beat-flash-dur]')!;
  const beatFlashDurCurrent = root.querySelector<HTMLElement>('[data-beat-flash-dur-current]')!;
  const beatFlashColorBtns = root.querySelectorAll<HTMLButtonElement>('[data-beat-flash-color]');
  const beatFlashColorCurrent = root.querySelector<HTMLElement>('[data-beat-flash-color-current]')!;
  const BEAT_FLASH_LABEL: Record<string, string> = { white: '白', cover: '封面', theme: '主题', warm: '暖光' };
  const sweepBtns = root.querySelectorAll<HTMLButtonElement>('[data-sweep]');
  const sweepCurrent = root.querySelector<HTMLElement>('[data-sweep-current]')!;
  const sweepOptions = root.querySelector<HTMLElement>('[data-sweep-options]')!;
  const sweepEveryInput = root.querySelector<HTMLInputElement>('[data-sweep-every]')!;
  const sweepEveryCurrent = root.querySelector<HTMLElement>('[data-sweep-every-current]')!;
  const sweepStyleBtns = root.querySelectorAll<HTMLButtonElement>('[data-sweep-style]');
  const sweepStyleCurrent = root.querySelector<HTMLElement>('[data-sweep-style-current]')!;
  const SWEEP_LABEL: Record<string, string> = { swipe: '扫光', fade: '淡变', ripple: '波纹', flash: '闪白' };
  const spectrumSmooth: number[] = [];
  const bgBlurInput""",
    "beat-flash-queries",
)

# 6) 默认值
edit(
    SHELL,
    """    beatEffect: 'firework',
    beatThreshold: 0.55,
    beatRange: 'low',""",
    """    beatEffect: 'firework',
    beatThreshold: 0.55,
    beatRange: 'low',
    beatFlash: true,
    beatFlashStrength: 42,
    beatFlashDur: 0.95,
    beatFlashColor: 'white' as 'white' | 'cover' | 'theme' | 'warm',
    sweep: false,
    sweepEvery: 16,
    sweepStyle: 'swipe' as 'swipe' | 'fade' | 'ripple' | 'flash',""",
    "defaults",
)

# 7) Partial 类型
edit(
    SHELL,
    """        beatThreshold?: unknown;
        beatRange?: unknown;""",
    """        beatThreshold?: unknown;
        beatRange?: unknown;
        beatFlash?: unknown;
        beatFlashStrength?: unknown;
        beatFlashDur?: unknown;
        beatFlashColor?: unknown;
        sweep?: unknown;
        sweepEvery?: unknown;
        sweepStyle?: unknown;""",
    "partial-type",
)

# 8) loadCustom 解析
edit(
    SHELL,
    """            ? parsed.beatRange
            : 'low',""",
    """            ? parsed.beatRange
            : 'low',
        beatFlash: typeof parsed.beatFlash === 'boolean' ? parsed.beatFlash : true,
        beatFlashStrength:
          typeof parsed.beatFlashStrength === 'number'
            ? Math.min(100, Math.max(5, Math.round(parsed.beatFlashStrength)))
            : 42,
        beatFlashDur:
          typeof parsed.beatFlashDur === 'number'
            ? Math.min(2.4, Math.max(0.25, Math.round(parsed.beatFlashDur * 20) / 20))
            : 0.95,
        beatFlashColor:
          parsed.beatFlashColor === 'cover' ||
          parsed.beatFlashColor === 'theme' ||
          parsed.beatFlashColor === 'warm'
            ? parsed.beatFlashColor
            : 'white',
        sweep: typeof parsed.sweep === 'boolean' ? parsed.sweep : false,
        sweepEvery:
          typeof parsed.sweepEvery === 'number' ? Math.min(64, Math.max(4, Math.round(parsed.sweepEvery))) : 16,
        sweepStyle:
          parsed.sweepStyle === 'fade' || parsed.sweepStyle === 'ripple' || parsed.sweepStyle === 'flash'
            ? parsed.sweepStyle
            : 'swipe',""",
    "load-parsing",
)

# 9) sync 函数 + 调用
edit(
    SHELL,
    """  const syncCustomUi = (): void => {
    syncHotkeysUi();""",
    """  const syncBeatFlashUi = (): void => {
    beatFlashBtns.forEach((button) => {
      button.classList.toggle('is-on', (button.dataset.beatFlash === '1') === custom.beatFlash);
    });
    beatFlashCurrent.textContent = custom.beatFlash ? '开' : '关';
    beatFlashOptions.classList.toggle('is-off', !custom.beatFlash);
    beatFlashStrengthInput.value = String(custom.beatFlashStrength);
    beatFlashStrengthCurrent.textContent = `${custom.beatFlashStrength}%`;
    beatFlashDurInput.value = String(custom.beatFlashDur);
    beatFlashDurCurrent.textContent = `${custom.beatFlashDur.toFixed(2)}s`;
    beatFlashColorBtns.forEach((button) => {
      button.classList.toggle('is-on', button.dataset.beatFlashColor === custom.beatFlashColor);
    });
    beatFlashColorCurrent.textContent = BEAT_FLASH_LABEL[custom.beatFlashColor] ?? '白';
  };
  const syncSweepUi = (): void => {
    sweepBtns.forEach((button) => {
      button.classList.toggle('is-on', (button.dataset.sweep === '1') === custom.sweep);
    });
    sweepCurrent.textContent = custom.sweep ? '开' : '关';
    sweepOptions.classList.toggle('is-off', !custom.sweep);
    sweepEveryInput.value = String(custom.sweepEvery);
    sweepEveryCurrent.textContent = `${custom.sweepEvery} 拍`;
    sweepStyleBtns.forEach((button) => {
      button.classList.toggle('is-on', button.dataset.sweepStyle === custom.sweepStyle);
    });
    sweepStyleCurrent.textContent = SWEEP_LABEL[custom.sweepStyle] ?? '扫光';
  };
  const syncCustomUi = (): void => {
    syncHotkeysUi();
    syncBeatFlashUi();
    syncSweepUi();""",
    "sync-fns",
)

# 10) 事件处理（挂在 gradientBeat 之后）
edit(
    SHELL,
    """  gradientBeatBtns.forEach((button) => {
    button.addEventListener('click', () => {
      custom.gradientBeat = button.dataset.gradientBeat === '1';
      syncCustomUi();
      persistCustom();
    });
  });""",
    """  gradientBeatBtns.forEach((button) => {
    button.addEventListener('click', () => {
      custom.gradientBeat = button.dataset.gradientBeat === '1';
      syncCustomUi();
      persistCustom();
    });
  });
  beatFlashBtns.forEach((button) => {
    button.addEventListener('click', () => {
      custom.beatFlash = button.dataset.beatFlash === '1';
      syncCustomUi();
      persistCustom();
    });
  });
  beatFlashStrengthInput.addEventListener('input', () => {
    custom.beatFlashStrength = Math.min(100, Math.max(5, Math.round(Number(beatFlashStrengthInput.value) || 42)));
    beatFlashStrengthCurrent.textContent = `${custom.beatFlashStrength}%`;
    persistCustom();
  });
  beatFlashDurInput.addEventListener('input', () => {
    custom.beatFlashDur = Math.min(2.4, Math.max(0.25, Math.round((Number(beatFlashDurInput.value) || 0.95) * 20) / 20));
    beatFlashDurCurrent.textContent = `${custom.beatFlashDur.toFixed(2)}s`;
    persistCustom();
  });
  beatFlashColorBtns.forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.dataset.beatFlashColor;
      custom.beatFlashColor =
        value === 'cover' || value === 'theme' || value === 'warm' ? value : 'white';
      syncCustomUi();
      persistCustom();
    });
  });
  sweepBtns.forEach((button) => {
    button.addEventListener('click', () => {
      custom.sweep = button.dataset.sweep === '1';
      syncCustomUi();
      persistCustom();
    });
  });
  sweepEveryInput.addEventListener('input', () => {
    custom.sweepEvery = Math.min(64, Math.max(4, Math.round(Number(sweepEveryInput.value) || 16)));
    sweepEveryCurrent.textContent = `${custom.sweepEvery} 拍`;
    persistCustom();
  });
  sweepStyleBtns.forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.dataset.sweepStyle;
      custom.sweepStyle =
        value === 'fade' || value === 'ripple' || value === 'flash' ? value : 'swipe';
      syncCustomUi();
      persistCustom();
    });
  });""",
    "handlers",
)

# 11) 鼓点命中时累计 + 传 beat 标记
edit(
    SHELL,
    """        const strength = Math.min(1, 0.22 + Math.max(0, Math.min(1, bass)) * 0.78);
        space?.flashLyricColor(strength * 0.9);
        flashBackground(strength * 0.42);""",
    """        const strength = Math.min(1, 0.22 + Math.max(0, Math.min(1, bass)) * 0.78);
        space?.flashLyricColor(strength * 0.9);
        flashBackground(strength * 0.42, true);
        if (custom.sweep) {
          sweepBeats += 1;
          if (sweepBeats >= custom.sweepEvery) {
            sweepBeats = 0;
            triggerColorSweep();
          }
        }""",
    "beat-accumulate",
)

# 12) sweepBeats 声明
edit(
    SHELL,
    "  let lastBeatFlashAt = 0;",
    "  let lastBeatFlashAt = 0;\n  let sweepBeats = 0;",
    "sweep-state",
)

# 13) 封面色切换丝滑：渐变换色不再瞬时
edit(
    SHELL,
    "      if (custom.bgColor === 'gradient') startGradientTransition(gradientRandomColors(), true);",
    "      if (custom.bgColor === 'gradient') startGradientTransition(gradientRandomColors(), false);",
    "accept-smooth",
)

# ---------------- space.css ----------------
css_extra = """

/* 累计拍数换色：整屏扫光层（四种样式） */
.space-sweep {
  position: fixed;
  inset: 0;
  z-index: 7;
  pointer-events: none;
  opacity: 0;
  overflow: hidden;
}
.space-sweep.is-play.is-swipe {
  background: linear-gradient(100deg, rgba(255, 255, 255, 0) 12%, rgba(255, 255, 255, 0.5) 46%, rgba(255, 255, 255, 0) 82%);
  animation: space-sweep-swipe 1.05s cubic-bezier(0.28, 0.7, 0.24, 1) both;
}
.space-sweep.is-play.is-fade {
  background: rgba(255, 255, 255, 0.42);
  animation: space-sweep-fade 1.2s ease-out both;
}
.space-sweep.is-play.is-ripple {
  background: radial-gradient(circle at 50% 52%, rgba(255, 255, 255, 0.62) 0%, rgba(255, 255, 255, 0.26) 34%, rgba(255, 255, 255, 0) 68%);
  animation: space-sweep-ripple 1.15s cubic-bezier(0.2, 0.7, 0.3, 1) both;
}
.space-sweep.is-play.is-flash {
  background: rgba(255, 255, 255, 0.72);
  animation: space-sweep-flash 0.62s ease-out both;
}
@keyframes space-sweep-swipe {
  0% { opacity: 0; transform: translate3d(-58%, 0, 0) scale(1.06); }
  22% { opacity: 0.85; }
  100% { opacity: 0; transform: translate3d(58%, 0, 0) scale(1.06); }
}
@keyframes space-sweep-fade {
  0% { opacity: 0; }
  30% { opacity: 0.6; }
  100% { opacity: 0; }
}
@keyframes space-sweep-ripple {
  0% { opacity: 0; transform: scale(0.3); }
  26% { opacity: 0.85; }
  100% { opacity: 0; transform: scale(2.1); }
}
@keyframes space-sweep-flash {
  0% { opacity: 0; }
  18% { opacity: 0.8; }
  100% { opacity: 0; }
}
.space-shell.theme-gold .space-sweep.is-play.is-swipe {
  background: linear-gradient(100deg, rgba(255, 236, 181, 0) 12%, rgba(255, 233, 168, 0.5) 46%, rgba(255, 236, 181, 0) 82%);
}
.space-shell.theme-gold .space-sweep.is-play.is-fade,
.space-shell.theme-gold .space-sweep.is-play.is-flash {
  background: rgba(255, 234, 176, 0.46);
}
.space-shell.theme-gold .space-sweep.is-play.is-ripple {
  background: radial-gradient(circle at 50% 52%, rgba(255, 232, 170, 0.66) 0%, rgba(255, 232, 170, 0.24) 36%, rgba(255, 232, 170, 0) 70%);
}
.custom-sub.is-off { opacity: 0.42; }
"""
CSS.write_text(CSS.read_text(encoding="utf-8") + css_extra, encoding="utf-8")
ok.append("css")

# ---------------- floatScene.ts：歌词进出场 ----------------
scene = SCENE.read_text(encoding="utf-8")
start = scene.index("    // 换句：把当前句内容搬进「上一句」视图")
end = scene.index("    // 上一句退场")
new_change = """    // 换句：把旧句降级到退场池里最空闲的视图，并保留它此刻的 amount 继续缓出；
    // 新句立刻接管当前视图 —— 上一句还没入场完就被下一句打断也不会硬切。
    if (activeView.index !== active || activeView.text !== (lyricData[active]?.text ?? '')) {
      if (activeView.index >= 0 && activeView.text) {
        let demoted = lyricLines[1];
        for (const view of lyricLines) {
          if (view === activeView) continue;
          if (view.amount < demoted.amount) demoted = view;
        }
        demoted.index = activeView.index;
        demoted.text = activeView.text;
        demoted.translation = activeView.translation;
        demoted.charBoxes = activeView.charBoxes.slice();
        demoted.strokeStamp = [];
        demoted.amount = Math.max(0.02, Math.min(1, activeView.amount));
        demoted.active = true;
        demoted.group.visible = true;
        paintLyricLine(demoted);
      } else {
        for (const view of lyricLines) {
          if (view === activeView) continue;
          view.amount = 0;
          view.index = -1;
          view.group.visible = false;
          hideSplitLine(view);
        }
      }
      const line = lyricData[active];
      activeView.index = active;
      activeView.active = true;
      activeView.text = line.text;
      activeView.translation = line.translation ?? '';
      activeView.amount = 0;
      activeView.strokeStamp = [];
      activeView.group.visible = true;
      paintLyricLine(activeView);
    }
"""
scene = scene[:start] + new_change + scene[end:]

# 退场：遍历退场池
old_exit_open = """    // 上一句退场
    if (prevView.index >= 0 && prevView.amount > 0.001) {"""
new_exit_open = """    // 退场池：所有非当前句的视图各自独立缓出（连续切句时多句可同时淡出）
    for (const outView of lyricLines) {
      if (outView === activeView) continue;
      const prevView = outView;
      if (prevView.index < 0 || prevView.amount <= 0.001) continue;"""
assert scene.count(old_exit_open) == 1, "exit open anchor"
scene = scene.replace(old_exit_open, new_exit_open)

# 退场 amount：线性 → 指数缓出
old_decay = """      prevView.amount = Math.max(
        0,
        prevView.amount - delta * (split ? 0.8 : 2.0) * (lyricLayout === 'rise' ? 0.75 : 1),
      );"""
new_decay = """      prevView.amount = Math.max(
        0,
        prevView.amount -
          prevView.amount * Math.min(1, delta * (split ? 2.4 : 4.6)) * (lyricLayout === 'rise' ? 0.8 : 1),
      );"""
assert scene.count(old_decay) == 1, "decay anchor"
scene = scene.replace(old_decay, new_decay)

# 入场 amount：线性 → 指数缓入
old_enter = """      view.amount = Math.min(
        1,
        view.amount + delta * (split ? 0.85 : 2.4) * (lyricLayout === 'rise' ? 0.55 : 1),
      );"""
new_enter = """      view.amount = Math.min(
        1,
        view.amount +
          (1 - view.amount) * Math.min(1, delta * (split ? 2.6 : 6.2)) * (lyricLayout === 'rise' ? 0.62 : 1),
      );"""
assert scene.count(old_enter) == 1, "enter anchor"
scene = scene.replace(old_enter, new_enter)

# split 碎片兜底：非当前句且已淡出才隐藏
old_hide = "      if (line.index !== lyricActive && line.index !== lyricPrev) hideSplitLine(line);"
new_hide = "      if (line.index !== lyricActive && line.amount <= 0.002) hideSplitLine(line);"
assert scene.count(old_hide) == 1, "hide anchor"
scene = scene.replace(old_hide, new_hide)

SCENE.write_text(scene, encoding="utf-8")
ok.append("lyrics")

print("OK:", ", ".join(ok))
