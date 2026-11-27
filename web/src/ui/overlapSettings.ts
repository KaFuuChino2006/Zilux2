import { FLOW_DEFAULTS, type FlowSettings } from './flowSettings';

const DEFAULT_CAMERA_CURVE = () => [1 / 3, 1 / 3, 2 / 3, 2 / 3];

export type OverlapPlacement = 'scatter' | 'grid';

/** 重合舞台的整屏底色：跟随主题（透明，露出封面底）或压成纯黑 / 纯白。 */
export type OverlapBackdrop = 'theme' | 'black' | 'white';

/**
 * Everything the overlap stage lets you tune. The palette, type and motion fields are folded
 * into the FlowSettings handed to the tempera scene; the rest are read straight by the builder,
 * the frame writer and the decorations, so a rebuild is only needed for the seeded choices.
 */
export interface OverlapSettings {
  paper: string;
  ink: string;
  accent: string;
  /** 新句落在哪：scatter 原来的随机散点、grid 阶梯格。 */
  placement: OverlapPlacement;
  fieldStyle: 'mixed' | 'wind' | 'ticks';
  ticksChance: number;
  beadsChance: number;
  stitchChance: number;
  ringsChance: number;
  chevronChance: number;
  diamondChance: number;
  progressArcChance: number;
  /** 整屏底色：theme 跟随主题（透明）、black / white 压成纯色。 */
  backdrop: OverlapBackdrop;
  /** 纸色与字色跟随当前封面取色；关掉才用上面三个颜色。 */
  followCover: boolean;
  /** 把每句再拆成 2–4 个词的小段，逐段出现（和拼合的拆句同一套规则）。 */
  splitLyrics: boolean;
  sizeScale: number;
  /** 0..1 wash from ink to accent along each line. */
  lyricTint: number;
  /** Brightness of the halo that lights up on keyword glyphs. */
  keywordGlow: number;
  fontWeight: number;
  glyphMotion: number;
  glyphSettleStretch: number;
  intensity: number;
  followGain: number;
  zoomRest: number;
  zoomSwell: number;
  zoomRelax: number;
  /** 下一句镜头提前叠加的秒数；只属于重合，0 关闭。 */
  cameraOverlap: number;
  /** 重合镜头平移速度曲线；四点贝塞尔，横轴是本句进度。 */
  cameraCurve: number[];
  /** 重合镜头缩放速度曲线；四点贝塞尔，横轴是本句进度。 */
  cameraZoomCurve: number[];
  panSoft: number;
  zoomSoft: number;
  rollSoft: number;
  turnChance: number;
  turnMinDeg: number;
  turnMaxDeg: number;
  scatter: number;
  ghostDrift: number;
  holdFade: number;
  ghostBlur: number;
  exitSeconds: number;
  trailInk: number;
  trailChance: number;
  bracketChance: number;
  bracketCrossChance: number;
  /** 每一句是否给几个字垫字模方框的概率。 */
  mouldChance: number;
  /** 每个字出现时在它周围溅出短线的概率（按句子抽取）。 */
  fieldChance: number;
  /** 0-2: hair count and opacity of the wind. */
  fieldStrength: number;
  /** Base px per second the gust travels. */
  fieldSpeed: number;
  /** Base hair length in pixels. */
  fieldLength: number;
  /** Chance that a line change knocks the camera. */
  shakeChance: number;
  /** Base kick in px. */
  shakePx: number;
  /** 0.3-2.5: how soft and long the rebound rings. */
  shakeElastic: number;
  /** Per-axis share of the bump: lateral, vertical, depth (zoom), roll. */
  shakeX: number;
  shakeY: number;
  shakeDepth: number;
  /** Dolly push in px (Z translation). */
  shakeZ: number;
  /** How fast the ring dies out: bigger = shorter tail. */
  shakeDamping: number;
  /** 高速运镜时撞击弹跳的削弱强度，百分比；可超过 100% 让中高速更早压平，0 不削弱。 */
  shakeSpeedDamp: number;
  /** 开始削弱撞击的镜头位移速度（px/s），0 表示从静止就开始算；低于它保持原样。 */
  shakeSpeedFrom: number;
  shakeRollDeg: number;
  /** Seconds for the hit to reach full force: smaller = sharper. */
  shakeAttack: number;
  /** Oscillation-rate multiplier of the ring. */
  shakeSwing: number;
  /** Percent into the line at which the bump lands (0-100). */
  shakeAt: number;
  /** 每一句在句尾盖一枚落款印的概率。 */
  sealChance: number;
  /** 每句收尾在句尾留一道短竖线的概率。 */
  breakChance: number;
  underlineChance: number;
  arcChance: number;
  silhouetteChance: number;
  creaseChance: number;
  specks: number;
  /** 0..1 chance a line gets a paper bar sweeping across one word. */
  maskChance: number;
  /** 背景纸网格：反向位移的比例（0 关闭视差）。 */
  gridParallax: number;
  /** 背景纸网格：镜头推近时向句子中心凹陷的强度（0 关闭透镜）。 */
  gridLens: number;
  /** 声纹波带的幅度。 */
  waveGain: number;
  decorAlpha: number;
  stagger: number;
  showBracket: boolean;
  showSeal: boolean;
  showField: boolean;
  showProgressArc: boolean;
  showLyricMarks: boolean;
  showMould: boolean;
  showBreak: boolean;
  showArc: boolean;
  showTrail: boolean;
  showHud: boolean;
  rackFocus: number;
  dollySplit: number;
  handheld: number;
  panStreak: number;
  settle: number;
  lensDistortion: number;
  rgbShift: number;
  grain: number;
  contrast: number;
  vignette: number;
  showMask: boolean;
  showGrid: boolean;
  showUnderline: boolean;
  showSilhouette: boolean;
  showCrease: boolean;
  showWave: boolean;
  /** 第一句唱词前与全曲唱完后各显示一次歌名卡（只显示歌名，不带词曲署名）。 */
  titleCard: boolean;
  /** 镜头运动时散落的墨尘/墨溅/字屑。 */
  showDebris: boolean;
  showAmbient: boolean;
  /** 自由线稿出现的频率倍率。 */
  ambientRate: number;
  dustGain: number;
  splashGain: number;
  shardGain: number;
}

export const OVERLAP_DEFAULTS: OverlapSettings = {
  paper: '#05080f',
  ink: '#e8f1f6',
  accent: '#5fd6c9',
  placement: 'grid',
  fieldStyle: 'mixed',
  ticksChance: 0.3,
  beadsChance: 0.25,
  stitchChance: 0.2,
  ringsChance: 0.2,
  chevronChance: 0.15,
  diamondChance: 0.15,
  progressArcChance: 0.55,
  backdrop: 'theme',
  followCover: true,
  splitLyrics: false,
  sizeScale: 1.12,
  lyricTint: 0.3,
  keywordGlow: 0.7,
  fontWeight: 700.0,
  glyphMotion: 0.82,
  glyphSettleStretch: 1.32,
  intensity: 1.82,
  followGain: 1.6,
  zoomRest: 1.35,
  zoomSwell: 0.095,
  zoomRelax: 0.15,
  cameraOverlap: 0.8,
  cameraCurve: DEFAULT_CAMERA_CURVE(),
  cameraZoomCurve: DEFAULT_CAMERA_CURVE(),
  panSoft: 0.6,
  zoomSoft: 0.56,
  rollSoft: 1.0,
  turnChance: 0.13,
  turnMinDeg: 30.0,
  turnMaxDeg: 360.0,
  scatter: 0.165,
  ghostDrift: 0.18,
  holdFade: 0.45,
  ghostBlur: 0.38,
  exitSeconds: 2.6,
  trailInk: 0.24,
  trailChance: 0.35,
  bracketChance: 0.6,
  bracketCrossChance: 0.5,
  mouldChance: 0.55,
  fieldChance: 0.55,
  fieldStrength: 1.0,
  fieldSpeed: 160.0,
  fieldLength: 9.0,
  shakeChance: 0.35,
  shakePx: 47,
  shakeElastic: 5.0,
  shakeX: 30,
  shakeY: 45,
  shakeZ: 70,
  shakeDepth: 0.0,
  shakeDamping: 1.75,
  shakeSpeedDamp: 62,
  shakeSpeedFrom: 700,
  shakeRollDeg: 7.6,
  shakeAttack: 0.34,
  shakeSwing: 0.4,
  shakeAt: 0,
  sealChance: 0.55,
  breakChance: 0.55,
  underlineChance: 0.7,
  arcChance: 0.7,
  silhouetteChance: 0.55,
  creaseChance: 0.5,
  specks: 4.0,
  maskChance: 0.6,
  gridParallax: 0.32,
  gridLens: 0.56,
  waveGain: 0.7,
  decorAlpha: 1.0,
  stagger: 0.55,
  showBracket: true,
  showSeal: true,
  showField: true,
  showProgressArc: true,
  showLyricMarks: true,
  showMould: true,
  showBreak: true,
  showArc: true,
  showTrail: true,
  showHud: true,
  showMask: true,
  showGrid: true,
  showUnderline: true,
  showSilhouette: true,
  showCrease: true,
  showWave: true,
  titleCard: true,
  showDebris: true,
  showAmbient: true,
  ambientRate: 1,
  dustGain: 1,
  splashGain: 1,
  shardGain: 1,
  rackFocus: 1.15,
  dollySplit: 0.5,
  handheld: 0.5,
  panStreak: 0.75,
  settle: 1.15,
  lensDistortion: 0.15,
  rgbShift: 0.0,
  grain: 0.0,
  contrast: 0.0,
  vignette: 0.0,
};

export type OverlapRangeKey =
  | 'ticksChance' | 'beadsChance' | 'stitchChance' | 'ringsChance' | 'chevronChance' | 'diamondChance' | 'progressArcChance'
  | 'lyricTint' | 'keywordGlow'
  | 'sizeScale' | 'fontWeight' | 'glyphMotion' | 'glyphSettleStretch'
  | 'intensity' | 'followGain' | 'zoomRest' | 'zoomSwell' | 'zoomRelax'
  | 'cameraOverlap' | 'panSoft' | 'zoomSoft' | 'rollSoft'
  | 'turnChance' | 'turnMinDeg' | 'turnMaxDeg'
  | 'scatter' | 'ghostDrift' | 'holdFade' | 'ghostBlur' | 'exitSeconds' | 'trailInk'
  | 'paper' | 'ink' | 'accent' | 'followCover' | 'splitLyrics' | 'sizeScale' | 'lyricTint' | 'keywordGlow' | 'fontWeight' | 'glyphMotion' | 'glyphSettleStretch' | 'intensity' | 'followGain' | 'zoomRest' | 'zoomSwell' | 'zoomRelax' | 'panSoft' | 'zoomSoft' | 'rollSoft' | 'turnChance' | 'turnMinDeg' | 'turnMaxDeg' | 'scatter' | 'ghostDrift' | 'holdFade' | 'ghostBlur' | 'exitSeconds' | 'trailInk' | 'trailChance' | 'bracketChance' | 'bracketCrossChance' | 'mouldChance' | 'fieldChance' | 'fieldStrength' | 'fieldSpeed' | 'fieldLength' | 'shakeChance' | 'shakePx' | 'shakeElastic' | 'shakeX' | 'shakeY' | 'shakeDepth' | 'shakeZ' | 'shakeDamping' | 'shakeSpeedDamp' | 'shakeSpeedFrom' | 'shakeRollDeg' | 'shakeAttack' | 'shakeSwing' | 'shakeAt' | 'sealChance' | 'breakChance' | 'underlineChance' | 'arcChance' | 'silhouetteChance' | 'creaseChance' | 'specks' | 'maskChance' | 'gridParallax' | 'gridLens' | 'waveGain' | 'decorAlpha' | 'stagger' | 'showBracket' | 'showSeal' | 'showField' | 'showProgressArc' | 'showMould' | 'showBreak' | 'showArc' | 'showTrail' | 'showHud' | 'rackFocus' | 'dollySplit' | 'handheld' | 'panStreak' | 'settle' | 'lensDistortion' | 'rgbShift' | 'grain' | 'contrast' | 'vignette' | 'showMask' | 'showGrid' | 'showUnderline' | 'showSilhouette' | 'showCrease' | 'showWave' | 'showDebris' | 'showAmbient' | 'ambientRate' | 'dustGain' | 'splashGain' | 'shardGain';

/** [key, label, min, max, step, category, hint] */
export const OVERLAP_RANGES: [OverlapRangeKey, string, number, number, number, string, string][] = [
  ['ticksChance', '游走刻线概率', 0, 1, 0.05, '字间动效', '每句独立抽取，可与其他笔迹同时出现'],
  ['beadsChance', '墨珠流概率', 0, 1, 0.05, '字间动效', '每句独立抽取，可与其他笔迹同时出现'],
  ['stitchChance', '交叉针脚概率', 0, 1, 0.05, '字间动效', '每句独立抽取，可与其他笔迹同时出现'],
  ['ringsChance', '涟漪环概率', 0, 1, 0.05, '字间动效', '每句独立抽取，可与其他笔迹同时出现'],
  ['chevronChance', '折翼箭概率', 0, 1, 0.05, '字间动效', '每句独立抽取，可与其他笔迹同时出现'],
  ['diamondChance', '菱形闪印概率', 0, 1, 0.05, '字间动效', '每句独立抽取，可与其他笔迹同时出现'],
  ['progressArcChance', '弧光跟随概率', 0, 1, 0.05, '字间动效', '每句独立抽取，可与其他笔迹同时出现'],
  ['lyricTint', '歌词渐层', 0, 1, 0.05, '文字', '整句从主墨色渐到强调色，0 关闭'],
  ['keywordGlow', '重点词辉光', 0, 1.5, 0.05, '文字', '重点词唱到时逐渐亮起的光晕，0 关闭'],
  ['sizeScale', '字号倍率', 0.6, 2, 0.02, '文字', '整句字号相对画面的大小'],
  ['fontWeight', '字重', 300, 900, 100, '文字', '笔画粗细'],
  ['glyphMotion', '逐字动态', 0, 1.5, 0.02, '文字', '每个字入场时的位移与拉伸'],
  ['glyphSettleStretch', '落定拉伸', 0, 1.5, 0.02, '文字', '唱到之后回弹的余量'],
  ['intensity', '运镜强度', 0, 2, 0.02, '运镜', '分镜自身漂移的总强度，0 时画面完全静止'],
  ['followGain', '跟随增益', 0.2, 1.6, 0.02, '运镜', '镜头把当前句拉到画面中央的力度'],
  ['zoomRest', '常驻推近', 1, 1.4, 0.01, '运镜', '画面整体的基础缩放'],
  ['zoomSwell', '句内呼吸', 0, 0.15, 0.005, '运镜', '一句唱到中间时再多推近的量'],
  ['zoomRelax', '间奏回吐', 0, 0.15, 0.005, '运镜', '长间奏时退回广角的量'],
  ['cameraOverlap', '镜头错帧', 0, 2, 0.05, '运镜', '下一句镜头提前这么久开始叠加；0 表示等上一段结束再换目标'],
  ['panSoft', '平移柔和', 0.1, 1.2, 0.02, '运镜', '换句时平移追上去的时间'],
  ['zoomSoft', '缩放柔和', 0.1, 1.2, 0.02, '运镜', '缩放变化的时间'],
  ['rollSoft', '旋转柔和', 0.3, 2.5, 0.05, '运镜', '旋转归正的时间，越大越慢'],
  ['turnChance', '旋转概率', 0, 1, 0.01, '旋转', '每一句有多大概率触发一次旋转'],
  ['turnMinDeg', '最小角度', 15, 180, 5, '旋转', '触发时至少转多少度'],
  ['turnMaxDeg', '最大角度', 45, 360, 5, '旋转', '触发时最多转多少度'],
  ['scatter', '落点散开', 0, 0.3, 0.005, '落点', '每句随机停放离画面中心多远'],
  ['holdFade', '等待渐隐', 0, 0.9, 0.05, '旧句', '唱完后在等待下一句的时间里缓慢减淡的幅度，0 保持原样'],
  ['ghostDrift', '旧句漂移', 0.02, 0.4, 0.005, '旧句', '唱完之后文字散开的距离'],
  ['ghostBlur', '唱后模糊', 0, 1, 0.02, '旧句', '旧句停留时的失焦程度'],
  ['exitSeconds', '退场时长', 0.8, 5, 0.1, '旧句', '旧句从开始离开到完全消失的时间'],
  ['trailInk', '拖尾浓度', 0, 0.6, 0.01, '旧句', '逐字残影的浓淡'],
  ['trailChance', '轨迹概率', 0, 1, 0.05, '装饰', '每一句有多大概率留下到下一句的轨迹，0 关闭'],
  ['stagger', '装饰错峰', 0, 1.5, 0.05, '装饰', '同一句的括号、横线、剪影、弧、折痕在多久内依次出现，0 同时出现'],
  ['bracketCrossChance', '十字框概率', 0, 1, 0.05, '装饰', '括号命中时，这个比例改成四角外伸的十字框'],
  ['bracketChance', '括号概率', 0, 1, 0.05, '装饰', '每一句出现句子括号的概率'],
  ['mouldChance', '字模概率', 0, 1, 0.05, '装饰', '每一句有多少概率挑出几个字垫上字模方框'],
  ['fieldChance', '扰乱场概率', 0, 1, 0.05, '装饰', '每一句有多少概率被风扫过'],
  ['fieldStrength', '风的力度', 0, 2, 0.05, '装饰', '风的线数与亮度，0 只剩最细的一两根'],
  ['fieldSpeed', '风速', 40, 400, 5, '装饰', '线横穿文字的速度，px/s'],
  ['fieldLength', '风的线长', 2, 30, 0.5, '装饰', '每根风线的基准长度'],
  ['shakeChance', '镜头撞击概率', 0, 1, 0.05, '高级', '换句时像轻轻撞了一下、弹回来的概率'],
  ['shakeElastic', '撞击弹性', 0.3, 5, 0.05, '高级', '回弹的快慢与余振长度，越大越软、余振越长'],
  ['shakeX', '横向位移', 0, 320, 1, '高级', '横向撞开的距离，单位 px'],
  ['shakeY', '纵向位移', 0, 320, 1, '高级', '纵向撞开的距离，单位 px'],
  ['shakeZ', '撞击 Z 位移', 0, 400, 2, '高级', '沿视线方向的推拉位移，单位 px（换算成缩放）'],
  ['shakeDepth', '撞击 Z 压缩', 0, 24, 0.2, '高级', '撞击瞬间镜头前后挤压的百分比'],
  ['shakeRollDeg', '撞击滚转', 0, 8, 0.05, '高级', '镜头滚转的角度，单位度'],
  ['shakeAttack', '撞击入场', 0.01, 0.6, 0.01, '高级', '从 0 到满力度的秒数，越小越像被砸一下'],
  ['shakeSwing', '撞击回摆', 0, 4, 0.05, '高级', '余振的频率倍率；0 表示不回摆，只推一下再淡出'],
  ['shakeAt', '撞击时机', 0, 100, 1, '高级', '当前这一句唱到百分之多少时撞一下；0 = 句首'],
  ['shakeDamping', '撞击削减', 0.2, 6, 0.05, '高级', '余振衰减的快慢，越大收得越快'],
  ['shakeSpeedDamp', '高速弹性削弱', 0, 200, 1, '高级', '运镜越快，撞击的弹跳压得越小；可超过 100%，0 = 不随速度削弱'],
  ['shakeSpeedFrom', '削弱起始速度', 0, 3000, 10, '高级', '镜头位移速度低于这个值时保持原样，0 = 从静止开始计算，单位 px/s'],
  ['sealChance', '落款概率', 0, 1, 0.05, '装饰', '每一句有多少概率在句尾盖一枚落款印'],
  ['breakChance', '断句记号概率', 0, 1, 0.05, '装饰', '每一句在句尾留下断句竖线的概率'],
  ['underlineChance', '横线概率', 0, 1, 0.05, '装饰', '每一句出现句下横线的概率'],
  ['arcChance', '书写弧概率', 0, 1, 0.05, '装饰', '每一次换句留下书写弧的概率'],
  ['silhouetteChance', '剪影概率', 0, 1, 0.05, '装饰', '每一句在远景留下剪影的概率'],
  ['creaseChance', '折痕概率', 0, 1, 0.05, '装饰', '每换一段留下折痕的概率'],
  ['specks', '墨点数', 0, 8, 1, '装饰', '每个字溅出的墨点数量，0 关闭'],
  ['maskChance', '遮罩概率', 0, 1, 0.05, '装饰', '每一句有多大概率有一道遮罩划过其中几个字，0 关闭'],
  ['gridParallax', '网格视差', 0, 1, 0.02, '装饰', '背景纸网格按镜头位移的反向比例移动，0 关闭视差'],
  ['gridLens', '网格透镜', 0, 1, 0.02, '装饰', '镜头推近时网格向句子中心凹陷的强度，0 关闭'],
  ['ambientRate', '自由线稿频率', 0.2, 3, 0.05, '装饰', '电路 / 星座 / 刻度盘自己出现的快慢'],
  ['dustGain', '墨尘', 0, 2, 0.05, '装饰', '镜头移动时被带起的墨尘量，0 关闭'],
  ['splashGain', '墨溅', 0, 2, 0.05, '装饰', '撞击时甩出的墨点量，0 关闭'],
  ['shardGain', '字屑', 0, 2, 0.05, '装饰', '换句时旧句位置崩下的碎块量，0 关闭'],
  ['waveGain', '声纹幅度', 0, 1.5, 0.05, '装饰', '底部声纹波带随唱字密度起伏的高度'],
  ['decorAlpha', '装饰浓度', 0, 1, 0.02, '装饰', '轨迹、括号、弧线、刻度尺的总浓度'],
  ['rackFocus', '对焦拉扯', 0, 2.4, 0.05, '镜头', '换句时旧句多糊一点、新句收清，像镜头在换焦'],
  ['dollySplit', '景深分层', 0, 1, 0.05, '镜头', '推近时背景只跟一部分，主歌词跟满，形成前后景'],
  ['handheld', '手持呼吸', 0, 2, 0.05, '镜头', '静止时极轻的位移与倾斜，长间奏不像死图'],
  ['panStreak', '速度拖影', 0, 1.6, 0.05, '镜头', '横移快时画面边缘出现极淡的墨线'],
  ['settle', '落定回弹', 0, 2, 0.05, '镜头', '镜头到位时缩放多冲一点再回正'],
  ['lensDistortion', '镜头畸变', 0, 2, 0.05, '印刷与画质', '和拼合同一套镜头畸变：中心不动，边缘像透过广角玻璃'],
  ['rgbShift', '色版偏移', 0, 1, 0.05, '印刷与画质', '和拼合同一套印刷色版偏移：红蓝分开一点点，像套印没对准'],
  ['grain', '纸面颗粒', 0, 1, 0.05, '印刷与画质', '纸纤维的细颗粒，0 关闭'],
  ['contrast', '对比度', 0, 1, 0.05, '印刷与画质', '整场的明暗对比'],
  ['vignette', '暗角', 0, 2, 0.05, '印刷与画质', '四角压暗，让字更聚光'],
];

export type OverlapSwitchKey = 'titleCard' | 'followCover' | 'splitLyrics' | 'showBracket' | 'showArc' | 'showTrail' | 'showHud' | 'showMask' | 'showGrid' | 'showUnderline' | 'showSilhouette' | 'showCrease' | 'showWave' | 'showDebris' | 'showMould' | 'showBreak' | 'showSeal' | 'showField' | 'showProgressArc' | 'showLyricMarks';

/** [key, label, category, hint] */
export const OVERLAP_SWITCHES: [OverlapSwitchKey, string, string, string][] = [
  ['showProgressArc', '弧光跟随', '装饰', '多条短书写弧随演唱穿过字间，部分笔迹带辉光，换行后从行首起笔'],
  ['showLyricMarks', '下句色签', '装饰', '每句有 45% 概率出现，三块色签依次滑入并指向下一句'],
  ['followCover', '跟随封面配色', '配色', '纸色与字色从当前封面提取，和拼合档同一套取色；关掉后用上面三个颜色'],
  ['splitLyrics', '拆句显示', '文字', '把每句按词拆成 2–4 段，逐段唱出来；关掉是整句一起排'],
  ['showBracket', '句子括号', '装饰', '在整句两侧随唱到的位置展开的方括号'],
  ['showSeal', '落款印章', '装饰', '每句唱完在句尾盖一枚小方印，随句子一起淡掉'],
  ['showField', '扰乱场', '装饰', '细风线扫过逐字歌词，句首与句尾落字时，上下各舒展一道短弧再收回'],
  ['showMould', '字模方框', '装饰', '挑几个字在脚下垫一个细线方框，随字出现、随字收回'],
  ['showBreak', '断句记号', '装饰', '每句结束在句尾留一道短竖线，下一句开始后淡掉'],
  ['showArc', '句间书写弧', '装饰', '从上一句句尾连到下一句句首的手写弧'],
  ['showTrail', '轨迹连线', '装饰', '每个换句节点留下的连线与圆点'],
  ['showHud', '边缘刻度尺', '装饰', '四边刻度与跟随句子的三角游标'],
  ['showMask', '词组遮罩', '装饰', '一块纸色薄板从一侧扫过其中几个字，扫完即退出'],
  ['showGrid', '纸面网格', '装饰', '背景的细网格：镜头移动时反向漂移，推近时向句子凹陷'],
  ['showUnderline', '句下横线', '装饰', '随歌词从左写到右的一条细线，唱完渐隐'],
  ['showSilhouette', '远景剪影', '装饰', '当前句放大数倍的巨大剪影，作为最远的一层随镜头慢移'],
  ['showCrease', '折痕翻页', '装饰', '每换一段在纸面上多一道极淡的折痕，然后慢慢淡掉'],
  ['showWave', '声纹波带', '装饰', '画面下缘一条随唱字密度起伏的连续波线'],
  ['titleCard', '曲名卡', '文字', '第一句唱词开口前与全曲唱完后，各显示一次歌名卡，样式跟随当前风格预设'],
];

export const OVERLAP_SETTINGS_KEY = 'zilux2.overlapSettings';
export const OVERLAP_SETTINGS_EVENT = 'zilux2:overlap-settings';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
const color = (value: unknown, fallback: string) => (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback);
const readCurve = (input: unknown): number[] => {
  if (!Array.isArray(input) || !input.every(Number.isFinite)) return DEFAULT_CAMERA_CURVE();
  if (input.length === 4) return input.map((v, i) => i % 2 ? Math.max(-1, Math.min(2, v)) : clamp(v, 0, 1));
  if (input.length === 9) {
    let aa = 0, ab = 0, bb = 0, ay = 0, by = 0;
    for (let i = 1; i < 8; i++) {
      const t = i / 8, a = 3 * t * (1 - t) ** 2, b = 3 * t * t * (1 - t), y = input[i] - t ** 3;
      aa += a * a; ab += a * b; bb += b * b; ay += a * y; by += b * y;
    }
    const det = aa * bb - ab * ab;
    return [1 / 3, clamp((ay * bb - by * ab) / det, 0, 1), 2 / 3, clamp((by * aa - ay * ab) / det, 0, 1)];
  }
  return DEFAULT_CAMERA_CURVE();
};
const pick = <K extends keyof OverlapSettings>(input: Partial<OverlapSettings> | null | undefined, key: K, fallback: OverlapSettings[K]): OverlapSettings[K] => {
  const value = input?.[key];
  return (typeof value === typeof fallback ? value : fallback) as OverlapSettings[K];
};

export function normalizeOverlapSettings(input: (Partial<OverlapSettings> & { interGlyphStyle?: string }) | null | undefined): OverlapSettings {
  const out: OverlapSettings = { ...OVERLAP_DEFAULTS };
  if (input?.fieldStyle === 'wind' || input?.fieldStyle === 'ticks') out.fieldStyle = input.fieldStyle;
  out.paper = color(input?.paper, OVERLAP_DEFAULTS.paper);
  out.ink = color(input?.ink, OVERLAP_DEFAULTS.ink);
  out.accent = color(input?.accent, OVERLAP_DEFAULTS.accent);
  out.cameraCurve = readCurve(input?.cameraCurve);
  out.cameraZoomCurve = readCurve(input?.cameraZoomCurve);
  for (const [key, , min, max, step] of OVERLAP_RANGES) {
    const raw = Number(input?.[key]);
    const fallback = Number(OVERLAP_DEFAULTS[key]);
    const snapped = Math.round((Number.isFinite(raw) ? raw : fallback) / step) * step;
    (out[key] as number) = clamp(snapped, min, max);
  }
  for (const [key] of OVERLAP_SWITCHES) out[key] = pick(input, key, OVERLAP_DEFAULTS[key]);
  // Preserve an explicit legacy selection when loading a pre-probability preset.
  if (input?.ticksChance === undefined && ['off', 'ticks', 'beads', 'stitch'].includes(input?.interGlyphStyle ?? '')) {
    for (const style of ['ticks', 'beads', 'stitch', 'rings', 'chevron', 'diamond'] as const) {
      out[`${style}Chance`] = Number(input?.interGlyphStyle === style);
    }
    out.progressArcChance = 1;
  }
  out.placement = input?.placement === 'scatter' || input?.placement === 'grid'
    ? input.placement
    : OVERLAP_DEFAULTS.placement;
  out.backdrop = input?.backdrop === 'black' || input?.backdrop === 'white' || input?.backdrop === 'theme'
    ? input.backdrop
    : OVERLAP_DEFAULTS.backdrop;
  if (out.turnMinDeg > out.turnMaxDeg) [out.turnMinDeg, out.turnMaxDeg] = [out.turnMaxDeg, out.turnMinDeg];
  return out;
}

/** 舞台根节点的 CSS 底色：跟随主题时透明，露出歌词页自己的封面底。 */
export function overlapBackdropColor(value: OverlapBackdrop): string {
  return value === 'black' ? '#000000' : value === 'white' ? '#ffffff' : 'transparent';
}

export function overlapSettings(): OverlapSettings {
  try {
    return normalizeOverlapSettings(JSON.parse(localStorage.getItem(OVERLAP_SETTINGS_KEY) || '{}'));
  } catch {
    return { ...OVERLAP_DEFAULTS };
  }
}

export function saveOverlapSettings(settings: OverlapSettings): OverlapSettings {
  const value = normalizeOverlapSettings(settings);
  localStorage.setItem(OVERLAP_SETTINGS_KEY, JSON.stringify(value));
  setOverlapFx(value);
  window.dispatchEvent(new CustomEvent(OVERLAP_SETTINGS_EVENT, { detail: value }));
  return value;
}

/**
 * The live values the builder and the frame writer read. The settings panel writes the draft
 * here while you drag, so the stage behind the sheet previews before you commit anything.
 */
let live: OverlapSettings = overlapSettings();

export function overlapFx(): OverlapSettings {
  return live;
}

export function setOverlapFx(settings: OverlapSettings): void {
  live = normalizeOverlapSettings(settings);
}

function cameraCurveSpeed(curve: number[], t: number): number {
  const [x1, y1, x2, y2] = curve;
  const at = clamp(t, 0, 1);
  const cubic = (s: number, a: number, b: number) => s * (3 * (1 - s) * ((1 - s) * a + s * b) + s * s);
  let low = 0, high = 1;
  for (let i = 0; i < 16; i++) {
    const mid = (low + high) / 2;
    if (cubic(mid, x1, x2) < at) low = mid; else high = mid;
  }
  const s = (low + high) / 2;
  const dx = 3 * (1 - s) * (1 - s) * x1 + 6 * (1 - s) * s * (x2 - x1) + 3 * s * s * (1 - x2);
  const dy = 3 * (1 - s) * (1 - s) * y1 + 6 * (1 - s) * s * (y2 - y1) + 3 * s * s * (1 - y2);
  if (dx <= 1e-4) return 1;
  return Math.max(0.35, Math.min(2, dy / dx));
}

/** 重合镜头平移速度：与文闪同一套贝塞尔斜率算法，但读重合自己的曲线。 */
export function overlapCameraSpeed(t: number): number {
  return cameraCurveSpeed(overlapFx().cameraCurve, t);
}

/** 重合镜头缩放速度：读重合自己的缩放曲线。 */
export function overlapCameraZoomSpeed(t: number): number {
  return Math.max(0.25, Math.min(2.5, Math.pow(cameraCurveSpeed(overlapFx().cameraZoomCurve, t), 1.6)));
}

/** FlowSettings view of the same settings, with the overlap-only numbers folded in. */
export function overlapStyleOf(settings: OverlapSettings): FlowSettings & { overlap: OverlapSettings } {
  return {
    ...FLOW_DEFAULTS,
    background: settings.followCover ? 'cover' : 'custom',
    text: settings.followCover ? 'cover' : 'custom',
    paper: settings.paper,
    ink: settings.ink,
    accent: settings.accent,
    wholeLineLyrics: !settings.splitLyrics,
    enableTransitions: false,
    motion: 'horizontal',
    horizontalDirection: 'right',
    showBlocks: false,
    showDecor: false,
    showCornerMarks: false,
    fontWeight: settings.fontWeight,
    sizeScale: settings.sizeScale,
    intensity: settings.intensity,
    glyphMotion: settings.glyphMotion,
    glyphSettleStretch: settings.glyphSettleStretch,
    mgPlayback: 'overlay',
    mgMix: 0,
    // The print pass is the flow stage's own chain (sonnet post-process), so 重合 inherits the
    // same grain, plate offset, lens bend and vignette instead of carrying a second shader.
    postProcessLensDistortion: settings.lensDistortion,
    postProcessRgbShift: settings.rgbShift,
    postProcessGrain: settings.grain,
    postProcessContrast: settings.contrast,
    postProcessVignette: settings.vignette,
    overlap: settings,
  };
}
