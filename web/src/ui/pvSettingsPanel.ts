/**
 * 歌词「PV 设置」面板：从快捷设置 → 歌词 → 效果设置（PV 档）点开。
 *
 * 和「几何设置」「房间设置」同一套骨架：底部居中大弹窗，左边是独立的实时预览
 * （单独一个 PV 场景按 1x 时钟循环播放，不依赖歌词页），右边是可调项。
 * 拖动即预览、点「保存」才落盘；取消/关闭还原到打开时的样子。
 */
import { h, icon, toast } from './dom';
import { lyricPreviewSong } from './lyrics';
import { applyPvStyleSettings } from './pv';
import { createPvScene, type PvScene, type PvSong } from './pvScene';
import {
  DEFAULT_PV_SETTINGS,
  PV_PALETTE_LABELS,
  normalizePvSettings,
  pvStyleSettings,
  savePvStyleSettings,
  type PvStyleSettings,
} from './pvSettings';

type NumericKey = 'dpr' | 'sizeScale' | 'glitch' | 'grain' | 'tilt' | 'transitions';

interface RangeSpec {
  key: NumericKey;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  digits: number;
  unit?: string;
}

const RANGES: RangeSpec[] = [
  {
    key: 'sizeScale',
    label: '字号',
    hint: '整页大字的倍率；PV 的风格是把字推到出血，1.0 以上更容易出裁切',
    min: 0.7,
    max: 1.4,
    step: 0.01,
    digits: 2,
    unit: 'x',
  },
  {
    key: 'tilt',
    label: '倾斜与手抖',
    hint: '画面整体的 1–4° 倾斜与 ±1px 手持抖动；0 是完全水平的静态版',
    min: 0,
    max: 1.5,
    step: 0.01,
    digits: 2,
  },
  {
    key: 'transitions',
    label: '图形转场',
    hint: '点→线→圆、白条擦入、大卡横扫、方块转画框、撕裂错位的出现频率与时长；0 时全部退回硬切',
    min: 0,
    max: 1.5,
    step: 0.01,
    digits: 2,
  },
  {
    key: 'glitch',
    label: '故障强度',
    hint: '撕裂错位的位移量与持续时间；关掉就只剩干净的印刷错版',
    min: 0,
    max: 1.5,
    step: 0.01,
    digits: 2,
  },
  {
    key: 'grain',
    label: '纸纹与扫描线',
    hint: '覆盖全屏的颗粒、细扫描线与缓慢下移的亮带，给画面一点印刷/显像管质感',
    min: 0,
    max: 1.5,
    step: 0.01,
    digits: 2,
  },
  {
    key: 'dpr',
    label: '清晰度',
    hint: '渲染分辨率倍率；字缘锯齿明显就调高，机器吃力就调低',
    min: 1,
    max: 2.5,
    step: 0.05,
    digits: 2,
    unit: 'x',
  },
];

/** 预览没有真实曲目时用的示例歌词，约 26s 一循环；12 句正好能把五幕都走一遍。 */
function demoPreviewSong(): PvSong {
  const introMs = 1200;
  const totalMs = 26000;
  const texts = [
    'あ な た は',
    '錯 覚 を 理 解 し て い る',
    '視 界 が',
    '小 さ く な る',
    '当 た り 前 に',
    '過 ぎ て く',
    'ど こ に も も う',
    '夜 な ん で し ょ う',
    'ど う し た い の',
    '教 え て く れ な い の',
    '遠 く へ',
    'あ な た の',
  ];
  const step = (totalMs - introMs) / texts.length;
  const lines = texts.map((text, index) => {
    const timeMs = Math.round(introMs + index * step);
    const tokens = text.split(/\s+/).filter((token) => token.length > 0);
    const span = (step - 500) / Math.max(1, tokens.length);
    return {
      timeMs,
      durationMs: Math.round(step - 500),
      text,
      translation: index % 4 === 1 ? '示例译文：这一句排进了版面' : '',
      words: tokens.map((token, wordIndex) => ({
        text: token,
        startMs: Math.round(timeMs + wordIndex * span),
        endMs: Math.round(timeMs + (wordIndex + 1) * span),
        spaceBefore: wordIndex > 0,
      })),
    };
  });
  return {
    trackKey: 'zilux-pv-preview',
    title: '字与版',
    artist: 'Zilux2 Preview',
    album: '',
    durationMs: totalMs,
    lyricOffsetMs: 0,
    lines,
  };
}

let openSheet: HTMLElement | null = null;

export function openPvSettingsSheet(): void {
  if (openSheet) {
    document.body.append(openSheet);
    return;
  }

  const baseline: PvStyleSettings = normalizePvSettings(pvStyleSettings());
  let draft: PvStyleSettings = { ...baseline };

  const rowsHost = h('div', { class: 'ts-groups' });
  const previewStage = h('div', { class: 'ts-preview-stage', style: 'position:relative' });
  const previewInner = h('div', { style: 'position:absolute;inset:0;overflow:hidden' });
  previewStage.append(previewInner);
  const previewHint = h('div', {
    class: 'ts-preview-hint',
    text: '这一格是独立的 PV 预览，自己按 1x 时钟循环播放：改任何一项都会立刻在这里重绘。',
  });
  const previewNote = h('div', {
    class: 'ts-preview-note',
    text: 'PV 是定格动画：入场与弹跳按 12 格/秒量化，换句是整页横向推走，不做淡入淡出。',
  });

  const previewSong = lyricPreviewSong() ?? demoPreviewSong();

  let scene: PvScene | null = null;
  try {
    scene = createPvScene({ style: draft });
    scene.root.style.position = 'absolute';
    scene.root.style.inset = '0';
    previewInner.append(scene.root);
  } catch (error) {
    scene = null;
    console.warn('[pv-settings] preview scene failed', error);
    previewHint.textContent = `预览场景启动失败：${error instanceof Error ? error.message : String(error)}`;
  }

  let raf = 0;
  let startedAt = 0;
  const frame = (): void => {
    if (!scene) return;
    if (!startedAt) startedAt = performance.now();
    const total = Math.max(4000, previewSong.durationMs || 26000);
    const now = (performance.now() - startedAt) % total;
    scene.update(now, true, 0);
    raf = window.requestAnimationFrame(frame);
  };

  const applyDraft = (): void => {
    draft = normalizePvSettings(draft);
    scene?.setStyle(draft);
    applyPvStyleSettings(draft);
  };

  const formatValue = (spec: RangeSpec, value: number): string => {
    const shown = spec.unit === 'x' ? value.toFixed(spec.digits) : value.toFixed(spec.digits);
    return spec.unit ? `${shown}${spec.unit}` : shown;
  };

  const rangeControls = new Map<NumericKey, { input: HTMLInputElement; value: HTMLElement }>();

  const rangeRow = (spec: RangeSpec): HTMLElement => {
    const value = h('span', { class: 'ts-value', text: formatValue(spec, draft[spec.key]) });
    const input = h('input', {
      class: 'ts-range',
      type: 'range',
      min: String(spec.min),
      max: String(spec.max),
      step: String(spec.step),
      value: String(draft[spec.key]),
    }) as HTMLInputElement;
    input.addEventListener('input', () => {
      const parsed = Number(input.value);
      if (!Number.isFinite(parsed)) return;
      draft[spec.key] = parsed;
      value.textContent = formatValue(spec, parsed);
      applyDraft();
    });
    input.addEventListener('pointerdown', (event) => event.stopPropagation());
    rangeControls.set(spec.key, { input, value });
    return h(
      'div',
      { class: 'ts-row' },
      h('div', { class: 'ts-row-head' }, h('span', { class: 'ts-label', text: spec.label }), value),
      input,
      h('div', { class: 'ts-hint', text: spec.hint }),
    );
  };

  const segmentedRow = (
    label: string,
    hint: string,
    options: Array<{ id: string; label: string; hint?: string }>,
    current: string,
    onPick: (id: string) => void,
  ): HTMLElement => {
    const buttons: HTMLButtonElement[] = options.map((option) => {
      const btn = h('button', {
        class: `ts-seg-btn${option.id === current ? ' is-on' : ''}`,
        type: 'button',
        text: option.label,
        title: option.hint ?? '',
      }) as HTMLButtonElement;
      btn.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      btn.addEventListener('click', () => {
        buttons.forEach((item) => item.classList.toggle('is-on', item === btn));
        onPick(option.id);
        applyDraft();
      });
      return btn;
    });
    return h(
      'div',
      { class: 'ts-row' },
      h('div', { class: 'ts-row-head' }, h('span', { class: 'ts-label', text: label })),
      h('div', { class: 'ts-seg' }, ...buttons),
      h('div', { class: 'ts-hint', text: hint }),
    );
  };

  const group = (title: string, ...rows: HTMLElement[]): HTMLElement =>
    h('div', { class: 'ts-group' }, h('div', { class: 'ts-group-title', text: title }), ...rows);

  const paletteRow = (): HTMLElement =>
    segmentedRow(
      '配色',
      '「跟歌走」会按整首歌的进度从墨蓝走到朱红、灰绿，最后收黑；其余四档把整首钉在某一幕上',
      PV_PALETTE_LABELS.map((item) => ({ id: item.id, label: item.label, hint: item.hint })),
      draft.palette,
      (id) => {
        draft.palette = normalizePvSettings({ ...draft, palette: id as PvStyleSettings['palette'] }).palette;
      },
    );

  const translationRow = (): HTMLElement =>
    segmentedRow(
      '显示译文',
      '版面左下角的小字译文（只有该句带翻译时才有）',
      [
        { id: 'on', label: '开' },
        { id: 'off', label: '关' },
      ],
      draft.showTranslation ? 'on' : 'off',
      (id) => {
        draft.showTranslation = id === 'on';
      },
    );

  const chromeRow = (): HTMLElement =>
    segmentedRow(
      '页眉页脚',
      '角落里的 PV 标记、曲名、时间码与「第几句 / 共几句」，像印刷物的页码栏',
      [
        { id: 'on', label: '开' },
        { id: 'off', label: '关' },
      ],
      draft.showChrome ? 'on' : 'off',
      (id) => {
        draft.showChrome = id === 'on';
      },
    );

  const renderRows = (): void => {
    rowsHost.textContent = '';
    rangeControls.clear();
    rowsHost.append(
      group('版式', paletteRow(), translationRow(), chromeRow()),
      group('动效与肌理', ...RANGES.map(rangeRow)),
    );
  };

  const close = (restore: boolean): void => {
    if (restore) applyPvStyleSettings(baseline);
    if (raf) window.cancelAnimationFrame(raf);
    raf = 0;
    scene?.dispose();
    scene = null;
    root.remove();
    openSheet = null;
  };

  const resetBtn = h('button', { class: 'ts-btn is-quiet', type: 'button', text: '恢复默认' });
  resetBtn.addEventListener('click', () => {
    draft = { ...DEFAULT_PV_SETTINGS };
    renderRows();
    applyDraft();
  });
  const cancelBtn = h('button', { class: 'ts-btn', type: 'button', text: '取消' });
  cancelBtn.addEventListener('click', () => close(true));
  const saveBtn = h('button', { class: 'ts-btn is-primary', type: 'button', text: '保存' });
  saveBtn.addEventListener('click', () => {
    const saved = savePvStyleSettings({ ...draft });
    applyPvStyleSettings(saved);
    toast('PV 设置已保存');
    close(false);
  });

  const root = h('div', { class: 'sheet text-sheet vinyl-sheet' });
  const panel = h('div', { class: 'ts-panel' });
  const previewText = previewSong.title ? `PV · ${previewSong.title}` : 'PV · 示例歌词';
  const head = h(
    'div',
    { class: 'sheet-head lp-head ts-head' },
    h(
      'div',
      { class: 'lp-head-text' },
      h('div', { class: 'sheet-title', text: 'PV 设置' }),
      h('div', { class: 'lp-head-song', text: previewText }),
    ),
    h('button', { class: 'icon-btn', title: '关闭' }, icon('close', 16)),
  );
  head.lastElementChild?.addEventListener('click', () => close(true));
  const previewCol = h('div', { class: 'ts-preview-col' }, h('div', { class: 'ts-preview-label', text: '实时预览' }), previewStage, previewHint, previewNote);
  const body = h('div', { class: 'ts-body' }, previewCol, h('div', { class: 'ts-left' }, rowsHost));
  const foot = h(
    'div',
    { class: 'ts-foot' },
    h('div', { class: 'ts-foot-status', text: '设置存在本机，换歌后继续生效' }),
    h('div', { class: 'ts-foot-actions' }, resetBtn, cancelBtn, saveBtn),
  );
  panel.append(head, body, foot);
  root.append(panel);
  root.addEventListener('pointerdown', (event) => {
    if (event.target === root) close(true);
  });

  renderRows();
  document.body.append(root);
  openSheet = root;

  if (scene) {
    scene.resize();
    scene.setSong(previewSong);
    applyDraft();
    raf = window.requestAnimationFrame(frame);
  }
}
