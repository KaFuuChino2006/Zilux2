/**
 * 歌词「唱片设置」面板：从快捷设置 → 歌词 → 唱片设置（唱片档）点开。
 *
 * 界面和「房间设置」一致：底部居中的大弹窗，左边是独立的实时预览画面
 * （单独一个唱片舞台，自己按 1x 时钟循环播放，不依赖歌词页是否打开），右边是可调项列表。
 * 拖动即预览：改动同时推给歌词页唱片舞台和预览舞台；点「保存」才写入本机，取消/关闭会还原。
 */
import { h, icon, toast } from './dom';
import { lyricPreviewSong } from './lyrics';
import { playerState } from './player';
import { applyVinylStyleSettings, currentVinylLyricTint } from './vinyl';
import { createVinylScene, type VinylScene, type VinylSceneSong } from './vinylScene';
import {
  DEFAULT_VINYL_SETTINGS,
  VINYL_STYLE_PRESETS,
  applyVinylPreset,
  normalizeVinylSettings,
  saveVinylStyleSettings,
  vinylStyleSettings,
  type VinylStyleSettings,
} from './vinylSettings';

// 快捷预设 chips 复用房间设置面板的样式（.room-preset-*，由 roomSettingsPanel.ts 引入 app.css 之外的那份样式）。
// 面板主体样式在 app.css 的 .ts-* 里，这里不重复引用。

/** 滑杆可写的数字字段（字重 / 前后句数用分段控件，不在滑杆里）。 */
type NumericKey = Exclude<
  {
    [K in keyof VinylStyleSettings]: VinylStyleSettings[K] extends number ? K : never;
  }[keyof VinylStyleSettings],
  'fontWeight' | 'neighborLines'
>;
type BooleanKey = {
  [K in keyof VinylStyleSettings]: VinylStyleSettings[K] extends boolean ? K : never;
}[keyof VinylStyleSettings];
type ColorKey =
  | 'color'
  | 'sungColor'
  | 'activeColor'
  | 'glowColor'
  | 'discColor'
  | 'labelColor'
  | 'accentColor'
  | 'bgTop'
  | 'bgBottom';

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
  /** 数值后缀（%, °, ms, em, x…）。 */
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
  { id: 'yahei', label: '微软雅黑' },
  { id: 'serif', label: '衬线' },
  { id: 'system', label: '自带字体' },
];

const WEIGHT_OPTIONS = [
  { id: '900', label: '超粗' },
  { id: '700', label: '粗' },
  { id: '400', label: '常规' },
];

const NEIGHBOR_OPTIONS = [
  { id: '0', label: '只看当前' },
  { id: '1', label: '前后各 1' },
  { id: '2', label: '前后各 2' },
];

const TEXT_RANGES: RangeSpec[] = [
  { key: 'sizeScale', label: '字号缩放', hint: '整首歌词的字号倍数，1 = 当前大小', min: 0.6, max: 1.8, step: 0.02, digits: 2, unit: 'x' },
  { key: 'letterSpacing', label: '字距', hint: '一个词里每个字之间的间距（em），负值更紧凑', min: -0.05, max: 0.2, step: 0.001, digits: 3, unit: 'em' },
  { key: 'glow', label: '辉光强度', hint: '正在唱的那句字外围的暖色光晕，0 = 不发光', min: 0, max: 2, step: 0.05, digits: 2, unit: 'x' },
  { key: 'unsungOpacity', label: '未唱亮度', hint: '还没唱到的词有多亮；调低更聚焦当前句', min: 0, max: 1, step: 0.01, digits: 0, scale: 100, unit: '%' },
  { key: 'sungOpacity', label: '唱过亮度', hint: '已经唱过的词保留的亮度', min: 0, max: 1, step: 0.01, digits: 0, scale: 100, unit: '%' },
  { key: 'activeOpacity', label: '正在唱亮度', hint: '正在唱的词的亮度，1 = 完全不透明', min: 0, max: 1, step: 0.01, digits: 0, scale: 100, unit: '%' },
];

const TEXT_COLORS: ColorSpec[] = [
  { key: 'color', label: '未唱颜色', hint: '还没唱到的词的底色' },
  { key: 'sungColor', label: '唱过颜色', hint: '已经唱过的词保留的颜色' },
  { key: 'activeColor', label: '正在唱颜色', hint: '正在唱的那句 / 那个词的颜色' },
  { key: 'glowColor', label: '辉光颜色', hint: '正在唱那句的暖色光晕颜色' },
];

const LAYOUT_RANGES: RangeSpec[] = [
  { key: 'lyricY', label: '歌词纵向位置', hint: '当前句在画面里的高度位置（占画面高）', min: 0.52, max: 0.86, step: 0.005, digits: 1, scale: 100, unit: '%' },
  { key: 'lyricWidth', label: '歌词最大宽度', hint: '一句歌词最多占画面宽的多少；太窄会多折行', min: 0.5, max: 1, step: 0.005, digits: 1, scale: 100, unit: '%' },
];

const DISC_RANGES: RangeSpec[] = [
  { key: 'discSize', label: '唱片大小', hint: '唱片半径占画面短边的比例，越大越有压迫感', min: 0.12, max: 0.46, step: 0.005, digits: 1, scale: 100, unit: '%' },
  { key: 'discX', label: '水平位置', hint: '唱片圆心的横向位置（占画面宽）', min: 0.3, max: 0.7, step: 0.005, digits: 1, scale: 100, unit: '%' },
  { key: 'discY', label: '垂直位置', hint: '唱片圆心的纵向位置（占画面高），往下压歌词空间更大', min: 0.22, max: 0.55, step: 0.005, digits: 1, scale: 100, unit: '%' },
  { key: 'labelSize', label: '贴纸大小', hint: '中心圆贴纸的半径 / 唱片半径', min: 0.24, max: 0.48, step: 0.005, digits: 0, scale: 100, unit: '%' },
  { key: 'grooveStrength', label: '纹路强度', hint: '黑胶盘面一圈圈纹路的明显程度，0 = 光滑盘面', min: 0, max: 1, step: 0.01, digits: 0, scale: 100, unit: '%' },
  { key: 'sheen', label: '盘面反光', hint: '斜打在盘面上的高光与轻扫光，让黑胶更有材质感', min: 0, max: 1, step: 0.01, digits: 0, scale: 100, unit: '%' },
];

const DISC_COLORS: ColorSpec[] = [
  { key: 'discColor', label: '盘面颜色', hint: '黑胶盘面的主色' },
  { key: 'labelColor', label: '贴纸颜色', hint: '中心圆贴纸的底色' },
  { key: 'accentColor', label: '金属强调色', hint: '黄铜唱臂、贴纸描边、进度条的颜色' },
];

const BG_COLORS: ColorSpec[] = [
  { key: 'bgTop', label: '顶部颜色', hint: '聆听室背景渐变上端的颜色' },
  { key: 'bgBottom', label: '底部颜色', hint: '聆听室背景渐变下端的颜色' },
];

const BG_RANGES: RangeSpec[] = [
  { key: 'spotGlow', label: '顶光强度', hint: '从画面上方打下来的暖色光束，0 = 完全不开', min: 0, max: 1, step: 0.01, digits: 0, scale: 100, unit: '%' },
  { key: 'vignette', label: '暗角', hint: '画面四角压暗的程度，越大越聚焦唱片', min: 0, max: 1, step: 0.01, digits: 0, scale: 100, unit: '%' },
  { key: 'grain', label: '颗粒噪点', hint: '整幅画面的细颗粒，一点点更像胶片/黑胶封面', min: 0, max: 1, step: 0.005, digits: 1, scale: 100, unit: '%' },
];

const DUST_RANGES: RangeSpec[] = [
  { key: 'dust', label: '尘埃数量', hint: '暖光里漂浮的细微尘埃，0 = 不显示', min: 0, max: 70, step: 1, digits: 0, unit: ' 颗' },
  { key: 'dustSpeed', label: '漂移速度', hint: '尘埃横向漂浮的速度倍数', min: 0.2, max: 3, step: 0.05, digits: 2, unit: 'x' },
];

const ARM_RANGES: RangeSpec[] = [
  { key: 'rpm', label: '转速', hint: '黑胶标准转速 33⅓ RPM；暂停时唱片会按这个速度慢慢停下', min: 20, max: 45, step: 0.01, digits: 2, unit: ' RPM' },
  { key: 'energy', label: '音乐呼吸', hint: '随音乐低频起伏的幅度（唱片半径与暖光轻微颤动），0 = 不跟着动', min: 0, max: 2, step: 0.05, digits: 2, unit: 'x' },
  { key: 'dpr', label: '渲染像素比', hint: '画面精细度，越高越清楚也越吃显卡（1~2）', min: 1, max: 2, step: 0.05, digits: 2, unit: 'x' },
];

const KEYWORD_COLORS: ToggleSpec = {
  key: 'keywordColors',
  label: '重点词染色',
  hint: '自动从整首歌词里挑出反复出现的长词（和纯字 / 房间档同一套规则），用色板里的强调色单独染色；关掉就统一词色',
};

const TRANSLATION_TOGGLE: ToggleSpec = {
  key: 'showTranslation',
  label: '显示翻译',
  hint: '当前句下方显示这一句的翻译',
};

const INTRO_TITLE: ToggleSpec = {
  key: 'introTitle',
  label: '前奏显示歌名',
  hint: '第一句歌词开口前，在唱片前方显示歌曲名和歌手；开口后自动淡出，拖回前奏会重新出现',
};

const LABEL_TEXT: ToggleSpec = {
  key: 'labelText',
  label: '贴纸印歌名',
  hint: '没有封面图时，在唱片中心贴纸上印歌名与歌手；有专辑封面的曲目直接印封面',
};

const INFO_TOGGLE: ToggleSpec = {
  key: 'showInfo',
  label: '底部歌名与进度',
  hint: '画面底部显示歌名、歌手与一条细进度线',
};

const BG_FOLLOW: ToggleSpec = {
  key: 'bgFollowLyrics',
  label: '贴纸跟随歌词颜色',
  hint: '贴纸底色、描边与唱臂金属色跟着快捷设置里的「歌词颜色」（纯色 / 封面色 / 自动渐变）走；关掉就用上面自定义的颜色',
};

const SHOW_ARM: ToggleSpec = {
  key: 'showArm',
  label: '显示唱臂',
  hint: '从右上方伸下来的黄铜唱臂，随播放进度缓缓内移',
};

const ARM_PAUSE: ToggleSpec = {
  key: 'armLiftOnPause',
  label: '暂停时抬起唱臂',
  hint: '暂停时唱臂抬起、唱片渐停；恢复播放后唱针落下继续转',
};

/** 预览没有真实曲目时，画一张同风格的方形示例封面；有歌词页时直接用当前曲目封面。 */
function buildDemoCover(title: string, artist: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const grad = ctx.createLinearGradient(0, 0, 512, 512);
  grad.addColorStop(0, '#3a2a3f');
  grad.addColorStop(0.52, '#7d4b3a');
  grad.addColorStop(1, '#1d1418');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 512);
  const glow = ctx.createRadialGradient(392, 168, 6, 392, 168, 250);
  glow.addColorStop(0, 'rgba(255,236,200,0.92)');
  glow.addColorStop(0.34, 'rgba(255,205,150,0.34)');
  glow.addColorStop(1, 'rgba(255,205,150,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 512, 512);
  // 半圈细纹，既像封面装饰，也让旋转看得出来。
  ctx.strokeStyle = 'rgba(255,236,210,0.12)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 16; i += 1) {
    ctx.beginPath();
    ctx.arc(256, 256, 96 + i * 11, 0.08 * Math.PI, 0.92 * Math.PI);
    ctx.stroke();
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,246,232,0.96)';
  ctx.font = '700 46px "Microsoft YaHei UI", "Noto Sans SC", sans-serif';
  ctx.fillText(title, 256, 318);
  ctx.fillStyle = 'rgba(255,246,232,0.62)';
  ctx.font = '400 22px "Segoe UI", "Microsoft YaHei UI", sans-serif';
  ctx.fillText(artist.toUpperCase(), 256, 356);
  return canvas.toDataURL('image/jpeg', 0.9);
}

/** 拿不到歌词页的歌词时，给预览一组中英混合的示例句，约 24s 一循环。 */
function demoPreviewSong(): VinylSceneSong {
  // 前面留 3.2s 前奏，预览里就能看到「前奏显示歌名」的效果。
  const introMs = 3200;
  const totalMs = 24000;
  // 刻意让「唱片 / 光 / 夜」出现两次以上，预览里能看到重点词染色与放大。
  const texts = [
    '夜 里 的 唱片 还 在 转',
    '暖 光 落 在 黑色 的 纹路 上',
    'Every word spins on the vinyl',
    'The night keeps turning with the light',
    '我们 把 夜 唱 成 了 唱片',
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
      translation: '',
      words: tokens.map((token, wordIndex) => ({
        text: token,
        startMs: Math.round(timeMs + wordIndex * span),
        endMs: Math.round(timeMs + (wordIndex + 1) * span),
        spaceBefore: wordIndex > 0,
      })),
    };
  });
  return {
    trackKey: 'zilux-vinyl-preview',
    title: '午夜唱片',
    artist: 'Zilux2 Preview',
    album: '',
    coverUrl: buildDemoCover('午夜唱片', 'Zilux2 Preview'),
    durationMs: totalMs,
    lyricOffsetMs: 0,
    lines,
  };
}

/** 面板单例：同一时间只开一个。 */
let openSheet: HTMLElement | null = null;

export function openVinylSettingsSheet(): void {
  if (openSheet) {
    // 已打开时只前置（挪到 body 末尾），不重复创建。
    document.body.append(openSheet);
    return;
  }

  let draft: VinylStyleSettings = normalizeVinylSettings(vinylStyleSettings());

  const rowsHost = h('div', { class: 'ts-groups' });
  const previewLabel = h('div', { class: 'ts-preview-label', text: '实时预览' });
  const previewStage = h('div', { class: 'ts-preview-stage', style: 'position:relative' });
  const previewInner = h('div', { style: 'position:absolute;inset:0;overflow:hidden' });
  const previewHint = h('div', {
    class: 'ts-preview-hint',
    text: '这一格是独立的唱片预览，自己按 1x 时钟循环播放：改任何一项都会立刻在这里重绘。',
  });
  const previewNote = h('div', {
    class: 'ts-preview-note',
    text: '预览不受歌词页是否打开影响；「唱片」「布局」改动会立刻重排盘面与歌词位置，保存后歌词页的唱片画面同步生效。',
  });
  previewStage.append(previewInner);

  const previewSong = lyricPreviewSong() ?? demoPreviewSong();

  /* ── 预览场景（独立唱片舞台） ─────────────────────────────── */

  let scene: VinylScene | null = null;
  try {
    scene = createVinylScene({ style: draft });
    scene.setLyricTint(currentVinylLyricTint());
    scene.root.style.position = 'absolute';
    scene.root.style.inset = '0';
    previewInner.append(scene.root);
  } catch (err) {
    scene = null;
    console.warn('[vinyl-settings] preview scene failed', err);
    previewHint.textContent = `预览场景启动失败：${err instanceof Error ? err.message : String(err)}`;
  }

  /* ── 自驱时钟：从播放器基准位置开始按 1x 前进，到歌尾取模循环 ── */

  const loopMs = previewSong.durationMs > 1000 ? previewSong.durationMs : 20000;
  const playerMs = playerState().positionMs;
  const baseMs = Number.isFinite(playerMs) && playerMs > 0 ? playerMs : 0;
  const clockStart = performance.now();
  let raf = 0;

  const frame = (): void => {
    if (!scene) return;
    const elapsed = performance.now() - clockStart;
    const t = elapsed / 1000;
    const positionMs = (((baseMs + elapsed) % loopMs) + loopMs) % loopMs;
    scene.update(positionMs, true, 0.55 + Math.sin(t * 0.7) * 0.2);
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
      const persisted = vinylStyleSettings();
      scene?.setStyle(persisted);
      applyVinylStyleSettings(persisted);
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
    const snapshot = normalizeVinylSettings(draft);
    scene?.setStyle(snapshot);
    applyVinylStyleSettings(snapshot);
  };

  /* ── 行构造器（照文字设置 / 房间设置面板） ─────────────────── */

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
    const buttons: HTMLButtonElement[] = VINYL_STYLE_PRESETS.map((preset) => {
      const btn = h('button', {
        class: 'ts-seg-btn',
        type: 'button',
        text: preset.label,
        title: '整套换掉背景、盘面与金属色（其它参数保持当前值）',
      });
      btn.dataset.preset = preset.id;
      btn.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      btn.addEventListener('click', () => {
        draft = applyVinylPreset(draft, preset);
        renderRows();
        applyDraft();
        markPreset(preset.id);
      });
      return btn;
    });
    presetButtons.length = 0;
    presetButtons.push(...buttons);
    return h(
      'div',
      { class: 'ts-row' },
      h('div', { class: 'ts-row-head' }, h('span', { class: 'ts-label', text: '一键预设' })),
      h('div', { class: 'ts-seg' }, ...buttons),
      h('div', { class: 'ts-hint', text: '整组换掉背景与唱片配色；歌词颜色跟随快捷设置里的「歌词颜色」，其它参数保持当前值，仍可继续微调。' }),
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
    segmentedRow('字体', '歌词大字用的字族；系统重字最粗，衬线更有印刷感', FONT_OPTIONS, draft.fontFamily, (id) => {
      draft.fontFamily = id === 'yahei' ? 'yahei' : id === 'serif' ? 'serif' : id === 'system' ? 'system' : 'display';
    });

  const weightRow = (): HTMLElement =>
    segmentedRow('字重', '字形的粗细；超粗最接近当前观感', WEIGHT_OPTIONS, String(draft.fontWeight), (id) => {
      draft.fontWeight = id === '400' ? 400 : id === '700' ? 700 : 900;
    });

  const neighborRow = (): HTMLElement =>
    segmentedRow(
      '前后句数',
      '当前句前后各显示几句；只看当前最干净，前后各 1 能看出上下文',
      NEIGHBOR_OPTIONS,
      String(draft.neighborLines),
      (id) => {
        draft.neighborLines = id === '0' ? 0 : id === '2' ? 2 : 1;
      },
    );

  const group = (title: string, ...rows: HTMLElement[]): HTMLElement =>
    h('div', { class: 'ts-group' }, h('div', { class: 'ts-group-title', text: title }), ...rows);

  const tintNote = h('div', {
    class: 'ts-hint',
    text: '歌词颜色与封面 / 主题同源：纯色档用「歌词颜色」的三态，封面色与自动渐变按封面取色板上色。这里调字体、字重、字号、字距、辉光与三态亮度。',
  });

  const renderRows = (): void => {
    rowsHost.textContent = '';
    // 整表重建前先清掉旧控件的引用，避免高亮/同步指向已经被移除的节点。
    rangeControls.clear();
    rowsHost.append(
      group('预设', presetRow()),
      group('歌词', tintNote, fontRow(), weightRow(), toggleRow(KEYWORD_COLORS), toggleRow(TRANSLATION_TOGGLE), toggleRow(INTRO_TITLE), ...TEXT_RANGES.map(rangeRow), ...TEXT_COLORS.map(colorRow)),
      group('布局', ...LAYOUT_RANGES.map(rangeRow), neighborRow(), toggleRow(INFO_TOGGLE)),
      group('唱片', ...DISC_RANGES.map(rangeRow), toggleRow(LABEL_TEXT), ...DISC_COLORS.map(colorRow)),
      group('背景', toggleRow(BG_FOLLOW), ...BG_COLORS.map(colorRow), ...BG_RANGES.map(rangeRow)),
      group('尘埃', ...DUST_RANGES.map(rangeRow)),
      group('唱臂与动效', toggleRow(SHOW_ARM), toggleRow(ARM_PAUSE), ...ARM_RANGES.map(rangeRow)),
    );
  };

  /* ── 底部按钮 ─────────────────────────────────────────────── */

  const resetBtn = h('button', { class: 'ts-btn is-quiet', type: 'button', text: '恢复默认' });
  resetBtn.addEventListener('click', () => {
    Object.assign(draft, DEFAULT_VINYL_SETTINGS);
    renderRows();
    applyDraft();
    markPreset('vinyl');
  });
  const cancelBtn = h('button', { class: 'ts-btn', type: 'button', text: '取消' });
  cancelBtn.addEventListener('click', () => close(true));
  const saveBtn = h('button', { class: 'ts-btn is-primary', type: 'button', text: '保存' });
  saveBtn.addEventListener('click', () => {
    const saved = saveVinylStyleSettings({ ...draft });
    applyVinylStyleSettings(saved);
    toast('唱片设置已保存');
    close(false);
  });

  /* ── 面板结构 ─────────────────────────────────────────────── */

  const root = h('div', { class: 'sheet text-sheet vinyl-sheet' });
  const panel = h('div', { class: 'ts-panel' });
  const previewText = previewSong.title ? `唱片 · ${previewSong.title}` : '唱片 · 示例歌词';
  const head = h(
    'div',
    { class: 'sheet-head lp-head ts-head' },
    h(
      'div',
      { class: 'lp-head-text' },
      h('div', { class: 'sheet-title', text: '唱片设置' }),
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
