/**
 * 歌词「文字设置」面板：从快捷设置 → 歌词 → 文字设置（纯字档）点开。
 *
 * 界面和「匹配歌词」一致：底部居中的大弹窗，左边是可调项列表，右边是独立的实时预览画面
 * （单独一个纯字舞台，跟着当前播放进度跑，不依赖歌词页是否打开）。
 * 拖动即预览：改动同时推给歌词页舞台和预览舞台；点「保存」才写入本机，取消/关闭会还原。
 */
import { h, icon, toast } from './dom';
import { createLumiereStage, type LumiereSongInput, type LumiereStage } from './lumiere';
import { applyLyricTextSettings, lyricPreviewSong, lyricsLumierePalette, lyricsLumiereTheme } from './lyrics';
import { playerState } from './player';
import {
  DEFAULT_TEXT_SETTINGS,
  lyricTextSettings,
  saveLyricTextSettings,
  type LyricTextSettings,
} from './lumiereSettings';
import { TEXT_BEAM_STYLES } from './lumiere-folia/components/visualizer/lumiere/light/textBeams';

type NumericKey = {
  [K in keyof LyricTextSettings]: LyricTextSettings[K] extends number ? K : never;
}[keyof LyricTextSettings];
type BooleanKey = {
  [K in keyof LyricTextSettings]: LyricTextSettings[K] extends boolean ? K : never;
}[keyof LyricTextSettings];

interface RangeSpec {
  key: NumericKey;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  digits: number;
}

interface ToggleSpec {
  key: BooleanKey;
  label: string;
  hint: string;
}

const TEXT_RANGES: RangeSpec[] = [
  { key: 'unlitOpacity', label: '未唱字亮度', hint: '还没唱到的字有多亮；调高能看清邻句，调低更聚焦当前句', min: 0.05, max: 0.6, step: 0.01, digits: 2 },
  { key: 'textBloom', label: '文字辉光', hint: '歌词大字的光晕强度', min: 0, max: 2, step: 0.05, digits: 2 },
  { key: 'themeColorMix', label: '主题色占比', hint: '文字颜色里混入主题色的比例', min: 0, max: 1, step: 0.05, digits: 2 },
];

const TEXT_TOGGLES: ToggleSpec[] = [
  { key: 'keywordColors', label: '关键字染色', hint: '一句里的重点词单独分配颜色和字号' },
];

const MOTION_RANGES: RangeSpec[] = [
  { key: 'decay', label: '崩解强度', hint: '一句唱完后字形散开、淡进烟里的程度；调到 0 就是原地上浮不散', min: 0, max: 2, step: 0.05, digits: 2 },
  { key: 'echo', label: '残影回声', hint: '唱过的词化成空心字碎片漂开；调 0 关掉', min: 0, max: 2, step: 0.05, digits: 2 },
];

const MOTION_TOGGLES: ToggleSpec[] = [
  { key: 'trails', label: '换位轨迹', hint: '换句时旧行飞走留下的拖尾细线' },
  { key: 'hideTrails', label: '隐藏轨迹线', hint: '彻底关掉拖尾细线，只留文字' },
  { key: 'seamlessTransitions', label: '无缝过渡', hint: '段落之间不做硬切换；改完会在下一次换歌时重新编译' },
];

const LIGHT_RANGES: RangeSpec[] = [
  { key: 'lightIntensity', label: '光强', hint: '背景光柱的亮度（开「背景光柱」后生效）', min: 0.3, max: 2, step: 0.05, digits: 2 },
  { key: 'audioResponse', label: '音频响应', hint: '随鼓点/人声脉冲的幅度', min: 0, max: 2, step: 0.05, digits: 2 },
  { key: 'bloom', label: '辉光强度', hint: '整幅画面的泛光强度', min: 0, max: 2, step: 0.05, digits: 2 },
];

const BEAM_TOGGLES: ToggleSpec[] = [
  { key: 'beams', label: '背景光柱', hint: '在文字后面加绘光的光柱与雾；关掉就只剩字' },
];

const BEAM_RANGES: RangeSpec[] = [
  { key: 'beamScale', label: '光柱大小', hint: '光柱的粗细与长度倍数，1 = 原始', min: 0.2, max: 3, step: 0.05, digits: 2 },
  { key: 'beamOffsetX', label: '左右位置', hint: '整束光柱左右平移（按画面宽的比例，负左正右）', min: -0.8, max: 0.8, step: 0.02, digits: 2 },
  { key: 'beamOffsetY', label: '上下位置', hint: '整束光柱上下平移（按画面高的比例，负上正下）', min: -0.8, max: 0.8, step: 0.02, digits: 2 },
];

const BG_RANGES: RangeSpec[] = [
  { key: 'fogDensity', label: '烟雾浓度', hint: '光柱周围的雾；纯字档开「背景光柱」后生效', min: 0, max: 2, step: 0.05, digits: 2 },
  { key: 'fogOctaves', label: '烟雾层次', hint: '雾的低频噪声层数，越高越蓬松', min: 2, max: 6, step: 1, digits: 0 },
  { key: 'moteAmount', label: '浮尘数量', hint: '空气里漂浮的光点（开「背景光柱」后生效）', min: 0, max: 2, step: 0.05, digits: 2 },
];

/** 拿不到歌词页的歌词时，给预览一组示例句，保证任何播放位置都有字可看。 */
function demoPreviewSong(): LumiereSongInput {
  const durationMs = Math.max(180000, playerState().durationMs || 0);
  const texts = ['光 会 落 在 每 一 个 字 上', 'Every word glows like light on water', '就 让 这 句 歌 慢 慢 散 开'];
  const step = 3200;
  const lines: Array<LumiereSongInput['lines'][number]> = [];
  for (let time = 0, index = 0; time < durationMs; time += step, index += 1) {
    const text = texts[index % texts.length] as string;
    const tokens = text.split(/\s+/).filter((token) => token.length > 0);
    const span = (step - 500) / Math.max(1, tokens.length);
    lines.push({
      timeMs: time,
      durationMs: step - 500,
      text,
      translation: '',
      words: tokens.map((token, wordIndex) => ({
        text: token,
        startMs: time + wordIndex * span,
        endMs: time + (wordIndex + 1) * span,
        spaceBefore: wordIndex > 0,
      })),
    });
  }
  return {
    trackKey: 'zilux-text-preview',
    title: '文字设置预览',
    artist: '',
    album: '',
    durationMs,
    lyricOffsetMs: 0,
    lines,
  };
}

/** 面板单例：同一时间只开一个。 */
let openSheet: HTMLElement | null = null;

export function openTextSettingsSheet(): void {
  if (openSheet) return;

  const draft: LyricTextSettings = { ...lyricTextSettings() };
  const rowsHost = h('div', { class: 'ts-groups' });
  const previewHost = h('div', { class: 'ts-preview-stage' });
  const previewLabel = h('div', { class: 'ts-preview-label', text: '实时预览' });
  const previewHint = h('div', {
    class: 'ts-preview-hint',
    text: '这一格是独立的预览画面，跟着当前播放进度走：改任何一项都会立刻在这里重绘。',
  });

  const previewSong = lyricPreviewSong() ?? demoPreviewSong();
  let previewStage: LumiereStage | null = null;
  try {
    previewStage = createLumiereStage({
      textOnly: true,
      theme: lyricsLumiereTheme(),
      palette: lyricsLumierePalette(),
    });
    // 舞台默认 mode 是 'off'：创建完成后若仍是 off 会把刚建好的运行时直接销毁，必须先置为 text。
    previewStage.setMode('text');
    previewStage.setSong(previewSong);
    previewHost.append(previewStage.root);
    previewStage.activate();
  } catch (err) {
    previewStage = null;
    console.warn('[text-settings] preview stage failed', err);
    previewHint.textContent = `预览舞台启动失败：${err instanceof Error ? err.message : String(err)}`;
  }

  const applyDraft = (): void => {
    const snapshot = { ...draft };
    applyLyricTextSettings(snapshot);
    previewStage?.applyTextSettings(snapshot);
  };

  const close = (revert: boolean): void => {
    if (revert) applyLyricTextSettings();
    previewStage?.dispose();
    previewStage = null;
    previewHost.textContent = '';
    openSheet = null;
    root.classList.add('is-leaving');
    window.setTimeout(() => root.remove(), 180);
  };

  const rangeRow = (spec: RangeSpec): HTMLElement => {
    const value = h('span', { class: 'ts-value', text: Number(draft[spec.key]).toFixed(spec.digits) });
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
      (draft[spec.key] as number) = parsed;
      value.textContent = parsed.toFixed(spec.digits);
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

  const segmentedRow = (
    label: string,
    hint: string,
    options: Array<{ id: string; label: string }>,
    current: string,
    onPick: (id: string) => void,
    wrap = false,
  ): HTMLElement => {
    const buttons: HTMLButtonElement[] = options.map((option) => {
      const btn = h('button', {
        class: `ts-seg-btn${option.id === current ? ' is-on' : ''}`,
        type: 'button',
        text: option.label,
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
      h('div', { class: `ts-seg${wrap ? ' is-wrap' : ''}` }, ...buttons),
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
        (draft[spec.key] as boolean) = id === 'on';
      },
    );

  const neighborsRow = (): HTMLElement =>
    segmentedRow(
      '显示邻句',
      '当前句上下各显示几行歌词（对中文长句更友好）',
      [
        { id: '2', label: '2 行' },
        { id: '1', label: '1 行' },
      ],
      String(draft.windowNeighbors),
      (id) => {
        draft.windowNeighbors = id === '1' ? 1 : 2;
      },
    );

  const qualityRow = (): HTMLElement =>
    segmentedRow(
      '渲染画质',
      '低画质更省电；纯字档对画质不敏感',
      [
        { id: 'full', label: '高' },
        { id: 'balanced', label: '中' },
        { id: 'low', label: '低' },
      ],
      draft.renderQuality,
      (id) => {
        draft.renderQuality = id === 'low' ? 'low' : id === 'balanced' ? 'balanced' : 'full';
      },
    );

  const beamStyleRow = (): HTMLElement => {
    const buttons: HTMLButtonElement[] = TEXT_BEAM_STYLES.map((option) => {
      const btn = h('button', {
        class: `ts-seg-btn${option.id === draft.beamStyle ? ' is-on' : ''}`,
        type: 'button',
        text: option.label,
      }) as HTMLButtonElement;
      btn.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      btn.addEventListener('click', () => {
        buttons.forEach((item) => item.classList.toggle('is-on', item === btn));
        draft.beamStyle = option.id;
        applyDraft();
      });
      return btn;
    });
    return h(
      'div',
      { class: 'ts-row' },
      h('div', { class: 'ts-row-head' }, h('span', { class: 'ts-label', text: '光柱效果' })),
      h('div', { class: 'ts-seg is-wrap' }, ...buttons),
      h('div', {
        class: 'ts-hint',
        text: '正射：静光 / 缓息 / 流幕 / 聚光；多入射角：斜光 / 交叉 / 仰光；彩虹色散：虹光',
      }),
    );
  };

  const beamAutoRow = (): HTMLElement =>
    segmentedRow(
      '自动轮换',
      '每隔 16 秒按「静光 → 缓息 → 流幕 → 聚光 → 斜光 → 交叉 → 仰光 → 虹光」换一套构图，切换处 2.4 秒平滑过渡，看不出硬切；关掉后固定当前样式',
      [
        { id: 'on', label: '开' },
        { id: 'off', label: '关' },
      ],
      draft.beamAuto ? 'on' : 'off',
      (id) => {
        draft.beamAuto = id === 'on';
      },
    );

  const group = (title: string, ...rows: HTMLElement[]): HTMLElement =>
    h('div', { class: 'ts-group' }, h('div', { class: 'ts-group-title', text: title }), ...rows);

  const renderRows = (): void => {
    rowsHost.textContent = '';
    rowsHost.append(
      group('文字', ...TEXT_RANGES.map(rangeRow), ...TEXT_TOGGLES.map(toggleRow)),
      group('排版与动效', neighborsRow(), ...MOTION_RANGES.map(rangeRow), ...MOTION_TOGGLES.map(toggleRow)),
      group(
        '光柱与光感',
        ...BEAM_TOGGLES.map(toggleRow),
        beamStyleRow(),
        beamAutoRow(),
        ...BEAM_RANGES.map(rangeRow),
        ...LIGHT_RANGES.map(rangeRow),
        qualityRow(),
        ...BG_RANGES.map(rangeRow),
      ),
    );
  };

  const resetBtn = h('button', { class: 'ts-btn is-quiet', type: 'button', text: '恢复默认' }) as HTMLButtonElement;
  resetBtn.addEventListener('click', () => {
    Object.assign(draft, DEFAULT_TEXT_SETTINGS);
    renderRows();
    applyDraft();
  });
  const cancelBtn = h('button', { class: 'ts-btn', type: 'button', text: '取消' }) as HTMLButtonElement;
  cancelBtn.addEventListener('click', () => close(true));
  const saveBtn = h('button', { class: 'ts-btn is-primary', type: 'button', text: '保存' }) as HTMLButtonElement;
  saveBtn.addEventListener('click', () => {
    saveLyricTextSettings({ ...draft });
    applyLyricTextSettings();
    toast('歌词文字设置已保存');
    close(false);
  });

  const root = h('div', { class: 'sheet text-sheet' });
  const panel = h('div', { class: 'ts-panel' });
  const previewText = previewSong.title ? `纯字 · ${previewSong.title}` : '纯字 · 示例歌词';
  const head = h(
    'div',
    { class: 'sheet-head lp-head ts-head' },
    h(
      'div',
      { class: 'lp-head-text' },
      h('div', { class: 'sheet-title', text: '文字设置' }),
      h('div', { class: 'lp-head-song', text: previewText }),
    ),
    h('button', { class: 'icon-btn', title: '关闭' }, icon('close', 16)),
  );
  head.lastElementChild?.addEventListener('click', () => close(true));
  const left = h('div', { class: 'ts-left' }, rowsHost);
  const previewNote = h('div', {
    class: 'ts-preview-note',
    text: '开「背景光柱」后文字后面会有光柱与雾，光强 / 烟雾 / 浮尘都跟着变；关掉就只剩文字和残影。',
  });
  // 布局：左边大预览画面（占大部分），右边参数列表只占一部分宽度。
  const previewCol = h('div', { class: 'ts-preview-col' }, previewLabel, previewHost, previewHint, previewNote);
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
}
