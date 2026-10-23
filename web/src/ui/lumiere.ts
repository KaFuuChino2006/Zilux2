/**
 * 歌词页「播放效果 · 纯字」。
 *
 * 这里不再自绘画面，而是把 folia（AGPL-3.0）的绘光（lumiere）原实现搬进 web/src/ui/lumiere-folia：
 * 舞台光束、烟雾、浮尘、线稿、星象、片尾卡全部由 folia 的 PixiJS 运行时渲染，编译与场景数据也原样使用。
 * 本文件只是适配层：
 *   - 把 Zilux2 的歌词文档（LyricDoc）翻译成 folia 的 Line[]，交给 compileLumiereProgram 编译成整首程序；
 *   - 提供 folia 运行时需要的 MotionValue<number>（播放时间、音频能量）——播放时间按「最近一次播放状态的
 *     位置 + performance.now() 增量」推进，绕开播放器 40ms 的位置跳变；
 *   - 用播放器的频谱分析器（core/audioTap 的 playbackAnalyser）算 bass/lowMid/mid/vocal/treble 五段能量；
 *   - 曲目/歌词/播放状态变化时更新运行时（换歌就 swapSong）。
 *
 * 纯字档沿用绘光自带的画字能力：打开后歌词大字由 folia 的歌词窗口直接画在舞台上（逐字上浮、回响、
 * 闪点、关键字染色、十字爆闪这些都在 canvas 里），此时歌词页会收起自己的 DOM 歌词与封面栏
 *（见 styles/app.css 的 .lyrics-view.is-lumiere-text）；背景光柱与雾由「文字设置」开关。
 */

import { LumierePixiRuntime, type LumiereSongContext } from './lumiere-folia/components/visualizer/lumiere/createLumierePixiRuntime';
import { extractLyricKeywords } from './keywords';
import { compileLumiereProgram } from './lumiere-folia/components/visualizer/lumiere/lumiereProgram';
import { LUMIERE_PROFILES } from './lumiere-folia/components/visualizer/lumiere/catalog';
import {
  DEFAULT_LUMIERE_TUNING,
  type AudioBands,
  type LumiereTuning,
  type Line,
  type Theme,
} from './lumiere-folia/types';
import { MotionValue } from './lumiere-folia/shims/framer-motion';
import { playbackAnalyser } from '../core/audioTap';
import { onPlayer, playerState } from './player';
import { lyricTextSettings, textSettingsToTuning, type LyricTextSettings } from './lumiereSettings';

/*
 * Zilux2 的改动：绘光原版的排版按镜头在「横排 / 竖排 / 交叉排」之间切换（竖排右起、交叉排会让周围
 * 的行自由落点、横竖都有）。中文竖排好看，但英语歌词被转 90° 就读不了，所以这里把光位目录里的排版
 * 统一改成横排。只改这一个字段，光束、运镜、线稿、雾、字的动效都不受影响。
 */
for (const profile of LUMIERE_PROFILES) profile.typography = 'horizontal';


/** 播放效果：关闭 / 纯字（folia 绘光的文字特效）/ 房间（薄荷绿纵深 + 长条地毯，逐词飘浮 + 镜头跟随，可细调）。 */
export type LumiereMode = 'off' | 'text' | 'room';

export const LUMIERE_MODES: Array<{ id: LumiereMode; label: string; hint: string }> = [
  { id: 'off', label: '关闭', hint: '歌词页不显示播放效果' },
  { id: 'text', label: '纯字', hint: 'folia 绘光的文字特效：发光大字、关键字染色、逐字点亮，可在「文字设置」里加背景光柱与雾' },
  { id: 'room', label: '房间', hint: '薄荷绿纵深 + 长条地毯：每句歌词拆成词散落在前方空间里，镜头跟着正在唱的那句推进；到「快捷设置 → 房间设置」可细调歌词风格、颜色与离散度' },
];

const STORE_KEY = 'zilux2.lumiere';

/** 当前播放效果（只在歌词页生效）。已删掉的「绘光 / 光场」存档统一归到「纯字」。 */
export function lumiereMode(): LumiereMode {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    // 「房间」是新加的 3D 场景；「光场」已删除不再复活；「绘光」被「纯字」取代，存档直接落到纯字。
    if (raw === 'room') return 'room';
    if (raw === 'off' || raw === 'lightfield') return 'off';
    if (raw) return 'text';
  } catch {
    // localStorage 不可用时按默认处理
  }
  return 'off';
}

export function setLumiereMode(mode: LumiereMode): void {
  try {
    if (mode === 'off') localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, mode);
  } catch {
    // 忽略存储失败
  }
}

/* ------------------------------------------------------------------ */
/* 歌词 → folia Line                                                   */
/* ------------------------------------------------------------------ */

export interface LumiereSongInput {
  trackKey: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  lyricOffsetMs: number;
  lines: ReadonlyArray<{
    timeMs: number;
    durationMs: number;
    text: string;
    translation: string;
    words: ReadonlyArray<{ text: string; startMs: number; endMs: number; spaceBefore?: boolean }>;
  }>;
}

const toFoliaLines = (input: LumiereSongInput): Line[] => {
  const offset = (input.lyricOffsetMs || 0) / 1000;
  const lines: Line[] = [];
  for (const line of input.lines) {
    const startTime = line.timeMs / 1000 + offset;
    const endTime = startTime + Math.max(0.24, line.durationMs / 1000);
    const words = line.words
      .filter((word) => word.text.trim().length > 0)
      .map((word) => ({
        text: word.text,
        startTime: word.startMs / 1000 + offset,
        endTime: Math.max(word.startMs / 1000 + offset + 0.02, word.endMs / 1000 + offset),
      }));
    lines.push({
      words,
      startTime,
      endTime,
      fullText: line.text.trim() || line.words.map((word) => word.text).join(''),
      translation: line.translation || undefined,
    });
  }
  return lines;
};

/** 绘光舞台的主题：folia 的暗色默认主题，强调色换成 Zilux2 的金色。 */
const LUMIERE_THEME: Theme = {
  name: 'Zilux 绘光',
  backgroundColor: '#09090b',
  primaryColor: '#f6f2ea',
  accentColor: '#e6c184',
  secondaryColor: '#8f939b',
  fontStyle: 'sans',
  animationIntensity: 'normal',
};

/* ------------------------------------------------------------------ */
/* 关键字（重点词）着色                                                 */
/* ------------------------------------------------------------------ */

/*
 * folia 的关键字来自主题的 wordColors（例：{ word: '花火', color: '#ff9f43' }）。
 * Zilux2 没有人工维护的词表，自动挑「反复出现的长词」的规则统一放在 ui/keywords.ts，
 * 房间档的「重点词染色」也用同一套提取逻辑，保证两档挑出来的词一致。
 */
const keywordWordColors = (
  input: LumiereSongInput | null,
  palette: string[] | null,
  base: Theme,
): NonNullable<Theme['wordColors']> =>
  extractLyricKeywords(input?.lines ?? [], palette, [base.accentColor, base.primaryColor, base.secondaryColor]).map(
    (keyword) => ({ word: keyword.text, color: keyword.color }),
  );

/**
 * 把「关闭」档那套封面取色（纯色 / 封面色 / 自动渐变）翻成绘光主题：
 * 舞台的光色主要吃 accent，唱到的字吃 primary，没唱的字吃 secondary。
 * 混入强度仍由「文字设置 → 主题色占比」控制（0 就回到原来的香槟金）。
 */
export function lumiereThemeForCover(mode: 'solid' | 'cover' | 'gradient', palette: string[] | null): Theme {
  if (mode === 'solid' || !palette || palette.length === 0) return LUMIERE_THEME;
  const at = (t: number): string => palette[Math.min(palette.length - 1, Math.max(0, Math.round(t * (palette.length - 1))))]!;
  // 自动渐变用色板首/中/尾，灯光、已唱字、未唱字各取一段，和「封面色」区分得开。
  const dominant = at(0);
  const second = mode === 'gradient' ? at(0.5) : palette[1] ?? dominant;
  const third = mode === 'gradient' ? at(1) : palette[2] ?? second;
  return {
    ...LUMIERE_THEME,
    name: mode === 'gradient' ? 'Zilux 封面渐变' : 'Zilux 封面色',
    accentColor: dominant,
    primaryColor: second ?? dominant,
    secondaryColor: third ?? dominant,
  };
}

const LUMIERE_TUNING: LumiereTuning = {
  ...DEFAULT_LUMIERE_TUNING,
  // 字体由 DOM 歌词负责；主题也没有 lyricsIcons，因此把主题图标关掉。
  themeIcons: false,
};

/** 把本机保存的文字设置叠到基础 tuning 上（textOnly 由各舞台自己定）。 */
const tuningWithSettings = (textOnly: boolean, settings: LyricTextSettings = lyricTextSettings()): LumiereTuning =>
  textSettingsToTuning({ ...LUMIERE_TUNING, textOnly }, settings);

/* ------------------------------------------------------------------ */
/* 舞台                                                                */
/* ------------------------------------------------------------------ */

export interface LumiereStage {
  readonly root: HTMLDivElement;
  setMode(mode: LumiereMode): void;
  /** 歌词文档变化（换歌、歌词晚到、时长变化）。 */
  setSong(input: LumiereSongInput | null): void;
  activate(): void;
  deactivate(): void;
  /** 换句：绘光由时间驱动，这里只留接口给旧调用点。 */
  pulse(): void;
  /** 应用「文字设置」：不传就读本机保存的值；传了就立即按这份值渲染（面板实时预览用）。 */
  applyTextSettings(settings?: LyricTextSettings): void;
  /** 换主题（跟随封面色）：光色与字色一起变，不重新编译歌词。 */
  setTheme(theme: Theme, palette?: string[] | null): void;
  dispose(): void;
}

const BAND_RANGES: Array<[number, number]> = [
  [20, 150], // bass
  [150, 400], // lowMid
  [400, 1200], // mid
  [1000, 3500], // vocal
  [3500, 12000], // treble
];

export interface LumiereStageOptions {
  /** 只画歌词文字：关掉光束、雾、浮尘、线稿与片尾卡等背景层。 */
  textOnly?: boolean;
  /** 初始主题（跟随封面色时由歌词页传入）。 */
  theme?: Theme;
  /** 「歌词颜色」从封面取到的色板；关键字着色与「自动渐变」都从这里取色。 */
  palette?: string[] | null;
}

export function createLumiereStage(options: LumiereStageOptions = {}): LumiereStage {
  const textOnly = options.textOnly === true;
  // 纯字档把「文字设置」叠到 folia 默认 tuning 上（面板里的实时预览也走这里）。
  let tuning: LumiereTuning = textOnly ? tuningWithSettings(true) : { ...LUMIERE_TUNING };
  const root = document.createElement('div');
  root.className = textOnly ? 'lyrics-stage is-pure' : 'lyrics-stage';

  let mode: LumiereMode = 'off';
  let theme: Theme = options.theme ?? LUMIERE_THEME;
  // 封面色板（「歌词颜色」取得的那几个颜色）：关键字着色与「自动渐变」都从它取色。
  let palette: string[] | null = options.palette ? [...options.palette] : null;
  let song: LumiereSongInput | null = null;
  let songSignature = '';
  /** 已真正应用到画布上的那首歌（切歌时用来看是不是同一首）。 */
  let appliedTrackKey = '';
  let runtime: LumierePixiRuntime | null = null;
  let starting = false;
  let disposed = false;
  let active = false;
  let abort: AbortController | null = null;
  let raf = 0;
  // 暂停时 pixi 的 ticker 是停的：适配层自己的 rAF 时钟推进后（换歌、拖动进度、刚打开页面）要补一帧，
  // 否则画面会停在旧时间——纯字档就只剩背景没有字。
  let renderedSeconds = Number.NaN;
  /** 自愈检查的帧计数（每 90 帧核对一次画布上的歌）。 */
  let healFrame = 0;
  let failed = false;
  // 关闭效果时先让画面淡出，再真正销毁运行时（否则切档会硬切）。
  let teardownTimer = 0;
  // 「画布真的画出东西了」：运行时 ready 之后逐帧读回几像素，只有出现不透明像素才收起 DOM 歌词，
  // 否则某些情况下（首帧还没画、WebGL 上下文没起来）会只剩一页灰背景。
  let painted = false;
  let probeFrame = 0;
  let probeCanvas: HTMLCanvasElement | null = null;
  let probeCtx: CanvasRenderingContext2D | null = null;

  // 播放时钟：每次播放状态到来时锚定一次，之后用 performance.now() 补齐，避免位置跳变。
  let anchorMs = 0;
  let anchorAt = performance.now();
  let playing = false;
  let durationMs = 0;
  let metadata = { title: '', artist: '', album: '' };

  const currentTime = new MotionValue(0);
  const audioPower = new MotionValue(0);
  const audioBands: AudioBands = {
    bass: new MotionValue(0),
    lowMid: new MotionValue(0),
    mid: new MotionValue(0),
    vocal: new MotionValue(0),
    treble: new MotionValue(0),
  };

  let analyser: AnalyserNode | null = null;
  let freq: Uint8Array<ArrayBuffer> | null = null;

  const syncPlayer = (): void => {
    const state = playerState();
    anchorMs = state.positionMs;
    anchorAt = performance.now();
    playing = state.playing;
    durationMs = state.durationMs || 0;
    if (runtime) runtime.setPaused(!playing);
  };

  const unsubscribe = onPlayer((state) => {
    anchorMs = state.positionMs;
    anchorAt = performance.now();
    playing = state.playing;
    durationMs = state.durationMs || 0;
    if (runtime) runtime.setPaused(!state.playing);
  });

  const updateAudio = (): void => {
    if (!analyser) {
      analyser = playbackAnalyser();
      if (!analyser) return;
      freq = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    }
    if (!freq) return;
    analyser.getByteFrequencyData(freq);
    if (!playing) {
      audioPower.set(0);
      audioBands.bass.set(0);
      audioBands.lowMid.set(0);
      audioBands.mid.set(0);
      audioBands.vocal.set(0);
      audioBands.treble.set(0);
      return;
    }
    const ctx = analyser.context;
    const binHz = ctx.sampleRate / analyser.fftSize;
    const average = (lowHz: number, highHz: number): number => {
      const from = Math.max(1, Math.floor(lowHz / binHz));
      const to = Math.min(freq!.length - 1, Math.ceil(highHz / binHz));
      if (to < from) return 0;
      let sum = 0;
      for (let i = from; i <= to; i += 1) sum += freq![i] ?? 0;
      return sum / (to - from + 1) / 255;
    };
    audioBands.bass.set(average(...BAND_RANGES[0]!));
    audioBands.lowMid.set(average(...BAND_RANGES[1]!));
    audioBands.mid.set(average(...BAND_RANGES[2]!));
    audioBands.vocal.set(average(...BAND_RANGES[3]!));
    audioBands.treble.set(average(...BAND_RANGES[4]!));
    audioPower.set(average(40, 9000));
  };

  const markPainted = (): void => {
    if (painted) return;
    painted = true;
    probeFrame = 0;
    root.classList.add('is-painted');
  };

  /** 每 6 帧读一次画布（缩小到 128x80）找不透明像素；画出内容就通知 CSS 收起 DOM 歌词。 */
  const probePaint = (): void => {
    if (painted || !runtime) return;
    probeFrame += 1;
    if (probeFrame % 6 !== 0) return;
    const canvas = root.querySelector('canvas');
    if (!canvas || !canvas.width || !canvas.height) return;
    if (!probeCanvas) {
      probeCanvas = document.createElement('canvas');
      probeCanvas.width = 128;
      probeCanvas.height = 80;
      probeCtx = probeCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (!probeCtx) return;
    try {
      probeCtx.clearRect(0, 0, 128, 80);
      probeCtx.drawImage(canvas, 0, 0, 128, 80);
      const data = probeCtx.getImageData(0, 0, 128, 80).data;
      let hits = 0;
      for (let i = 3; i < data.length; i += 4) {
        if ((data[i] ?? 0) > 10) hits += 1;
        if (hits > 6) break;
      }
      if (hits > 6) markPainted();
    } catch {
      // 读画布失败（上下文丢失等）就等下一轮，别把异常往上抛。
    }
  };

  const tick = (): void => {
    if (!active) return;
    const now = performance.now();
    const seconds = playing ? (anchorMs + (now - anchorAt)) / 1000 : anchorMs / 1000;
    currentTime.set(seconds);
    if (runtime && !playing && (!Number.isFinite(renderedSeconds) || Math.abs(seconds - renderedSeconds) > 0.04)) {
      renderedSeconds = seconds;
      runtime.renderOnce();
    }
    // 自愈：画布上的歌和当前这首不一致（例如换场没接上）就重推一次，别让「只剩背景」一直留着。
    healFrame += 1;
    if (runtime && song && song.lines.length > 0 && healFrame % 90 === 0) {
      const shown = (runtime as unknown as { options?: { song?: { seed?: string; program?: { paragraphs?: Array<{ lines?: unknown[] }> } } } }).options?.song;
      let shownLines = 0;
      for (const paragraph of shown?.program?.paragraphs ?? []) shownLines += paragraph.lines?.length ?? 0;
      if (shown?.seed !== song.trackKey || shownLines === 0) {
        songSignature = '';
        applySong(song);
      }
    }
    updateAudio();
    probePaint();
    raf = window.requestAnimationFrame(tick);
  };

  const buildSongContext = (input: LumiereSongInput | null): LumiereSongContext => {
    const program = compileLumiereProgram(
      input ? toFoliaLines(input) : [],
      input?.trackKey ?? 'zilux',
      {},
      {
        duration: Math.max(1, (input?.durationMs ?? durationMs) / 1000 || 480),
        seamless: tuning.seamlessTransitions,
      },
    );
    // 关键字（重点词）着色：folia 的关键字来自主题 wordColors，这里按整首歌词自动生成。
    const themed: Theme = {
      ...theme,
      wordColors: keywordWordColors(input, palette, theme),
    };
    return {
      seed: input?.trackKey ?? 'zilux',
      program,
      theme: themed,
    };
  };

  const themeSignature = (): string => {
    if (!theme) return '';
    return `${theme.name}|${theme.backgroundColor}|${theme.primaryColor}|${theme.accentColor}|${theme.secondaryColor}|${(palette ?? []).join(',')}`;
  };
  const applySong = (next: LumiereSongInput | null): void => {
    if (!runtime) return;
    const signature = next
      ? `${next.trackKey}|${next.lines.length}|${next.lines[0]?.timeMs ?? 0}|${next.lines[next.lines.length - 1]?.timeMs ?? 0}|${next.durationMs}|${next.lyricOffsetMs}|${themeSignature()}`
      : `empty|${themeSignature()}`;
    if (signature === songSignature) return;
    const hasLines = (next?.lines.length ?? 0) > 0;
    const hadContent = root.classList.contains('is-content');
    // 同一首歌重新拉歌词时会短暂给空列表：别把已经画出来的歌词换掉。
    if (!hasLines && hadContent && (next?.trackKey ?? '') === appliedTrackKey) return;
    songSignature = signature;
    appliedTrackKey = next?.trackKey ?? '';
    metadata = {
      title: next?.title ?? '',
      artist: next?.artist ?? '',
      album: next?.album ?? '',
    };
    runtime.setSongMetadata(metadata);
    const context = buildSongContext(next);
    // 有歌词内容才允许收起 DOM 歌词：歌词还没到手时舞台是空的，藏掉文字会露出灰页。
    root.classList.toggle('is-content', hasLines);
    renderedSeconds = Number.NaN;
    // 从「没字的空段落」第一次拿到歌词时直接整段替换，避免两帧换场中途停在没字的旧场景上。
    if (hasLines && !hadContent) runtime.replaceSong(context);
    else void runtime.swapSong(context);
  };

  const start = (): void => {
    if (starting || runtime || disposed || failed) return;
    starting = true;
    abort = new AbortController();
    const controller = abort;
    const context = buildSongContext(song);
    songSignature = song
      ? `${song.trackKey}|${song.lines.length}|${song.lines[0]?.timeMs ?? 0}|${song.lines[song.lines.length - 1]?.timeMs ?? 0}|${song.durationMs}|${song.lyricOffsetMs}|${themeSignature()}`
      : `empty|${themeSignature()}`;
    metadata = {
      title: song?.title ?? '',
      artist: song?.artist ?? '',
      album: song?.album ?? '',
    };
    syncPlayer();
    currentTime.set(anchorMs / 1000);
    void LumierePixiRuntime.create({
      host: root,
      song: context,
      tuning,
      currentTime,
      audioPower,
      audioBands,
      staticMode: false,
      showText: true,
      paused: !playing,
      metadata,
      signal: controller.signal,
    })
      .then((instance) => {
        starting = false;
        if (disposed || mode === 'off' || controller.signal.aborted) {
          instance.destroy();
          return;
        }
        runtime = instance;
        // 创建期间用户可能在设置面板里拖过参数：把最新的 tuning 补推一次。
        instance.setTuning(tuning);
        root.classList.remove('is-failed');
        root.classList.add('is-ready');
        // 页面刚打开时歌词是异步拉的：创建运行时用的还是空歌词，这里按最新的 song 再换一次，
        // 否则纯字档只剩背景没有字（要切换一下效果才会重建）。
        songSignature = '';
        applySong(song);
        painted = false;
        probeFrame = 0;
        renderedSeconds = Number.NaN;
        if (!active) return;
        const seconds = playing ? (anchorMs + (performance.now() - anchorAt)) / 1000 : anchorMs / 1000;
        currentTime.set(seconds);
      })
      .catch((err: unknown) => {
        starting = false;
        failed = true;
        console.warn('[lumiere] folia runtime unavailable', err);
        root.classList.remove('is-ready');
        // 运行时起不来看不到画面：让 CSS 兜底把 DOM 歌词放回来，别留一页灰。
        root.classList.add('is-failed');
      });
  };

  const stop = (): void => {
    if (raf) {
      window.cancelAnimationFrame(raf);
      raf = 0;
    }
    abort?.abort();
    abort = null;
    starting = false;
    runtime?.destroy();
    runtime = null;
    painted = false;
    probeFrame = 0;
    renderedSeconds = Number.NaN;
    root.classList.remove('is-ready', 'is-content', 'is-painted');
  };

  return {
    root,

    setMode(next: LumiereMode): void {
      mode = next;
    },

    setSong(input: LumiereSongInput | null): void {
      song = input;
      applySong(input);
    },

    setTheme(next: Theme, nextPalette?: string[] | null): void {
      const paletteKey = (value: string[] | null | undefined) => (value ?? []).join(',');
      if (
        next.accentColor === theme.accentColor
        && next.primaryColor === theme.primaryColor
        && next.secondaryColor === theme.secondaryColor
        && next.backgroundColor === theme.backgroundColor
        && paletteKey(nextPalette ?? palette) === paletteKey(palette)
      ) return;
      theme = next;
      palette = nextPalette === undefined ? palette : nextPalette ? [...nextPalette] : null;
      if (!runtime) return;
      songSignature = '';
      // 歌词还没到（舞台里是空段落）时只记颜色，等 applySong 用新主题建场景；
      // 这时候换场景会把画面换成「没字的空段落」，正是「只剩背景」的来源。
      if (!song || song.lines.length === 0) return;
      void runtime.swapSong(buildSongContext(song)).then(() => {
        // 暂停时 pixi ticker 是停的：换完歌补一帧，别等下一次时间变化。
        runtime?.renderOnce();
      });
    },

    activate(): void {
      if (disposed) return;
      if (teardownTimer) {
        window.clearTimeout(teardownTimer);
        teardownTimer = 0;
      }
      if (active) return;
      active = true;
      failed = false;
      root.classList.remove('is-failed');
      root.classList.add('is-on');
      // 运行时还在（还没被 teardown 销毁）时直接把 ready 补回来，避免快速来回切档后画面一直不出现。
      if (runtime) {
        root.classList.add('is-ready');
        if (painted) root.classList.add('is-painted');
      }
      start();
      if (!raf) raf = window.requestAnimationFrame(tick);
    },

    deactivate(): void {
      if (!active) return;
      active = false;
      // 先摘掉 is-on：CSS 把舞台淡出；等淡出结束再销毁 Pixi 运行时，避免黑场硬切。
      // is-ready / is-content / is-painted 先留着：760ms 内又切回来时画布还带着上一帧，直接淡入即可。
      root.classList.remove('is-on');
      if (raf) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      }
      if (teardownTimer) window.clearTimeout(teardownTimer);
      teardownTimer = window.setTimeout(() => {
        teardownTimer = 0;
        if (active || disposed) return;
        stop();
        root.textContent = '';
      }, 760);
    },

    pulse(): void {
      // 绘光由播放时间驱动，换句不需要额外触发。
    },

    applyTextSettings(next?: LyricTextSettings): void {
      // 文字设置只服务于「纯字」档；绘光舞台忽略。
      if (!textOnly) return;
      const previous = tuning;
      tuning = tuningWithSettings(textOnly, next ?? lyricTextSettings());
      if (!runtime) return;
      // 大部分参数只是渲染参数：直接推给运行时，下一帧就生效。
      runtime.setTuning(tuning);
      // 无缝过渡会改变整首曲子的编译结果（段落合并方式不同），只能重新编译并换歌。
      if (previous.seamlessTransitions !== tuning.seamlessTransitions) {
        songSignature = '';
        void runtime.swapSong(buildSongContext(song));
      }
    },

    dispose(): void {
      disposed = true;
      active = false;
      if (teardownTimer) {
        window.clearTimeout(teardownTimer);
        teardownTimer = 0;
      }
      unsubscribe();
      stop();
      root.remove();
    },
  };
}
