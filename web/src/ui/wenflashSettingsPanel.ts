import { h, icon, toast } from './dom';
import { lyricPreviewSong } from './lyrics';
import { overlapPreviewSong } from './overlapSettingsPanel';
import { createWenflashScene } from './overlapScene';
import { flowCoverPalette } from './flow';
import {
  currentWenflashSettings,
  defaultEntryCurve,
  defaultWenflashSettings,
  previewWenflashSettings,
  restoreWenflashSettings,
  saveWenflashSettings,
} from './wenflashSettings';

type NumericKey =
  | 'sizeMin'
  | 'phraseArtRun'
  | 'phraseArtBrake'
  | 'decorIntensity'
  | 'sizeMax'
  | 'entryDelay'
  | 'entryZoom'
  | 'entryRotation'
  | 'lineRotation'
  | 'cameraRotation'
  | 'letterboxPercent'
  | 'entryBlurChance'
  | 'entryBlurAmount'
  | 'entryBlurDuration'
  | 'cameraOverlap'
  | 'cameraZoomOverlap'
  | 'cameraSteps'
  | 'renderFps'
  | 'phraseSize'
  | 'stretchAmount'
  | 'stretchDuration'
  | 'stretchSteps'
  | 'postZoomChance'
  | 'postZoomWaveChance'
  | 'postZoomScale'
  | 'postZoomDuration'
  | 'postZoomSteps'
  | 'chance'
  | 'blurDelay'
  | 'blurAmount'
  | 'glowStrength'
  | 'glowRadius'
  | 'glowPlain'
  | 'glowChance'
  | 'textColorChance'
  | 'textColorCount'
  | 'invertEveryMin'
  | 'invertEveryMax'
  | 'invertFlashCount'
  | 'invertFlashWindow'
  | 'invertFlashDark'
  | 'ghostLayers'
  | 'ghostOffset'
  | 'ghostAlpha'
  | 'glyphDecorChance'
  | 'glyphDecorSize'
  | 'glyphDecorSpeed'
  | 'kineticChance'
  | 'kineticDensity'
  | 'kineticSpeed'
  | 'glowFlowSpeed'
  | 'glowFlowScale'
  | 'flashCount'
  | 'flashWindow'
  | 'flashDark'
  | 'flashDim'
  | 'solidChance'
  | 'outlineChance'
  | 'lineBlockChance'
  | 'lineBlockPadding'
  | 'lineBlockAlpha'
  | 'lineBlockSweep'
  | 'blockPadding'
  | 'blockAlpha'
  | 'outlineWidth'
  | 'hollowLingerChance'
  | 'hollowLingerDuration'
  | 'marqueeChance'
  | 'marqueeDuration'
  | 'marqueeLength'
  | 'marqueePadding'
  | 'marqueeWidth'
  | 'marqueeGlow'
  | 'marqueeEntryDelay'
  | 'marqueeEntryFade'
  | 'marqueeEntryScale'
  | 'marqueeRun'
  | 'marqueeBrake'
  | 'bottomLineChance'
  | 'bottomLineLength'
  | 'bottomLineWidth'
  | 'bottomLineGlow'
  | 'bottomLineOffset'
  | 'bottomLineSpeed'
  | 'bottomLineRun'
  | 'bottomLineBrake'
  | 'bottomLineFade'
  | 'shakeChance'
  | 'shakePx'
  | 'shakeElastic'
  | 'shakeX'
  | 'shakeY'
  | 'shakeZ'
  | 'shakeDepth'
  | 'shakeRollDeg'
  | 'shakeAttack'
  | 'shakeSwing'
  | 'shakeAt'
  | 'shakeDamping'
  | 'lensDistortion'
  | 'rgbShift'
  | 'grain'
  | 'contrast'
  | 'vignette';

type NumberRow = {
  key: NumericKey;
  slider: HTMLInputElement;
  display: HTMLElement;
  format: (value: number) => string;
};

type GlowColorKey = 'glowColorA' | 'glowColorB' | 'glowColorC';
type ColorRow = {
  key: GlowColorKey;
  input: HTMLInputElement;
};

export function openWenflashSettingsSheet() {
  if (document.getElementById('wenflash-settings')) return;
  const previousFocus = document.activeElement;
  const draft = currentWenflashSettings();
  const song = lyricPreviewSong() ?? overlapPreviewSong();
  const start = Math.max(0, (song.lines[0]?.timeMs ?? 0) - 500);
  const end = Math.max(start + 4000, song.durationMs || 24000);
  let position = start, playing = true, frameId = 0, last = 0;
  const stage = h('div', {class:'ts-preview-stage'});
  const hint = h('div', {class:'ts-preview-hint', text:'拖动进度可查看逐字入场与闪烁。'});
  const scene = createWenflashScene(() => {}, () => { hint.textContent = '预览加载失败'; });
  stage.append(scene.root);
  scene.setSong(song);
  scene.setPalette(flowCoverPalette());
  const seek = h('input', {type:'range', class:'ts-range', min:String(start), max:String(end), value:String(start), 'aria-label':'预览进度'});
  function paint() { scene.update(position); seek.value = String(position); }
  seek.oninput = () => { position = Number(seek.value); paint(); };
  const pause = h('button', {class:'ts-btn', text:'暂停预览'});
  pause.onclick = () => { playing = !playing; pause.textContent = playing ? '暂停预览' : '继续预览'; };
  const replay = h('button', {class:'ts-btn is-quiet', text:'从头预览'});
  replay.onclick = () => { position = start; paint(); };

  const numberRows: NumberRow[] = [];
  const colorRows: ColorRow[] = [];
  const colorRow = (key: GlowColorKey, label: string) => {
    const input = h('input', {type:'color', class:'ts-color', value:draft[key], 'aria-label':label}) as HTMLInputElement;
    colorRows.push({key, input});
    input.oninput = () => { draft[key] = input.value; sync(); };
    return h('div', {class:'ts-row'},
      h('div', {class:'ts-row-head'}, h('span', {class:'ts-label', text:label}), input));
  };
  const numberRow = (
    key: NumericKey,
    label: string,
    min: number,
    max: number,
    step: number,
    format: (value: number) => string,
    hintText?: string,
  ) => {
    const slider = h('input', {type:'range', class:'ts-range', min:String(min), max:String(max), step:String(step), 'aria-label':label});
    const display = h('span', {class:'ts-value'});
    const control: NumberRow = {key, slider, display, format};
    numberRows.push(control);
    slider.oninput = () => {
      draft[key] = Number(slider.value);
      normalizeDraft(key);
      sync();
    };
    return h('div', {class:'ts-row'},
      h('div', {class:'ts-row-head'}, h('span', {class:'ts-label', text:label}), display),
      slider,
      hintText ? h('div', {class:'ts-hint', text:hintText}) : null);
  };

  const switches = h('div', {class:'ts-seg'});
  const buttons = [true, false].map(enabled => {
    const button = h('button', {class:'ts-seg-btn', text:enabled ? '开' : '关'});
    button.onclick = () => { draft.enabled = enabled; sync(); };
    switches.append(button);
    return button;
  });
  const decorSwitches = h('div', {class:'ts-seg'});
  const decorButtons = [true, false].map(enabled => {
    const button = h('button', {class:'ts-seg-btn', text: enabled ? '开' : '关'});
    button.onclick = () => { draft.glyphDecor = enabled; sync(); };
    decorSwitches.append(button);
    return button;
  });
  const kineticSwitches = h('div', {class:'ts-seg'});
  const kineticButtons = [true, false].map(enabled => {
    const button = h('button', {class:'ts-seg-btn', text: enabled ? '开' : '关'});
    button.onclick = () => { draft.kineticDecor = enabled; sync(); };
    kineticSwitches.append(button);
    return button;
  });
  const stretchSwitches = h('div', {class:'ts-seg'});
  const stretchButtons = [true, false].map(enabled => {
    const button = h('button', {class:'ts-seg-btn', text: enabled ? '开' : '关'});
    button.onclick = () => { draft.stretch = enabled; sync(); };
    stretchSwitches.append(button);
    return button;
  });
  const hollowSwitches = h('div', {class:'ts-seg'});
  const hollowButtons = [true, false].map(enabled => {
    const button = h('button', {class:'ts-seg-btn', text: enabled ? '开' : '关'});
    button.onclick = () => { draft.hollowLinger = enabled; sync(); };
    hollowSwitches.append(button);
    return button;
  });
  const marqueeSwitches = h('div', {class:'ts-seg'});
  const marqueeButtons = [true, false].map(enabled => {
    const button = h('button', {class:'ts-seg-btn', text: enabled ? '开' : '关'});
    button.onclick = () => { draft.marquee = enabled; sync(); };
    marqueeSwitches.append(button);
    return button;
  });
  const bottomLineSwitches = h('div', {class:'ts-seg'});
  const bottomLineButtons = [true, false].map(enabled => {
    const button = h('button', {class:'ts-seg-btn', text: enabled ? '开' : '关'});
    button.onclick = () => { draft.bottomLine = enabled; sync(); };
    bottomLineSwitches.append(button);
    return button;
  });
  const layout = h('div', {class:'ts-seg'});
  const layoutOptions = ['whole', 'split', 'mixed'] as const;
  const layoutButtons = layoutOptions.map(value => {
    const button = h('button', {class:'ts-seg-btn', text: value === 'whole' ? '整句' : value === 'split' ? '拆分短句' : '混合'});
    button.onclick = () => {
      draft.splitLyrics = value !== 'whole';
      draft.mixedLyrics = value === 'mixed';
      sync();
    };
    layout.append(button);
    return button;
  });
  const draftLayout = () => draft.mixedLyrics ? 'mixed' : draft.splitLyrics ? 'split' : 'whole';
  const order = h('div', {class:'ts-seg'});
  const orderValues = ['time', 'random', 'all-random'] as const;
  const orderButtons = orderValues.map(value => {
    const button = h('button', {
      class:'ts-seg-btn',
      text: value === 'time' ? '按歌词时间' : value === 'random' ? '短句随机' : '随机出现',
    });
    button.onclick = () => { draft.order = value; sync(); };
    order.append(button);
    return button;
  });
  const entryStyle = h('div', {class:'ts-seg'});
  const entryStyleOptions = ['wenflash', 'overlap', 'both'] as const;
  const entryStyleButtons = entryStyleOptions.map(value => {
    const button = h('button', {
      class:'ts-seg-btn',
      text: value === 'wenflash' ? '只用缩放' : value === 'overlap' ? '重合逐字' : '叠加两者',
    });
    button.onclick = () => { draft.entryStyle = value; sync(); };
    entryStyle.append(button);
    return button;
  });
  const decorStyle = h('div', {class:'ts-seg'});
  const decorStyleOptions = ['random', 'sparkle', 'bracket', 'orbit', 'dash'] as const;
  const decorStyleButtons = decorStyleOptions.map(value => {
    const button = h('button', {
      class:'ts-seg-btn',
      text: value === 'random' ? '随机' : value === 'sparkle' ? '星芒'
        : value === 'bracket' ? '角标' : value === 'orbit' ? '环绕' : '划线',
    });
    button.onclick = () => { draft.glyphDecorStyle = value; sync(); };
    decorStyle.append(button);
    return button;
  });
  const arrangement = h('div', {class:'ts-seg'});
  const glowColorMode = h('div', {class:'ts-seg'});
  const glowColorModeOptions = ['keyword', 'custom'] as const;
  const glowColorModeButtons = glowColorModeOptions.map(value => {
    const button = h('button', {class:'ts-seg-btn', text: value === 'keyword' ? '跟随重点词' : '自定义'});
    button.onclick = () => { draft.glowColorMode = value; sync(); };
    glowColorMode.append(button);
    return button;
  });
  const arrangementOptions = ['horizontal', 'vertical', 'mixed', 'graphic'] as const;
  const arrangementButtons = arrangementOptions.map(value => {
    const button = h('button', {
      class:'ts-seg-btn',
      text: value === 'horizontal' ? '横向' : value === 'vertical' ? '竖排' : value === 'mixed' ? '横竖混合' : '图形',
    });
    button.onclick = () => { draft.arrangement = value; sync(); };
    arrangement.append(button);
    return button;
  });
  const linePlacement = h('div', {class:'ts-seg'});
  const linePlacementOptions = ['follow', 'direction', 'random'] as const;
  const linePlacementLabels = ['链式向下', '方向链', '画面随机'] as const;
  const linePlacementButtons = linePlacementOptions.map((value, index) => {
    const button = h('button', {class:'ts-seg-btn', text: linePlacementLabels[index]});
    button.onclick = () => { draft.linePlacement = value; sync(); };
    linePlacement.append(button);
    return button;
  });
  const lineDirection = h('div', {class:'ts-seg', style:'flex-wrap:wrap'});
  const lineDirectionOptions = ['south', 'southeast', 'east', 'northeast', 'north', 'northwest', 'west', 'southwest'] as const;
  const lineDirectionLabels = ['↓', '↘', '→', '↗', '↑', '↖', '←', '↙'] as const;
  const lineDirectionButtons = lineDirectionOptions.map((value, index) => {
    const button = h('button', {
      class:'ts-seg-btn',
      text: lineDirectionLabels[index],
      title: ['向下', '右下', '向右', '右上', '向上', '左上', '向左', '左下'][index],
    });
    button.onclick = () => { draft.lineDirection = value; draft.lineDirectionMode = 'fixed'; sync(); };
    lineDirection.append(button);
    return button;
  });
  const lineDirectionMode = h('div', {class:'ts-seg'});
  const lineDirectionModeOptions = ['fixed', 'rotate', 'random'] as const;
  const lineDirectionModeLabels = ['固定', '每句轮转', '每句随机'] as const;
  const lineDirectionModeButtons = lineDirectionModeOptions.map((value, index) => {
    const button = h('button', {class:'ts-seg-btn', text: lineDirectionModeLabels[index]});
    button.onclick = () => { draft.lineDirectionMode = value; sync(); };
    lineDirectionMode.append(button);
    return button;
  });
  const linePlacementRow = h('div', {class:'ts-row'},
    h('div', {class:'ts-row-head'}, h('span', {class:'ts-label', text:'下一句位置'})), linePlacement,
    h('div', {class:'ts-hint', text:'链式向下：首字接上一句末字的左边缘下方；方向链：按上一句整行包围盒在 8 个方向外接，不会压住上一句；画面随机：每句按镜头种子落在画面内的随机位置。'}));
  const lineDirectionRow = h('div', {class:'ts-row'},
    h('div', {class:'ts-row-head'}, h('span', {class:'ts-label', text:'接续方向'})), lineDirection,
    h('div', {class:'ts-hint', text:'方向只改变下一句的起始落点；横排仍从左到右，竖排仍从上到下。文字允许出画面。'}));
  const lineDirectionModeRow = h('div', {class:'ts-row'},
    h('div', {class:'ts-row-head'}, h('span', {class:'ts-label', text:'方向变化'})), lineDirectionMode,
    h('div', {class:'ts-hint', text:'固定：每句都往同一方向；每句轮转：顺时针转 45° 形成环绕；每句随机：按歌词时间种子从 8 个方向抽一个，重播稳定。'}));
  const shape = h('div', {class:'ts-seg'});
  const shapeOptions = ['ring', 'wave', 'burst'] as const;
  const shapeButtons = shapeOptions.map(value => {
    const button = h('button', {
      class:'ts-seg-btn',
      text: value === 'ring' ? '环形' : value === 'wave' ? '波浪' : '放射',
    });
    button.onclick = () => { draft.graphicShape = value; sync(); };
    shape.append(button);
    return button;
  });
  const shapeRow = h('div', {class:'ts-row'},
    h('span', {class:'ts-label', text:'图形轨迹'}), shape);
  const textColorMode = h('div', {class:'ts-seg'});
  const textColorModeOptions = ['cover', 'custom', 'complement', 'invert'] as const;
  const textColorModeButtons = textColorModeOptions.map(value => {
    const button = h('button', {
      class:'ts-seg-btn',
      text: value === 'cover' ? '跟随封面' : value === 'custom' ? '自定义' : value === 'complement' ? '互补色' : '背景反色',
    });
    button.onclick = () => { draft.textColorMode = value; sync(); };
    textColorMode.append(button);
    return button;
  });
  const textColorInput = h('input', {
    type:'color', class:'ts-color', value:draft.textColor, 'aria-label':'自定义文字颜色',
  }) as HTMLInputElement;
  textColorInput.oninput = () => { draft.textColor = textColorInput.value; sync(); };
  const textColorRow = h('div', {class:'ts-row'},
    h('div', {class:'ts-row-head'}, h('span', {class:'ts-label', text:'自定义文字颜色'}), textColorInput));
  const invertDarkInput = h('input', {
    type:'color', class:'ts-color', value:draft.invertDark, 'aria-label':'反色深色',
  }) as HTMLInputElement;
  invertDarkInput.oninput = () => { draft.invertDark = invertDarkInput.value; sync(); };
  const invertLightInput = h('input', {
    type:'color', class:'ts-color', value:draft.invertLight, 'aria-label':'反色浅色',
  }) as HTMLInputElement;
  invertLightInput.oninput = () => { draft.invertLight = invertLightInput.value; sync(); };
  const invertDarkRow = h('div', {class:'ts-row'},
    h('div', {class:'ts-row-head'}, h('span', {class:'ts-label', text:'反色深色'}), invertDarkInput));
  const invertLightRow = h('div', {class:'ts-row'},
    h('div', {class:'ts-row-head'}, h('span', {class:'ts-label', text:'反色浅色'}), invertLightInput));
  const invertFlashSwitches = h('div', {class:'ts-seg'});
  const invertFlashButtons = [true, false].map(enabled => {
    const button = h('button', {class:'ts-seg-btn', text: enabled ? '开' : '关'});
    button.onclick = () => { draft.invertFlash = enabled; sync(); };
    invertFlashSwitches.append(button);
    return button;
  });
  const invertKeywordSwitches = h('div', {class:'ts-seg'});
  const invertKeywordButtons = [true, false].map(enabled => {
    const button = h('button', {class:'ts-seg-btn', text: enabled ? '开' : '关'});
    button.onclick = () => { draft.invertKeyword = enabled; sync(); };
    invertKeywordSwitches.append(button);
    return button;
  });
  const invertFlashRow = h('div', {class:'ts-row'},
    h('span', {class:'ts-label', text:'反色闪烁'}), invertFlashSwitches);
  const invertKeywordRow = h('div', {class:'ts-row'},
    h('span', {class:'ts-label', text:'重点词触发'}), invertKeywordSwitches);
  const backdropMode = h('div', {class:'ts-seg'});
  const backdropModeOptions = ['cover', 'custom', 'black', 'white'] as const;
  const backdropModeButtons = backdropModeOptions.map(value => {
    const button = h('button', {
      class:'ts-seg-btn',
      text: value === 'cover' ? '封面' : value === 'custom' ? '自定义' : value === 'black' ? '纯黑' : '纯白',
    });
    button.onclick = () => { draft.backdropMode = value; sync(); };
    backdropMode.append(button);
    return button;
  });
  const backdropInput = h('input', {
    type:'color', class:'ts-color', value:draft.backdropColor, 'aria-label':'自定义背景颜色',
  }) as HTMLInputElement;
  backdropInput.oninput = () => { draft.backdropColor = backdropInput.value; sync(); };
  const backdropColorRow = h('div', {class:'ts-row'},
    h('div', {class:'ts-row-head'}, h('span', {class:'ts-label', text:'自定义背景颜色'}), backdropInput));

  type CurveField = 'curve' | 'cameraCurve' | 'cameraZoomCurve';
  function curveEditor(field: CurveField, label: string) {
    const canvas = h('canvas', {width:'640', height:'300', style:'display:block;width:100%;height:auto;touch-action:none;cursor:crosshair', 'aria-label':label});
    const inset = 16;
    const w = canvas.width - 2 * inset, height = canvas.height - 2 * inset;
    const py = (y:number) => inset+(2-y)*height/3;
    const px = (x:number) => inset+x*w;
    function draw() {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const css = getComputedStyle(canvas);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = css.getPropertyValue('--line-strong');
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i <= 8; i++) {
        const x = inset + i * w / 8, y = inset + i * height / 8;
        ctx.moveTo(x, inset); ctx.lineTo(x, inset + height);
        ctx.moveTo(inset, y); ctx.lineTo(inset + w, y);
      }
      ctx.stroke();
      const [x1,y1,x2,y2] = draft[field];
      ctx.fillStyle = ctx.strokeStyle = css.getPropertyValue('--muted');
      ctx.font = '20px system-ui';
      for (const y of [0,1]) {
        ctx.beginPath(); ctx.moveTo(inset,py(y)); ctx.lineTo(inset+w,py(y)); ctx.stroke();
        ctx.fillText(y ? '100%' : '0%',inset+4,py(y)-5);
      }
      ctx.beginPath();
      ctx.moveTo(px(0),py(0)); ctx.lineTo(px(x1),py(y1));
      ctx.moveTo(px(1),py(1)); ctx.lineTo(px(x2),py(y2));
      ctx.strokeStyle = css.getPropertyValue('--muted');
      ctx.stroke();
      ctx.strokeStyle = ctx.fillStyle = css.getPropertyValue('--accent');
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(px(0),py(0));
      ctx.bezierCurveTo(px(x1),py(y1),px(x2),py(y2),px(1),py(1));
      ctx.stroke();
      [[0,0,4],[x1,y1,10],[x2,y2,10],[1,1,4]].forEach(([x,y,r]) => {
        ctx.beginPath(); ctx.arc(px(x),py(y),r,0,Math.PI*2); ctx.fill();
      });
    }
    let handle = 0;
    canvas.onpointerdown = e => {
      const box = canvas.getBoundingClientRect();
      if (!e.isPrimary) return;
      const x=(e.clientX-box.left)/box.width*canvas.width-inset;
      const y=(e.clientY-box.top)/box.height*canvas.height;
      const dist=(i:number) => Math.hypot(x-w*draft[field][i], y-py(draft[field][i+1]));
      handle = dist(0) <= dist(2) ? 0 : 2;
      canvas.setPointerCapture(e.pointerId);
      moveHandle(e);
    };
    function moveHandle(e: PointerEvent) {
      if (!canvas.hasPointerCapture(e.pointerId)) return;
      const box = canvas.getBoundingClientRect();
      const v = 2 - 3*(((e.clientY-box.top)/box.height)*canvas.height-inset)/height;
      draft[field][handle] = Math.max(0, Math.min(1, ((e.clientX-box.left)/box.width*canvas.width-inset)/w));
      draft[field][handle+1] = Math.max(-1, Math.min(2, v));
      sync();
    }
    canvas.onpointermove = moveHandle;
    const reset = h('button', {class:'ts-btn is-quiet', text:'重置曲线'});
    reset.onclick = () => {draft[field] = defaultEntryCurve(); sync();};
    return {canvas, draw, reset};
  }
  const entryCurve = curveEditor('curve', '入场速度曲线');
  const cameraCurve = curveEditor('cameraCurve', '镜头移动速度曲线');
  const cameraZoomCurve = curveEditor('cameraZoomCurve', '镜头缩放速度曲线');

  // 撞击参数图表：和重合面板一样，把包络与纵向位移画出来，调滑杆时实时重绘。
  const impactCurve = h('canvas', {class:'ts-curve'}) as HTMLCanvasElement;
  const impactCurveCard = h('div', {class:'ts-curve-card'},
    h('div', {class:'ts-curve-title', text:'撞击曲线'}),
    impactCurve,
    h('div', {class:'ts-curve-hint', text:'橙色包络 · 蓝色纵向位移 · 随撞击参数实时重绘'}));
  function drawImpactCurve() {
    const w = Math.max(240, Math.round(impactCurve.clientWidth || 480));
    const hgt = 118;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (impactCurve.width !== Math.round(w * dpr) || impactCurve.height !== Math.round(hgt * dpr)) {
      impactCurve.width = Math.round(w * dpr);
      impactCurve.height = Math.round(hgt * dpr);
    }
    const ctx = impactCurve.getContext('2d');
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
    const amplitude = Math.max(4, draft.shakePx * draft.shakeY);
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
      const v = draft.shakePx * e * draft.shakeY
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
  }
  const overlapLink = h('div', {class:'ts-seg'});
  const overlapLinkButtons = [true, false].map(linked => {
    const button = h('button', {class:'ts-seg-btn', text: linked ? '合并' : '分开'});
    button.onclick = () => { draft.cameraOverlapLinked = linked; sync(); };
    overlapLink.append(button);
    return button;
  });

  let linkedOverlapRow: HTMLElement | undefined;
  let positionOverlapRow: HTMLElement | undefined;
  let zoomOverlapRow: HTMLElement | undefined;

  function normalizeDraft(key: NumericKey) {
    if (key === 'sizeMin') draft.sizeMax = Math.max(draft.sizeMax, draft.sizeMin);
    else if (key === 'sizeMax') draft.sizeMin = Math.min(draft.sizeMin, draft.sizeMax);
    else if (key === 'invertEveryMin') draft.invertEveryMax = Math.max(draft.invertEveryMax, draft.invertEveryMin);
    else if (key === 'invertEveryMax') draft.invertEveryMin = Math.min(draft.invertEveryMin, draft.invertEveryMax);
  }

  function sync() {
    for (const {key, slider, display, format} of numberRows) {
      slider.value = String(draft[key]);
      display.textContent = format(draft[key]);
    }
    const chanceRow = numberRows.find(row => row.key === 'chance');
    if (chanceRow) chanceRow.slider.disabled = !draft.enabled;
    const lineBlockKeys: NumericKey[] = ['lineBlockChance', 'lineBlockPadding', 'lineBlockAlpha', 'lineBlockSweep'];
    for (const row of numberRows) {
      if (lineBlockKeys.includes(row.key)) row.slider.disabled = !draft.enabled;
    }
    for (const {key, input} of colorRows) {
      input.value = draft[key];
      input.disabled = draft.glowColorMode !== 'custom';
    }
    glowColorModeButtons.forEach((b,i) => b.classList.toggle('is-on', draft.glowColorMode === glowColorModeOptions[i]));
    textColorModeButtons.forEach((b,i) => b.classList.toggle('is-on', draft.textColorMode === textColorModeOptions[i]));
    textColorInput.value = draft.textColor;
    textColorRow.style.display = draft.textColorMode === 'custom' ? '' : 'none';
    const invertMode = draft.textColorMode === 'invert';
    invertDarkInput.value = draft.invertDark;
    invertLightInput.value = draft.invertLight;
    invertDarkRow.style.display = 'none';
    invertLightRow.style.display = 'none';
    invertFlashRow.style.display = invertMode ? '' : 'none';
    invertKeywordRow.style.display = invertMode ? '' : 'none';
    invertFlashButtons.forEach((b,i) => b.classList.toggle('is-on', draft.invertFlash === (i === 0)));
    invertKeywordButtons.forEach((b,i) => b.classList.toggle('is-on', draft.invertKeyword === (i === 0)));
    const invertKeys: NumericKey[] = ['invertEveryMin', 'invertEveryMax', 'invertFlashCount', 'invertFlashWindow', 'invertFlashDark'];
    for (const row of numberRows) {
      if (!invertKeys.includes(row.key)) continue;
      const line = row.slider.closest('.ts-row') as HTMLElement | null;
      if (line) line.style.display = invertMode ? '' : 'none';
      row.slider.disabled = !invertMode || !draft.invertFlash;
    }
    backdropModeButtons.forEach((b,i) => b.classList.toggle('is-on', draft.backdropMode === backdropModeOptions[i]));
    backdropInput.value = draft.backdropColor;
    backdropColorRow.style.display = draft.backdropMode === 'custom' ? '' : 'none';
    entryCurve.draw();
    cameraCurve.draw();
    cameraZoomCurve.draw();
    drawImpactCurve();
    overlapLinkButtons.forEach((b,i) => b.classList.toggle('is-on', draft.cameraOverlapLinked === (i === 0)));
    if (linkedOverlapRow) linkedOverlapRow.style.display = draft.cameraOverlapLinked ? '' : 'none';
    if (positionOverlapRow) positionOverlapRow.style.display = draft.cameraOverlapLinked ? 'none' : '';
    if (zoomOverlapRow) zoomOverlapRow.style.display = draft.cameraOverlapLinked ? 'none' : '';
    layoutButtons.forEach((b,i) => b.classList.toggle('is-on', draftLayout() === layoutOptions[i]));
    for (const row of numberRows) {
      if (row.key === 'phraseSize') row.slider.disabled = draftLayout() === 'whole';
    }
    orderButtons.forEach((b,i) => b.classList.toggle('is-on', draft.order === orderValues[i]));
    entryStyleButtons.forEach((b,i) => b.classList.toggle('is-on', draft.entryStyle === entryStyleOptions[i]));
    arrangementButtons.forEach((b,i) => b.classList.toggle('is-on', draft.arrangement === arrangementOptions[i]));
    linePlacementButtons.forEach((b,i) => b.classList.toggle('is-on', draft.linePlacement === linePlacementOptions[i]));
    const directional = draft.linePlacement === 'direction' && draft.arrangement !== 'graphic';
    linePlacementRow.style.display = draft.arrangement === 'graphic' ? 'none' : '';
    lineDirectionButtons.forEach((b,i) => b.classList.toggle('is-on', draft.lineDirection === lineDirectionOptions[i]));
    lineDirectionModeButtons.forEach((b,i) => b.classList.toggle('is-on', draft.lineDirectionMode === lineDirectionModeOptions[i]));
    lineDirectionRow.style.display = directional ? '' : 'none';
    lineDirectionModeRow.style.display = directional ? '' : 'none';
    shapeButtons.forEach((b,i) => b.classList.toggle('is-on', draft.graphicShape === shapeOptions[i]));
    shapeRow.hidden = draft.arrangement !== 'graphic';
    shapeRow.style.display = draft.arrangement === 'graphic' ? '' : 'none';
    buttons.forEach((b,i) => b.classList.toggle('is-on', draft.enabled === (i === 0)));
    decorButtons.forEach((b,i) => b.classList.toggle('is-on', draft.glyphDecor === (i === 0)));
    decorStyleButtons.forEach((b,i) => b.classList.toggle('is-on', draft.glyphDecorStyle === decorStyleOptions[i]));
    for (const row of numberRows) {
      if (row.key === 'glyphDecorChance' || row.key === 'glyphDecorSize' || row.key === 'glyphDecorSpeed') {
        row.slider.disabled = !draft.glyphDecor;
      }
    }
    kineticButtons.forEach((b,i) => b.classList.toggle('is-on', draft.kineticDecor === (i === 0)));
    for (const row of numberRows) {
      if (row.key === 'kineticChance' || row.key === 'kineticDensity' || row.key === 'kineticSpeed') {
        row.slider.disabled = !draft.kineticDecor;
      }
    }
    stretchButtons.forEach((b,i) => b.classList.toggle('is-on', draft.stretch === (i === 0)));
    hollowButtons.forEach((b,i) => b.classList.toggle('is-on', draft.hollowLinger === (i === 0)));
    marqueeButtons.forEach((b,i) => b.classList.toggle('is-on', draft.marquee === (i === 0)));
    bottomLineButtons.forEach((b,i) => b.classList.toggle('is-on', draft.bottomLine === (i === 0)));
    const marqueeKeys: NumericKey[] = ['marqueeChance', 'marqueeDuration', 'marqueeLength', 'marqueePadding', 'marqueeWidth', 'marqueeGlow', 'marqueeEntryDelay', 'marqueeEntryFade', 'marqueeEntryScale', 'marqueeRun', 'marqueeBrake'];
    const bottomLineKeys: NumericKey[] = ['bottomLineChance', 'bottomLineLength', 'bottomLineWidth', 'bottomLineGlow', 'bottomLineOffset', 'bottomLineSpeed', 'bottomLineRun', 'bottomLineBrake', 'bottomLineFade'];
    for (const row of numberRows) {
      if (row.key === 'stretchAmount' || row.key === 'stretchDuration' || row.key === 'stretchSteps') row.slider.disabled = !draft.stretch;
      if (row.key === 'hollowLingerChance' || row.key === 'hollowLingerDuration') row.slider.disabled = !draft.hollowLinger;
      if (marqueeKeys.includes(row.key)) row.slider.disabled = !draft.marquee;
      if (bottomLineKeys.includes(row.key)) row.slider.disabled = !draft.bottomLine;
    }
    previewWenflashSettings(draft);
    paint();
  }

  const reset = h('button', {class:'ts-btn is-quiet', text:'恢复默认'});
  reset.onclick = () => { Object.assign(draft, defaultWenflashSettings()); sync(); };
  const root = h('div', {class:'sheet text-sheet vinyl-sheet flow-sheet overlap-sheet', id:'wenflash-settings'});
  function close() {
    cancelAnimationFrame(frameId);
    scene.dispose();
    restoreWenflashSettings();
    document.removeEventListener('keydown', keydown, true);
    root.remove();
    if (previousFocus instanceof HTMLElement) previousFocus.focus();
  }
  function keydown(e: KeyboardEvent) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }
  const cancel = h('button', {class:'ts-btn', text:'取消'});
  cancel.onclick = close;
  const save = h('button', {class:'ts-btn is-primary', text:'保存'});
  save.onclick = () => { previewWenflashSettings(draft); saveWenflashSettings(); toast('文闪设置已保存'); close(); };
  const exit = h('button', {class:'icon-btn', title:'关闭'}, icon('close',16));
  exit.onclick = close;
  root.append(h('div', {class:'ts-panel', role:'dialog', 'aria-modal':'true', 'aria-label':'文闪设置'},
    h('div', {class:'sheet-head lp-head ts-head'}, h('div', {class:'lp-head-text'},
      h('div', {class:'sheet-title', text:'文闪设置'}), h('div', {class:'lp-head-song', text:'文闪 · '+song.title})), exit),
    h('div', {class:'ts-body'},
      h('div', {class:'ts-preview-col'}, h('div', {class:'ts-preview-label', text:'实时预览'}), stage,
        h('div', {class:'overlap-preview-controls'}, seek, pause, replay), hint),
      h('div', {class:'ts-left'}, h('div', {class:'ts-groups'},
        h('div', {class:'ts-group'},
          h('div', {class:'ts-group-title', text:'文字入场'}),
          numberRow('sizeMin', '起始倍率下限', 1, 3, 0.05, v => v.toFixed(2) + '×'),
          numberRow('sizeMax', '起始倍率上限', 1, 3, 0.05, v => v.toFixed(2) + '×'),
          h('div', {class:'ts-row'}, h('div', {class:'ts-row-head'}, h('span', {class:'ts-label', text:'入场速度曲线'}), entryCurve.reset), entryCurve.canvas,
            h('div', {class:'ts-hint', text:'横轴是时间，纵轴是入场进度。拖动两个贝塞尔控制柄，分别调整起步和收尾。'})),
          h('div', {class:'ts-row'}, h('span', {class:'ts-label', text:'歌词显示'}), layout),
          numberRow('phraseSize', '拆分粒度', 1, 8, 1, v => Math.round(v) + ' 字/词', '中日泰等无空格文字按字计；英文、韩文、阿拉伯文等按词计；1 最碎，8 接近长句。'),
          h('div', {class:'ts-row'}, h('div', {class:'ts-row-head'}, h('span', {class:'ts-label', text:'入场动作'})), entryStyle,
            h('div', {class:'ts-hint', text:'只用缩放：保留 1.3–1.8 倍收束；重合逐字：使用重合的 7 种逐字入场，不再额外放大；叠加两者：原始逐字动作 + 倍率。'})),
          numberRow('entryDelay', '入场延后', 0, 1.5, 0.05, v => v.toFixed(2) + 's', '字形出现后先等这么久，再开始放大收束；默认 0.30s，正好接在入场闪烁之后。'),
          numberRow('entryZoom', '收束时长', 0.2, 3, 0.05, v => v.toFixed(2) + 's', '从起始倍率收到 1 倍所用的时间；越长越容易看清这段动画。'),
          numberRow('entryRotation', '入场随机角度', 0, 360, 1, v => Math.round(v) + '°', '每个字在原有入场角上再随机偏转这么多（左右各一半），落位时转正；0° 关闭。'),
          numberRow('lineRotation', '整句随机角度', 0, 360, 1, v => Math.round(v) + '°', '每一整句额外随机倾斜一个角度，同一句所有字共用；落位时转正，镜头会反向抵消这句的倾斜；0° 关闭。'),
          numberRow('entryBlurChance', '入场模糊概率', 0, 100, 1, v => Math.round(v) + '%', '每个字独立掷骰；0% 关闭，所有字都清晰入场。'),
          numberRow('entryBlurAmount', '入场模糊强度', 0, 200, 1, v => Math.round(v) + '%', '100% 为原有湿墨底模糊上再加一档；越高越虚，模糊从字出现开始收敛到清晰。'),
          numberRow('entryBlurDuration', '入场模糊时长', 0.1, 1.2, 0.05, v => v.toFixed(2) + 's', '每个字在这个基准附近随机取时长；越长，模糊停留越久。'),
          h('div', {class:'ts-hint', text:'混合：整句与拆分短句按行随机出现，两种排法都会出现，不再固定交替。'}),
          h('div', {class:'ts-row'}, h('div', {class:'ts-row-head'}, h('span', {class:'ts-label', text:'出现顺序'})), order,
            h('div', {class:'ts-hint', text:'按歌词时间保持原顺序；短句随机只打乱拆分/混合档每个短句内部；随机出现在整句范围内打乱所有字的入场先后，拆分档仍以每个短句为界，不改变位置与句长。'})),
          h('div', {class:'ts-row'}, h('div', {class:'ts-row-head'}, h('span', {class:'ts-label', text:'文字排列'})), arrangement,
            h('div', {class:'ts-hint', text:'竖排：每行歌词成一列、字自上而下；横竖混合：相邻歌词行交替横向/竖排；图形：整句字沿轨迹排开，仍按歌词时钟逐字入场。'})),
          linePlacementRow,
          lineDirectionRow,
          lineDirectionModeRow,
          shapeRow),
        h('div', {class:'ts-group'},
          h('div', {class:'ts-group-title', text:'歌词颜色'}),
          h('div', {class:'ts-row'}, h('span', {class:'ts-label', text:'颜色来源'}), textColorMode),
          textColorRow,
          numberRow('textColorChance', '异色概率', 0, 100, 1, v => Math.round(v) + '%', '按整句普通字数量抽取；抽中的字从下面的异色色盘取色，重点词颜色不变。'),
          numberRow('textColorCount', '异色数量', 2, 32, 1, v => Math.round(v) + ' 种', '色盘沿色环铺开，抽中的字尽量分散取色；数量越多，同一句里的颜色越丰富。'),
          invertFlashRow,
          invertKeywordRow,
          numberRow('invertEveryMin', '最短间隔', 1, 12, 1, v => Math.round(v) + ' 句', '每隔这么多句至少触发一次反色闪烁；和最长间隔一起随机。'),
          numberRow('invertEveryMax', '最长间隔', 1, 12, 1, v => Math.round(v) + ' 句', '实际间隔在这个范围内按句种子随机取；不会小于最短间隔。'),
          numberRow('invertFlashCount', '闪烁次数', 1, 8, 1, v => Math.round(v) + ' 次', '每次反色翻转时闪几下；独立于文字入退场闪烁。'),
          numberRow('invertFlashWindow', '闪烁时长', 0.05, 2, 0.05, v => v.toFixed(2) + 's', '整段反色翻转闪烁持续多久；越长越慢。'),
          numberRow('invertFlashDark', '暗拍占比', 0, 100, 1, v => Math.round(v) + '%', '每次闪烁里停在旧状态的比例；越高越偏暗，越低越偏亮。'),
          h('div', {class:'ts-hint', text:'反色是整幅画面（背景、文字、装饰、图片）一起翻成黑白；这组闪烁参数是反色专用，不跟随文字入退场闪烁。'}),
          h('div', {class:'ts-hint', text:'跟随封面：以封面墨色为底；自定义：以自定义色为底；互补色：以封面强调色的互补色为底。异色从该底色对应的多色色盘里取。'}),
          h('div', {class:'ts-hint', text:'异色概率按整句普通字数量抽取；异色数量决定色盘有多少种颜色，抽中的字会按随机顺序依次取不同颜色。'})),
        h('div', {class:'ts-group'},
          h('div', {class:'ts-group-title', text:'层叠色版'}),
          numberRow('ghostLayers', '色版层数', 0, 4, 1, v => v <= 0 ? '关闭' : Math.round(v) + ' 层', '每个字后方预置几张错位色版；0 层只保留原来的单层阴影。'),
          numberRow('ghostOffset', '色版错位', 0, 40, 1, v => Math.round(v) + 'px', '每往后一层，色版沿右下方向多错开这么多像素。'),
          numberRow('ghostAlpha', '色版浓度', 0, 100, 1, v => Math.round(v) + '%', '每层色版的透明度；越往后越淡，随文字一起入场、闪烁和退场。'),
          h('div', {class:'ts-hint', text:'这是固定在基字后方的印刷色版，和入场拖尾、残影分开；镂空和纯色块亮拍时会自动让位。'})),
        h('div', {class:'ts-group'},
          h('div', {class:'ts-group-title', text:'字形装饰'}),
          h('div', {class:'ts-row'}, h('span', {class:'ts-label', text:'装饰开关'}), decorSwitches),
          h('div', {class:'ts-row'}, h('span', {class:'ts-label', text:'装饰样式'}), decorStyle),
          numberRow('glyphDecorChance', '出现概率', 0, 100, 1, v => Math.round(v) + '%', '每个字独立抽取；只会有一部分字带装饰，不会整句每个字都加。'),
          numberRow('glyphDecorSize', '装饰大小', 30, 220, 1, v => Math.round(v) + '%', '相对字号的大小。'),
          numberRow('glyphDecorSpeed', '动画速度', 20, 200, 1, v => Math.round(v) + '%', '星芒旋转、环绕墨点和划线呼吸的速度。'),
          h('div', {class:'ts-hint', text:'装饰从字落定后浮现，随文字闪烁和退场一起收走；镂空和纯色块亮拍时会自动让位。'})),
        h('div', {class:'ts-group'},
          h('div', {class:'ts-group-title', text:'动态图示'}),
          h('div', {class:'ts-row'}, h('span', {class:'ts-label', text:'跟随图形'}), kineticSwitches,
            h('div', {class:'ts-hint', text:'图形挂在每一句自己的舞台上，跟着文字的位置、镜头、排列、入场和退场一起走；不是屏幕四边的固定框。'})),
          numberRow('kineticChance', '出现概率', 0, 100, 1, v => Math.round(v) + '%', '每一句独立抽取，抽中才出现动态图示；0% 等于关掉。'),
          numberRow('kineticDensity', '图形密度', 0, 100, 1, v => Math.round(v) + '%', '进度格数量与逐字刻度的疏密；越低越留白。'),
          numberRow('kineticSpeed', '流动速度', 20, 200, 1, v => Math.round(v) + '%', '游标呼吸与刻度摆动的速度；100% 为基准。'),
          h('div', {class:'ts-hint', text:'几何图形贴着句子边缘走，进度格按逐字演唱填满；每句按「出现概率」独立抽取，不是每句都有。'})),
        h('div', {class:'ts-group'},
          h('div', {class:'ts-group-title', text:'歌词背景'}),
          numberRow('decorIntensity', '画面装饰强度', 0, 100, 1, v => Math.round(v) + '%', '调节 32 组句边动效及文字装饰的浓度，0% 关闭。'),
          numberRow('phraseArtRun', '句边动效运动时长', 0, 30, 0.1, v => v <= 0 ? '一直跑' : v.toFixed(1) + 's', '32 组句边动效共用。设为 0 时持续运动到退场。'),
          numberRow('phraseArtBrake', '句边动效刹停时长', 0.1, 8, 0.1, v => v.toFixed(1) + 's', '从当前速度减到静止所需的时间。停住后仍按歌词时间闪退。'),
          h('div', {class:'ts-row'}, h('span', {class:'ts-label', text:'背景来源'}), backdropMode),
          backdropColorRow,
          h('div', {class:'ts-hint', text:'封面：透出当前播放页的封面背景；自定义：使用上面的背景颜色；纯黑/纯白：整屏压成对应底色。'}),
          h('div', {class:'ts-hint', text:'只影响文闪舞台；重合效果仍使用它自己的背景设置。'})),
        h('div', {class:'ts-group'},
          h('div', {class:'ts-group-title', text:'镜头移动'}),
          h('div', {class:'ts-row'}, h('div', {class:'ts-row-head'}, h('span', {class:'ts-label', text:'镜头移动速度曲线'}), cameraCurve.reset), cameraCurve.canvas,
            h('div', {class:'ts-hint', text:'横轴是本句演唱进度，纵轴是镜头平移速度。曲线越陡，镜头追得越快；默认与入场曲线相同。'})),
          h('div', {class:'ts-row'}, h('div', {class:'ts-row-head'}, h('span', {class:'ts-label', text:'镜头缩放速度曲线'}), cameraZoomCurve.reset), cameraZoomCurve.canvas,
            h('div', {class:'ts-hint', text:'横轴是本句演唱进度，纵轴是镜头缩放速度。与平移分开设置；曲线越陡，缩放收得越紧。只影响横向/竖排/横竖混合的跟随镜头，图形档固定镜头。'})),
          h('div', {class:'ts-row'}, h('span', {class:'ts-label', text:'错帧联动'}), overlapLink,
            h('div', {class:'ts-hint', text:'合并：一个错帧时长同时控制位置与缩放；分开：位置和缩放各有自己的时长，可以一个先接、一个后接。'})),
          numberRow('cameraSteps', '镜头抽帧', 0, 24, 1, v => v <= 1 ? '连续' : Math.round(v) + ' 帧/秒', '0/1 为连续跟随；2–24 为每秒更新镜头位置的次数，越低越像定格。'),
          numberRow('cameraRotation', '镜头跟随旋转', 0, 100, 1, v => Math.round(v) + '%', '镜头反向抵消整句的随机倾斜（按文字实际的逐字动态缩放），让文字看着保持水平；100% 完全抵消，0% 保留原始倾斜。'),
          numberRow('letterboxPercent', '黑边占比上限', 0, 30, 1, v => Math.round(v) + '%', '每条黑边最多占画面高度的比例。小幅推拉只带动少量变化，大幅拉远时逐渐接近上限。'),
          numberRow('renderFps', '画面帧率', 0, 30, 1, v => v <= 1 ? '原生' : Math.round(v) + ' 帧/秒', '真正限制整幅画面的重绘帧率：2–30 时文字、色块和镜头一起降帧，模拟动漫低帧；0/1 为原生。'),
          linkedOverlapRow = numberRow('cameraOverlap', '错帧时长', 0, 2, 0.05, v => v <= 0 ? '关闭' : v.toFixed(2) + 's', '合并时同时控制位置与缩放；0 表示等上一段结束再换目标。'),
          positionOverlapRow = numberRow('cameraOverlap', '位置错帧', 0, 2, 0.05, v => v <= 0 ? '关闭' : v.toFixed(2) + 's', '只控制平移：下一句的镜头位置提前这么久开始叠加。'),
          zoomOverlapRow = numberRow('cameraZoomOverlap', '缩放错帧', 0, 2, 0.05, v => v <= 0 ? '关闭' : v.toFixed(2) + 's', '只控制缩放：下一句的镜头推拉提前这么久开始叠加。')),
        h('div', {class:'ts-group'},
          h('div', {class:'ts-group-title', text:'镜头撞击'}),
          numberRow('shakeChance', '撞击概率', 0, 100, 1, v => Math.round(v) + '%', '每一条歌词行独立抽取；拆分短句同行只撞一次。'),
          numberRow('shakePx', '撞击位移', 0, 320, 1, v => Math.round(v) + 'px'),
          numberRow('shakeElastic', '撞击弹性', 0.3, 5, 0.05, v => v.toFixed(2), '越大越软、余振越长。'),
          numberRow('shakeX', '横向分量', 0, 4, 0.05, v => v.toFixed(2) + '×'),
          numberRow('shakeY', '纵向分量', 0, 4, 0.05, v => v.toFixed(2) + '×'),
          numberRow('shakeZ', 'Z 推拉', 0, 400, 2, v => Math.round(v) + 'px', '沿视线方向的推拉，换算成缩放。'),
          numberRow('shakeDepth', 'Z 压缩', 0, 24, 0.2, v => v.toFixed(1) + '%'),
          numberRow('shakeRollDeg', '撞击滚转', 0, 8, 0.05, v => v.toFixed(2) + '°'),
          numberRow('shakeAttack', '撞击入场', 0.01, 0.6, 0.01, v => v.toFixed(2) + 's', '从 0 到满力度的秒数，越小越像被砸一下。'),
          numberRow('shakeSwing', '撞击回摆', 0, 4, 0.05, v => v.toFixed(2), '0 表示不回摆，只推一下再淡出。'),
          numberRow('shakeAt', '撞击时机', 0, 100, 1, v => Math.round(v) + '%', '当前这句唱到百分之多少时撞一下。'),
          numberRow('shakeDamping', '撞击削减', 0.2, 6, 0.05, v => v.toFixed(2), '越大余振收得越快。'),
          impactCurveCard,
          h('div', {class:'ts-hint', text:'这是文闪自己的撞击参数，不读取重合效果的运镜设置。曲线实时显示包络与纵向位移。'})),
        h('div', {class:'ts-group'},
          h('div', {class:'ts-group-title', text:'印刷与画质'}),
          numberRow('lensDistortion', '镜头畸变', 0, 2, 0.05, v => v.toFixed(2), '中心不动，边缘像透过广角玻璃。'),
          numberRow('rgbShift', '色版偏移', 0, 1, 0.05, v => v.toFixed(2), '红蓝分开一点点，像套印没对准。'),
          numberRow('grain', '纸面颗粒', 0, 1, 0.05, v => v.toFixed(2), '纸纤维的细颗粒，0 关闭。'),
          numberRow('contrast', '对比度', 0, 1, 0.05, v => v.toFixed(2)),
          numberRow('vignette', '暗角', 0, 2, 0.05, v => v.toFixed(2), '四角压暗，让字更聚光。'),
          h('div', {class:'ts-hint', text:'这五项只作用于文闪舞台；重合效果仍使用它自己的「印刷与画质」。'})),
        h('div', {class:'ts-group'},
          h('div', {class:'ts-group-title', text:'入场拉伸'}),
          h('div', {class:'ts-row'}, h('span', {class:'ts-label', text:'独立拉伸'}), stretchSwitches),
          numberRow('stretchAmount', '拉伸倍率', 2, 40, 1, v => '×' + Math.round(v), '字出现后沿排版方向拉长到设定倍率，再收回到 1 倍；横排拉左右，竖排拉上下。'),
          numberRow('stretchDuration', '收回时长', 0.02, 0.4, 0.01, v => Math.round(v * 1000) + 'ms', '拉伸从设定倍率收回 1 倍所需的时间；越长越柔和，越短越像一帧残影。'),
          numberRow('stretchSteps', '抽帧级数', 0, 24, 1, v => v <= 1 ? '连续' : Math.round(v) + ' 级', '0 或 1 为连续收回；数值越小，拉伸收回越像跳帧。'),
          h('div', {class:'ts-hint', text:'独立于七种入场，不改变入场的位移与方向；只影响字刚出现时的形状。'})),
        h('div', {class:'ts-group'},
          h('div', {class:'ts-group-title', text:'入场后抽帧放大'}),
          numberRow('postZoomChance', '触发概率', 0, 100, 1, v => Math.round(v) + '%', '每个字在自己的落定时间后独立触发；0% 关闭。'),
          numberRow('postZoomWaveChance', '波浪概率', 0, 100, 1, v => Math.round(v) + '%', '按镜头种子决定这一句是否改走从左到右的波浪；其余情况仍按字随机。'),
          numberRow('postZoomScale', '上限倍率', 1.05, 3, 0.05, v => v.toFixed(2) + '×', '每个字在 1× 到这个上限之间独立取峰值，不会所有字都顶到上限。'),
          numberRow('postZoomDuration', '持续时间', 0.08, 1.5, 0.02, v => v.toFixed(2) + 's'),
          numberRow('postZoomSteps', '抽帧级数', 2, 24, 1, v => Math.round(v) + ' 级', '数值越小，跳变越硬；越大越接近连续缩放。'),
          h('div', {class:'ts-hint', text:'每个字落定后用离散台阶从 1 倍涨到自己峰值再回到 1 倍；不改变字的位置和布局。'})),
        h('div', {class:'ts-group'},
          h('div', {class:'ts-group-title', text:'闪烁节奏（入场/退场）'}),
          h('div', {class:'ts-row'}, h('span', {class:'ts-label', text:'叠加入场闪烁'}), switches),
          numberRow('chance', '入场触发概率', 0, 100, 1, v => Math.round(v) + '%', '按镜头种子决定这一整句是否闪烁入场；退场固定使用下面的节奏。'),
          numberRow('flashCount', '闪烁次数', 1, 8, 1, v => Math.round(v) + ' 次'),
          numberRow('flashWindow', '闪烁时长', 0.1, 1.2, 0.05, v => v.toFixed(2) + 's', '入场从每个字起唱算起；退场从下一句出现后 0.5 秒开始算起。'),
          numberRow('flashDark', '暗拍占比', 0, 100, 1, v => Math.round(v) + '%', '每个亮暗周期里暗拍所占的时间。'),
          numberRow('flashDim', '暗拍亮度', 0, 100, 1, v => Math.round(v) + '%', '暗拍保留的字形透明度；100% 等于不压暗。')),
        h('div', {class:'ts-group'},
          h('div', {class:'ts-group-title', text:'亮拍外观（单字）'}),
          numberRow('solidChance', '纯色块概率', 0, 100, 1, v => Math.round(v) + '%'),
          numberRow('outlineChance', '镂空概率', 0, 100, 1, v => Math.round(v) + '%', '两个概率各自独立；相加超过 100% 时纯色块优先，镂空只占剩下的部分。'),
          h('div', {class:'ts-hint', text:'纯色块自动使用该字自己的文字颜色，不再单独选色。'}),
          numberRow('blockPadding', '单字色块外扩', 0, 20, 0.5, v => v.toFixed(1) + '%', '按字号百分比；0 表示紧贴字形墨迹。'),
          numberRow('blockAlpha', '单字色块不透明度', 0, 100, 1, v => Math.round(v) + '%'),
          numberRow('outlineWidth', '镂空描边', 0.5, 10, 0.5, v => v.toFixed(1) + '%', '按字号百分比。')),
        h('div', {class:'ts-group'},
          h('div', {class:'ts-group-title', text:'镂空停留'}),
          h('div', {class:'ts-row'}, h('span', {class:'ts-label', text:'保持镂空'}), hollowSwitches),
          numberRow('hollowLingerChance', '停留概率', 0, 100, 1, v => Math.round(v) + '%', '每个字被镂空亮拍选中后，按这个概率决定要不要一直保持描边；没选中镂空的字不受影响。'),
          numberRow('hollowLingerDuration', '停留时长', 0, 8, 0.1, v => v <= 0 ? '到本句结束' : v.toFixed(1) + 's', '0 表示从最后一次镂空亮拍一直保持到本句退场；大于 0 时按秒收回。'),
          h('div', {class:'ts-hint', text:'停留期间只保留描边、隐藏填充；再次被纯色块亮拍选中时会短暂盖住，亮拍结束后继续镂空。'})),
        h('div', {class:'ts-group'},
          h('div', {class:'ts-group-title', text:'跑马框'}),
          h('div', {class:'ts-row'}, h('span', {class:'ts-label', text:'整句跑马框'}), marqueeSwitches),
          numberRow('marqueeChance', '触发概率', 0, 100, 1, v => Math.round(v) + '%', '按镜头种子决定这一整句是否套框；0% 关闭。'),
          numberRow('marqueeDuration', '环绕时长', 0.8, 12, 0.1, v => v.toFixed(1) + 's', '图样沿外框运行一整圈所需的时间；越短跑得越快，不同样式的具体轨迹由样式决定。'),
          numberRow('marqueeLength', '光线长度', 5, 45, 1, v => Math.round(v) + '%', '图样主线占整圈周长的比例；彗尾/拖尾类会变成尾长，虚线类会改变划线长度，整宽类不受影响。'),
          numberRow('marqueePadding', '外框外扩', 0, 2, 0.1, v => v.toFixed(1) + ' em', '外框在整句包围盒外再放大的距离；按字号计。'),
          numberRow('marqueeWidth', '光线宽度', 1, 20, 0.5, v => v.toFixed(1) + '%', '光线粗细，按字号百分比；辉光会跟着变粗。'),
          numberRow('marqueeGlow', '辉光强度', 0, 100, 1, v => Math.round(v) + '%', '光线背后的柔光；0% 只剩硬边线。'),
          numberRow('marqueeEntryDelay', '入场延后', 0, 2, 0.02, v => v.toFixed(2) + 's', '从本句第一个字起唱，到外框开始出现之间的等待。'),
          numberRow('marqueeEntryFade', '入场时长', 0.05, 2, 0.01, v => Math.round(v * 1000) + 'ms', '外框从透明到完全显示所用时间；越短越硬，越长越柔。'),
          numberRow('marqueeEntryScale', '起始缩放', 0.6, 1.4, 0.01, v => v.toFixed(2) + '×', '外框出现时的初始尺寸；1.00 为原尺寸，小于 1 时从框心略微展开，大于 1 时收回。'),
          numberRow('marqueeRun', '运动时长', 0, 30, 0.1, v => v <= 0 ? '一直跑' : v.toFixed(1) + 's', '从外框出现开始匀速环绕多久，之后进入刹停；0 表示本句内一直环绕。'),
          numberRow('marqueeBrake', '刹停时长', 0.1, 8, 0.1, v => v.toFixed(1) + 's', '刹停阶段速度从当前值缓降到 0 所用时间；停住后图样原地不动，直到本句退场。'),
          h('div', {class:'ts-hint', text:'30 种绘线样式按镜头种子随机抽选（双彗、星屑、虚线、角标、波带、扫描、残影、粒子、刻度等）；同一句的边框与底线共用一种样式，重播保持不变。颜色跟随这一句文字；入场延后/时长/起始缩放独立可调，退场随文字闪烁结束一起消失。'})),
        h('div', {class:'ts-group'},
          h('div', {class:'ts-group-title', text:'底部光线'}),
          h('div', {class:'ts-row'}, h('span', {class:'ts-label', text:'单条底部光线'}), bottomLineSwitches),
          numberRow('bottomLineChance', '触发概率', 0, 100, 1, v => Math.round(v) + '%', '按镜头种子决定这一整句是否出现底部光线；与跑马框各自独立。'),
          numberRow('bottomLineLength', '线长', 10, 100, 1, v => Math.round(v) + '%', '光线长度占整句宽度的比例；100% 与整句同宽。'),
          numberRow('bottomLineWidth', '线宽', 1, 20, 0.5, v => v.toFixed(1) + '%', '光线粗细，按字号百分比；辉光会跟着变粗。'),
          numberRow('bottomLineGlow', '辉光强度', 0, 100, 1, v => Math.round(v) + '%', '光线背后的柔光；0% 只剩硬边线。'),
          numberRow('bottomLineOffset', '离文字距离', 0, 2, 0.1, v => v.toFixed(1) + ' em', '光线在整句包围盒下方多远；按字号计。'),
          numberRow('bottomLineSpeed', '往返时长', 0.5, 20, 0.1, v => v.toFixed(1) + 's', '光线在整句宽度内左右往返一次的时间；两端缓入缓出。'),
          numberRow('bottomLineRun', '运动时长', 0, 30, 0.1, v => v <= 0 ? '一直跑' : v.toFixed(1) + 's', '从光线出现开始往返多久，之后进入刹停；0 表示本句内一直往返。'),
          numberRow('bottomLineBrake', '刹停时长', 0.1, 8, 0.1, v => v.toFixed(1) + 's', '刹停阶段速度从当前值缓降到 0 所用时间；停住后光线原地不动，直到本句退场。'),
          numberRow('bottomLineFade', '入场时长', 0.05, 2, 0.01, v => Math.round(v * 1000) + 'ms', '光线从透明到完全显示所用时间。'),
          h('div', {class:'ts-hint', text:'单条同色辉光线画在整句下方，颜色跟随这一句文字；随整句入场淡入、退场闪烁结束一起消失。'})),
        h('div', {class:'ts-group'},
          h('div', {class:'ts-group-title', text:'整句覆盖'}),
          numberRow('lineBlockChance', '触发概率', 0, 100, 1, v => Math.round(v) + '%', '按镜头种子决定这一整句是否出现覆盖整行的色块；0% 关闭。'),
          numberRow('lineBlockPadding', '整句色块外扩', 0, 20, 0.5, v => v.toFixed(1) + '%', '与单字色块分开设置；按字号百分比。'),
          numberRow('lineBlockAlpha', '整句色块不透明度', 0, 100, 1, v => Math.round(v) + '%'),
          numberRow('lineBlockSweep', '扫过时长', 0.1, 3, 0.05, v => v.toFixed(2) + 's', '入场后色块用这段时间扫过整句并消失；横排从左到右，竖排从上到下。'),
          h('div', {class:'ts-hint', text:'整句色块按自己的节奏扫过，不跟随唱词推进；颜色沿用句中文字自己的颜色。'})),
        h('div', {class:'ts-group'},
          h('div', {class:'ts-group-title', text:'辉光'}),
          numberRow('glowStrength', '辉光强度', 0, 200, 1, v => Math.round(v) + '%', '乘在重合的重点词辉光上；0% 关闭所有辉光。'),
          numberRow('glowRadius', '辉光半径', 20, 300, 1, v => Math.round(v) + '%', '柔光扩散范围；越大越柔，也越吃性能。'),
          numberRow('glowPlain', '普通字比例', 0, 100, 1, v => Math.round(v) + '%', '普通字相对重点词的亮度；100% 与重点词一样亮。'),
          numberRow('glowChance', '普通字辉光概率', 0, 100, 1, v => Math.round(v) + '%', '重点词始终有辉光；普通字按这个概率随机抽取，100% 每个普通字都有，0% 只有重点词。'),
          h('div', {class:'ts-row'}, h('span', {class:'ts-label', text:'渐变颜色'}), glowColorMode),
          colorRow('glowColorA', '色带 A'),
          colorRow('glowColorB', '色带 B'),
          colorRow('glowColorC', '色带 C'),
          numberRow('glowFlowSpeed', '流动速度', 0, 300, 5, v => Math.round(v) + '%', '色带滚动速度；0% 冻结。'),
          numberRow('glowFlowScale', '色带密度', 30, 300, 5, v => Math.round(v) + '%', '数值越大，色带越窄、重复越密。'),
          h('div', {class:'ts-hint', text:'「跟随重点词」使用每个重点词自己的颜色；「自定义」使用下面三段颜色。普通字只有柔光，不参与流动渐变。'})),
        h('div', {class:'ts-group'},
          h('div', {class:'ts-group-title', text:'出现后模糊'}),
          numberRow('blurDelay', '出现完成后延迟', 0, 8, 0.1, v => v.toFixed(1) + 's', '从这组文字最后一个字落位完成开始计时；0s 表示落位后立刻开始。'),
          numberRow('blurAmount', '模糊程度', 0, 100, 1, v => Math.round(v) + '%', '0% 关闭唱后模糊；参与模糊的仍是原字，不改变歌词。'))))),
    h('div', {class:'ts-foot'}, h('div', {class:'ts-foot-status', text:'取消将恢复已保存的设置'}),
      h('div', {class:'ts-foot-actions'}, reset, cancel, save))));
  root.onpointerdown = e => { if (e.target === root) close(); };
  document.body.append(root);
  document.addEventListener('keydown', keydown, true);
  exit.focus();
  sync();
  function frame(now: number) {
    if (playing) { position = start + (position - start + (last ? now - last : 0)) % (end - start); paint(); }
    last = now;
    frameId = requestAnimationFrame(frame);
  }
  frameId = requestAnimationFrame(frame);
}
