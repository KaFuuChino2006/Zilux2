/**
 * 歌词「房间设置」面板：从快捷设置 → 歌词 → 房间设置（房间档）点开。
 *
 * 界面和「文字设置」一致：底部居中的大弹窗，右边是可调项列表，左边是独立的实时预览画面
 * （单独一个房间舞台，自己按 1x 时钟循环播放，不依赖歌词页是否打开）。
 * 拖动即预览：改动同时推给歌词页房间舞台和预览舞台；点「保存」才写入本机，取消/关闭会还原。
 */
import { h, icon, toast } from './dom';
import { lyricPreviewSong } from './lyrics';
import { playerState } from './player';
import { applyRoomStyleSettings } from './room';
import { createRoomScene, type RoomScene, type RoomSceneSong } from './roomScene';
import { currentRoomLyricTint } from './room';
import {
  DEFAULT_ROOM_SETTINGS,
  ROOM_STYLE_PRESETS,
  applyRoomPreset,
  normalizeRoomSettings,
  roomStyleSettings,
  saveRoomStyleSettings,
  type RoomStyleSettings,
} from './roomSettings';

/** 滑杆可写的数字字段（字重/句数用分段控件，不在滑杆里）。 */
type NumericKey = Exclude<
  {
    [K in keyof RoomStyleSettings]: RoomStyleSettings[K] extends number ? K : never;
  }[keyof RoomStyleSettings],
  'fontWeight' | 'neighborLines'
>;
type BooleanKey = {
  [K in keyof RoomStyleSettings]: RoomStyleSettings[K] extends boolean ? K : never;
}[keyof RoomStyleSettings];
type ColorKey = 'color' | 'sungColor' | 'activeColor' | 'glowColor' | 'bgTop' | 'bgBottom' | 'rugColor';

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
  { key: 'keywordScale', label: '重点词字号', hint: '重点词比普通词大多少，1 = 和普通词一样大', min: 0.8, max: 1.6, step: 0.01, digits: 2, unit: 'x' },
  { key: 'introTitleScale', label: '歌名字号', hint: '前奏歌名卡的字号倍数，1 = 当前大小', min: 0.5, max: 2.2, step: 0.02, digits: 2, unit: 'x' },
  { key: 'letterSpacing', label: '字距', hint: '一个词里每个字之间的间距（em），负值更紧凑', min: -0.05, max: 0.2, step: 0.001, digits: 3, unit: 'em' },
  { key: 'glow', label: '辉光强度', hint: '正在唱的那句字外围的光晕强度，0 = 不发光', min: 0, max: 2, step: 0.05, digits: 2, unit: 'x' },
  { key: 'unsungOpacity', label: '未唱亮度', hint: '还没唱到的词有多亮；调低更聚焦当前句', min: 0, max: 1, step: 0.01, digits: 0, scale: 100, unit: '%' },
  { key: 'sungOpacity', label: '唱过亮度', hint: '已经唱过的词保留的亮度', min: 0, max: 1, step: 0.01, digits: 0, scale: 100, unit: '%' },
  { key: 'activeOpacity', label: '正在唱亮度', hint: '正在唱的那个词的亮度', min: 0, max: 1, step: 0.01, digits: 0, scale: 100, unit: '%' },
];

const LAYOUT_RANGES: RangeSpec[] = [
  { key: 'spreadX', label: '横向离散', hint: '词在画面左右方向散开的范围（占画面宽的比例）', min: 0.1, max: 0.5, step: 0.005, digits: 1, scale: 100, unit: '%' },
  { key: 'areaTop', label: '上边界', hint: '散落区域从画面中心往上延伸多少（占画面高）', min: 0.05, max: 0.5, step: 0.005, digits: 1, scale: 100, unit: '%' },
  { key: 'areaBottom', label: '下边界', hint: '散落区域从画面中心往下延伸多少（占画面高）', min: 0.02, max: 0.5, step: 0.005, digits: 1, scale: 100, unit: '%' },
  { key: 'depthSpread', label: '纵深离散', hint: '词在焦点平面前后错开的幅度，越大越有穿行感', min: 0, max: 2, step: 0.05, digits: 2, unit: 'x' },
  { key: 'rotation', label: '随机旋转', hint: '每个词额外随机滚转的最大角度，0 = 全部摆正', min: 0, max: 20, step: 0.1, digits: 1, unit: '°' },
];

const BG_COLORS: ColorSpec[] = [
  { key: 'bgTop', label: '顶部颜色', hint: '背景渐变上端的颜色' },
  { key: 'bgBottom', label: '底部颜色', hint: '背景渐变下端的颜色' },
];

const BG_RANGES: RangeSpec[] = [
  { key: 'bgAngle', label: '渐变角度', hint: '背景渐变的方向（0° = 从上到下，90° = 从左到右）', min: 0, max: 360, step: 1, digits: 0, unit: '°' },
  { key: 'centerGlow', label: '中心柔光', hint: '画面中心那团亮光，0 = 完全不开', min: 0, max: 1, step: 0.01, digits: 0, scale: 100, unit: '%' },
  { key: 'vignette', label: '暗角', hint: '画面四角压暗的程度，越大越聚焦中间', min: 0, max: 1, step: 0.01, digits: 0, scale: 100, unit: '%' },
  { key: 'grain', label: '颗粒噪点', hint: '整幅画面的细颗粒，一点点更像胶片', min: 0, max: 1, step: 0.005, digits: 1, scale: 100, unit: '%' },
];

const METEOR_RANGES: RangeSpec[] = [
  { key: 'streakCount', label: '流星数量', hint: '画面上同时出现的流星条数，0 = 没有', min: 0, max: 12, step: 1, digits: 0, unit: ' 条' },
  { key: 'streakStrength', label: '流星亮度', hint: '流星线条的亮度，0 = 完全看不见', min: 0, max: 1, step: 0.01, digits: 0, scale: 100, unit: '%' },
  { key: 'streakSpeed', label: '飞行速度', hint: '流星朝镜头飞来（或往远处飞走）的速度倍数', min: 0.2, max: 3, step: 0.05, digits: 2, unit: 'x' },
  { key: 'streakLength', label: '拖尾长度', hint: '流星尾巴相对当前飞行距离的长度比例，越大拖得越长', min: 0.02, max: 0.9, step: 0.01, digits: 0, scale: 100, unit: '%' },
  { key: 'streakWidth', label: '线条粗细', hint: '流星线条与头部光斑的粗细倍数', min: 0.3, max: 2.5, step: 0.05, digits: 2, unit: 'x' },
];

const RUG_COLOR: ColorSpec = { key: 'rugColor', label: '地毯颜色', hint: '地上长条地毯的颜色' };

const RUG_RANGES: RangeSpec[] = [
  { key: 'rugWidth', label: '地毯宽度', hint: '地毯的横向宽度倍数，1 = 当前宽度', min: 0.4, max: 2.4, step: 0.05, digits: 2, unit: 'x' },
  { key: 'rugNear', label: '最近深度', hint: '地毯离镜头最近的深度，越大离得越远', min: 0.8, max: 4, step: 0.1, digits: 1 },
  { key: 'rugFar', label: '最远深度', hint: '地毯渐渐化进背景的深度', min: 10, max: 60, step: 1, digits: 0 },
  { key: 'rugBandGap', label: '织纹间距', hint: '地毯横向织纹的疏密，越大纹路越稀', min: 0.4, max: 2.4, step: 0.05, digits: 2 },
  { key: 'rugOpacity', label: '地毯不透明度', hint: '地毯整体的透明程度', min: 0, max: 1, step: 0.01, digits: 0, scale: 100, unit: '%' },
];

const PARTICLE_RANGES: RangeSpec[] = [
  { key: 'particleCount', label: '粒子数量', min: 0, max: 90, step: 1, digits: 0, hint: '画面里漂浮的光点数量，0 关闭' },
  { key: 'particleSize', label: '粒子大小', min: 0.3, max: 3, step: 0.05, digits: 2, hint: '光点的世界尺寸倍率' },
  { key: 'particleBrightness', label: '粒子亮度', min: 0.15, max: 2.5, step: 0.05, digits: 2, hint: '光点透明度倍率' },
  { key: 'particleSpeed', label: '粒子速度', min: 0.2, max: 3, step: 0.05, digits: 2, hint: '光点向镜头飘动的速度' },
  { key: 'particleDrift', label: '粒子漂移', min: 0.2, max: 3, step: 0.05, digits: 2, hint: '漂浮时的横向游动幅度' },
];

const KEYWORD_COLORS: ToggleSpec = {
  key: 'keywordColors',
  label: '重点词染色',
  hint: '自动从整首歌词里挑出反复出现的长词（和纯字档「关键字染色」同一套规则），用色板里的强调色单独染色；关掉就统一词色',
};

const INTRO_TITLE: ToggleSpec = {
  key: 'introTitle',
  label: '前奏显示歌名',
  hint: '第一句歌词开口前，在画面中央显示歌曲名和歌手；开口后自动淡出，拖回前奏会重新出现',
};

const RUG_VISIBLE: ToggleSpec = { key: 'rugVisible', label: '显示地毯', hint: '画面底部那条长条地毯；关掉只剩背景和歌词' };

const BG_FOLLOW: ToggleSpec = {
  key: 'bgFollowLyrics',
  label: '背景跟随歌词颜色',
  hint: '背景渐变跟着快捷设置里的「歌词颜色」（纯色 / 封面色 / 自动渐变）走；关掉就用上面自定义的两个颜色',
};

const RUG_FOLLOW: ToggleSpec = {
  key: 'rugFollowLyrics',
  label: '地毯跟随歌词颜色',
  hint: '地毯主色跟着「歌词颜色」走，和歌词/背景同源；关掉就用下面的自定义地毯色',
};

const CAMERA_RANGES: RangeSpec[] = [
  { key: 'camHeight', label: '相机高度', hint: '镜头离地的高度，压低更有贴地感', min: 0.4, max: 2, step: 0.05, digits: 2 },
  { key: 'focusDepth', label: '焦点深度', hint: '正在唱那句离镜头多远，越大词越小越远', min: 4, max: 14, step: 0.1, digits: 1 },
  { key: 'lineGap', label: '句距', hint: '换句时镜头默认往前推进的距离', min: 2, max: 10, step: 0.1, digits: 1 },
  { key: 'creep', label: '前蹭距离', hint: '一句唱完前镜头自己往前蹭的距离', min: 0, max: 2, step: 0.05, digits: 2 },
  { key: 'pullChance', label: '后拉概率', hint: '换句时往后拉一下的概率，0 = 只往前推', min: 0, max: 1, step: 0.01, digits: 0, scale: 100, unit: '%' },
  { key: 'pullDistance', label: '后拉距离', hint: '往后拉的行程，越大越有从镜头背后拽出来的感觉', min: 0, max: 20, step: 0.1, digits: 1 },
  { key: 'rollMin', label: '滚转下限', hint: '换句滚转的最小角度，0 = 总是朝同一方向', min: 0, max: 20, step: 0.5, digits: 1, unit: '°' },
  { key: 'rollMax', label: '滚转上限', hint: '换句滚转的最大角度', min: 0, max: 20, step: 0.5, digits: 1, unit: '°' },
  { key: 'shake', label: '晃动倍率', hint: '手持镜头的细微晃动，0 = 完全静止', min: 0, max: 3, step: 0.05, digits: 2, unit: 'x' },
];

const ENTRANCE: ToggleSpec = { key: 'entrance', label: '逐词浮现', hint: '每个词从无到有慢慢浮现；关掉就整句直接出现' };

const MOTION_RANGES: RangeSpec[] = [
  { key: 'entranceMs', label: '浮现时长', hint: '一个词浮现用多久，越长越柔和', min: 0, max: 1200, step: 10, digits: 0, unit: 'ms' },
  { key: 'fadeGhost', label: '残影强度', hint: '前后句保留的清晰度，1 = 当前观感，越大残影越实', min: 0, max: 2, step: 0.05, digits: 2, unit: 'x' },
  { key: 'energy', label: '音乐呼吸', hint: '随音乐低频起伏的幅度，0 = 不跟着动', min: 0, max: 2, step: 0.05, digits: 2, unit: 'x' },
  { key: 'dpr', label: '渲染像素比', hint: '画面精细度，越高越清楚也越吃显卡（1~2）', min: 1, max: 2, step: 0.05, digits: 2, unit: 'x' },
];

/** 拿不到歌词页的歌词时，给预览一组中英混合的示例句，约 24s 一循环。 */
function demoPreviewSong(): RoomSceneSong {
  // 前面留 3.2s 前奏，预览里就能看到「前奏显示歌名」的效果。
  const introMs = 3200;
  const totalMs = 24000;
  // 刻意让「房间 / room / 光」出现两次以上，预览里能看到重点词染色与放大。
  const texts = [
    '光 落在 薄荷色 的 房间 里',
    '房间 里 的 光 慢慢 变亮',
    'Every word drifts in the room',
    'The room keeps breathing with the light',
    '我们 站在 同一束 光 里',
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
    trackKey: 'zilux-room-preview',
    title: '薄荷房间',
    artist: 'Zilux2 Preview',
    album: '',
    durationMs: totalMs,
    lyricOffsetMs: 0,
    lines,
  };
}

/** 面板单例：同一时间只开一个。 */
let openSheet: HTMLElement | null = null;

export function openRoomSettingsSheet(): void {
  if (openSheet) {
    // 已打开时只前置（挪到 body 末尾），不重复创建。
    document.body.append(openSheet);
    return;
  }

  let draft: RoomStyleSettings = normalizeRoomSettings(roomStyleSettings());

  const rowsHost = h('div', { class: 'ts-groups' });
  const previewLabel = h('div', { class: 'ts-preview-label', text: '实时预览' });
  const previewStage = h('div', { class: 'ts-preview-stage', style: 'position:relative' });
  const previewInner = h('div', { style: 'position:absolute;inset:0;overflow:hidden' });
  const previewHint = h('div', {
    class: 'ts-preview-hint',
    text: '这一格是独立的房间预览，自己按 1x 时钟循环播放：改任何一项都会立刻在这里重绘。',
  });
  const previewNote = h('div', {
    class: 'ts-preview-note',
    text: '预览不受歌词页是否打开影响；「镜头」「布局」改动会立刻重排逐词位置，保存后歌词页的房间画面同步生效。',
  });
  previewStage.append(previewInner);

  const previewSong = lyricPreviewSong() ?? demoPreviewSong();

  /* ── 预览场景（独立房间舞台） ─────────────────────────────── */

  let scene: RoomScene | null = null;
  try {
    scene = createRoomScene({ style: draft });
    scene.setLyricTint(currentRoomLyricTint());
    scene.root.style.position = 'absolute';
    scene.root.style.inset = '0';
    previewInner.append(scene.root);
  } catch (err) {
    scene = null;
    console.warn('[room-settings] preview scene failed', err);
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
      const persisted = roomStyleSettings();
      scene?.setStyle(persisted);
      applyRoomStyleSettings(persisted);
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
    const snapshot = normalizeRoomSettings(draft);
    scene?.setStyle(snapshot);
    applyRoomStyleSettings(snapshot);
  };

  /* ── 行构造器（照文字设置面板） ───────────────────────────── */

  const presetButtons: HTMLButtonElement[] = [];
  const markPreset = (id: string | null): void => {
    for (const btn of presetButtons) btn.classList.toggle('is-on', btn.dataset.preset === id);
  };

  const formatValue = (spec: RangeSpec, value: number): string => {
    const scaled = value * (spec.scale ?? 1);
    return `${scaled.toFixed(spec.digits)}${spec.unit ?? ''}`;
  };

  const presetRow = (): HTMLElement => {
    const buttons: HTMLButtonElement[] = ROOM_STYLE_PRESETS.map((preset) => {
      const btn = h('button', { class: 'ts-seg-btn', type: 'button', text: preset.label });
      btn.dataset.preset = preset.id;
      btn.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      btn.addEventListener('click', () => {
        draft = applyRoomPreset(draft, preset);
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
      h('div', { class: 'ts-hint', text: '整组换掉背景与地毯配色；歌词颜色跟随快捷设置里的「歌词颜色」，其它参数保持当前值，仍可继续微调。' }),
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
      '当前句前后各显示几句；只看当前最干净，前后各 2 最有纵深',
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
    text: '歌词颜色已跟随快捷设置里的「歌词颜色」（纯色 / 封面色 / 自动渐变）：纯色档用标准暖白三态，封面色与自动渐变按封面取色板上色。这里只调字体、字重、字号、字距、辉光强度与三态亮度。',
  });

  const renderRows = (): void => {
    rowsHost.textContent = '';
    rowsHost.append(
      group('预设', presetRow()),
      group('文字', tintNote, fontRow(), weightRow(), toggleRow(KEYWORD_COLORS), toggleRow(INTRO_TITLE), ...TEXT_RANGES.map(rangeRow)),
      group('布局', ...LAYOUT_RANGES.map(rangeRow), neighborRow()),
      group('背景', toggleRow(BG_FOLLOW), ...BG_COLORS.map(colorRow), ...BG_RANGES.map(rangeRow)),
      group('流星', ...METEOR_RANGES.map(rangeRow)),
      group('粒子', ...PARTICLE_RANGES.map(rangeRow)),
      group('地毯', toggleRow(RUG_VISIBLE), toggleRow(RUG_FOLLOW), colorRow(RUG_COLOR), ...RUG_RANGES.map(rangeRow)),
      group('镜头', ...CAMERA_RANGES.map(rangeRow)),
      group('动效', toggleRow(ENTRANCE), ...MOTION_RANGES.map(rangeRow)),
    );
  };

  /* ── 底部按钮 ─────────────────────────────────────────────── */

  const resetBtn = h('button', { class: 'ts-btn is-quiet', type: 'button', text: '恢复默认' });
  resetBtn.addEventListener('click', () => {
    Object.assign(draft, DEFAULT_ROOM_SETTINGS);
    renderRows();
    applyDraft();
    markPreset('mint');
  });
  const cancelBtn = h('button', { class: 'ts-btn', type: 'button', text: '取消' });
  cancelBtn.addEventListener('click', () => close(true));
  const saveBtn = h('button', { class: 'ts-btn is-primary', type: 'button', text: '保存' });
  saveBtn.addEventListener('click', () => {
    const saved = saveRoomStyleSettings({ ...draft });
    applyRoomStyleSettings(saved);
    toast('房间设置已保存');
    close(false);
  });

  /* ── 面板结构 ─────────────────────────────────────────────── */

  const root = h('div', { class: 'sheet text-sheet room-sheet' });
  const panel = h('div', { class: 'ts-panel' });
  const previewText = previewSong.title ? `房间 · ${previewSong.title}` : '房间 · 示例歌词';
  const head = h(
    'div',
    { class: 'sheet-head lp-head ts-head' },
    h(
      'div',
      { class: 'lp-head-text' },
      h('div', { class: 'sheet-title', text: '房间设置' }),
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
