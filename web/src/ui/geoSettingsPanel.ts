/**
 * 歌词「几何设置」面板：从快捷设置 → 歌词 → 几何设置（几何档）点开。
 *
 * 界面和「房间设置」「唱片设置」一致：底部居中的大弹窗，左边是独立的实时预览画面
 * （单独一个几何场景，自己按 1x 时钟循环播放，不依赖歌词页是否打开），右边是可调项列表。
 * 拖动即预览：改动同时推给歌词页几何舞台和预览舞台；点「保存」才写入本机，取消/关闭会还原。
 */
import { h, icon, toast } from './dom';
import { lyricPreviewSong } from './lyrics';
import { playerState } from './player';
import { applyGeoStyleSettings, currentGeoLyricTint } from './geo';
import { createGeoScene, type GeoScene, type GeoSong } from './geoScene';
import {
  DEFAULT_GEO_SETTINGS,
  GEO_LAYOUTS,
  GEO_LAYOUT_LABELS,
  GEO_PALETTE_PRESETS,
  applyGeoPalette,
  geoPaletteMatches,
  geoStyleSettings,
  normalizeGeoSettings,
  saveGeoStyleSettings,
  type GeoLayoutId,
  type GeoStyleSettings,
} from './geoSettings';

/** 滑杆可写的数字字段（字重 / 构图表用分段控件，不在滑杆里）。 */
type NumericKey = Exclude<
  {
    [K in keyof GeoStyleSettings]: GeoStyleSettings[K] extends number ? K : never;
  }[keyof GeoStyleSettings],
  'fontWeight'
>;
type BooleanKey = {
  [K in keyof GeoStyleSettings]: GeoStyleSettings[K] extends boolean ? K : never;
}[keyof GeoStyleSettings];
type ColorKey = 'bgTop' | 'bgBottom' | 'ink' | 'sungInk' | 'accent' | 'secondary';

interface RangeSpec {
  key: NumericKey;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  /** 显示的小数位。 */
  digits: number;
  /** 显示倍数（0~1 的比例按 % 显示时传 100）。 */
  scale?: number;
  /** 数值后缀（%, °, ms, em, px…）。 */
  unit?: string;
}

interface ColorSpec {
  key: ColorKey;
  label: string;
  hint: string;
}

interface ToggleSpec {
  key: BooleanKey;
  label: string;
  hint: string;
}

const FONT_OPTIONS = [
  { id: 'display', label: '系统重字' },
  { id: 'mono', label: '等宽' },
  { id: 'serif', label: '衬线' },
  { id: 'yahei', label: '雅黑' },
];

const WEIGHT_OPTIONS = [
  { id: '700', label: '粗' },
  { id: '900', label: '超粗' },
];

const LAYOUT_OPTIONS = [
  { id: 'auto', label: '自动轮换' },
  ...GEO_LAYOUTS.map((id) => ({ id, label: GEO_LAYOUT_LABELS[id] })),
];

/* ── 可调项 ───────────────────────────────────────────────────── */

const TEXT_RANGES: RangeSpec[] = [
  {
    key: 'sizeScale',
    label: '字号',
    hint: '歌词大字整体缩放；几何档的字本来就大，一般不需要再放大',
    min: 0.5,
    max: 2,
    step: 0.01,
    digits: 2,
    unit: '×',
  },
  {
    key: 'letterSpacing',
    label: '字距',
    hint: '字与字之间额外加的空隙（负数会挤紧，像更西式的排版）',
    min: -0.08,
    max: 0.3,
    step: 0.005,
    digits: 3,
    unit: 'em',
  },
];

const LAYOUT_RANGES: RangeSpec[] = [
{
    key: 'revealMs',
    label: '逐字点亮',
    hint: '一个字从压淡的底稿弹成强调色要多久（毫秒）；0 = 到点直接亮',
    min: 0,
    max: 600,
    step: 10,
    digits: 0,
    unit: 'ms',
  },
{
    key: 'energy',
    label: '随音乐抖',
    hint: '低频重的时候整版左右抖的程度；0 = 完全静止',
    min: 0,
    max: 2,
    step: 0.05,
    digits: 2,
    unit: '×',
  },
];

const TEXTURE_RANGES: RangeSpec[] = [
  {
    key: 'halftone',
    label: '网点强度',
    hint: '半调网点铺在背景与巨字后面的浓淡；0 = 没有网点',
    min: 0,
    max: 1,
    step: 0.01,
    digits: 2,
    scale: 100,
    unit: '%',
  },
{
    key: 'grain',
    label: '颗粒',
    hint: '纸面/复印颗粒的强度；0 = 干净的数字画面',
    min: 0,
    max: 0.4,
    step: 0.005,
    digits: 3,
    scale: 100,
    unit: '%',
  },
  {
    key: 'grid',
    label: '网格',
    hint: '细网格与中央十字线的浓度；0 = 只有底色',
    min: 0,
    max: 1,
    step: 0.01,
    digits: 2,
    scale: 100,
    unit: '%',
  },
  {
    key: 'dpr',
    label: '渲染精度',
    hint: '画布的像素比上限；文字边缘更锐利，但更吃显卡',
    min: 1,
    max: 2,
    step: 0.05,
    digits: 2,
    unit: '×',
  },
];

const COLOR_ROWS: ColorSpec[] = [
  { key: 'bgTop', label: '底色 · 起', hint: '底色渐变靠上/靠前那一端的颜色' },
  { key: 'bgBottom', label: '底色 · 止', hint: '底色渐变另一端' },
  { key: 'ink', label: '油墨', hint: '没唱到的字、线框、标记的颜色' },
  { key: 'sungInk', label: '已唱', hint: '唱过的字落的颜色；默认与油墨同色' },
  { key: 'accent', label: '强调色', hint: '正在唱的字、被填充的色块、进度条' },
  { key: 'secondary', label: '副色', hint: '分割构图里的另一半颜色、画框里的内填充色' },
];

const FOLLOW_LYRICS: ToggleSpec = {
  key: 'followLyrics',
  label: '跟随歌词颜色',
  hint: '强调色与两路错版色跟着快捷设置里的「歌词颜色」走（封面色 / 自动渐变）；纯色档仍用下面这组印刷配色',
};

const TRANSLATION_TOGGLE: ToggleSpec = {
  key: 'showTranslation',
  label: '显示翻译',
  hint: '当前句右下角显示这一句的翻译（等宽小字，压在版面上）',
};

const MARKS_TOGGLE: ToggleSpec = {
  key: 'marks',
  label: '裁切标记',
  hint: '四角的「⌐」形裁切标记，印刷/装订的语言',
};

const META_TOGGLE: ToggleSpec = {
  key: 'meta',
  label: '版面标记',
  hint: '左上版面编号与曲名、右上时间码与句序、底部进度条',
};

/** 预览没有真实曲目时，给一组中英混合的示例句，约 26s 一循环。 */
function demoPreviewSong(): GeoSong {
  const introMs = 2600;
  const totalMs = 26000;
  // 刻意让句长有长有短：巨字裁切/镜像要短句，横条与跑马灯长句更好看。
  const texts = [
    '把 夜 切 成 两 半',
    '一半给我 一半给风',
    'Every word is printed twice',
    '地 铁 窗 外 的 灯 一直 在 退 后',
    '我 把 心 事 排 成 版',
    'then the ink dries on the page',
  ];
  const step = (totalMs - introMs) / texts.length;
  const lines = texts.map((text, index) => {
    const timeMs = Math.round(introMs + index * step);
    const tokens = text.split(/\s+/).filter((token) => token.length > 0);
    const span = (step - 700) / Math.max(1, tokens.length);
    return {
      timeMs,
      durationMs: Math.round(step - 700),
      text,
      translation: index % 3 === 1 ? '示例译文：这一句排进了格子里' : '',
      words: tokens.map((token, wordIndex) => ({
        text: token,
        startMs: Math.round(timeMs + wordIndex * span),
        endMs: Math.round(timeMs + (wordIndex + 1) * span),
        spaceBefore: wordIndex > 0,
      })),
    };
  });
  return {
    trackKey: 'zilux-geo-preview',
    title: '铅字与夜',
    artist: 'Zilux2 Preview',
    album: '',
    durationMs: totalMs,
    lyricOffsetMs: 0,
    lines,
  };
}

/** 面板单例：同一时间只开一个。 */
let openSheet: HTMLElement | null = null;

export function openGeoSettingsSheet(): void {
  if (openSheet) {
    // 已打开时只前置（挪到 body 末尾），不重复创建。
    document.body.append(openSheet);
    return;
  }

  let draft: GeoStyleSettings = normalizeGeoSettings(geoStyleSettings());

  const rowsHost = h('div', { class: 'ts-groups' });
  const previewLabel = h('div', { class: 'ts-preview-label', text: '实时预览' });
  const previewStage = h('div', { class: 'ts-preview-stage', style: 'position:relative' });
  const previewInner = h('div', { style: 'position:absolute;inset:0;overflow:hidden' });
  const previewHint = h('div', {
    class: 'ts-preview-hint',
    text: '这一格是独立的几何预览，自己按 1x 时钟循环播放：改任何一项都会立刻在这里重绘。',
  });
  const previewNote = h('div', {
    class: 'ts-preview-note',
    text: '构图按「自动轮换」时，每句换一种排版（横条压字 / 竖排 / 巨字裁切 / 镜像 / 网格 / 跑马灯 / 画框 / 拼章）；同一首歌每次进来顺序一致。',
  });
  previewStage.append(previewInner);

  const previewSong = lyricPreviewSong() ?? demoPreviewSong();

  /* ── 预览场景（独立几何舞台） ─────────────────────────────── */

  let scene: GeoScene | null = null;
  try {
    scene = createGeoScene({ style: draft });
    scene.setLyricTint(currentGeoLyricTint());
    scene.root.style.position = 'absolute';
    scene.root.style.inset = '0';
    previewInner.append(scene.root);
  } catch (err) {
    scene = null;
    console.warn('[geo-settings] preview scene failed', err);
    previewHint.textContent = `预览场景启动失败：${err instanceof Error ? err.message : String(err)}`;
  }

  /* ── 自驱时钟：从播放器基准位置开始按 1x 前进，到歌尾取模循环 ── */

  const loopMs = previewSong.durationMs > 1000 ? previewSong.durationMs : 24000;
  const playerMs = playerState().positionMs;
  const baseMs = Number.isFinite(playerMs) && playerMs > 0 ? playerMs : 0;
  const clockStart = performance.now();
  let raf = 0;

  const frame = (): void => {
    if (!scene) return;
    const elapsed = performance.now() - clockStart;
    const t = elapsed / 1000;
    const positionMs = (((baseMs + elapsed) % loopMs) + loopMs) % loopMs;
    // 假一个跟着拍子的低频，预览里能看到「随音乐抖」与网点脉动。
    const beat = Math.max(0, Math.sin(t * Math.PI * 1.15));
    scene.update(positionMs, true, 0.34 + beat * beat * 0.5);
    raf = window.requestAnimationFrame(frame);
  };

  const onResize = (): void => {
    scene?.resize();
  };
  window.addEventListener('resize', onResize);

  const close = (revert: boolean): void => {
    window.removeEventListener('resize', onResize);
    if (raf) {
      window.cancelAnimationFrame(raf);
      raf = 0;
    }
    if (revert) {
      const persisted = geoStyleSettings();
      scene?.setStyle(persisted);
      applyGeoStyleSettings(persisted);
    }
    scene?.dispose();
    scene = null;
    previewInner.textContent = '';
    openSheet = null;
    root.classList.add('is-leaving');
    window.setTimeout(() => root.remove(), 180);
  };

  /* ── 实时应用 draft ───────────────────────────────────────── */

  const applyDraft = (): void => {
    const snapshot = normalizeGeoSettings(draft);
    scene?.setStyle(snapshot);
    applyGeoStyleSettings(snapshot);
  };

  /* ── 行构造器（照文字设置 / 房间设置 / 唱片设置面板） ─────── */

  const presetButtons: HTMLButtonElement[] = [];
  const markPreset = (id: string | null): void => {
    for (const btn of presetButtons) btn.classList.toggle('is-on', btn.dataset.preset === id);
  };

  const formatValue = (spec: RangeSpec, value: number): string => {
    const scaled = value * (spec.scale ?? 1);
    return `${scaled.toFixed(spec.digits)}${spec.unit ?? ''}`;
  };

  /** 滑杆控件注册表在整表重建时清空，避免高亮/同步指向已经被移除的节点。 */
  const rangeControls = new Map<NumericKey, { spec: RangeSpec; input: HTMLInputElement; value: HTMLElement }>();
  void rangeControls;

  const presetRow = (): HTMLElement => {
    const buttons: HTMLButtonElement[] = GEO_PALETTE_PRESETS.map((preset) => {
      const btn = h('button', {
        class: 'ts-seg-btn',
        type: 'button',
        text: preset.label,
        title: preset.hint,
      });
      btn.dataset.preset = preset.id;
      btn.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      btn.addEventListener('click', () => {
        draft = applyGeoPalette(draft, preset);
        renderRows();
        applyDraft();
        markPreset(preset.id);
      });
      return btn;
    });
    presetButtons.length = 0;
    presetButtons.push(...buttons);
    // 高亮当前配色（和预设完全一致才亮）
    const matched = GEO_PALETTE_PRESETS.find((preset) => geoPaletteMatches(draft, preset));
    markPreset(matched ? matched.id : draft.palette);
    return h(
      'div',
      { class: 'ts-row' },
      h('div', { class: 'ts-row-head' }, h('span', { class: 'ts-label', text: '配色预设' })),
      h('div', { class: 'ts-seg' }, ...buttons),
      h('div', { class: 'ts-hint', text: '整组换掉底色、油墨、强调色与两路错版色；字形、构图与肌理保持当前值，仍可继续微调。' }),
    );
  };

  const rangeRow = (spec: RangeSpec): HTMLElement => {
    const value = h('span', { class: 'ts-value', text: formatValue(spec, draft[spec.key]) });
    const input = h('input', {
      class: 'ts-range',
      type: 'range',
      min: String(spec.min),
      max: String(spec.max),
      step: String(spec.step),
      value: String(draft[spec.key]),
    });
    input.addEventListener('input', () => {
      const parsed = Number(input.value);
      if (!Number.isFinite(parsed)) return;
      draft[spec.key] = parsed;
      value.textContent = formatValue(spec, parsed);
      markPreset(null);
      applyDraft();
    });
    input.addEventListener('pointerdown', (event) => event.stopPropagation());
    rangeControls.set(spec.key, { spec, input, value });
    return h(
      'div',
      { class: 'ts-row' },
      h('div', { class: 'ts-row-head' }, h('span', { class: 'ts-label', text: spec.label }), value),
      input,
      h('div', { class: 'ts-hint', text: spec.hint }),
    );
  };

  const colorRow = (spec: ColorSpec): HTMLElement => {
    const value = h('span', { class: 'ts-color-value', text: draft[spec.key].toUpperCase() });
    const input = h('input', { type: 'color', value: draft[spec.key] });
    input.addEventListener('input', () => {
      const hex = input.value.toLowerCase();
      draft[spec.key] = hex;
      value.textContent = hex.toUpperCase();
      markPreset(null);
      applyDraft();
    });
    input.addEventListener('pointerdown', (event) => event.stopPropagation());
    return h(
      'div',
      { class: 'ts-row' },
      h(
        'div',
        { class: 'ts-row-head' },
        h('span', { class: 'ts-label', text: spec.label }),
        h('label', { class: 'ts-color' }, input, value),
      ),
      h('div', { class: 'ts-hint', text: spec.hint }),
    );
  };

  const segmentedRow = (
    label: string,
    hint: string,
    options: Array<{ id: string; label: string }>,
    current: string,
    onPick: (id: string) => void,
  ): HTMLElement => {
    const buttons: HTMLButtonElement[] = options.map((option) => {
      const btn = h('button', {
        class: `ts-seg-btn${option.id === current ? ' is-on' : ''}`,
        type: 'button',
        text: option.label,
      });
      btn.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      btn.addEventListener('click', () => {
        buttons.forEach((item) => item.classList.toggle('is-on', item === btn));
        onPick(option.id);
        markPreset(null);
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

  const toggleRow = (spec: ToggleSpec): HTMLElement =>
    segmentedRow(
      spec.label,
      spec.hint,
      [
        { id: 'on', label: '开' },
        { id: 'off', label: '关' },
      ],
      draft[spec.key] ? 'on' : 'off',
      (id) => {
        draft[spec.key] = id === 'on';
      },
    );

  const fontRow = (): HTMLElement =>
    segmentedRow('字体', '歌词大字用的字族；系统重字最像 PV，等宽更像印刷编号', FONT_OPTIONS, draft.fontFamily, (id) => {
      draft.fontFamily = id === 'mono' ? 'mono' : id === 'serif' ? 'serif' : id === 'yahei' ? 'yahei' : 'display';
    });

  const weightRow = (): HTMLElement =>
    segmentedRow('字重', '字形的粗细；超粗是这套版式的默认观感', WEIGHT_OPTIONS, String(draft.fontWeight), (id) => {
      draft.fontWeight = id === '700' ? 700 : 900;
    });

  const layoutRow = (): HTMLElement =>
    segmentedRow(
      '构图',
      '固定用某一种排版，或自动轮换全部八种；自动轮换时第一句一定是「巨字裁切」开场',
      LAYOUT_OPTIONS,
      draft.layout,
      (id) => {
        draft.layout = (LAYOUT_OPTIONS.some((option) => option.id === id) ? id : 'auto') as GeoLayoutId;
      },
    );

  const group = (title: string, ...rows: HTMLElement[]): HTMLElement =>
    h('div', { class: 'ts-group' }, h('div', { class: 'ts-group-title', text: title }), ...rows);

  const tintNote = h('div', {
    class: 'ts-hint',
    text: '几何档不按封面给每个字上渐变：它只有一种强调色。勾上「跟随歌词颜色」后，强调色与两路错版色会取「歌词颜色」的封面色板，底色与油墨仍用下面这组印刷配色。',
  });

  const styleNote = h('div', {
    class: 'ts-hint',
    text: '逐字点亮用的是歌词自带的逐字时间（没有逐字数据的 LRC 会按整句均分），所以「唱到哪个字亮哪个字」跟演唱走，不是固定延时。',
  });

  const renderRows = (): void => {
    rowsHost.textContent = '';
    // 整表重建前先清掉旧控件的引用，避免高亮/同步指向已经被移除的节点。
    rangeControls.clear();
    rowsHost.append(
      group('预设', presetRow()),
      group('字形', tintNote, styleNote, fontRow(), weightRow(), ...TEXT_RANGES.map(rangeRow), toggleRow(TRANSLATION_TOGGLE)),
      group('构图与动效', layoutRow(), ...LAYOUT_RANGES.map(rangeRow)),
      group('配色', toggleRow(FOLLOW_LYRICS), ...COLOR_ROWS.map(colorRow)),
      group('肌理与标记', toggleRow(MARKS_TOGGLE), toggleRow(META_TOGGLE), ...TEXTURE_RANGES.map(rangeRow)),
    );
  };

  /* ── 底部按钮 ─────────────────────────────────────────────── */

  const resetBtn = h('button', { class: 'ts-btn is-quiet', type: 'button', text: '恢复默认' });
  resetBtn.addEventListener('click', () => {
    Object.assign(draft, DEFAULT_GEO_SETTINGS);
    renderRows();
    applyDraft();
  });
  const cancelBtn = h('button', { class: 'ts-btn', type: 'button', text: '取消' });
  cancelBtn.addEventListener('click', () => close(true));
  const saveBtn = h('button', { class: 'ts-btn is-primary', type: 'button', text: '保存' });
  saveBtn.addEventListener('click', () => {
    const saved = saveGeoStyleSettings({ ...draft });
    applyGeoStyleSettings(saved);
    toast('几何设置已保存');
    close(false);
  });

  /* ── 面板结构 ─────────────────────────────────────────────── */

  const root = h('div', { class: 'sheet text-sheet vinyl-sheet' });
  const panel = h('div', { class: 'ts-panel' });
  const previewText = previewSong.title ? `几何 · ${previewSong.title}` : '几何 · 示例歌词';
  const head = h(
    'div',
    { class: 'sheet-head lp-head ts-head' },
    h(
      'div',
      { class: 'lp-head-text' },
      h('div', { class: 'sheet-title', text: '几何设置' }),
      h('div', { class: 'lp-head-song', text: previewText }),
    ),
    h('button', { class: 'icon-btn', title: '关闭' }, icon('close', 16)),
  );
  head.lastElementChild?.addEventListener('click', () => close(true));
  const left = h('div', { class: 'ts-left' }, rowsHost);
  // 布局：左边大预览画面（占大部分），右边参数列表只占一部分宽度。
  const previewCol = h('div', { class: 'ts-preview-col' }, previewLabel, previewStage, previewHint, previewNote);
  const body = h('div', { class: 'ts-body' }, previewCol, left);
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

  // 挂进文档后再量尺寸/铺歌词，然后开始跑预览时钟。
  if (scene) {
    scene.resize();
    scene.setSong(previewSong);
    applyDraft();
    raf = window.requestAnimationFrame(frame);
  }
}
