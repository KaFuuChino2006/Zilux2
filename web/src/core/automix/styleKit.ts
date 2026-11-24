/**
 * styleKit —— 过渡风格目录、选型打分与参数决策（纯函数，零依赖）
 *
 * 本模块只做「选哪种手法 / 给什么参数 / 为什么」的判断，不产生任何音频节点。
 * 每种风格的 requires 字段直接标出它要占用哪些现有 DSP 原语：
 *   split       -> buildV2Plan 的 a.low / b.low 换手（bass swap 那一对曲线）
 *   sweep       -> buildV2Plan 的 a.sweepLp / b.sweepHp 双扫
 *   duck        -> buildDuckEvents（B 的攻击点压 A 的人声）
 *   reverb      -> scheduleAutomixV2Reverb（混响送出）
 *   echo        -> planEchoTail（尾段回声，含 delay/feedback/阻尼）
 *   bridge      -> buildBridgePlan / pickBridgeUnit（A 的尾段 loop 延长）
 *   introBridge -> planIntroBridge（B 的前奏 loop 补时）
 *   tempo       -> tempoRate / tempoInverted（A 贴 B 的变速）
 *   cut         -> styleResolved === 'cut'（硬切）
 *   tailHold    -> aTailHold / aTailBleedMs（A 尾巴当乐器持续）
 *
 * 所有上下文字段都是可选的：分析结果可能只拿到一部分，缺字段按保守默认处理，
 * rankStyles / pickStyle 在任何输入下都不抛异常。
 */

export type TransitionStyleId =
  | 'bassSwap'
  | 'eqSwap'
  | 'filterSweep'
  | 'echoOut'
  | 'reverbOut'
  | 'loopRoll'
  | 'backspin'
  | 'slam'
  | 'dropSwap'
  | 'doubleDrop'
  | 'doubling'
  | 'acapellaOverlay'
  | 'halfTime'
  | 'keyLift'
  | 'longBlend'
  | 'cut';

/** 现有 DSP 原语名，用于让接线方一眼看出该风格要打开哪几路自动化。 */
export type StylePrimitive =
  | 'split'
  | 'sweep'
  | 'duck'
  | 'reverb'
  | 'echo'
  | 'bridge'
  | 'introBridge'
  | 'tempo'
  | 'cut'
  | 'tailHold';

export interface StyleParams {
  /** 真正完成低频换手的那一段占整段过渡的比例，0–1。 */
  swapShare?: number;
  /** 双扫占整段过渡的比例，0–1。 */
  sweepShare?: number;
  /** 回声拍值，1 = 1 拍，0.5 = 1/2 拍，0.25 = 1/4 拍。 */
  echoDiv?: number;
  /** 混响送出声压，dB，必须 ≤ 0。 */
  reverbSendDb?: number;
  /** B 攻击点压 A 的深度，dB，必须 ≤ 0。 */
  duckDb?: number;
  /** A 尾巴保持电平占原电平的比例，0–0.4（与 v2Plan 的 aTailHold 上限一致）。 */
  tailHold?: number;
  /** 允许的 BPM 偏差百分比上限，超过即被该风格自身门控挡掉。 */
  tempoRange?: number;
  /** 建议的过渡长度，小节数。 */
  bars?: number;
}

export interface StyleSpec {
  id: TransitionStyleId;
  label: string;
  /** 一句话说明这个手法为什么存在（听感层面的卖点）。 */
  why: string;
  requires: readonly StylePrimitive[];
  params: StyleParams;
  minFadeMs: number;
  maxFadeMs: number;
}

/**
 * 选型上下文。全部可选：没分析出来的字段走保守默认（见 normalizeCtx）。
 * 单位统一 ms / 百分比 / 0–1 比例，避免调用方换算。
 */
export interface StyleContext {
  bpmA?: number;
  bpmB?: number;
  /** 调性距离，以 Camelot 步数计（0 = 同码，1 = 相邻，≥5 视为冲突）。 */
  keyGap?: number;
  /** 能量差，0–1（响度/活动度的归一化差值）。 */
  energyGap?: number;
  meterA?: number;
  meterB?: number;
  aVocal?: boolean;
  bVocal?: boolean;
  aHasIntro?: boolean;
  bHasIntro?: boolean;
  /** B 有可瞄准的 drop / 副歌落点（dropSwap / doubleDrop 的真正前提）。 */
  bHasDrop?: boolean;
  aHasOutro?: boolean;
  /** B 首句人声出现的文件时间，ms；< 1500 视为没有干净入口。 */
  bFirstVocalMs?: number;
  bLoopUnits?: number;
  aLoopUnits?: number;
  fadeMsWanted?: number;
  barMs?: number;
  beatMs?: number;
  /** BPM 偏差软限，百分比，默认 6。 */
  tempoSoftLimit?: number;
  /** BPM 偏差硬限，百分比，默认 12。 */
  tempoHardLimit?: number;
  aInstrumental?: boolean;
  bInstrumental?: boolean;
  /** 是否检测到可用 downbeat 网格，默认 true。 */
  hasDownbeat?: boolean;
}

export interface RankedStyle {
  spec: StyleSpec;
  score: number;
  reasons: string[];
  /** 被硬门控挡掉时给出原因；为 undefined 表示可选。 */
  blockedBy?: string;
  /** 建议的实际过渡时长，已夹到该风格的 [minFadeMs, maxFadeMs] 并对齐小节。 */
  fadeMs: number;
}

// ---------------------------------------------------------------------------
// 目录
// ---------------------------------------------------------------------------

/**
 * 16 种风格。minFadeMs / maxFadeMs 是真实可用窗口：
 * 下限来自「至少要塞进一个可听的换手/一次果断动作」，
 * 上限来自「再长就要开始硬撑乐句，听觉上会暴露技巧」。
 */
export const STYLE_CATALOG: readonly StyleSpec[] = [
  {
    id: 'longBlend',
    label: '长混音（16–32 小节对轨）',
    why: '同级能量、调性相容时最自然的交接，听感上像一首曲自然长出了下一首。',
    requires: ['split', 'sweep', 'duck', 'tempo'],
    params: { swapShare: 0.5, sweepShare: 0.35, duckDb: -4, tempoRange: 6, bars: 16 },
    minFadeMs: 16_000,
    maxFadeMs: 32_000,
  },
  {
    id: 'bassSwap',
    label: '低频换手（bass swap）',
    why: '两条 bassline 绝不同时存在，只在中高频重叠；换手点落在 downbeat 上会有一记「落地」感。',
    requires: ['split', 'duck', 'tempo'],
    params: { swapShare: 0.25, duckDb: -4, tempoRange: 8, bars: 8 },
    minFadeMs: 6_000,
    maxFadeMs: 24_000,
  },
  {
    id: 'eqSwap',
    label: '三段 EQ 分工交接',
    why: '低/中/高依次交接，A 的中频最后退场、B 的高频先探头，适合人声对唱式的曲目。',
    requires: ['split', 'sweep', 'duck', 'tempo'],
    params: { swapShare: 0.15, sweepShare: 0.4, duckDb: -4, tempoRange: 8, bars: 12 },
    minFadeMs: 8_000,
    maxFadeMs: 32_000,
  },
  {
    id: 'filterSweep',
    label: '双扫（A 低通收 / B 高通开）',
    why: '两首在交叉点各自「变薄」，共享同一段频谱，听感像雾散开再聚拢。',
    requires: ['sweep', 'tempo'],
    params: { sweepShare: 1, tempoRange: 15, bars: 4 },
    minFadeMs: 4_000,
    maxFadeMs: 16_000,
  },
  {
    id: 'echoOut',
    label: '回声收尾（echo out）',
    why: '杀掉 A 的干声只留 1–2 小节延迟尾巴，B 在尾巴下面进来；可以在任何拍点、跨 BPM 换。',
    requires: ['echo', 'tailHold'],
    params: { echoDiv: 0.5, tailHold: 0.15, tempoRange: 40, bars: 2 },
    minFadeMs: 1_200,
    maxFadeMs: 6_000,
  },
  {
    id: 'reverbOut',
    label: '混响收尾（reverb out）',
    why: '把 A 推进大空间再抽走，留一片尾音当桥；比 echo 更糊、更氛围，适合慢速与 breakdown。',
    requires: ['reverb', 'tailHold'],
    params: { reverbSendDb: -6, tailHold: 0.2, tempoRange: 40, bars: 2 },
    minFadeMs: 2_000,
    maxFadeMs: 8_000,
  },
  {
    id: 'loopRoll',
    label: '连滚 loop（1/2 → 1/4 → 1/8 拍）',
    why: '把 A 滚成越来越碎的节奏，在目标 downbeat 上一次性释放；制造 1–2 小节的机械张力。',
    requires: ['bridge', 'tailHold'],
    params: { echoDiv: 0.25, tailHold: 0.1, tempoRange: 25, bars: 1 },
    minFadeMs: 1_000,
    maxFadeMs: 4_000,
  },
  {
    id: 'backspin',
    label: '回旋刹车（backspin / brake）',
    why: '反向猛拉或受控减速，用一个「音乐性的休止」结束 A；BPM 差太远时唯一不丢人的收尾。',
    requires: ['cut', 'tailHold'],
    params: { tailHold: 0.05, tempoRange: 60, bars: 1 },
    minFadeMs: 1_000,
    maxFadeMs: 2_400,
  },
  {
    id: 'slam',
    label: '砸切（slam）',
    why: '在强拍上把 crossfader 一把推到底，A 瞬断 B 满编进；最响、最不掩饰、也最不容易出错。',
    requires: ['cut'],
    params: { tempoRange: 60, bars: 1 },
    minFadeMs: 1_000,
    maxFadeMs: 1_500,
  },
  {
    id: 'dropSwap',
    label: '交换 drop（drop swap）',
    why: '只在 drop 那一刻切过去，全场只听到一个 drop；零重叠所以调性风险为零。',
    requires: ['cut', 'bridge'],
    params: { swapShare: 0.05, tempoRange: 2, bars: 2 },
    minFadeMs: 2_400,
    // drop 直切通常是「一小节铺场 + 半小节退出」，6 s 足够；再长就不像在等 drop。
    maxFadeMs: 6_000,
  },
  {
    id: 'doubleDrop',
    label: '双 drop（double drop）',
    why: '两个 drop 同一小节同时落地，能量翻倍；需要同速同调，且至少一首在 drop 处稀疏。',
    requires: ['split', 'duck', 'tempo'],
    params: { swapShare: 0.3, duckDb: -6, tempoRange: 0.5, bars: 8 },
    minFadeMs: 12_000,
    maxFadeMs: 32_000,
  },
  {
    id: 'doubling',
    label: '叠播加厚（doubling）',
    why: '同一首（或同源 loop）两条 deck 错开几拍叠放，得到更宽更狠的鼓组；也可做「半速叠全速」。',
    requires: ['split', 'duck', 'bridge', 'tempo'],
    params: { swapShare: 0.4, duckDb: -3, tempoRange: 1, bars: 8 },
    minFadeMs: 4_000,
    maxFadeMs: 16_000,
  },
  {
    id: 'acapellaOverlay',
    label: '清唱叠加（acapella overlay）',
    why: '把 A（或第三方）的清唱垫在 B 的器乐上，用 duck 让人声始终在最前面；出片最像「编排过」。',
    requires: ['duck', 'bridge', 'introBridge', 'tempo'],
    params: { duckDb: -6, tempoRange: 4, bars: 16 },
    minFadeMs: 8_000,
    maxFadeMs: 32_000,
  },
  {
    id: 'halfTime',
    label: '半速 / 双速切换（half-time）',
    why: '把 BPM 折半或翻倍，同一首曲在另一层速度上获得呼吸感；鼓组密度自然减半。',
    requires: ['tempo', 'split'],
    params: { swapShare: 0.5, tempoRange: 50, bars: 4 },
    minFadeMs: 4_000,
    maxFadeMs: 16_000,
  },
  {
    id: 'keyLift',
    label: '升调推进（key lift）',
    why: '过渡时把 B 抬 +1 半音（Camelot +1 步），落地即完成一次「能量抬升」；老派 harmonic set 的招牌。',
    requires: ['bridge', 'introBridge', 'tempo'],
    params: { tempoRange: 3, bars: 4 },
    minFadeMs: 3_000,
    maxFadeMs: 12_000,
  },
  {
    id: 'cut',
    label: '硬切（cut）',
    why: '零重叠：A 音量瞬杀、B 从第一拍起。调性冲突、拍号不同、能量断层时最干净的解。',
    requires: ['cut'],
    params: { tempoRange: 100, bars: 1 },
    minFadeMs: 1_000,
    maxFadeMs: 1_000,
  },
];

/** 目录顺序的 id 列表，便于 UI 与测试对齐（与 STYLE_CATALOG 同序）。 */
export const TRANSITION_STYLE_IDS: readonly TransitionStyleId[] = STYLE_CATALOG.map((s) => s.id);

// ---------------------------------------------------------------------------
// 打分常数表（每一项都能在 reasons 里被念出来）
// ---------------------------------------------------------------------------

/** 基础分：越通用、越不容易翻车的手法底分越高。 */
const STYLE_BASE: Readonly<Record<TransitionStyleId, number>> = {
  bassSwap: 26,
  longBlend: 24,
  eqSwap: 22,
  filterSweep: 20,
  echoOut: 18,
  cut: 16,
  dropSwap: 14,
  doubling: 12,
  loopRoll: 12,
  acapellaOverlay: 10,
  reverbOut: 10,
  halfTime: 8,
  keyLift: 8,
  backspin: 6,
  slam: 6,
  doubleDrop: 4,
};

/** 调性敏感度：重叠越长、越有音高内容，调性权重越高；硬切/尾巴散的手法几乎不吃调性。 */
const KEY_WEIGHT: Readonly<Record<TransitionStyleId, number>> = {
  longBlend: 1,
  acapellaOverlay: 1,
  eqSwap: 1,
  doubling: 1,
  keyLift: 1,
  bassSwap: 0.8,
  halfTime: 0.8,
  doubleDrop: 0.8,
  dropSwap: 0.8,
  filterSweep: 0.5,
  loopRoll: 0.5,
  reverbOut: 0.5,
  echoOut: 0.2,
  cut: 0.2,
  slam: 0.2,
  backspin: 0.2,
};

/** 两首都有唱词时的扣分（duck 能救一部分，所以 bassSwap/dropSwap 扣得少）。 */
const DUAL_VOCAL_PENALTY: Readonly<Record<TransitionStyleId, number>> = {
  longBlend: -16,
  doubling: -16,
  doubleDrop: -12,
  eqSwap: -10,
  keyLift: -8,
  acapellaOverlay: -2,
  loopRoll: -6,
  halfTime: -6,
  bassSwap: -4,
  filterSweep: -4,
  reverbOut: 0,
  dropSwap: 0,
  echoOut: 0,
  cut: 0,
  slam: 0,
  backspin: 0,
};

/** 能量差大时反而加分的额度（这类手法就是为断层设计的）。 */
const ENERGY_GAP_REWARD: Readonly<Record<TransitionStyleId, number>> = {
  filterSweep: 12,
  echoOut: 10,
  loopRoll: 10,
  reverbOut: 8,
  slam: 8,
  dropSwap: 6,
  cut: 6,
  backspin: 6,
  longBlend: 0,
  bassSwap: 0,
  eqSwap: 0,
  doubleDrop: 0,
  doubling: 0,
  acapellaOverlay: 0,
  halfTime: 0,
  keyLift: 0,
};

/** 完全不依赖 downbeat 网格也能做的风格。 */
const GRIDLESS_OK: readonly TransitionStyleId[] = ['cut', 'slam'];

/**
 * 不需要两首同时踩在同一个 BPM 上的风格：
 * 硬切/砸切/回旋没有重叠；echo/reverb 的尾巴可以锁到 B 的 BPM；halfTime 本来就是变速。
 * 这些风格不受全局 BPM 硬限约束（各自还有 tempoRange 细分门控）。
 */
const TEMPO_FREE_IDS: readonly TransitionStyleId[] = [
  'cut',
  'slam',
  'backspin',
  'echoOut',
  'reverbOut',
  'halfTime',
  // drop 直切是零重叠手法：不需要两首同速，BPM 差大反而是它唯一体面的场景。
  'dropSwap',
  'doubleDrop',
];

/** 依赖 8/16 小节乐句对齐的风格：拍号不一致时直接不可用。 */
const PHRASE_IDS: readonly TransitionStyleId[] = [
  'loopRoll',
  'longBlend',
  'bassSwap',
  'eqSwap',
  'dropSwap',
  'doubleDrop',
  'doubling',
  'acapellaOverlay',
  'halfTime',
  'keyLift',
];

/** 需要「B 有干净入口」的风格：B 无前奏且首句很近时，尾巴下面没有落脚点。 */
const ENTRY_IDS: readonly TransitionStyleId[] = ['echoOut', 'reverbOut', 'loopRoll', 'doubleDrop', 'dropSwap'];

/** 长重叠且吃和声的风格：keyGap 大 + 能量断层时禁止。 */
const HARMONIC_IDS: readonly TransitionStyleId[] = ['longBlend', 'acapellaOverlay', 'doubling', 'eqSwap', 'bassSwap'];

// ---------------------------------------------------------------------------
// 上下文归一化
// ---------------------------------------------------------------------------

interface NormCtx {
  bpmA: number;
  bpmB: number;
  bpmKnown: boolean;
  /** 实际 BPM 偏差百分比（不折叠）：128 对 64 就是 50%。 */
  bpmPct: number;
  /** 折叠到 1:1 之后的偏差百分比，只有 halfTime 用得上（128 对 64 折叠后是 0%）。 */
  bpmPctFolded: number;
  ratio: number;
  halfDouble: boolean;
  keyGap: number;
  keyKnown: boolean;
  energyGap: number;
  meterA: number;
  meterB: number;
  aVocal: boolean;
  bVocal: boolean;
  aHasIntro: boolean;
  bHasIntro: boolean;
  bHasDrop: boolean;
  aHasOutro: boolean;
  bFirstVocalMs: number;
  aLoopUnits: number;
  bLoopUnits: number;
  fadeMsWanted: number;
  barMs: number;
  beatMs: number;
  tempoSoftLimit: number;
  tempoHardLimit: number;
  aInstrumental: boolean;
  bInstrumental: boolean;
  hasDownbeat: boolean;
}

function num(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function flag(value: boolean | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * 缺字段的默认值刻意偏保守：
 * - BPM 未知 -> bpmKnown=false，不参与变速判断（同速假设）；
 * - B 无前奏（未检测到就当没有）、首句时刻未知 -> 0，于是「没有干净入口」的门控生效；
 * - loop 单元未知 -> 0，loop 类手法被门控掉；
 * - 拍号未知 -> 4/4；
 * - 有 downbeat（除非显式给 false），否则全曲都做不了。
 */
function normalizeCtx(ctx: StyleContext | undefined): NormCtx {
  const src: StyleContext = ctx === undefined ? {} : ctx;
  const bpmA = num(src.bpmA, 0);
  const bpmB = num(src.bpmB, 0);
  const bpmKnown = bpmA > 0 && bpmB > 0;
  const ratio = bpmKnown ? bpmB / bpmA : 1;

  const isDouble = Math.abs(ratio - 2) <= 0.06;
  const isHalf = Math.abs(ratio - 0.5) <= 0.015;
  const halfDouble = bpmKnown && (isDouble || isHalf);
  const folded = isDouble ? ratio / 2 : isHalf ? ratio * 2 : ratio;
  const bpmPct = bpmKnown ? Math.abs(ratio - 1) * 100 : 0;
  const bpmPctFolded = bpmKnown ? Math.abs(folded - 1) * 100 : 0;

  const barMs = num(src.barMs, bpmA > 0 ? (60_000 / bpmA) * 4 : 1_875);
  const beatMs = num(src.beatMs, barMs / 4);

  return {
    bpmA,
    bpmB,
    bpmKnown,
    bpmPct,
    bpmPctFolded,
    ratio,
    halfDouble,
    keyGap: Math.max(0, Math.round(num(src.keyGap, 0))),
    keyKnown: typeof src.keyGap === 'number' && Number.isFinite(src.keyGap),
    energyGap: Math.min(1, Math.max(0, num(src.energyGap, 0))),
    meterA: num(src.meterA, 4),
    meterB: num(src.meterB, 4),
    aVocal: flag(src.aVocal, false),
    bVocal: flag(src.bVocal, false),
    aHasIntro: flag(src.aHasIntro, false),
    bHasIntro: flag(src.bHasIntro, false),
    bHasDrop: flag(src.bHasDrop, false),
    aHasOutro: flag(src.aHasOutro, false),
    bFirstVocalMs: Math.max(0, num(src.bFirstVocalMs, 0)),
    aLoopUnits: Math.max(0, Math.round(num(src.aLoopUnits, 0))),
    bLoopUnits: Math.max(0, Math.round(num(src.bLoopUnits, 0))),
    fadeMsWanted: Math.max(0, num(src.fadeMsWanted, 0)),
    barMs,
    beatMs,
    tempoSoftLimit: num(src.tempoSoftLimit, 6),
    tempoHardLimit: num(src.tempoHardLimit, 12),
    aInstrumental: flag(src.aInstrumental, false),
    bInstrumental: flag(src.bInstrumental, false),
    hasDownbeat: flag(src.hasDownbeat, true),
  };
}

// ---------------------------------------------------------------------------
// 硬门控
// ---------------------------------------------------------------------------

/**
 * 门控顺序即优先级：先 BPM（最硬的物理约束），再网格/拍号、入口、和声、素材。
 * 返回第一命中原因；返回 undefined 表示该风格可选。
 */
/**
 * 用于门控/打分的 BPM 偏差：
 * 只有 halfTime 用折叠后的值（128 对 64 折叠成 0%），其它风格按实际速率变化算
 * —— 把 64 BPM 的曲硬拉到 128 是 50% 的变速，不能假装「齐平」。
 */
function effBpmPct(spec: StyleSpec, n: NormCtx): number {
  return spec.id === 'halfTime' ? n.bpmPctFolded : n.bpmPct;
}

function gateOf(spec: StyleSpec, n: NormCtx): string | undefined {
  const pct = round1(effBpmPct(spec, n));

  if (n.bpmKnown && effBpmPct(spec, n) > n.tempoHardLimit && !TEMPO_FREE_IDS.includes(spec.id)) {
    return `BPM 差 ${pct}% 超过硬限 ${n.tempoHardLimit}%，变速必然听得出来`;
  }

  const styleRange = spec.params.tempoRange ?? 100;
  if (n.bpmKnown && effBpmPct(spec, n) > styleRange) {
    return `BPM 差 ${pct}% 超过该风格的 tempoRange ${styleRange}%`;
  }

  if (!n.hasDownbeat && !GRIDLESS_OK.includes(spec.id)) {
    return '未检测到 downbeat 网格，拍点无法对齐';
  }

  if (n.meterA !== n.meterB && PHRASE_IDS.includes(spec.id)) {
    return `拍号不一致（${n.meterA}/4 对 ${n.meterB}/4），8/16 小节乐句无法对齐`;
  }

  if (!n.bHasIntro && n.bFirstVocalMs < 1_500 && ENTRY_IDS.includes(spec.id)) {
    return `B 无前奏且首句人声 ${Math.round(n.bFirstVocalMs)}ms < 1500ms，尾巴下面没有干净入口`;
  }

  if ((spec.id === 'dropSwap' || spec.id === 'doubleDrop') && !n.bHasDrop) {
    return 'B 没有 drop / 副歌段，找不到可瞄准的落点';
  }

  if (n.keyGap >= 5 && n.energyGap >= 0.3 && HARMONIC_IDS.includes(spec.id)) {
    return `keyGap ${n.keyGap} 且能量差 ${n.energyGap.toFixed(2)}，长重叠会和声撞车`;
  }

  if (spec.id === 'loopRoll' && n.aLoopUnits <= 0) {
    return 'A 没有可用 loop 单元，滚不起来';
  }

  // 叠播只需要 B 的一小片素材（A 那一侧只是被垫着），所以只要求 B 有 loop 单元。
  if (spec.id === 'doubling' && n.bLoopUnits <= 0) {
    return `叠播需要 B 有可用的 loop 单元（当前 ${n.bLoopUnits}）`;
  }

  if (spec.id === 'halfTime' && !n.halfDouble) {
    return `BPM 比 ${n.ratio.toFixed(2)} 不是 2:1 / 1:2 关系`;
  }

  if (spec.id === 'acapellaOverlay' && n.aInstrumental) {
    return 'A 本身没有唱词，没有可叠加的清唱素材';
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// 打分
// ---------------------------------------------------------------------------

function scoreOf(spec: StyleSpec, n: NormCtx): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = STYLE_BASE[spec.id];

  // 1) BPM ----------------------------------------------------------------
  if (!n.bpmKnown) {
    reasons.push('BPM 未知，按同速处理');
  } else if (n.halfDouble && spec.id === 'halfTime') {
    score += 24;
    reasons.push(`BPM 比 ${n.ratio.toFixed(2)} 正好是 half/double 关系，+24`);
  } else {
    const pct = round1(effBpmPct(spec, n));
    if (pct <= 0.5) {
      score += 14;
      reasons.push(`BPM 齐平（差 ${pct}%），+14`);
    } else if (pct <= n.tempoSoftLimit) {
      const gain = round1(14 * (1 - pct / n.tempoSoftLimit));
      score += gain;
      reasons.push(`BPM 差 ${pct}% 在软限 ${n.tempoSoftLimit}% 内，+${gain}`);
    } else if (pct <= n.tempoHardLimit) {
      score -= 18;
      reasons.push(`BPM 差 ${pct}% 超过软限 ${n.tempoSoftLimit}%，−18`);
    } else {
      score -= 30;
      reasons.push(`BPM 差 ${pct}% 超过硬限 ${n.tempoHardLimit}%，−30`);
    }
  }

  // 2) 调性 ---------------------------------------------------------------
  const kw = KEY_WEIGHT[spec.id];
  if (!n.keyKnown) {
    const gain = round1(10 * kw);
    score += gain;
    reasons.push(`调性未知，按同调保守计入 +${gain}`);
  } else if (n.keyGap <= 0) {
    score += round1(10 * kw);
    reasons.push(`同调（keyGap 0），+${round1(10 * kw)}`);
  } else if (n.keyGap <= 1) {
    score += round1(7 * kw);
    reasons.push(`相邻调（keyGap ${n.keyGap}），+${round1(7 * kw)}`);
  } else if (n.keyGap === 2) {
    score += round1(2 * kw);
    reasons.push(`两格距离（keyGap 2），只能压缩重叠，+${round1(2 * kw)}`);
  } else if (n.keyGap <= 4) {
    const pen = round1(8 * kw);
    score -= pen;
    reasons.push(`keyGap ${n.keyGap} 已出安全区，−${pen}`);
  } else {
    const pen = round1(18 * kw);
    score -= pen;
    reasons.push(`keyGap ${n.keyGap} 属 key clash，−${pen}`);
  }

  // 3) 能量 ---------------------------------------------------------------
  const reward = ENERGY_GAP_REWARD[spec.id];
  if (n.energyGap >= 0.35) {
    score += reward;
    reasons.push(
      reward > 0
        ? `能量差 ${n.energyGap.toFixed(2)} 偏大，正是这类手法的用武之地，+${reward}`
        : `能量差 ${n.energyGap.toFixed(2)} 偏大，长重叠容易被拉平`,
    );
  } else if (n.energyGap <= 0.15) {
    score += 8;
    reasons.push(`能量接近（差 ${n.energyGap.toFixed(2)}），+8`);
  } else {
    score += 3;
    reasons.push(`能量差中等（${n.energyGap.toFixed(2)}），+3`);
  }

  // 4) 唱词 ---------------------------------------------------------------
  if (n.aVocal && n.bVocal) {
    const pen = DUAL_VOCAL_PENALTY[spec.id];
    if (pen !== 0) {
      score += pen;
      reasons.push(`两首都有唱词，−${Math.abs(pen)}`);
    }
  }
  if (spec.id === 'acapellaOverlay' && n.aInstrumental && !n.bInstrumental) {
    score -= 12;
    reasons.push('A 无唱词，清唱叠加没有素材，−12');
  }
  if (spec.id === 'acapellaOverlay' && !n.aInstrumental && n.bVocal) {
    // 零分轨降级版的目标场景：A 有唱词、B 也有唱词 —— 靠「A 抬中频 + B 让位」
    // 做出「最后一句浮在 B 的伴奏上」。两首都唱本来是别的手法的扣分项，这里反而是前提。
    const close = n.keyGap <= 2;
    score += close ? 10 : 5;
    reasons.push(`A/B 都有唱词${close ? '且调性接近' : ''}，可做「最后一句浮出」，+${close ? 10 : 5}`);
  }

  // 5) 结构 ---------------------------------------------------------------
  if (spec.requires.includes('bridge') && n.aLoopUnits > 0) {
    score += 8;
    reasons.push(`A 有 ${n.aLoopUnits} 个 loop 单元，可做结构桥，+8`);
  }
  if (spec.id === 'loopRoll' && n.bLoopUnits > 0) {
    score += 4;
    reasons.push(`B 有 ${n.bLoopUnits} 个 loop 单元，尾巴可对齐，+4`);
  }
  if (ENTRY_IDS.includes(spec.id) && n.bHasIntro) {
    score += 8;
    reasons.push('B 有干净前奏，尾巴/换手有落点，+8');
  }
  if (
    (spec.id === 'longBlend' || spec.id === 'bassSwap' || spec.id === 'eqSwap') &&
    n.aHasOutro
  ) {
    score += 6;
    reasons.push('A 有完整尾奏，可以从容交接，+6');
  }
  if (PHRASE_IDS.includes(spec.id) && n.hasDownbeat) {
    score += 6;
    reasons.push('downbeat 网格可用，8/16 小节能对齐，+6');
  }
  // dropSwap / doubleDrop 的真正用武之地是「拍速差太大，怎么拉都听得出来」：
  //   零重叠的 drop 切换不受 BPM 约束，反而是唯一体面的解法。
  const gapPct = n.bpmA > 0 && n.bpmB > 0 ? Math.abs(n.bpmA - n.bpmB) / n.bpmA * 100 : 0;
  if (spec.id === 'dropSwap' && gapPct >= 8) {
    const gain = round1(Math.min(20, (gapPct - 8) * 1.6));
    score += gain;
    reasons.push(`BPM 差 ${gapPct.toFixed(1)}%，blend 拉不动，drop 直切是唯一体面的解法，+${gain}`);
  }
  if (spec.id === 'doubling' && n.bHasDrop) {
    score += 12;
    reasons.push('B 有结实的 drop，切片叠在 A 上不会糊，+12');
  }
  if (spec.id === 'doubleDrop' && gapPct <= 1 && n.energyGap <= 0.25) {
    const gain = round1(14 + (0.25 - n.energyGap) * 20);
    score += gain;
    reasons.push(`同速（差 ${gapPct.toFixed(1)}%）且能量接近，两个 drop 可以同时落地，+${gain}`);
  }
  if (n.aInstrumental && (spec.id === 'acapellaOverlay' || spec.id === 'doubling')) {
    score += 4;
    reasons.push('A 是器乐，叠人声/叠鼓不会抢词，+4');
  }

  // 6) 期望时长是否落在该手法的窗口里 ------------------------------------
  if (n.fadeMsWanted > 0) {
    if (n.fadeMsWanted < spec.minFadeMs) {
      score -= 6;
      reasons.push(
        `期望 ${Math.round(n.fadeMsWanted)}ms 短于该手法下限 ${spec.minFadeMs}ms，−6`,
      );
    } else if (n.fadeMsWanted > spec.maxFadeMs) {
      score -= 10;
      reasons.push(
        `期望 ${Math.round(n.fadeMsWanted)}ms 超出该手法上限 ${spec.maxFadeMs}ms，−10`,
      );
    } else {
      score += 6;
      reasons.push(`期望 ${Math.round(n.fadeMsWanted)}ms 落在窗口内，+6`);
    }
  }

  return { score: round1(score), reasons };
}

/** 把期望时长夹进 [minFadeMs, maxFadeMs]，并在不越界的前提下尽量对齐整小节。 */
function clampFadeMs(spec: StyleSpec, wanted: number, barMs: number): number {
  const target =
    wanted > 0 ? wanted : Math.round((spec.minFadeMs + spec.maxFadeMs) / 2);
  let value = Math.min(spec.maxFadeMs, Math.max(spec.minFadeMs, target));
  if (barMs > 0) {
    const bars = Math.max(1, Math.round(value / barMs));
    const quantized = bars * barMs;
    if (quantized >= spec.minFadeMs && quantized <= spec.maxFadeMs) {
      value = quantized;
    }
  }
  return Math.round(value);
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

/**
 * 给全部 16 种风格打分并排序。
 * 排序是稳定的：分数相同则按 STYLE_CATALOG 顺序（先 bassSwap 后 longBlend 这种固定次序）。
 */
export function rankStyles(ctx?: StyleContext): RankedStyle[] {
  const n = normalizeCtx(ctx);

  const rows = STYLE_CATALOG.map((spec, index) => {
    const { score, reasons } = scoreOf(spec, n);
    const blockedBy = gateOf(spec, n);
    const row: RankedStyle = {
      spec,
      score,
      reasons,
      fadeMs: clampFadeMs(spec, n.fadeMsWanted, n.barMs),
    };
    if (blockedBy !== undefined) {
      row.blockedBy = blockedBy;
      row.reasons = reasons.concat(`被挡：${blockedBy}`);
    }
    return { row, index };
  });

  rows.sort((left, right) => {
    if (right.row.score !== left.row.score) return right.row.score - left.row.score;
    return left.index - right.index;
  });

  return rows.map((entry) => entry.row);
}

/** 取当前上下文下最该用的风格；全部被挡住时返回 null（正常情况 cut 永远可选）。 */
export function pickStyle(ctx?: StyleContext): RankedStyle | null {
  const ranked = rankStyles(ctx);
  for (const candidate of ranked) {
    if (candidate.blockedBy === undefined) return candidate;
  }
  return null;
}

const STYLE_DESCRIPTIONS: Readonly<Record<TransitionStyleId, string>> = {
  longBlend:
    '16–32 小节对轨：B 一进来就切掉低频，两条 bassline 只在中高频重叠，整段过渡只有一个 bass swap 交接点。听感像一首曲自然长出了下一首，观众听不出「操作」。要求调性在 ±1 步内、能量接近；两首都有强唱词时不要用。',
  bassSwap:
    '6–24 秒内只做一件事：把低频从 A 换到 B。B 先 kill 低频推起来，骑一个乐句，然后在 downbeat 上同时把 A low 拉到 0、B low 回到 unity。听感是一记「落地」，鼓组瞬间换人。任何时刻只有一条 bassline 在响是唯一铁律。',
  eqSwap:
    '低/中/高依次交接：B 的高频先探头、A 的中频最后退场。比 bass swap 细腻，能保住人声对唱感；缺点是时间窗更长，调性冲突会被放大。适合两首都以人声/和弦为主的流行、R&B、house。',
  filterSweep:
    'A 用低通逐渐关掉（先没高频、再没中频，最后只剩 kick 与 sub），B 用高通逐渐打开（低频最后进来），两首在交叉点各自「变薄」共享同一段频谱。4–16 秒就够，滥用会让人听见技巧本身。',
  echoOut:
    '在乐句尾或任意强拍上开 1/2 或 1/4 拍 echo，随即杀掉 A 的干声，只留 1–2 小节尾巴，B 在尾巴下面进来。因为尾巴可以锁到 B 的 BPM，跨速换歌也不散架；peak time 慎用，会泄气。',
  reverbOut:
    '把 A 送进大混响再抽走干声，留 1–2 小节尾音当桥，B 在混响消散前进场。比 echo 更糊更氛围，适合慢速、breakdown、ambient 段落；快歌里会糊掉低频。',
  loopRoll:
    '把 A 的 1 拍切成 1/2、1/4、1/8 逐级加速，在目标 downbeat 一次释放。单次不超过 1 小节，否则听起来像唱片卡住。制造的是机械张力，不是和声张力，所以几乎不怕调性冲突。',
  backspin:
    '反向猛拉唱片或受控减速（brake），用一个果断的休止结束 A，松手瞬间回到原速。结束点比速度重要：必须落在 downbeat 上，而且 B 已经在跑。BPM 差太远、blend 无望时最体面。',
  slam:
    '在强拍上一把把 crossfader 推到底，A 瞬断、B 满编进入。没有重叠所以没有调性风险，代价是律动断裂——催眠式段落里用会把人从状态里拽出来。',
  dropSwap:
    '把 B 的 drop 打成 hot cue，两首的乐句对齐到「两个 drop 本应重合」，然后在那一拍切过去，全场只听到一个 drop。零重叠、调性风险为零，但错一拍所有人都听得出来。',
  doubleDrop:
    '两个 drop 在同一小节同时落地，能量翻倍。需要同速（±0.5%）、调性相容，而且至少一首在 drop 处稀疏；低频必须在 drop 之前换掉，不能在 drop 当中换。Drum & Bass、dubstep 最常用。',
  doubling:
    '同一首（或同源 loop）在两条 deck 上错开几拍叠放，鼓组变宽变狠；也可以半速叠全速做加厚。需要两边都有 loop 单元、BPM 几乎完全一致，否则梳状滤波会让低频忽大忽小。',
  acapellaOverlay:
    '把清唱垫在另一首的器乐上，用 duck 让人声始终在最前。前提是清唱有正确 beatgrid、能锁拍；A 本身是器乐时无从叠加。出片最像「编排过」，但也最容易在版权与调性上翻车。',
  halfTime:
    '把 BPM 折半或翻倍，同一首曲换一层速度呼吸；鼓组密度自然减半，适合在 set 中段换气或从 hip-hop 切 drum & bass。只在两曲确实是 2:1 / 1:2 关系时成立。',
  keyLift:
    '过渡时把 B 抬 +1 半音（Camelot +1 步），落地即完成一次能量抬升。3–12 秒的小窗口，靠前奏 loop 补时；调性本来就 +1 时不要再用，会变成 +2。',
  cut:
    '零重叠：A 音量瞬杀、B 从第一拍起。调性冲突、拍号不同、能量断层时最干净的解，也是所有自动系统的兜底。干净的一刀永远好过混乱的拖长。',
};

/** 取某种风格的中文说明；未知 id 也给一句可用的兜底文案。 */
/** 手法的短名（「低频换手」「双扫」这种人话），不带括号里的英文注释。 */
export function styleLabel(id: TransitionStyleId): string {
  const spec = STYLE_CATALOG.find((s) => s.id === id);
  if (!spec) return String(id);
  return spec.label.replace(/（.*?）/g, '').trim();
}

export function describeStyle(id: TransitionStyleId): string {
  const text: string | undefined = STYLE_DESCRIPTIONS[id];
  if (typeof text === 'string' && text.length > 0) return text;
  return `未收录的过渡风格（${String(id)}）：请回退到 cut 或 longBlend 这类已验证的手法。`;
}

/** 参数表快照，方便 UI 展示与接线时对齐（返回副本，调用方改动不会污染目录）。 */
export function styleParamTable(): {
  id: TransitionStyleId;
  label: string;
  minFadeMs: number;
  maxFadeMs: number;
  params: StyleParams;
}[] {
  return STYLE_CATALOG.map((spec) => ({
    id: spec.id,
    label: spec.label,
    minFadeMs: spec.minFadeMs,
    maxFadeMs: spec.maxFadeMs,
    params: { ...spec.params },
  }));
}
