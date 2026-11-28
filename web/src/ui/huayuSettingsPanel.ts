/**
 * 「话语」对话框歌词的设置面板：从快捷设置 → 播放效果 → 效果设置（话语设置…）点开。
 *
 * 和文字/文闪的面板同一套大弹窗：左边一整格实时预览（独立的「话语」舞台，跟着当前播放进度跑），
 * 右边是参数列表。话语的画面是每帧现画的，所以这里不走「重建场景」那一套 ——
 * 拖动滑杆直接把草稿推进舞台，画面立刻变；取消读回本机存档，保存才落盘。
 */
import { h, icon, toast } from './dom';
import { installSettingsSections } from './settingsSections';
import { playerState } from './player';
import { createHuayuStage, type HuayuStage } from './huayu';
import { lyricsLumiereTheme, lyricPreviewSong } from './lyrics';
import {
  DEFAULT_HUAYU_SETTINGS,
  HUAYU_AVATAR_SHAPES,
  HUAYU_BACKDROPS,
  HUAYU_ENTERS,
  HUAYU_EXITS,
  HUAYU_STYLES,
  HUAYU_SHAPES,
  currentHuayuSettings,
  previewHuayuSettings,
  restoreHuayuSettings,
  saveHuayuSettings,
  type HuayuAvatarShape,
  type HuayuBubbleStyle,
  type HuayuEnter,
  type HuayuExit,
  type HuayuSettings,
  type HuayuSideMode,
} from './huayuSettings';
import type { LumiereSongInput } from './lumiere';

const HUAYU_SECTIONS = [
  { id: 'layout', label: '布局', titles: ['布局'] },
  { id: 'chat', label: '界面', titles: ['界面'] },
  { id: 'look', label: '外观', titles: ['外观'] },
  { id: 'avatar', label: '头像', titles: ['头像'] },
  { id: 'motion', label: '动效', titles: ['动效'] },
];

type NumericKey = {
  [K in keyof HuayuSettings]: HuayuSettings[K] extends number ? K : never;
}[keyof HuayuSettings];
type BooleanKey = {
  [K in keyof HuayuSettings]: HuayuSettings[K] extends boolean ? K : never;
}[keyof HuayuSettings];

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

const LAYOUT_RANGES: RangeSpec[] = [
  { key: 'quoteChance', label: '引用概率', hint: '一条消息把上一条（另一个人）的话引在气泡顶上的概率，任何气泡样式都可能触发，0 = 关', min: 0, max: 1, step: 0.02, digits: 2 },
  { key: 'fontScale', label: '字号', hint: '整个气泡、头像、行距一起缩放；画面越大越建议调低', min: 0.7, max: 1.7, step: 0.02, digits: 2 },
  { key: 'visibleCount', label: '同屏条数', hint: '画面上最多同时留几条消息，更早的已经淡出、不再排版', min: 3, max: 14, step: 1, digits: 0 },
  { key: 'baseRatio', label: '落点高度', hint: '最新一条消息底边落在画面的高度比例；1 = 贴底，0.5 = 居中', min: 0.45, max: 0.92, step: 0.01, digits: 2 },
  { key: 'widthRatio', label: '气泡宽度', hint: '气泡最宽能占画面宽度的比例，长句会在这里面折行', min: 0.3, max: 0.82, step: 0.01, digits: 2 },
  { key: 'radius', label: '圆角', hint: '1 = 圆润气泡；0.2 接近方角，适合更「终端」的观感', min: 0.15, max: 1.3, step: 0.05, digits: 2 },
  { key: 'splitChars', label: '拆词字数', hint: '一句歌词超过这么多字就切段，切出来的几段是同一个人连着发的', min: 4, max: 20, step: 1, digits: 0 },
  { key: 'splitChance', label: '拆句概率', hint: '只有这个比例的长句会被切开，其余照常整句发出来；同一首歌切的位置是固定的', min: 0, max: 1, step: 0.05, digits: 2 },
];

const LAYOUT_TOGGLES: ToggleSpec[] = [
  { key: 'splitWords', label: '拆词', hint: '长句按字数切成几条短消息连发，像聊天时一句一句往外冒，而不是一整段砸下来' },
];

const CHAT_RANGES: RangeSpec[] = [
  { key: 'railScale', label: '会话栏宽度', hint: '左侧联系人栏的宽度倍数；1 = 默认，屏幕窄时会自动收起', min: 0.7, max: 1.6, step: 0.05, digits: 2 },
];

const CHAT_TOGGLES: ToggleSpec[] = [
  { key: 'showContacts', label: '待播列表', hint: '左侧那列待播歌曲（当前播放前 5 首 + 之后全部），点一行就切过去；关掉后画面只剩对话，也可以直接点左上角「待播」标题收起' },
  { key: 'showComposer', label: '输入框', hint: '底部那条聊天输入条，可以直接打字发消息；关掉后底部整条让给画面，最新一句往下沉' },
  { key: 'draftTyping', label: '草稿打字', hint: '下一句歌词在输入框里逐字敲出来；关掉就整句直接显现' },
];

const LOOK_RANGES: RangeSpec[] = [
  { key: 'bubbleAlpha', label: '气泡浓度', hint: '气泡底色有多实；调低更像半透明浮层', min: 0.25, max: 1, step: 0.01, digits: 2 },
  { key: 'unlitOpacity', label: '未唱字亮度', hint: '还没唱到的字压多暗；调高能预读下半句', min: 0.1, max: 0.75, step: 0.01, digits: 2 },
  { key: 'glow', label: '辉光强度', hint: '正在唱的字与气泡高光的光晕；0 = 完全关掉', min: 0, max: 2, step: 0.05, digits: 2 },
  { key: 'tilt', label: '气泡倾角', hint: '围绕气泡尾部轻微倾斜，0 为水平', min: 0, max: 2, step: 0.05, digits: 2 },
  { key: 'sendGrowMs', label: '发送撑开', hint: '自己发出一条消息时，长卷被撑开、镜头跟上所用的时间，毫秒', min: 80, max: 700, step: 10, digits: 0 },
  { key: 'revokeMs', label: '撤回时长', hint: '被撤回的气泡收成一行小字所用的时间，毫秒', min: 120, max: 900, step: 10, digits: 0 },
  { key: 'revokeChance', label: '撤回概率', hint: '每出现一句新歌词，前面已经唱过的句子按这个概率撤回成一行小字「撤回了一条消息」；0 = 关', min: 0, max: 1, step: 0.02, digits: 2 },
];

const LOOK_TOGGLES: ToggleSpec[] = [
  { key: 'chatWindow', label: '会话窗口', hint: '显示会话标题、消息计数和播放进度' },
  { key: 'showTranslation', label: '显示译文', hint: '歌词译文作为气泡内下方小字；没有译文时只是空白' },
  { key: 'showTicks', label: '已读双勾', hint: '右侧消息唱完后在右下角浮出两个小勾' },
  { key: 'showTime', label: '时间戳', hint: '气泡右下角标出这句歌词的时间（与双勾同一行）' },
  { key: 'showAvatar', label: '头像', hint: '左「话」右「语」的圆头像；关掉后气泡直接贴边距' },
];

const MOTION_RANGES: RangeSpec[] = [
  { key: 'cameraStrength', label: '镜头跟随', hint: '自由跟随机位：随最新一条消息缓缓平移、带轻微手持倾角；0 为固定镜头', min: 0, max: 1, step: 0.05, digits: 2 },
  { key: 'cameraZoomSpeed', label: '推近速度', hint: '镜头摇向下一句、并贴近它的快慢：0.15 = 极慢的长镜头，1 = 默认，3 = 几乎立刻到位', min: 0.15, max: 3, step: 0.05, digits: 2 },
  { key: 'cameraZoom', label: '镜头推近', hint: '把镜头拉近到「正在唱的这句」：0 = 平视不缩放，1 = 这句撑满画面（约 2 倍），中途换句是缓缓横摇过去', min: 0, max: 1, step: 0.02, digits: 2 },
  { key: 'enterMs', label: '入场时长', hint: '一条消息从出现到落位的时间，毫秒', min: 100, max: 700, step: 10, digits: 0 },
  { key: 'enterRise', label: '上浮距离', hint: '入场时从下方多少倍字号处漂上来；0 = 原地淡入', min: 0, max: 3, step: 0.05, digits: 2 },
  { key: 'enterDrift', label: '滑入距离', hint: '入场时朝自己那一侧横向滑入的距离，按字号倍数', min: 0, max: 3, step: 0.05, digits: 2 },
  { key: 'overshoot', label: '入场行程', hint: '入场时走得远不远：0 = 几乎原地淡入，越大从越远处滑到落点', min: 0, max: 2.2, step: 0.02, digits: 2 },
  { key: 'elasticity', label: '弹出弹性', hint: '落位后收尾的弹簧感：0 = 一次到位不晃，1 = 默认，2 = 明显回弹两三次', min: 0, max: 2, step: 0.02, digits: 2 },
  { key: 'enterElastic', label: '入场弹性', hint: '入场这段行程的弹性：0 = 直线滑到位，1 = 默认轻回弹，2 = 被拽过落点再弹回来', min: 0, max: 2, step: 0.02, digits: 2 },
  { key: 'popDepth', label: '鼓起幅度', hint: '入场时体积从多小鼓到满：0 = 不缩放直接淡入，0.5 = 从一半大小鼓起来', min: 0, max: 0.5, step: 0.01, digits: 2 },
  { key: 'swayAngle', label: '晃动角度', hint: '气泡吊在头像上摆出去的最大角度（度）：0 = 不晃，12 = 甩得很明显', min: 0, max: 12, step: 0.1, digits: 1 },
  { key: 'swaySpeed', label: '晃动快慢', hint: '摆动频率倍数：1 = 约 0.31 秒一个来回，大于 1 更快更碎', min: 0.4, max: 2.2, step: 0.05, digits: 2 },
  { key: 'riseSpeed', label: '滚动速度', hint: '镜头滚到新消息的跟手程度，越大越紧跟；文字本身不再被顶上去', min: 4, max: 28, step: 0.5, digits: 1 },
];

const MOTION_TOGGLES: ToggleSpec[] = [
  { key: 'showTyping', label: '正在输入', hint: '句间空档在下一句那一侧冒三点跳动' },
];

const SIDE_OPTIONS: Array<{ id: HuayuSideMode; label: string }> = [
  { id: 'random', label: '随机' },
  { id: 'alternate', label: '交替' },
  { id: 'left', label: '全左' },
  { id: 'right', label: '全右' },
];

/** 没有歌词页时的示例聊天：按播放时长铺满，任何位置都有消息可看。 */
function demoPreviewSong(): LumiereSongInput {
  const durationMs = Math.max(180000, playerState().durationMs || 0);
  const texts = [
    '今天的风有点大',
    '你有没有听见那句歌词',
    '我把它记在备忘录里了',
    '副歌之前那一小段最安静',
    '像有人把灯关了一半',
  ];
  const step = 3400;
  const lines: Array<LumiereSongInput['lines'][number]> = [];
  for (let time = 0, index = 0; time < durationMs; time += step, index += 1) {
    const text = texts[index % texts.length] as string;
    const tokens = text.split('').filter((token) => token.trim().length > 0);
    const span = (step - 600) / Math.max(1, tokens.length);
    lines.push({
      timeMs: time,
      durationMs: step - 600,
      text,
      translation: index % 3 === 1 ? 'And the wind keeps talking' : '',
      words: tokens.map((token, wordIndex) => ({
        text: token,
        startMs: time + wordIndex * span,
        endMs: time + (wordIndex + 1) * span,
        spaceBefore: false,
      })),
    });
  }
  return {
    trackKey: 'zilux-huayu-preview',
    title: '话语设置预览',
    artist: '',
    album: '',
    durationMs,
    lyricOffsetMs: 0,
    lines,
  };
}

/** 面板单例：同一时间只开一个。 */
let openSheet: HTMLElement | null = null;

export function openHuayuSettingsSheet(): void {
  if (openSheet) return;

  const draft: HuayuSettings = currentHuayuSettings();
  const rowsHost = h('div', { class: 'ts-groups' });
  const previewHost = h('div', { class: 'ts-preview-stage' });
  const previewLabel = h('div', { class: 'ts-preview-label', text: '实时预览' });
  const previewHint = h('div', {
    class: 'ts-preview-hint',
    text: '这一格是独立的话语舞台，跟着当前播放进度走：拖动任何一项，气泡、头像、三点都会立刻重画。',
  });

  const previewSong = lyricPreviewSong() ?? demoPreviewSong();
  // 预览自带一条循环时间轴：不依赖播放器状态，暂停着也能看完整出入场。
  const clipStart = Math.max(0, (previewSong.lines[0]?.timeMs ?? 0));
  const clipEnd = Math.max(clipStart + 8000, previewSong.durationMs || 24000);
  let clockMs = Math.min(clipEnd - 500, clipStart + 900);
  let previewStage: HuayuStage | null = null;
  let previewRaf = 0;
  let previewLast = 0;
  const previewLoop = (now: number): void => {
    if (!previewStage) return;
    const dt = previewLast > 0 ? Math.min(120, Math.max(0, now - previewLast)) : 16;
    previewLast = now;
    clockMs += dt;
    if (clockMs >= clipEnd) clockMs = clipStart;
    previewRaf = window.requestAnimationFrame(previewLoop);
  };
  const applyDraft = (): void => {
    previewHuayuSettings({ ...draft });
  };

  const close = (revert: boolean): void => {
    if (revert) restoreHuayuSettings();
    if (previewRaf) window.cancelAnimationFrame(previewRaf);
    previewRaf = 0;
    previewStage?.dispose();
    previewStage = null;
    previewHost.textContent = '';
    document.removeEventListener('keydown', onKey, true);
    openSheet = null;
    root.classList.add('is-leaving');
    window.setTimeout(() => root.remove(), 180);
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
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

  /** 头像上的字：输入即改，留空自动回默认「话 / 语」。 */
  const avatarTextRow = (side: 'left' | 'right'): HTMLElement => {
    const key = side === 'left' ? 'avatarLeftText' : 'avatarRightText';
    const input = h('input', {
      class: 'ts-input',
      type: 'text',
      maxlength: '2',
      value: draft[key],
      placeholder: side === 'left' ? '话' : '语',
      'aria-label': side === 'left' ? '左侧头像文字' : '右侧头像文字',
    }) as HTMLInputElement;
    input.addEventListener('pointerdown', (event) => event.stopPropagation());
    input.addEventListener('input', () => {
      draft[key] = Array.from(input.value.trim()).slice(0, 2).join('');
      applyDraft();
    });
    return h(
      'div',
      { class: 'ts-row' },
      h('div', { class: 'ts-row-head' }, h('span', { class: 'ts-label', text: side === 'left' ? '左侧头像字' : '右侧头像字' })),
      input,
      h('div', { class: 'ts-hint', text: '最多 2 个字；留空回到默认的「话 / 语」' }),
    );
  };

  /** 自定义头像图片：选图后缩到 192px 的方图再存，本机存档不会被撑爆。 */
  const shrinkToDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        try {
          const size = 192;
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const context = canvas.getContext('2d');
          if (!context) {
            reject(new Error('canvas unavailable'));
            return;
          }
          // 等比铺满再取中间，圆/方头像都不会拉变形。
          const ratio = Math.max(size / image.width, size / image.height);
          const w = image.width * ratio;
          const h = image.height * ratio;
          context.drawImage(image, (size - w) / 2, (size - h) / 2, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.88));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('图片解码失败'));
      };
      image.src = url;
    });

  const avatarImageRow = (side: 'left' | 'right'): HTMLElement => {
    const key = side === 'left' ? 'avatarLeftImage' : 'avatarRightImage';
    const state = h('span', { class: 'ts-value', text: draft[key] ? '已设置' : '未设置' });
    const pick = h('button', { class: 'ts-btn', type: 'button', text: '选图片…' }) as HTMLButtonElement;
    const clear = h('button', { class: 'ts-btn is-quiet', type: 'button', text: '清除' }) as HTMLButtonElement;
    const input = h('input', { type: 'file', accept: 'image/*', style: 'display:none' }) as HTMLInputElement;
    pick.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      void shrinkToDataUrl(file)
        .then((dataUrl) => {
          draft[key] = dataUrl;
          state.textContent = '已设置';
          applyDraft();
        })
        .catch((error: unknown) => {
          toast(`图片没用上：${error instanceof Error ? error.message : String(error)}`);
        });
    });
    clear.addEventListener('click', () => {
      draft[key] = '';
      state.textContent = '未设置';
      applyDraft();
    });
    return h(
      'div',
      { class: 'ts-row' },
      h('div', { class: 'ts-row-head' }, h('span', { class: 'ts-label', text: side === 'left' ? '左侧头像图片' : '右侧头像图片' }), state),
      h('div', {}, pick, clear, input),
      h('div', { class: 'ts-hint', text: '设了图片就替代渐变底色显示图片（自动铺满裁切，不变形）' }),
    );
  };

  const sideRow = (): HTMLElement =>
    segmentedRow(
      '分侧方式',
      '随机 = 按「歌 + 行号」定死左右（每次进入都一样）；交替 = 严格一左一右；全左/全右 = 单侧流水',
      SIDE_OPTIONS,
      draft.sideMode,
      (id) => {
        draft.sideMode = id === 'alternate' || id === 'left' || id === 'right' ? id : 'random';
      },
      true,
    );

  const group = (title: string, ...rows: HTMLElement[]): HTMLElement =>
    h('div', { class: 'ts-group' }, h('div', { class: 'ts-group-title', text: title }), ...rows);

  const pickRow = <T extends string>(
    label: string,
    hint: string,
    choices: readonly (readonly [T, string, string])[],
    current: T,
    onPick: (id: T) => void,
  ): HTMLElement =>
    segmentedRow(
      label,
      hint,
      choices.map(([id, text]) => ({ id, label: text })),
      current,
      (id) => onPick(id as T),
      true,
    );

  const bgRow = (): HTMLElement =>
    pickRow(
      '背景',
      '封面 = 当前歌曲封面放大铺满；关闭 = 透明底，露出页面自己的背景',
      HUAYU_BACKDROPS,
      draft.bgMode,
      (id) => {
        draft.bgMode = id;
      },
    );

  const styleRow = (): HTMLElement =>
    pickRow(
      '气泡外观',
      '自动 = 按歌名从三种质感里抽一种，同一首歌固定',
      HUAYU_STYLES,
      draft.bubbleStyle,
      (id) => {
        draft.bubbleStyle = id as HuayuBubbleStyle;
      },
    );

  const avatarShapeRow = (): HTMLElement =>
    pickRow(
      '头像外框',
      '圆形是默认；圆角方更像聊天软件里的方形头像',
      HUAYU_AVATAR_SHAPES,
      draft.avatarShape,
      (id) => {
        draft.avatarShape = id as HuayuAvatarShape;
      },
    );

  const enterRow = (): HTMLElement =>
    pickRow(
      '入场动画',
      '每条新消息各自入场；自动 = 按「歌 + 行号」抽一种，同一首歌固定',
      HUAYU_ENTERS,
      draft.enter,
      (id) => {
        draft.enter = id as HuayuEnter;
      },
    );

  const exitRow = (): HTMLElement =>
    pickRow(
      '出场动画',
      '消息退出时沿入场轨迹反向收拢，可选两种收尾速度',
      HUAYU_EXITS,
      draft.exit,
      (id) => {
        draft.exit = id as HuayuExit;
      },
    );

  const shapeLottery = (): HTMLElement => {
    const controls = h('div', {});
    controls.hidden = !draft.randomShapes;
    const chance = rangeRow({ key: 'shapeChance', label: '整体触发概率（%）', min: 0, max: 100, step: 1, digits: 0,
      hint: '每句先按此概率决定是否随机，未触发时使用固定形状。' });
    const buttons = HUAYU_SHAPES.map(([id, name]) => {
      const selected = draft.shapePool.includes(id);
      const btn = h('button', { type: 'button', text: name, class: 'ts-seg-btn' + (selected ? ' is-on' : ''),
        'aria-pressed': String(selected) });
      btn.addEventListener('click', () => {
        const active = !draft.shapePool.includes(id);
        draft.shapePool = active ? [...draft.shapePool, id] : draft.shapePool.filter(item => item !== id);
        btn.classList.toggle('is-on', active);
        btn.setAttribute('aria-pressed', String(active));
        applyDraft();
      });
      return btn;
    });
    controls.append(chance, h('div', { class: 'ts-row' },
      h('div', { class: 'ts-label', text: '参与随机的形状（可多选）' }),
      h('div', { class: 'ts-seg is-wrap' }, ...buttons),
      h('div', { class: 'ts-hint', text: '连续缺席 6 句后，下次抽取权重升至 2 倍；之后每缺席一句再加 1 倍，出现即恢复。全部取消时使用固定形状。' })));
    const mode = segmentedRow('逐句随机形状', '设置整体概率，并选择参与抽取的形状。',
      [{ id: 'off', label: '关' }, { id: 'on', label: '开' }], draft.randomShapes ? 'on' : 'off', id => {
        draft.randomShapes = id === 'on';
        controls.hidden = !draft.randomShapes;
      });
    return h('div', {}, mode, controls);
  };

  const renderRows = (): void => {
    rowsHost.textContent = '';
    rowsHost.append(
      group('布局', ...LAYOUT_RANGES.map(rangeRow), ...LAYOUT_TOGGLES.map(toggleRow), sideRow()),
      group('界面', ...CHAT_TOGGLES.map(toggleRow), ...CHAT_RANGES.map(rangeRow)),
      group('外观', bgRow(), pickRow('消息形状', '线条样式只画文字和线条，可搭配任意配色。', HUAYU_SHAPES,
        draft.shape, id => { draft.shape = id; }), shapeLottery(), styleRow(), ...LOOK_RANGES.map(rangeRow), ...LOOK_TOGGLES.map(toggleRow)),
      group(
        '头像',
        avatarShapeRow(),
        avatarTextRow('left'),
        avatarTextRow('right'),
        avatarImageRow('left'),
        avatarImageRow('right'),
      ),
      group('动效', enterRow(), exitRow(), ...MOTION_RANGES.map(rangeRow), ...MOTION_TOGGLES.map(toggleRow)),
    );
    installSettingsSections(rowsHost, HUAYU_SECTIONS);
  };

  const resetBtn = h('button', { class: 'ts-btn is-quiet', type: 'button', text: '恢复默认' }) as HTMLButtonElement;
  resetBtn.addEventListener('click', () => {
    Object.assign(draft, DEFAULT_HUAYU_SETTINGS);
    renderRows();
    applyDraft();
  });
  const cancelBtn = h('button', { class: 'ts-btn', type: 'button', text: '取消' }) as HTMLButtonElement;
  cancelBtn.addEventListener('click', () => close(true));
  const saveBtn = h('button', { class: 'ts-btn is-primary', type: 'button', text: '保存' }) as HTMLButtonElement;
  saveBtn.addEventListener('click', () => {
    saveHuayuSettings({ ...draft });
    toast('话语设置已保存');
    close(false);
  });

  const root = h('div', { class: 'sheet text-sheet huayu-sheet' });
  const panel = h('div', { class: 'ts-panel' });
  const head = h(
    'div',
    { class: 'sheet-head lp-head ts-head' },
    h(
      'div',
      { class: 'lp-head-text' },
      h('div', { class: 'sheet-title', text: '话语设置' }),
      h('div', {
        class: 'lp-head-song',
        text: previewSong.title ? `话语 · ${previewSong.title}` : '话语 · 示例聊天',
      }),
    ),
    h('button', { class: 'icon-btn', title: '关闭' }, icon('close', 16)),
  );
  head.lastElementChild?.addEventListener('click', () => close(true));
  const left = h('div', { class: 'ts-left' }, rowsHost);
  const previewNote = h('div', {
    class: 'ts-preview-note',
    text: '话语是按帧现画的，所以这里改任何一项都是即时生效、不用等重建；保存后歌词页继续用这套设置。',
  });
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
  try {
    previewStage = createHuayuStage({ clock: () => clockMs });
    previewHost.append(previewStage.root);
    previewStage.setTheme(lyricsLumiereTheme());
    previewStage.setSong(previewSong);
    previewStage.setMode('huayu');
    previewStage.activate();
    previewRaf = window.requestAnimationFrame(previewLoop);
  } catch (err) {
    previewStage = null;
    console.warn('[huayu-settings] preview stage failed', err);
    previewHint.textContent = `预览舞台启动失败：${err instanceof Error ? err.message : String(err)}`;
  }
  document.addEventListener('keydown', onKey, true);
  openSheet = root;
}
