import { h, icon, toast } from './dom';
import type { LumiereSongInput } from './lumiere';
import { lyricPreviewSong } from './lyrics';
import { createFlowScene } from './flowScene';
import {
  OVERLAP_DEFAULTS,
  OVERLAP_RANGES,
  OVERLAP_SWITCHES,
  normalizeOverlapSettings,
  overlapBackdropColor,
  overlapSettings,
  overlapStyleOf,
  saveOverlapSettings,
  setOverlapFx,
  OVERLAP_SETTINGS_EVENT,
  type OverlapSettings,
} from './overlapSettings';

const PRESETS: {name: string; patch: Partial<OverlapSettings>}[] = [
  {name: '青瓷', patch: {...OVERLAP_DEFAULTS, followCover: false}},
  {name: '夜蓝', patch: {paper: '#04060d', ink: '#dfe7ff', accent: '#8aa0ff', followCover: false}},
  {name: '朱砂', patch: {paper: '#120607', ink: '#ffd9c2', accent: '#ff5a3c', followCover: false}},
  {name: '宣纸', patch: {paper: '#efe6d4', ink: '#2b2620', accent: '#b4543a', followCover: false}},
];

let opened: HTMLElement | null = null;

export function overlapPreviewSong(): LumiereSongInput {
  const texts = ['重合的句子留在纸上', '像墨迹等下一笔', '把未说完的话折成纸页', 'We move into another morning', '直到整个世界慢慢安静'];
  return {
    trackKey: 'overlap-settings-demo', title: '重合预览', artist: 'Zilux2', album: '', durationMs: 24000,
    lyricOffsetMs: 0,
    lines: texts.map((text, i) => ({
      text, translation: '', timeMs: 1000 + i * 4400, durationMs: 4000,
      words: Array.from(text).map((text, j, chars) => ({
        text, startMs: 1000 + i * 4400 + (j * 3600) / chars.length,
        endMs: 1000 + i * 4400 + ((j + 1) * 3600) / chars.length,
      })),
    })),
  };
}

export function openOverlapSettingsSheet(): void {
  if (opened) return;
  const previousFocus = document.activeElement as HTMLElement | null;
  let draft = overlapSettings();
  let disposed = false;
  let pending = 0;

  const rows = h('div', {class: 'ts-groups'});
  const saved = overlapSettings();
  setOverlapFx(draft);
  // Same shape as the other effect sheets: a small fixed-style scene with its own clock.
  const stage = h('div', {class: 'ts-preview-stage'});
  const song = lyricPreviewSong() ?? overlapPreviewSong();
  const start = Math.max(0, (song.lines[0]?.timeMs ?? 0) - 500);
  const end = Math.max(start + 4000, song.durationMs || 24000);
  let position = start;
  let playing = true;
  const status = h('div', {class: 'ts-preview-hint', text: '独立预览 · 拖动参数会立刻作用在这里，保存后应用到播放器'});
  let scene: ReturnType<typeof createFlowScene> | null = null;
  const seek = h('input', {
    class: 'ts-range', type: 'range', min: String(start), max: String(end), step: '10',
    value: String(start), 'aria-label': '预览进度',
  }) as HTMLInputElement;
  seek.oninput = () => {position = Number(seek.value); scene?.update(position);};
  const pause = h('button', {class: 'ts-btn', text: '暂停预览'});
  pause.onclick = () => {playing = !playing; pause.textContent = playing ? '暂停预览' : '继续预览';};
  const restart = h('button', {class: 'ts-btn is-quiet', text: '从头预览'});
  restart.onclick = () => {position = start; seek.value = String(start); scene?.update(position);};
  let raf = 0;
  let last = performance.now();
  let lastSeekUpdate = 0;
  const previewStyle = () => ({...overlapStyleOf(draft), textureResolution: 1});
  const frame = (now: number) => {
    if (disposed) return;
    const step = now - last;
    last = now;
    if (playing) {
      position += step;
      if (position > end) position = start;
      scene?.update(position);
      if (now - lastSeekUpdate >= 100) {
        lastSeekUpdate = now;
        seek.value = String(Math.round(position));
      }
    }
    raf = requestAnimationFrame(frame);
  };
  const startPreview = () => {
    if (disposed || scene) return;
    // Build only once the stage is laid out; otherwise Pixi sizes its canvas from a zero box.
    scene = createFlowScene(undefined, error => {
      status.textContent = `预览不可用：${error instanceof Error ? error.message : String(error)}`;
    }, false, previewStyle());
    stage.append(scene.root);
    paintBackdrop();
    scene.setSong(song);
    scene.update(position);
    raf = requestAnimationFrame(frame);
  };
  // No separate preview: every change is pushed to the running stage, so what plays behind the
  // sheet is the preview.
  const push = () => {
    window.dispatchEvent(new CustomEvent<OverlapSettings>(OVERLAP_SETTINGS_EVENT, {detail: draft}));
  };

  const curve = h('canvas', {class: 'ts-curve'}) as HTMLCanvasElement;
  const curveCard = h('div', {class: 'ts-curve-card'},
    h('div', {class: 'ts-curve-title', text: '撞击曲线'}),
    curve,
    h('div', {class: 'ts-curve-hint', text: '橙色包络 · 蓝色纵向位移 · 随高级设置实时重绘'}));

  const drawCurve = () => {
    const w = Math.max(240, Math.round(curve.clientWidth || 480));
    const hgt = 118;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (curve.width !== Math.round(w * dpr) || curve.height !== Math.round(hgt * dpr)) {
      curve.width = Math.round(w * dpr);
      curve.height = Math.round(hgt * dpr);
    }
    const ctx = curve.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const elastic = Math.max(0.2, draft.shakeElastic);
    const damping = Math.max(0.15, draft.shakeDamping);
    const attack = Math.max(0.005, draft.shakeAttack);
    const decay = (0.14 * elastic) / damping;
    const omega = draft.shakeSwing < 0.02 ? 0 : (46 / Math.sqrt(elastic)) * draft.shakeSwing;
    const span = Math.max(0.6, attack + decay * 6.5 + attack * 0.35);
    const left = 10;
    const right = w - 10;
    const top = 10;
    const bottom = hgt - 10;
    const mid = (top + bottom) / 2;
    const amplitude = Math.max(4, Math.abs(draft.shakeY));
    const tx = (t: number) => left + ((right - left) * t) / span;
    const ey = (v: number) => bottom - (bottom - top) * v;
    const dy = (v: number) => mid - (v / amplitude) * ((bottom - top) / 2);

    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(148,160,178,.22)';
    ctx.beginPath();
    ctx.moveTo(left, mid + 0.5);
    ctx.lineTo(right, mid + 0.5);
    ctx.stroke();

    const steps = 220;
    const env: [number, number][] = [];
    const wave: [number, number][] = [];
    for (let i = 0; i <= steps; i += 1) {
      const t = (span * i) / steps;
      const rise = Math.min(1, Math.max(0, t / attack));
      const e = rise * rise * (3 - 2 * rise)
        * Math.exp(-Math.max(0, t - attack) / decay);
      env.push([tx(t), ey(Math.min(1, e))]);
      const v = e * draft.shakeY
        * Math.sin(t * omega + 0.55);
      wave.push([tx(t), dy(v)]);
    }

    ctx.beginPath();
    env.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.lineTo(tx(span), bottom);
    ctx.lineTo(left, bottom);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, top, 0, bottom);
    fill.addColorStop(0, 'rgba(224,149,106,.34)');
    fill.addColorStop(1, 'rgba(224,149,106,.02)');
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.beginPath();
    env.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.strokeStyle = 'rgba(224,149,106,.92)';
    ctx.lineWidth = 1.6;
    ctx.stroke();

    ctx.beginPath();
    wave.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.strokeStyle = 'rgba(122,166,232,.95)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = 'rgba(186,196,212,.72)';
    ctx.font = '11px "Microsoft YaHei", sans-serif';
    ctx.fillText(`包络 ${decay.toFixed(2)}s`, left + 2, top + 10);
    ctx.fillText(`位移峰值 ${Math.round(amplitude)}px`, left + 2, bottom - 4);
  };

  // 预览窗里「跟随主题」仍压成黑色（面板背景不适合当舞台底），纯黑/纯白照选。
  const paintBackdrop = () => {
    if (!scene) return;
    scene.root.style.backgroundColor = draft.backdrop === 'theme' ? '#000000' : overlapBackdropColor(draft.backdrop);
  };

  const update = () => {
    draft = normalizeOverlapSettings(draft);
    setOverlapFx(draft);
    paintBackdrop();
    clearTimeout(pending);
    pending = window.setTimeout(() => {
      if (disposed) return;
      scene?.setStyle(previewStyle());
      push();
    }, 90);
  };

  function group(title: string) {
    const content = h('div', {class: 'ts-group'}, h('div', {class: 'ts-group-title', text: title}));
    rows.append(content);
    return content;
  }

  function segments(parent: HTMLElement, label: string, choices: readonly (readonly [string, string])[], current: string, pick: (id: string) => void) {
    const host = h('div', {class: 'ts-seg', style: 'flex-wrap:wrap'});
    for (const [id, text] of choices) {
      const button = h('button', {class: `ts-seg-btn${id === current ? ' is-on' : ''}`, type: 'button', text});
      button.onclick = () => {
        host.querySelectorAll('button').forEach(item => item.classList.toggle('is-on', item === button));
        pick(id);
        update();
      };
      host.append(button);
    }
    parent.append(h('div', {class: 'ts-row'}, h('div', {class: 'ts-row-head'}, h('span', {class: 'ts-label', text: label})), host));
  }

  type CurveField = 'cameraCurve' | 'cameraZoomCurve';
  function curveEditor(field: CurveField, label: string) {
    const canvas = h('canvas', {
      width: '640', height: '300',
      style: 'display:block;width:100%;height:auto;touch-action:none;cursor:crosshair',
      'aria-label': label,
    }) as HTMLCanvasElement;
    const inset = 16;
    const w = canvas.width - 2 * inset;
    const hgt = canvas.height - 2 * inset;
    const px = (x: number) => inset + x * w;
    const py = (y: number) => inset + (2 - y) * hgt / 3;
    function draw() {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const css = getComputedStyle(canvas);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = css.getPropertyValue('--line-strong');
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i <= 8; i++) {
        const x = inset + i * w / 8, y = inset + i * hgt / 8;
        ctx.moveTo(x, inset); ctx.lineTo(x, inset + hgt);
        ctx.moveTo(inset, y); ctx.lineTo(inset + w, y);
      }
      ctx.stroke();
      const [x1, y1, x2, y2] = draft[field];
      ctx.fillStyle = ctx.strokeStyle = css.getPropertyValue('--muted');
      ctx.font = '20px system-ui';
      for (const y of [0, 1]) {
        ctx.beginPath(); ctx.moveTo(inset, py(y)); ctx.lineTo(inset + w, py(y)); ctx.stroke();
        ctx.fillText(y ? '100%' : '0%', inset + 4, py(y) - 5);
      }
      ctx.beginPath();
      ctx.moveTo(px(0), py(0)); ctx.lineTo(px(x1), py(y1));
      ctx.moveTo(px(1), py(1)); ctx.lineTo(px(x2), py(y2));
      ctx.strokeStyle = css.getPropertyValue('--muted');
      ctx.stroke();
      ctx.strokeStyle = ctx.fillStyle = css.getPropertyValue('--accent');
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(px(0), py(0));
      ctx.bezierCurveTo(px(x1), py(y1), px(x2), py(y2), px(1), py(1));
      ctx.stroke();
      [[0, 0, 4], [x1, y1, 10], [x2, y2, 10], [1, 1, 4]].forEach(([x, y, r]) => {
        ctx.beginPath(); ctx.arc(px(x), py(y), r, 0, Math.PI * 2); ctx.fill();
      });
    }
    let handle = 0;
    canvas.onpointerdown = event => {
      if (!event.isPrimary) return;
      const box = canvas.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width * canvas.width - inset;
      const y = (event.clientY - box.top) / box.height * canvas.height;
      const dist = (i: number) => Math.hypot(x - w * draft[field][i], y - py(draft[field][i + 1]));
      handle = dist(0) <= dist(2) ? 0 : 2;
      canvas.setPointerCapture(event.pointerId);
      moveHandle(event);
    };
    function moveHandle(event: PointerEvent) {
      if (!canvas.hasPointerCapture(event.pointerId)) return;
      const box = canvas.getBoundingClientRect();
      const value = 2 - 3 * (((event.clientY - box.top) / box.height) * canvas.height - inset) / hgt;
      draft[field][handle] = Math.max(0, Math.min(1, ((event.clientX - box.left) / box.width * canvas.width - inset) / w));
      draft[field][handle + 1] = Math.max(-1, Math.min(2, value));
      update();
      draw();
    }
    canvas.onpointermove = moveHandle;
    const reset = h('button', {class: 'ts-btn is-quiet', text: '重置曲线'});
    reset.onclick = () => {draft[field] = [1 / 3, 1 / 3, 2 / 3, 2 / 3]; update(); draw();};
    return {canvas, draw, reset};
  }

  function render() {
    rows.replaceChildren();
    const presets = group('风格预设');
    for (const preset of PRESETS) {
      const button = h('button', {class: 'ts-btn', text: preset.name, style: 'margin:4px'});
      button.onclick = () => {
        draft = normalizeOverlapSettings({...draft, ...preset.patch});
        render();
        update();
      };
      presets.append(button);
    }

    const color = group('配色');
    segments(color, '背景', [['theme', '跟随主题'], ['black', '纯黑'], ['white', '纯白']], draft.backdrop, id => {
      draft.backdrop = id as typeof draft.backdrop;
      paintBackdrop();
      update();
    });
    color.append(h('div', {class: 'ts-hint', text: draft.backdrop === 'theme'
      ? '跟随主题：舞台底色透明，露出歌词页自己的封面底（现在的样子）。'
      : draft.backdrop === 'black'
        ? '纯黑：整屏压成纯黑，纸面与字都浮在黑底上。'
        : '纯白：整屏压成纯白，适合浅色封面；纸面偏白时字会靠强调色区分。'}));
    segments(color, '取色方式', [['cover', '跟随封面'], ['custom', '自定义']], draft.followCover ? 'cover' : 'custom', id => {
      draft.followCover = id === 'cover';
      render();
      update();
    });
    if (draft.followCover) {
      color.append(h('div', {class: 'ts-hint', text: '跟随封面：纸面取封面最暗的一档，文字取最亮的一档，强调色取第二色；换歌会自动换色。'}));
    } else {
      for (const [key, label] of [['paper', '纸面'], ['ink', '文字'], ['accent', '强调']] as const) {
        const input = h('input', {type: 'color', value: draft[key], 'aria-label': label}) as HTMLInputElement;
        input.oninput = () => {draft[key] = input.value; update();};
        color.append(h('div', {class: 'ts-row'}, h('div', {class: 'ts-row-head'}, h('span', {class: 'ts-label', text: label}), input)));
      }
      color.append(h('div', {class: 'ts-hint', text: '纸面是画面的底色，文字与强调色用于字形、括号、轨迹和刻度尺。'}));
    }

    for (const category of ['文字', '运镜', '镜头', '旋转', '落点', '旧句', '字间动效', '装饰', '印刷与画质', '高级']) {
      let section: HTMLElement;
      if (category === '高级') {
        const body = h('div', {class: 'ts-group-body'});
        const advanced = h('details', {class: 'ts-group ts-advanced'},
          h('summary', {class: 'ts-group-title', text: '高级设置'}),
          body);
        body.append(curveCard);
        advanced.ontoggle = () => { if (advanced.open) drawCurve(); };
        rows.append(advanced);
        section = body;
      } else {
        section = group(category);
      }
      if (category === '装饰') {
        segments(section, '扰乱场样式', [['mixed', '按句变化'], ['wind', '风线'], ['ticks', '偏移刻线']], draft.fieldStyle, id => {
          draft.fieldStyle = id as typeof draft.fieldStyle;
        });
      }
      if (category === '落点') {
        segments(section, '落位方式', [['scatter', '随机散点'], ['grid', '阶梯格']], draft.placement, id => {
          draft.placement = id as typeof draft.placement;
          render();
          update();
          scene?.refresh();
        });
        section.append(h('div', {class: 'ts-hint', text: draft.placement === 'scatter'
          ? '随机散点：原来的做法，每句按曲目种子散落在画面里，靠近时可能压到上一句。'
          : '阶梯格：上下两行、左右三列轮转，新句不会落在上一句身上（拆句的各段也不会）。'}));
      }
      for (const [key, label, min, max, step, sectionName, hint] of OVERLAP_RANGES) {
        if (sectionName !== category) continue;
        const value = h('span', {class: 'ts-value', text: Number(draft[key]).toFixed(step >= 1 ? 0 : 2)});
        const input = h('input', {
          class: 'ts-range', type: 'range',
          min: String(min), max: String(max), step: String(step),
          value: String(draft[key]), 'aria-label': label,
        }) as HTMLInputElement;
        input.oninput = () => {
          draft[key] = Number(input.value) as never;
          value.textContent = Number(draft[key]).toFixed(step >= 1 ? 0 : 2);
          if (String(key).startsWith('shake')) drawCurve();
          update();
        };
        section.append(h('div', {class: 'ts-row'}, h('div', {class: 'ts-row-head'}, h('span', {class: 'ts-label', text: label}), value), input));
        if (hint) section.append(h('div', {class: 'ts-hint', text: hint}));
      }
      if (category === '运镜') {
        const curves: [CurveField, string, string][] = [
          ['cameraCurve', '镜头移动速度曲线', '横轴是本句演唱进度，纵轴是镜头平移速度；与文闪一样拖动两个控制柄。'],
          ['cameraZoomCurve', '镜头缩放速度曲线', '横轴是本句演唱进度，纵轴是缩放速度；与移动分开设置。'],
        ];
        for (const [field, label, hint] of curves) {
          const editor = curveEditor(field, label);
          section.append(
            h('div', {class: 'ts-row'},
              h('div', {class: 'ts-row-head'}, h('span', {class: 'ts-label', text: label}), editor.reset),
              editor.canvas,
              h('div', {class: 'ts-hint', text: hint})),
          );
          editor.draw();
        }
      }
      if (category === '高级') {
        const resetAdvanced = h('button', {class: 'ts-btn is-quiet ts-advanced-reset', text: '还原高级默认'});
        resetAdvanced.onclick = () => {
          for (const [key, , , , , sectionName] of OVERLAP_RANGES) {
            if (sectionName !== '高级') continue;
            (draft as unknown as Record<string, unknown>)[key] = (OVERLAP_DEFAULTS as unknown as Record<string, unknown>)[key];
          }
          // 只重画面板，不动其它分类；重画会把折叠的高级组收回，这里再展开回来。
          render();
          const advancedBody = root.querySelector<HTMLDetailsElement>('.ts-group.ts-advanced');
          if (advancedBody) advancedBody.open = true;
          update();
          requestAnimationFrame(drawCurve);
        };
        section.append(
          h('div', {class: 'ts-row ts-advanced-actions'}, resetAdvanced),
          h('div', {class: 'ts-hint', text: '只还原「高级设置」里的这组参数，文字、运镜、落点等其它分类保持不动。'}),
        );
      }
      for (const [key, label, sectionName, hint] of OVERLAP_SWITCHES) {
        if (sectionName !== category) continue;
        segments(section, label, [['on', '开'], ['off', '关']], draft[key] ? 'on' : 'off', id => {
          draft[key] = id === 'on';
          update();
        });
        if (hint) section.append(h('div', {class: 'ts-hint', text: hint}));
      }
    }
    requestAnimationFrame(drawCurve);
  }

  const root = h('div', {class: 'sheet text-sheet vinyl-sheet flow-sheet overlap-sheet', id: 'overlap-settings'});
  const restore = () => {
    setOverlapFx(saved);
    window.dispatchEvent(new CustomEvent<OverlapSettings>(OVERLAP_SETTINGS_EVENT, {detail: saved}));
  };
  const close = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(pending);
    cancelAnimationFrame(raf);
    scene?.dispose();
    document.removeEventListener('keydown', key, true);
    root.remove();
    opened = null;
    previousFocus?.focus();
  };
  const cancel = () => {restore(); close();};
  const key = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); cancel();}
  };
  const reset = h('button', {class: 'ts-btn is-quiet', text: '恢复默认'});
  reset.onclick = () => {draft = {...OVERLAP_DEFAULTS}; render(); update(); requestAnimationFrame(drawCurve);};
  const cancelButton = h('button', {class: 'ts-btn', text: '取消'});
  cancelButton.onclick = cancel;
  const save = h('button', {class: 'ts-btn is-primary', text: '保存'});
  save.onclick = () => {saveOverlapSettings(draft); toast('重合设置已保存'); close();};
  const exit = h('button', {class: 'icon-btn', title: '关闭'}, icon('close', 16));
  exit.onclick = cancel;

  root.append(h('div', {class: 'ts-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': '重合设置'},
    h('div', {class: 'sheet-head lp-head ts-head'},
      h('div', {class: 'lp-head-text'},
        h('div', {class: 'sheet-title', text: '重合设置'}),
        h('div', {class: 'lp-head-song', text: '重合 · 实时作用在当前播放'})),
      exit),
    h('div', {class: 'ts-body'},
      h('div', {class: 'ts-preview-col'},
        h('div', {class: 'ts-preview-label', text: '独立预览'}),
        stage,
        h('div', {class: 'overlap-preview-controls'}, seek, pause, restart),
        status),
      h('div', {class: 'ts-left'}, rows)),
    h('div', {class: 'ts-foot'},
      h('div', {class: 'ts-foot-status', text: '保存后立即应用；取消不会改动原设置'}),
      h('div', {class: 'ts-foot-actions'}, reset, cancelButton, save))));
  root.onpointerdown = event => {if (event.target === root) cancel();};
  render();
  document.body.append(root);
  opened = root;
  document.addEventListener('keydown', key, true);
  exit.focus();
  requestAnimationFrame(drawCurve);
  requestAnimationFrame(startPreview);
}

