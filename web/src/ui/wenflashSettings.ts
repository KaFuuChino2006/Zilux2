const key = 'zilux2.wenflash.entry';
export type WenflashOrder = 'time' | 'random' | 'all-random';
export type WenflashGlowColorMode = 'keyword' | 'custom';
export type WenflashTextColorMode = 'cover' | 'custom' | 'complement';
export type WenflashBackdropMode = 'cover' | 'custom' | 'black' | 'white';
export type WenflashLyrics = 'whole' | 'split' | 'mixed';
export type WenflashArrangement = 'horizontal' | 'vertical' | 'mixed' | 'graphic';
export type WenflashGraphicShape = 'ring' | 'wave' | 'burst';
export type WenflashLinePlacement = 'follow' | 'direction' | 'random';
export type WenflashLineDirection = 'south' | 'southeast' | 'east' | 'northeast'
  | 'north' | 'northwest' | 'west' | 'southwest';
export type WenflashLineDirectionMode = 'fixed' | 'rotate' | 'random';
const LINE_DIRECTIONS: WenflashLineDirection[] = [
  'south', 'southeast', 'east', 'northeast', 'north', 'northwest', 'west', 'southwest',
];
const readLineDirection = (value: unknown): WenflashLineDirection => (
  LINE_DIRECTIONS.includes(value as WenflashLineDirection) ? value as WenflashLineDirection : 'south'
);
export type WenflashEntryStyle = 'wenflash' | 'overlap' | 'both';
export const defaultEntrySizes = {sizeMin: 1.3, sizeMax: 1.8};
const readSize = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value)
  ? Math.max(1, Math.min(3, value)) : fallback;
const readNumber = (value: unknown, fallback: number, min: number, max: number) => (
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback
);
const readInt = (value: unknown, fallback: number, min: number, max: number) => (
  Math.round(readNumber(value, fallback, min, max))
);
export const defaultEntryCurve = () => [1/3, 1/3, 2/3, 2/3];
const unit = (v: number) => Math.max(0, Math.min(1, v));
export interface WenflashSettings {
  decorIntensity: number;
  sizeMin: number;
  sizeMax: number;
  enabled: boolean;
  curve: number[];
  /** 镜头平移速度曲线；横轴是本句演唱进度，纵轴是相对速度。 */
  cameraCurve: number[];
  /** 镜头缩放速度曲线；与平移分开，横轴是本句演唱进度，纵轴是相对速度。 */
  cameraZoomCurve: number[];
  /** 下一句镜头提前叠加的秒数；0 表示等上一段结束再换目标。 */
  cameraOverlap: number;
  /** 缩放和位置共用同一个错帧时长；关闭后可分别设置。 */
  cameraOverlapLinked: boolean;
  /** 分开设置时，缩放单独使用的错帧时长。 */
  cameraZoomOverlap: number;
  /** 镜头抽帧帧率；0/1 为连续跟随，2–24 为每秒更新镜头姿态的次数。 */
  cameraSteps: number;
  /** 整幅画面的重绘帧率；0/1 为原生，2–30 真正限制 Pixi 画布重绘。 */
  renderFps: number;
  /** How the overlap's per-glyph entrance is combined with the wenflash size ramp. */
  entryStyle: WenflashEntryStyle;
  /** Seconds to wait after a glyph starts before its size ramp begins. */
  entryDelay: number;
  /** Seconds the size ramp takes to go from the initial scale to 1. */
  entryZoom: number;
  /** Chance that a glyph arrives through a random defocus, in percent. */
  entryBlurChance: number;
  /** Peak strength of the random arrival blur over the wet-ink base, in percent. */
  entryBlurAmount: number;
  /** Base seconds the arrival blur takes to settle; each glyph varies around it. */
  entryBlurDuration: number;
  /** 每个字沿自己的入场方向拉伸的开关。 */
  stretch: boolean;
  /** 拉伸倍率；1 等于不拉伸。 */
  stretchAmount: number;
  /** 拉伸从设定倍率收回 1 倍所需的秒数。 */
  stretchDuration: number;
  /** 拉伸收回的抽帧级数；0 为连续，2–24 为离散台阶。 */
  stretchSteps: number;
  /** Chance that a landed line gets a stepped zoom pulse, in percent. */
  postZoomChance: number;
  /** Chance that the step pulse becomes a left-to-right travelling wave, in percent. */
  postZoomWaveChance: number;
  /** Upper scale bound of the stepped zoom pulse. */
  postZoomScale: number;
  /** Seconds the stepped zoom pulse lasts. */
  postZoomDuration: number;
  /** Number of discrete steps in the stepped zoom pulse. */
  postZoomSteps: number;
  splitLyrics: boolean;
  /** `mixed` alternates whole-line and split-phrase lines; it implies splitLyrics for styling. */
  mixedLyrics: boolean;
  /** 拆分/混合档每个短句最多几个汉字；1 最碎，8 接近整句。 */
  phraseSize: number;
  order: WenflashOrder;
  /** How the kept phrase is laid out on screen. */
  arrangement: WenflashArrangement;
  /** Shape used when `arrangement` is `graphic`. */
  graphicShape: WenflashGraphicShape;
  /** How each new lyric line is placed: after the previous line, in one of 8 directions, or at a seeded random spot. */
  linePlacement: WenflashLinePlacement;
  /** Direction used by `linePlacement: 'direction'`. */
  lineDirection: WenflashLineDirection;
  /** How the 8-way direction evolves: fixed, rotate 45° per line, or seeded random per line. */
  lineDirectionMode: WenflashLineDirectionMode;
  /** Seconds after the whole shot has landed before its sung blur starts. */
  blurDelay: number;
  /** Sung blur strength in percent of the font-derived maximum; 0 turns it off. */
  blurAmount: number;
  /** Multiplier on the shared keyword-glow strength, in percent. */
  glowStrength: number;
  /** Multiplier on the font-derived glow blur radius, in percent. */
  glowRadius: number;
  /** Opacity of a non-keyword glow relative to a keyword glow, in percent. */
  glowPlain: number;
  /** Chance that a non-keyword glyph gets a glow, in percent; keywords always glow. */
  glowChance: number;
  /** Multiplier on the gradient's scroll speed, in percent. */
  glowFlowSpeed: number;
  /** Multiplier on the gradient's spatial frequency, in percent. */
  glowFlowScale: number;
  /** Lyric ink source: follow the cover, use one custom colour, or use the cover's complement. */
  textColorMode: WenflashTextColorMode;
  /** Base ink for custom mode. */
  textColor: string;
  /** Chance that a non-keyword glyph takes an alternate ink, in percent. */
  textColorChance: number;
  /** How many distinct alternate inks the per-line palette draws from. */
  textColorCount: number;
  /** Whole-stage backdrop: cover, one custom colour, black, or white. */
  backdropMode: WenflashBackdropMode;
  backdropColor: string;
  /** Gradient palette source: follow the keyword colour, or use the three custom stops. */
  glowColorMode: WenflashGlowColorMode;
  glowColorA: string;
  glowColorB: string;
  glowColorC: string;
  /** Chance that a shot uses the flash entrance, in percent. */
  chance: number;
  /** Number of bright/dark cycles inside the entry flash window. */
  flashCount: number;
  /** Total flash window in seconds, measured from the glyph's own start time. */
  flashWindow: number;
  /** Share of each cycle spent dark, in percent. */
  flashDark: number;
  /** Opacity of the dark beat, in percent. */
  flashDim: number;
  /** Chance that a bright beat prints the solid block, in percent. */
  solidChance: number;
  /** Chance that a bright beat turns the glyph into the hollow outline, in percent. */
  outlineChance: number;
  /** Chance that a shot prints one full-line block that sweeps across and vanishes, in percent. */
  lineBlockChance: number;
  /** Full-line block expansion beyond the measured ink box, in percent of the font size. */
  lineBlockPadding: number;
  /** Opacity of the full-line block, in percent. */
  lineBlockAlpha: number;
  /** Seconds the full-line block takes to sweep across the phrase and disappear. */
  lineBlockSweep: number;
  /** Block expansion beyond the measured ink box, in percent of the font size. */
  blockPadding: number;
  /** Opacity of the solid block, in percent. */
  blockAlpha: number;
  /** Outline stroke width, in percent of the font size. */
  outlineWidth: number;
  /** Keep the hollow outline after the bright beat that selected it. */
  hollowLinger: boolean;
  /** Chance that a glyph selected for the outline keeps it, in percent. */
  hollowLingerChance: number;
  /** Seconds the kept outline lasts; 0 keeps it until the line ends. */
  hollowLingerDuration: number;
  /** 文闪独立的镜头撞击概率，0..100。 */
  shakeChance: number;
  /** 撞击位移基准，单位 px。 */
  shakePx: number;
  /** 撞击回弹弹性。 */
  shakeElastic: number;
  /** 撞击横向分量。 */
  shakeX: number;
  /** 撞击纵向分量。 */
  shakeY: number;
  /** 撞击沿视线方向的推拉位移。 */
  shakeZ: number;
  /** 撞击瞬间的 Z 压缩，单位百分比。 */
  shakeDepth: number;
  /** 撞击滚转，单位度。 */
  shakeRollDeg: number;
  /** 撞击从 0 到满力度的秒数。 */
  shakeAttack: number;
  /** 撞击余振频率倍率；0 只推一下。 */
  shakeSwing: number;
  /** 当前句唱到百分之多少时撞击。 */
  shakeAt: number;
  /** 撞击余振衰减速度。 */
  shakeDamping: number;
  /** 文闪独立的镜头畸变。 */
  lensDistortion: number;
  /** 文闪独立的色版偏移。 */
  rgbShift: number;
  /** 文闪独立的纸面颗粒。 */
  grain: number;
  /** 文闪独立的对比度。 */
  contrast: number;
  /** 文闪独立的暗角。 */
  vignette: number;
  /** 整句跑马框：两条辉光线绕这句的外框追逐。 */
  marquee: boolean;
  /** Chance that a sentence gets the marquee frame, in percent. */
  marqueeChance: number;
  /** Seconds one light line takes to travel around the frame once. */
  marqueeDuration: number;
  /** Each light line's length, in percent of the frame perimeter. */
  marqueeLength: number;
  /** Frame padding beyond the sentence box, in em. */
  marqueePadding: number;
  /** Light line width, in percent of the font size. */
  marqueeWidth: number;
  /** Glow strength behind the light lines, in percent. */
  marqueeGlow: number;
  /** Seconds after the line starts before the frame begins to appear. */
  marqueeEntryDelay: number;
  /** Seconds the frame takes to fade in. */
  marqueeEntryFade: number;
  /** Scale the frame starts at; 1 means it appears at full size. */
  marqueeEntryScale: number;
  /** Seconds the frame keeps running before it starts braking; 0 never brakes. */
  marqueeRun: number;
  /** Seconds the frame takes to ease to a stop once braking starts. */
  marqueeBrake: number;
  /** 单条底部光线：画在整句下方的辉光线。 */
  bottomLine: boolean;
  /** Chance that a sentence gets the bottom line, in percent. */
  bottomLineChance: number;
  /** Line length, in percent of the sentence width. */
  bottomLineLength: number;
  /** Line thickness, in percent of the font size. */
  bottomLineWidth: number;
  /** Glow strength behind the line, in percent. */
  bottomLineGlow: number;
  /** Distance below the sentence box, in em. */
  bottomLineOffset: number;
  /** Seconds one left-to-right pass takes; 0 keeps the line still. */
  bottomLineSpeed: number;
  /** Seconds the line keeps moving before it starts braking; 0 never brakes. */
  bottomLineRun: number;
  /** Seconds the line takes to ease to a stop once braking starts. */
  bottomLineBrake: number;
  /** Seconds the line takes to fade in. */
  bottomLineFade: number;
}
export const defaultWenflashSettings = (): WenflashSettings => ({
  decorIntensity: 80,
  ...defaultEntrySizes,
  enabled: true,
  curve: defaultEntryCurve(),
  cameraCurve: defaultEntryCurve(),
  cameraZoomCurve: defaultEntryCurve(),
  cameraOverlap: 0.8,
  cameraOverlapLinked: true,
  cameraZoomOverlap: 0.8,
  cameraSteps: 0,
  renderFps: 0,
  entryStyle: 'both',
  entryDelay: 0.3,
  entryZoom: 1,
  entryBlurChance: 45,
  entryBlurAmount: 100,
  entryBlurDuration: 0.42,
  stretch: true,
  stretchAmount: 14,
  stretchDuration: 0.1,
  stretchSteps: 7,
  postZoomChance: 30,
  postZoomWaveChance: 35,
  postZoomScale: 1.6,
  postZoomDuration: 0.34,
  postZoomSteps: 7,
  splitLyrics: false,
  mixedLyrics: false,
  phraseSize: 3,
  order: 'time',
  arrangement: 'horizontal',
  graphicShape: 'ring',
  linePlacement: 'follow',
  lineDirection: 'south',
  lineDirectionMode: 'fixed',
  blurDelay: 1.2,
  blurAmount: 45,
  glowStrength: 100,
  glowRadius: 100,
  glowPlain: 70,
  glowChance: 100,
  glowFlowSpeed: 100,
  glowFlowScale: 100,
  textColorMode: 'cover',
  textColor: '#f2efe6',
  textColorChance: 0,
  textColorCount: 8,
  backdropMode: 'cover',
  backdropColor: '#0d0d12',
  glowColorMode: 'keyword',
  glowColorA: '#ff5c8a',
  glowColorB: '#ffd166',
  glowColorC: '#7bdff2',
  chance: 35,
  flashCount: 4,
  flashWindow: 0.3,
  flashDark: 45,
  flashDim: 5,
  solidChance: 25,
  outlineChance: 25,
  lineBlockChance: 35,
  lineBlockPadding: 0,
  lineBlockAlpha: 100,
  lineBlockSweep: 0.55,
  blockPadding: 0,
  blockAlpha: 100,
  outlineWidth: 3.5,
  hollowLinger: true,
  hollowLingerChance: 35,
  hollowLingerDuration: 0,
  shakeChance: 35,
  shakePx: 47,
  shakeElastic: 5,
  shakeX: 0.65,
  shakeY: 0.95,
  shakeZ: 70,
  shakeDepth: 0,
  shakeRollDeg: 7.6,
  shakeAttack: 0.34,
  shakeSwing: 0.4,
  shakeAt: 0,
  shakeDamping: 1.75,
  lensDistortion: 0.15,
  rgbShift: 0,
  grain: 0,
  contrast: 0,
  vignette: 0,
  marquee: true,
  marqueeChance: 25,
  marqueeDuration: 3.6,
  marqueeLength: 22,
  marqueePadding: 0.6,
  marqueeWidth: 5,
  marqueeGlow: 60,
  marqueeEntryDelay: 0.08,
  marqueeEntryFade: 0.32,
  marqueeEntryScale: 1,
  marqueeRun: 0,
  marqueeBrake: 1.2,
  bottomLine: true,
  bottomLineChance: 30,
  bottomLineLength: 70,
  bottomLineWidth: 5,
  bottomLineGlow: 55,
  bottomLineOffset: 0.5,
  bottomLineSpeed: 4.5,
  bottomLineRun: 0,
  bottomLineBrake: 1.2,
  bottomLineFade: 0.4,
});
function readColor(input: unknown, fallback: string): string {
  return typeof input === 'string' && /^#[0-9a-f]{6}$/i.test(input) ? input : fallback;
}
function readCurve(input: unknown): number[] {
  if (!Array.isArray(input) || !input.every(Number.isFinite)) return defaultEntryCurve();
  if (input.length === 4) return input.map((v,i) => i % 2 ? Math.max(-1, Math.min(2,v)) : unit(v));
  if (input.length === 9) {
    // Fit the two control heights to the previously saved progress samples.
    let aa=0, ab=0, bb=0, ay=0, by=0;
    for (let i=1; i<8; i++) {
      const t=i/8, a=3*t*(1-t)**2, b=3*t*t*(1-t), y=input[i]-t**3;
      aa+=a*a; ab+=a*b; bb+=b*b; ay+=a*y; by+=b*y;
    }
    const det=aa*bb-ab*ab;
    return [1/3, unit((ay*bb-by*ab)/det), 2/3, unit((by*aa-ay*ab)/det)];
  }
  return defaultEntryCurve();
}
function readSettings(): WenflashSettings {
  const fallback = defaultWenflashSettings();
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}');
    const sizeMin = readSize(value?.sizeMin, fallback.sizeMin);
    const mixedLyrics = value?.mixedLyrics === true;
    const solidChance = readNumber(value?.solidChance, fallback.solidChance, 0, 100);
    const outlineChance = readNumber(value?.outlineChance, fallback.outlineChance, 0, 100);
    return {
      sizeMin,
      sizeMax: Math.max(sizeMin, readSize(value?.sizeMax, fallback.sizeMax)),
      enabled: value?.enabled !== false,
      curve: readCurve(value?.curve),
      cameraCurve: readCurve(value?.cameraCurve),
      cameraZoomCurve: readCurve(value?.cameraZoomCurve),
      cameraOverlap: readNumber(value?.cameraOverlap, fallback.cameraOverlap, 0, 2),
      cameraOverlapLinked: value?.cameraOverlapLinked !== false,
      cameraZoomOverlap: readNumber(value?.cameraZoomOverlap, fallback.cameraZoomOverlap, 0, 2),
      cameraSteps: readInt(value?.cameraSteps, fallback.cameraSteps, 0, 24),
      renderFps: readInt(value?.renderFps, fallback.renderFps, 0, 30),
      entryStyle: value?.entryStyle === 'wenflash' ? 'wenflash'
        : value?.entryStyle === 'overlap' ? 'overlap' : 'both',
      entryDelay: readNumber(value?.entryDelay, fallback.entryDelay, 0, 1.5),
      entryZoom: readNumber(value?.entryZoom, fallback.entryZoom, 0.2, 3),
      entryBlurChance: readNumber(value?.entryBlurChance, fallback.entryBlurChance, 0, 100),
      entryBlurAmount: readNumber(value?.entryBlurAmount, fallback.entryBlurAmount, 0, 200),
      entryBlurDuration: readNumber(value?.entryBlurDuration, fallback.entryBlurDuration, 0.1, 1.2),
      stretch: value?.stretch !== false,
      stretchAmount: readNumber(value?.stretchAmount, fallback.stretchAmount, 2, 40),
      stretchDuration: readNumber(value?.stretchDuration, fallback.stretchDuration, 0.02, 0.4),
      stretchSteps: readInt(value?.stretchSteps, fallback.stretchSteps, 0, 24),
      postZoomChance: readNumber(value?.postZoomChance, fallback.postZoomChance, 0, 100),
      postZoomWaveChance: readNumber(value?.postZoomWaveChance, fallback.postZoomWaveChance, 0, 100),
      postZoomScale: value?.postZoomScale === 1.12
        ? 1.6
        : readNumber(value?.postZoomScale, fallback.postZoomScale, 1.05, 3),
      postZoomDuration: readNumber(value?.postZoomDuration, fallback.postZoomDuration, 0.08, 1.5),
      postZoomSteps: readInt(value?.postZoomSteps, fallback.postZoomSteps, 2, 24),
      splitLyrics: mixedLyrics || value?.splitLyrics === true,
      mixedLyrics,
      phraseSize: readInt(value?.phraseSize, fallback.phraseSize, 1, 8),
      order: value?.order === 'random' ? 'random'
        : value?.order === 'all-random' ? 'all-random' : 'time',
      arrangement: value?.arrangement === 'vertical' ? 'vertical'
        : value?.arrangement === 'mixed' ? 'mixed'
          : value?.arrangement === 'graphic' ? 'graphic' : 'horizontal',
      graphicShape: value?.graphicShape === 'wave' ? 'wave'
        : value?.graphicShape === 'burst' ? 'burst' : 'ring',
      linePlacement: value?.linePlacement === 'random' ? 'random'
        : value?.linePlacement === 'direction' ? 'direction' : 'follow',
      lineDirection: readLineDirection(value?.lineDirection),
      lineDirectionMode: value?.lineDirectionMode === 'rotate' ? 'rotate'
        : value?.lineDirectionMode === 'random' ? 'random' : 'fixed',
      blurDelay: readNumber(value?.blurDelay, fallback.blurDelay, 0, 8),
      blurAmount: readNumber(value?.blurAmount, fallback.blurAmount, 0, 100),
      glowStrength: readNumber(value?.glowStrength, fallback.glowStrength, 0, 200),
      decorIntensity: readNumber(value?.decorIntensity, fallback.decorIntensity, 0, 100),
      glowRadius: readNumber(value?.glowRadius, fallback.glowRadius, 20, 300),
      glowPlain: readNumber(value?.glowPlain, fallback.glowPlain, 0, 100),
      glowChance: readNumber(value?.glowChance, fallback.glowChance, 0, 100),
      glowFlowSpeed: readNumber(value?.glowFlowSpeed, fallback.glowFlowSpeed, 0, 300),
      glowFlowScale: readNumber(value?.glowFlowScale, fallback.glowFlowScale, 30, 300),
      textColorMode: value?.textColorMode === 'custom' ? 'custom' : value?.textColorMode === 'complement' ? 'complement' : 'cover',
      textColor: readColor(value?.textColor, fallback.textColor),
      textColorChance: readNumber(value?.textColorChance, fallback.textColorChance, 0, 100),
      textColorCount: Math.round(readNumber(value?.textColorCount, fallback.textColorCount, 2, 32)),
      backdropMode: value?.backdropMode === 'custom' || value?.backdropMode === 'black' || value?.backdropMode === 'white'
        ? value.backdropMode
        : 'cover',
      backdropColor: readColor(value?.backdropColor, fallback.backdropColor),
      glowColorMode: value?.glowColorMode === 'custom' ? 'custom' : 'keyword',
      glowColorA: readColor(value?.glowColorA, fallback.glowColorA),
      glowColorB: readColor(value?.glowColorB, fallback.glowColorB),
      glowColorC: readColor(value?.glowColorC, fallback.glowColorC),
      chance: readNumber(value?.chance, fallback.chance, 0, 100),
      flashCount: readInt(value?.flashCount, fallback.flashCount, 1, 8),
      flashWindow: readNumber(value?.flashWindow, fallback.flashWindow, 0.1, 1.2),
      flashDark: readNumber(value?.flashDark, fallback.flashDark, 0, 100),
      flashDim: readNumber(value?.flashDim, fallback.flashDim, 0, 100),
      solidChance,
      outlineChance,
      lineBlockChance: readNumber(value?.lineBlockChance, fallback.lineBlockChance, 0, 100),
      lineBlockPadding: readNumber(value?.lineBlockPadding, fallback.lineBlockPadding, 0, 20),
      lineBlockAlpha: readNumber(value?.lineBlockAlpha, fallback.lineBlockAlpha, 0, 100),
      lineBlockSweep: readNumber(value?.lineBlockSweep, fallback.lineBlockSweep, 0.1, 3),
      blockPadding: readNumber(value?.blockPadding, fallback.blockPadding, 0, 20),
      blockAlpha: readNumber(value?.blockAlpha, fallback.blockAlpha, 0, 100),
      outlineWidth: readNumber(value?.outlineWidth, fallback.outlineWidth, 0.5, 10),
      hollowLinger: value?.hollowLinger !== false,
      hollowLingerChance: readNumber(value?.hollowLingerChance, fallback.hollowLingerChance, 0, 100),
      hollowLingerDuration: readNumber(value?.hollowLingerDuration, fallback.hollowLingerDuration, 0, 8),
      shakeChance: readNumber(value?.shakeChance, fallback.shakeChance, 0, 100),
      shakePx: readNumber(value?.shakePx, fallback.shakePx, 0, 320),
      shakeElastic: readNumber(value?.shakeElastic, fallback.shakeElastic, 0.3, 5),
      shakeX: readNumber(value?.shakeX, fallback.shakeX, 0, 4),
      shakeY: readNumber(value?.shakeY, fallback.shakeY, 0, 4),
      shakeZ: readNumber(value?.shakeZ, fallback.shakeZ, 0, 400),
      shakeDepth: readNumber(value?.shakeDepth, fallback.shakeDepth, 0, 24),
      shakeRollDeg: readNumber(value?.shakeRollDeg, fallback.shakeRollDeg, 0, 8),
      shakeAttack: readNumber(value?.shakeAttack, fallback.shakeAttack, 0.01, 0.6),
      shakeSwing: readNumber(value?.shakeSwing, fallback.shakeSwing, 0, 4),
      shakeAt: readNumber(value?.shakeAt, fallback.shakeAt, 0, 100),
      shakeDamping: readNumber(value?.shakeDamping, fallback.shakeDamping, 0.2, 6),
      lensDistortion: readNumber(value?.lensDistortion, fallback.lensDistortion, 0, 2),
      rgbShift: readNumber(value?.rgbShift, fallback.rgbShift, 0, 1),
      grain: readNumber(value?.grain, fallback.grain, 0, 1),
      contrast: readNumber(value?.contrast, fallback.contrast, 0, 1),
      vignette: readNumber(value?.vignette, fallback.vignette, 0, 2),
      marquee: value?.marquee !== false,
      marqueeChance: readNumber(value?.marqueeChance, fallback.marqueeChance, 0, 100),
      marqueeDuration: readNumber(value?.marqueeDuration, fallback.marqueeDuration, 0.8, 12),
      marqueeLength: readNumber(value?.marqueeLength, fallback.marqueeLength, 5, 45),
      marqueePadding: readNumber(value?.marqueePadding, fallback.marqueePadding, 0, 2),
      marqueeWidth: readNumber(value?.marqueeWidth, fallback.marqueeWidth, 1, 20),
      marqueeGlow: readNumber(value?.marqueeGlow, fallback.marqueeGlow, 0, 100),
      marqueeEntryDelay: readNumber(value?.marqueeEntryDelay, fallback.marqueeEntryDelay, 0, 2),
      marqueeEntryFade: readNumber(value?.marqueeEntryFade, fallback.marqueeEntryFade, 0.05, 2),
      marqueeEntryScale: readNumber(value?.marqueeEntryScale, fallback.marqueeEntryScale, 0.6, 1.4),
      marqueeRun: readNumber(value?.marqueeRun, fallback.marqueeRun, 0, 30),
      marqueeBrake: readNumber(value?.marqueeBrake, fallback.marqueeBrake, 0.1, 8),
      bottomLine: value?.bottomLine !== false,
      bottomLineChance: readNumber(value?.bottomLineChance, fallback.bottomLineChance, 0, 100),
      bottomLineLength: readNumber(value?.bottomLineLength, fallback.bottomLineLength, 10, 100),
      bottomLineWidth: readNumber(value?.bottomLineWidth, fallback.bottomLineWidth, 1, 20),
      bottomLineGlow: readNumber(value?.bottomLineGlow, fallback.bottomLineGlow, 0, 100),
      bottomLineOffset: readNumber(value?.bottomLineOffset, fallback.bottomLineOffset, 0, 2),
      bottomLineSpeed: Math.max(0.5, readNumber(value?.bottomLineSpeed, fallback.bottomLineSpeed, 0, 20) || fallback.bottomLineSpeed),
      bottomLineFade: readNumber(value?.bottomLineFade, fallback.bottomLineFade, 0.05, 2),
      bottomLineRun: readNumber(value?.bottomLineRun, fallback.bottomLineRun, 0, 30),
      bottomLineBrake: readNumber(value?.bottomLineBrake, fallback.bottomLineBrake, 0.1, 8),
    };
  } catch {
    return fallback;
  }
}
let settings: WenflashSettings = readSettings();
export function wenflashDecorIntensity(): number {
  return settings.decorIntensity / 100;
}
let revision = 0;
export const WENFLASH_SPLIT_EVENT = 'zilux2:wenflash-split';
function apply(value: WenflashSettings) {
  const structureChanged = settings.splitLyrics !== value.splitLyrics
    || settings.mixedLyrics !== value.mixedLyrics
    || settings.phraseSize !== value.phraseSize
    || settings.order !== value.order
    || settings.arrangement !== value.arrangement
    || settings.graphicShape !== value.graphicShape
    || settings.linePlacement !== value.linePlacement
    || settings.lineDirection !== value.lineDirection
    || settings.lineDirectionMode !== value.lineDirectionMode
    || settings.textColorMode !== value.textColorMode
    || settings.textColor !== value.textColor
    || settings.textColorChance !== value.textColorChance
    || settings.textColorCount !== value.textColorCount
    || settings.backdropMode !== value.backdropMode
    || settings.backdropColor !== value.backdropColor
    || settings.lensDistortion !== value.lensDistortion
    || settings.rgbShift !== value.rgbShift
    || settings.grain !== value.grain
    || settings.contrast !== value.contrast
    || settings.vignette !== value.vignette
    || settings.glowChance !== value.glowChance;
  settings = {...value, curve: [...value.curve], cameraCurve: [...value.cameraCurve], cameraZoomCurve: [...value.cameraZoomCurve]};
  revision += 1;
  if (structureChanged && typeof window !== 'undefined') window.dispatchEvent(new Event(WENFLASH_SPLIT_EVENT));
}
// 纯函数测试会在没有 DOM 的沙箱里直接加载本模块（temperaShotFrame 依赖入场曲线），
// 顶层注册监听必须容忍 window 不存在；浏览器里行为不变。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) apply(readSettings());
  });
}
export const wenflashRevision = () => revision;
export function wenflashEntryChance(): number {
  return settings.enabled ? settings.chance / 100 : 0;
}
export function wenflashLayout(): WenflashLyrics {
  return settings.mixedLyrics ? 'mixed' : settings.splitLyrics ? 'split' : 'whole';
}
/** 拆分档每个短句最多几个汉字；1 最碎，8 接近整句。 */
export function wenflashPhraseSize(): number {
  return Math.max(1, Math.min(8, Math.round(settings.phraseSize)));
}
export function wenflashArrangement(): WenflashArrangement {
  return settings.arrangement;
}
export function wenflashLinePlacement(): WenflashLinePlacement {
  return settings.linePlacement;
}
export function wenflashLineDirection(): WenflashLineDirection {
  return settings.lineDirection;
}
export function wenflashLineDirectionMode(): WenflashLineDirectionMode {
  return settings.lineDirectionMode;
}
export function wenflashEntryStyle(): WenflashEntryStyle {
  return settings.entryStyle;
}
export function wenflashEntryDelay(): number {
  return Math.max(0, settings.entryDelay);
}
export function wenflashEntryZoom(): number {
  return Math.max(0.05, settings.entryZoom);
}
export function wenflashEntryBlurChance(): number {
  return unit(settings.entryBlurChance / 100);
}
export function wenflashEntryBlurAmount(): number {
  return unit(settings.entryBlurAmount / 100);
}
export function wenflashEntryBlurDuration(): number {
  return Math.max(0.1, settings.entryBlurDuration);
}
/** 入场拉伸倍率；关闭时返回 1。 */
export function wenflashStretchAmount(): number {
  return settings.stretch ? Math.max(1, settings.stretchAmount) : 1;
}
/** 拉伸收回时长；关闭时返回 0。 */
export function wenflashStretchDuration(): number {
  return settings.stretch ? Math.max(0.02, settings.stretchDuration) : 0;
}
/** 拉伸收回的抽帧级数；0 为连续，关闭时返回 0。 */
export function wenflashStretchSteps(): number {
  return settings.stretch ? Math.max(0, Math.round(settings.stretchSteps)) : 0;
}
export function wenflashPostZoomChance(): number {
  return settings.enabled ? unit(settings.postZoomChance / 100) : 0;
}
export function wenflashPostZoomWaveChance(): number {
  return settings.enabled ? unit(settings.postZoomWaveChance / 100) : 0;
}
export function wenflashPostZoomScale(): number {
  return Math.max(1.01, settings.postZoomScale);
}
export function wenflashPostZoomDuration(): number {
  return Math.max(0.08, settings.postZoomDuration);
}
export function wenflashPostZoomSteps(): number {
  return Math.max(2, Math.round(settings.postZoomSteps));
}
export function wenflashGraphicShape(): WenflashGraphicShape {
  return settings.graphicShape;
}
export function wenflashBlurDelay(): number {
  return Math.max(0, settings.blurDelay);
}
export function wenflashBlurAmount(): number {
  return unit(settings.blurAmount / 100);
}
export function wenflashTextColorMode(): WenflashTextColorMode {
  return settings.textColorMode;
}
export function wenflashTextColor(): string {
  return settings.textColor;
}
export function wenflashTextColorChance(): number {
  return unit(settings.textColorChance / 100);
}
export function wenflashTextColorCount(): number {
  return Math.round(settings.textColorCount);
}
export function wenflashBackdropMode(): WenflashBackdropMode {
  return settings.backdropMode;
}
export function wenflashBackdropColor(): string {
  return settings.backdropColor;
}
export function wenflashGlowStrength(): number {
  return Math.max(0, settings.glowStrength / 100);
}
export function wenflashGlowRadius(): number {
  return Math.max(0.2, settings.glowRadius / 100);
}
export function wenflashGlowPlain(): number {
  return unit(settings.glowPlain / 100);
}
export function wenflashGlowChance(): number {
  return unit(settings.glowChance / 100);
}
export function wenflashGlowFlowSpeed(): number {
  return Math.max(0, settings.glowFlowSpeed / 100);
}
export function wenflashGlowFlowScale(): number {
  return Math.max(0.3, settings.glowFlowScale / 100);
}
export function wenflashGlowColorMode(): WenflashGlowColorMode {
  return settings.glowColorMode;
}
export function wenflashGlowColors(): [string, string, string] {
  return [settings.glowColorA, settings.glowColorB, settings.glowColorC];
}
export function wenflashFlashCount(): number {
  return Math.max(1, Math.round(settings.flashCount));
}
export function wenflashFlashWindow(): number {
  return Math.max(0.05, settings.flashWindow);
}
export function wenflashFlashDark(): number {
  return unit(settings.flashDark / 100);
}
export function wenflashFlashDim(): number {
  return unit(settings.flashDim / 100);
}
export function wenflashSolidChance(): number {
  return unit(settings.solidChance / 100);
}
export function wenflashOutlineChance(): number {
  return unit(settings.outlineChance / 100);
}
/** 镂空停留：被镂空亮拍选中后，是否继续保留描边外观。 */
export function wenflashHollowLinger(): boolean {
  return settings.enabled && settings.hollowLinger;
}
export function wenflashHollowLingerChance(): number {
  return unit(settings.hollowLingerChance / 100);
}
/** 停留秒数；0 表示一直保持到本句结束。 */
export function wenflashHollowLingerDuration(): number {
  return Math.max(0, settings.hollowLingerDuration);
}
/** 整句跑马框：两条辉光线绕这一句的外框追逐。 */
export function wenflashMarquee(): boolean {
  return settings.enabled && settings.marquee;
}
export function wenflashMarqueeChance(): number {
  return unit(settings.marqueeChance / 100);
}
export function wenflashMarqueeDuration(): number {
  return Math.max(0.8, settings.marqueeDuration);
}
/** 每条光线占整圈周长的比例。 */
export function wenflashMarqueeLength(): number {
  return Math.max(0.03, Math.min(0.45, settings.marqueeLength / 100));
}
/** 外框在整句包围盒外再放大的量，按字号计。 */
export function wenflashMarqueePadding(): number {
  return Math.max(0, settings.marqueePadding);
}
/** 光线宽度，按字号比例。 */
export function wenflashMarqueeWidth(): number {
  return Math.max(0.005, settings.marqueeWidth / 100);
}
/** 光线背后的辉光强度。 */
export function wenflashMarqueeGlow(): number {
  return unit(settings.marqueeGlow / 100);
}
/** 外框出现前的等待，按本句第一个字起唱计时。 */
export function wenflashMarqueeEntryDelay(): number {
  return Math.max(0, settings.marqueeEntryDelay);
}
export function wenflashMarqueeEntryFade(): number {
  return Math.max(0.05, settings.marqueeEntryFade);
}
/** 外框起始缩放；1 为原尺寸。 */
export function wenflashMarqueeEntryScale(): number {
  return Math.max(0.6, Math.min(1.4, settings.marqueeEntryScale));
}
export function wenflashMarqueeRun(): number {
  return Math.max(0, settings.marqueeRun);
}
export function wenflashMarqueeBrake(): number {
  return Math.max(0.1, settings.marqueeBrake);
}
/** 单条底部光线。 */
export function wenflashBottomLine(): boolean {
  return settings.enabled && settings.bottomLine;
}
export function wenflashBottomLineChance(): number {
  return unit(settings.bottomLineChance / 100);
}
/** 线长占整句宽度的比例。 */
export function wenflashBottomLineLength(): number {
  return unit(settings.bottomLineLength / 100);
}
/** 线宽，按字号比例。 */
export function wenflashBottomLineWidth(): number {
  return Math.max(0.005, settings.bottomLineWidth / 100);
}
export function wenflashBottomLineGlow(): number {
  return unit(settings.bottomLineGlow / 100);
}
/** 光线距整句底边的距离，按字号计。 */
export function wenflashBottomLineOffset(): number {
  return Math.max(0, settings.bottomLineOffset);
}
/** 横向扫动一圈的秒数；0 为静止。 */
export function wenflashBottomLineSpeed(): number {
  return Math.max(0, settings.bottomLineSpeed);
}
export function wenflashBottomLineFade(): number {
  return Math.max(0.05, settings.bottomLineFade);
}
export function wenflashBottomLineRun(): number {
  return Math.max(0, settings.bottomLineRun);
}
export function wenflashBottomLineBrake(): number {
  return Math.max(0.1, settings.bottomLineBrake);
}
export function wenflashLineBlockChance(): number {
  return settings.enabled ? unit(settings.lineBlockChance / 100) : 0;
}
export function wenflashLineBlockPadding(): number {
  return unit(settings.lineBlockPadding / 100);
}
export function wenflashLineBlockAlpha(): number {
  return unit(settings.lineBlockAlpha / 100);
}
export function wenflashLineBlockSweep(): number {
  return Math.max(0.05, settings.lineBlockSweep);
}
export function wenflashBlockPadding(): number {
  return unit(settings.blockPadding / 100);
}
export function wenflashBlockAlpha(): number {
  return unit(settings.blockAlpha / 100);
}
export function wenflashOutlineWidth(): number {
  return Math.max(0.005, settings.outlineWidth / 100);
}
export function wenflashEntrySize(sample: number, progress: number): number {
  const initial = settings.sizeMin + (settings.sizeMax - settings.sizeMin) * sample;
  return initial ** (1 - wenflashEntryTime(progress));
}
export function wenflashEntryTime(t: number): number {
  const [x1,y1,x2,y2] = settings.curve;
  if (t <= 0 || t >= 1 || (x1 === y1 && x2 === y2)) return unit(t);
  const cubic = (s:number,a:number,b:number) => s*(3*(1-s)*((1-s)*a+s*b)+s*s);
  let low=0, high=1;
  for (let i=0; i<16; i++) {
    const mid=(low+high)/2;
    if (cubic(mid,x1,x2)<t) low=mid; else high=mid;
  }
  return cubic((low+high)/2,y1,y2);
}
function cameraCurveSpeed(curve: number[], t: number): number {
  const [x1,y1,x2,y2] = curve;
  const at = unit(t);
  const cubic = (s:number,a:number,b:number) => s*(3*(1-s)*((1-s)*a+s*b)+s*s);
  let low=0, high=1;
  for (let i=0; i<16; i++) {
    const mid=(low+high)/2;
    if (cubic(mid,x1,x2)<at) low=mid; else high=mid;
  }
  const s=(low+high)/2;
  const dx=3*(1-s)*(1-s)*x1+6*(1-s)*s*(x2-x1)+3*s*s*(1-x2);
  const dy=3*(1-s)*(1-s)*y1+6*(1-s)*s*(y2-y1)+3*s*s*(1-y2);
  if (dx <= 1e-4) return 1;
  return Math.max(0.35, Math.min(2, dy / dx));
}
/** 镜头平移速度：贝塞尔曲线在当前进度的斜率，1 为按原速度跟随。
 *  斜率大表示这一段镜头追得快，斜率小表示镜头放慢。 */
export function wenflashCameraSpeed(t: number): number {
  return cameraCurveSpeed(settings.cameraCurve, t);
}
/** 镜头缩放速度：使用独立的缩放曲线，再放大斜率以增强响应。 */
export function wenflashCameraZoomSpeed(t: number): number {
  return Math.max(0.25, Math.min(2.5, Math.pow(cameraCurveSpeed(settings.cameraZoomCurve, t), 1.6)));
}
/** 镜头错帧权重：下一句开头前的 overlap 秒内，从 0 平滑升到 1。
 *  上一段还没走完时，下一段的运动已经按这个权重叠进来。 */
export function wenflashCameraBlend(time: number, nextStart: number, overlap = settings.cameraOverlap): number {
  if (!(overlap > 0)) return time >= nextStart ? 1 : 0;
  const t = unit((time - (nextStart - overlap)) / overlap);
  return t * t * (3 - 2 * t);
}
export function wenflashCameraOverlap(): number {
  return settings.cameraOverlap;
}
export function wenflashCameraOverlapLinked(): boolean {
  return settings.cameraOverlapLinked;
}
/** 镜头抽帧帧率；0 或 1 为连续跟随。 */
export function wenflashCameraSteps(): number {
  return settings.cameraSteps > 1 ? Math.max(2, Math.round(settings.cameraSteps)) : 0;
}
/** 整幅画面重绘帧率；0 或 1 为原生。 */
export function wenflashRenderFps(): number {
  return settings.renderFps > 1 ? Math.max(2, Math.min(30, Math.round(settings.renderFps))) : 0;
}
export function wenflashCameraZoomOverlap(): number {
  return settings.cameraZoomOverlap;
}
/** 缩放的错帧权重：合并时跟位置共用时长，分开时用独立的缩放时长。 */
export function wenflashCameraZoomBlend(time: number, nextStart: number): number {
  const overlap = settings.cameraOverlapLinked ? settings.cameraOverlap : settings.cameraZoomOverlap;
  return wenflashCameraBlend(time, nextStart, overlap);
}

/** 文闪自己的撞击参数，形状与 overlapFx() 的 shake 字段一致，避免共用重合影棚设置。 */
export function wenflashImpact() {
  return {
    shakeChance: unit(settings.shakeChance / 100),
    shakePx: settings.shakePx,
    shakeElastic: settings.shakeElastic,
    shakeX: settings.shakeX,
    shakeY: settings.shakeY,
    shakeZ: settings.shakeZ,
    shakeDepth: settings.shakeDepth,
    shakeRollDeg: settings.shakeRollDeg,
    shakeAttack: settings.shakeAttack,
    shakeSwing: settings.shakeSwing,
    shakeAt: settings.shakeAt,
    shakeDamping: settings.shakeDamping,
  };
}

export function currentWenflashSettings() {
  return {...settings, curve: [...settings.curve], cameraCurve: [...settings.cameraCurve], cameraZoomCurve: [...settings.cameraZoomCurve]};
}
export function previewWenflashSettings(value: typeof settings) { apply(value); }
export function saveWenflashSettings() { localStorage.setItem(key, JSON.stringify(settings)); }
export function restoreWenflashSettings() { apply(readSettings()); }
