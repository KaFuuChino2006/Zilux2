/**
 * 智能过渡决策层（P0）：纯计算，不碰音频、不碰 DOM。
 *
 * 三层架构里的第一、二层：
 *   Decider  —— 判断两首歌能不能换、允许换哪几轨、要不要 sync（`Compat`）
 *   Scheduler —— 把换手动作排到 A 的 downbeat / 乐句边界上，输出可序列化的 `TransitionPlan`
 * Performer（第三层）只消费 `TransitionPlan`，把 `actions` 变成 AudioParam 自动化。
 *
 * 设计要点：
 * - 所有时间锚点都落在 `downbeats`（换手点误差 <5 ms 是硬约束）。
 * - 输出是纯数据，可以 dump、可以在 UI 上拖动、可以离线跑测试。
 * - 任何不确定都走 `fallback`，绝不抛异常给播放链路。
 */

import type { BeatAnalysis } from '../online/analysis';

export type Stem = 'bass' | 'drums' | 'other' | 'vocals';

/**
 * 增益曲线：
 * - `linear`      两路相关（同源低频、已对齐 kick）→ a+b=1，功率不叠加
 * - `equalPower`  两路不相关（不同 stem / 不同曲）→ cos/sin，功率恒定
 * - `shelfDip`    中点刻意压 −3 dB；只适用于两轨低频部分相关、需要牺牲纯度换稳定性的场合。
 *                 （实测：完全相关的低频用 linear 才是 `a+b=1`，shelfDip 反而引入 3 dB 凹陷。）
 */
export type Curve = 'linear' | 'equalPower' | 'shelfDip';

export type Template = 'standard' | 'vocalFirst' | 'doubleDrop' | 'bassOnly' | 'filterBuild';

export interface SwapAction {
  stem: Stem;
  /** 相对过渡起点的第几小节（0 起）。 */
  startBar: number;
  /** 交叉长度（拍）。bass 通常 0.5，其他 1~2。 */
  lengthBeats: number;
  curve: Curve;
}

export interface Compat {
  /** 0~1，越高越适合做完整换手。 */
  score: number;
  /** Camelot 距离：同调 0、相邻 1、差 2 及以上。 */
  keyDistance: number;
  /** B 相对 A 的播放速率（已做拍族折叠，尽量落在 1 附近）。 */
  tempoRatio: number;
  /** |tempoRatio − 1|。 */
  tempoDeviation: number;
  /** |energyA − energyB|，缺失按 0.2 估计。 */
  energyGap: number;
  /** 允许换手的轨。 */
  allowed: Stem[];
  /** 给 UI 展示的「为什么这样换」。 */
  reason: string;
}

export interface TransitionPlan {
  template: Template;
  /** A 侧让位起点（ms，文件内时间）。 */
  startMsA: number;
  /** B 侧进场点（ms，文件内时间）。 */
  startMsB: number;
  totalBars: number;
  /** 一拍多少 ms（按 A 的 bpm）。 */
  beatMs: number;
  barMs: number;
  rate: number;
  actions: SwapAction[];
  /**
   * 人声回声甩尾的排程（可选）：`vocalFirst` 模板会带上。
   * `startMs` 是 A 的人声开始送进 delay 总线的时刻（相对过渡起点），
   * `lengthBeats` 是送出的时长（1 拍 = 甩一次尾，下一小节线切干声）。
   */
  echo?: { startMs: number; lengthBeats: number };
  /** 滤波扫频（目前只有 `filterBuild` 用）：把进场 deck 从窄带放回全开。 */
  filter?: { startMs: number; lengthBeats: number; fromHz: number; toHz: number };
  /** 出场侧的关门（低通从全开收到闷）：与 `filter` 成对，`filterBuild` 才有。 */
  filterOut?: { startMs: number; lengthBeats: number; fromHz: number; toHz: number };
  compat: Compat;
  fallback: 'none' | 'bassDrumsOnly' | 'eq3band' | 'fixedEqualPower';
  warnings: string[];
}

import type { TransitionTuning } from './transitionTuning';

export interface PlanInput {
  /** 面板调参（内部测试版）；缺省 = 全部走默认值，行为与旧版逐字段一致。 */
  tuning?: TransitionTuning;
  analysisA: BeatAnalysis;
  analysisB: BeatAnalysis;
  /** A 当前播放位置（ms）。 */
  positionMsA: number;
  currentDurationMs?: number;
  nextDurationMs?: number;
  /** 低置信度直接降级，不要冒险换手。 */
  minConfidence?: number;
  /**
   * 用户拖动换手点后的覆盖值（ms，A 的曲内时间）。
   * 命中时会被**吸附到最近的小节线**——v1 约束 3「不抖结构」：换手必须落在小节线。
   */
  handoffOverrideMs?: number;
  /**
   * 每条分轨在两首曲之间的低频互相关（−1..1，来自 `correlation.ts` 的 `lowBandCorrelation`）。
   * 给了就据此选曲线：ρ ≥ 阈值用 `linear`（幅度守恒），否则 `equalPower`（功率守恒）。
   * 不给就沿用模板里的默认曲线（行为与之前完全一致）。
   */
  correlation?: Partial<Record<Stem, number>>;
}

const EPS = 1e-6;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** `8A` → { num: 8, letter: 1 }；无法解析返回 null。 */
export function parseCamelot(value: string | undefined): { num: number; letter: number } | null {
  if (!value) return null;
  const m = /^\s*(\d{1,2})\s*([AB])\s*$/i.exec(value);
  if (!m) return null;
  const num = Number(m[1]);
  if (!(num >= 1 && num <= 12)) return null;
  return { num, letter: m[2].toUpperCase() === 'A' ? 0 : 1 };
}

/**
 * Camelot 距离：同号 0；环上相邻（含 1↔12 回绕）1；换字母 +0~1；其余 2 起步。
 * 无法解析按 3 处理（最保守：不允许换人声）。
 */
export function camelotDistance(a: string | undefined, b: string | undefined): number {
  const x = parseCamelot(a), y = parseCamelot(b);
  if (!x || !y) return 3;
  const raw = Math.abs(x.num - y.num);
  const ring = Math.min(raw, 12 - raw);
  const letter = x.letter === y.letter ? 0 : 1;
  if (ring === 0 && letter === 0) return 0;
  if (ring <= 1 && letter === 0) return 1;
  if (ring === 0 && letter === 1) return 1;
  return Math.min(3, ring + letter);
}

/** 把任意比值折叠到最接近 1 的八度族（128/64 → 1，64/128 → 1）。 */
export function foldTempoRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return 2 ** (Math.log2(ratio) - Math.round(Math.log2(ratio)));
}

/** 选播放速率：优先折叠到 1 附近，其次 1.5 / 0.667 这种三连音族。 */
export function chooseRate(bpmA: number, bpmB: number): { ratio: number; deviation: number } {
  if (!(bpmA > 0) || !(bpmB > 0)) return { ratio: 1, deviation: 0 };
  const raw = bpmB / bpmA;
  const candidates = [raw, raw / 2, raw * 2, raw / 1.5, raw * 1.5];
  let best = 1, bestDev = Infinity;
  for (const c of candidates) {
    const dev = Math.abs(c - 1);
    if (dev < bestDev) { bestDev = dev; best = c; }
  }
  return { ratio: Number(best.toFixed(6)), deviation: Number(bestDev.toFixed(6)) };
}

function nextDownbeat(downbeats: number[] | undefined, atMs: number): number {
  if (!downbeats || !downbeats.length) return atMs;
  for (const d of downbeats) if (d >= atMs - EPS) return d;
  return downbeats[downbeats.length - 1];
}

/** 优先取 8 小节乐句边界，没有就取下一处 downbeat。 */
function nextPhraseAnchor(analysis: BeatAnalysis, atMs: number, barMs: number): number {
  const phrases = (analysis.phraseStartsMs ?? []).filter((p) => p >= atMs - EPS);
  if (phrases.length) {
    // 太近的乐句边界（<2 小节）不好排动作，往后挪一个。
    const usable = phrases.find((p) => p - atMs >= barMs * 2 - EPS);
    return usable ?? phrases[0];
  }
  return nextDownbeat(analysis.downbeats, atMs);
}

/** 在 B 的 downbeat 上找离 cueInMs（缺省 0）最近的一处作为进场点。 */
function alignEntry(analysis: BeatAnalysis, cueMs: number, barMs: number): number {
  const target = cueMs > 0 ? cueMs : (analysis.firstDownbeatMs ?? 0);
  const downs = analysis.downbeats ?? [];
  if (!downs.length) return Math.max(0, target);
  let best = downs[0], bestDist = Infinity;
  for (const d of downs) {
    const dist = Math.abs(d - target);
    if (dist < bestDist) { bestDist = dist; best = d; }
  }
  // 落点在弱起位置时，宁可用下一个 downbeat，让 B 从「1」进。
  return best + barMs < target ? nextDownbeat(downs, best + 1) : best;
}

export function scoreCompat(a: BeatAnalysis, b: BeatAnalysis): Compat {
  const keyDistance = camelotDistance(a.camelot, b.camelot);
  const { ratio, deviation } = chooseRate(a.bpm, b.bpm);
  const energyA = typeof a.energy === 'number' ? a.energy : 0.5;
  const energyB = typeof b.energy === 'number' ? b.energy : 0.5;
  const energyGap = Math.abs(energyA - energyB);

  const allowed: Stem[] = ['bass', 'drums', 'other'];
  const reasons: string[] = [];
  if (keyDistance <= 1) {
    allowed.push('vocals');
    reasons.push(`调性相邻（Camelot ${a.camelot ?? '?'}→${b.camelot ?? '?'}，距离 ${keyDistance}）`);
  } else {
    reasons.push(`调性差 ${keyDistance}，人声只做淡出不换手`);
  }
  if (deviation <= 0.03) {
    reasons.push(`速度差 ${(deviation * 100).toFixed(1)}%，直接 sync`);
  } else if (deviation <= 0.06) {
    reasons.push(`速度差 ${(deviation * 100).toFixed(1)}%，sync 但提示变速`);
  } else {
    reasons.push(`速度差 ${(deviation * 100).toFixed(1)}%，不 sync`);
  }
  if (energyGap > 0.35) reasons.push(`能量差 ${energyGap.toFixed(2)}，过渡缩短到 8 小节`);

  const score = clamp(
    1 - keyDistance * 0.22 - Math.min(deviation, 0.12) * 2.2 - energyGap * 0.5,
    0, 1,
  );

  return {
    score: Number(score.toFixed(4)),
    keyDistance,
    tempoRatio: ratio,
    tempoDeviation: deviation,
    energyGap: Number(energyGap.toFixed(4)),
    allowed,
    reason: reasons.join('；'),
  };
}

/**
 * A 在 `positionMs` 所在段落的标签（intro / outro / climax / 空串）。
 * 段区间左闭右开；找不到返回空串——调用方据此走保守分支。
 */
export function sectionLabelAt(analysis: BeatAnalysis | undefined, positionMs: number): string {
  const sections = analysis?.sections;
  if (!Array.isArray(sections) || sections.length === 0) return '';
  if (!Number.isFinite(positionMs)) return '';
  for (const section of sections) {
    if (positionMs >= section.startMs && positionMs < section.endMs) return section.label ?? '';
  }
  return '';
}

/** 自动选模板需要的段落/能量上下文；缺字段时按「不知道」处理。 */
export interface TemplateContext {
  energyA?: number;
  energyB?: number;
  labelA?: string;
  labelB?: string;
}

/**
 * 模板自动选择（第 23 轮起把 `doubleDrop` 纳入自动档）：
 *
 * 1. 显式 hint 永远优先（UI 的「炸一下」「人声先行」按钮）；
 * 2. 速度差 >6% 只换鼓+低音（`bassOnly`）——再多轨也听不出对齐；
 * 3. 能量差 >0.35 走 `filterBuild`（A 热 B 冷，先堆气氛）；
 * 4. 两首都在高位（≥0.62）且调性不冲突（Camelot ≤1）→ `doubleDrop`：8 小节里鼓/低音/旋律/人声同时换手，
 *    这是唯一会产生 8 小节「双歌齐响」的模板，只在两首都够热时才有意义；
 * 5. A 已进尾奏（outro）或 B 还在 intro → `standard`（32 小节，留足铺垫）；
 * 6. 其余保守走 `bassOnly`。
 */
function templateFor(
  compat: Compat,
  planHint: Template | undefined,
  context: TemplateContext = {},
): Template {
  if (planHint) return planHint;
  if (compat.tempoDeviation > 0.06) return 'bassOnly';
  if (compat.energyGap > 0.35) return 'filterBuild';

  const hotA = typeof context.energyA === 'number' && context.energyA >= 0.62;
  const hotB = typeof context.energyB === 'number' && context.energyB >= 0.62;
  if (hotA && hotB && compat.keyDistance <= 1 && compat.allowed.includes('vocals')) return 'doubleDrop';

  if (context.labelA === 'outro' || context.labelB === 'intro') return 'standard';

  if (compat.keyDistance <= 1 && compat.allowed.includes('vocals')) return 'standard';
  return 'bassOnly';
}

const TEMPLATE_BARS: Record<Template, number> = {
  standard: 32,
  vocalFirst: 16,
  doubleDrop: 8,
  bassOnly: 8,
  filterBuild: 16,
};

/**
 * 曲线选择阈值：ρ ≥ 0.35 视为「同源低频」，用 `linear`；低于则用 `equalPower`。
 * 0.35 来自实测：真曲（BKS vs Girls Under Glass）低频 ρ ≈ 0.02–0.12，同曲错位/同 loop 时 ρ > 0.8。
 */
export const CORRELATION_THRESHOLD = 0.35;

/**
 * 按实测相关度选交叉曲线。`rho` 缺失/非有限值返回 `fallback`（模板默认，保持旧行为）。
 */
export function chooseCurve(rho: number | undefined, fallback: Curve): Curve {
  if (typeof rho !== 'number' || !Number.isFinite(rho)) return fallback;
  return Math.abs(rho) >= CORRELATION_THRESHOLD ? 'linear' : 'equalPower';
}

function actionsFor(template: Template, allowed: Stem[], correlation?: Partial<Record<Stem, number>>): SwapAction[] {
  const has = (s: Stem) => allowed.includes(s);
  const list: SwapAction[] = [];
  const push = (stem: Stem, startBar: number, lengthBeats: number, curve: Curve) => {
    if (has(stem)) list.push({ stem, startBar, lengthBeats, curve: chooseCurve(correlation?.[stem], curve) });
  };
  switch (template) {
    case 'standard':
      push('bass', 0, 0.5, 'linear');
      push('drums', 2, 2, 'linear');
      push('other', 4, 2, 'equalPower');
      push('vocals', 8, 1, 'equalPower');
      break;
    case 'vocalFirst':
      push('vocals', 0, 1, 'equalPower');
      push('bass', 2, 0.5, 'linear');
      push('drums', 4, 2, 'linear');
      push('other', 6, 2, 'equalPower');
      break;
    case 'doubleDrop':
      push('bass', 0, 0.5, 'linear');
      push('drums', 0, 2, 'linear');
      push('other', 2, 2, 'equalPower');
      push('vocals', 4, 1, 'equalPower');
      break;
    case 'filterBuild':
      push('bass', 0, 0.5, 'linear');
      push('drums', 2, 2, 'linear');
      push('other', 4, 4, 'equalPower');
      push('vocals', 12, 1, 'equalPower');
      break;
    case 'bassOnly':
    default:
      push('bass', 0, 0.5, 'linear');
      push('drums', 2, 2, 'linear');
      break;
  }
  return list.sort((x, y) => x.startBar - y.startBar);
}

/**
 * 主入口：输入两首分析结果 + A 的播放位置，输出完整过渡方案。
 * 只做决策，任何字段缺失都走安全默认值，不抛异常。
 */
/**
 * 拖动换手点：把用户给的毫秒吸附到最近的小节线。
 * 优先用实测 `downbeats`（真下拍），没有就按 `positionMsA` 起算的等距小节。
 */
function snapToBar(a: BeatAnalysis, base: number, overrideMs: number | undefined, barMs: number): number {
  if (overrideMs === undefined || !Number.isFinite(overrideMs)) return base;
  const target = Math.max(0, overrideMs);
  const bars = Array.isArray(a.downbeats) ? a.downbeats.filter((d) => Number.isFinite(d)) : [];
  if (bars.length > 0) {
    let nearest = bars[0];
    for (const bar of bars) {
      if (Math.abs(bar - target) < Math.abs(nearest - target)) nearest = bar;
    }
    return nearest;
  }
  if (!(barMs > 0)) return target;
  return Math.round(target / barMs) * barMs;
}

export function planTransition(input: PlanInput, planHint?: Template): TransitionPlan {
  const { analysisA: a, analysisB: b } = input;
  const warnings: string[] = [];
  const compat = scoreCompat(a, b);

  const bpmA = a.bpm > 0 ? a.bpm : 120;
  const beatMs = 60000 / bpmA;
  const meter = a.meter >= 1 && a.meter <= 12 ? a.meter : 4;
  const barMs = beatMs * meter;

  const minConfidence = input.minConfidence ?? 0.55;
  const confA = typeof a.bpmConfidence === 'number' ? a.bpmConfidence : 1;
  const confB = typeof b.bpmConfidence === 'number' ? b.bpmConfidence : 1;

  let template = templateFor(compat, planHint, {
    energyA: typeof a.energy === 'number' ? a.energy : undefined,
    energyB: typeof b.energy === 'number' ? b.energy : undefined,
    labelA: sectionLabelAt(a, input.positionMsA),
    labelB: sectionLabelAt(b, 0),
  });
  let fallback: TransitionPlan['fallback'] = 'none';

  if (a.downbeats.filter((d) => d >= input.positionMsA).length < 2) {
    warnings.push('A 剩余不足 2 小节，退化到固定 16 拍');
    fallback = 'fixedEqualPower';
    template = 'bassOnly';
  } else if (Math.min(confA, confB) < minConfidence) {
    warnings.push(`置信度偏低（A ${confA.toFixed(2)} / B ${confB.toFixed(2)}），只换低频与鼓`);
    fallback = 'bassDrumsOnly';
    template = 'bassOnly';
  } else if (compat.tempoDeviation > 0.06) {
    warnings.push('速度差过大，不做 sync，只做节奏型交接');
    fallback = 'bassDrumsOnly';
  }

  const startMsA = fallback === 'fixedEqualPower'
    ? input.positionMsA
    : snapToBar(a, nextPhraseAnchor(a, input.positionMsA, barMs), input.handoffOverrideMs, barMs);
  const startMsB = fallback === 'fixedEqualPower'
    ? Math.max(0, alignEntry(b, b.cueInMs ?? 0, barMs))
    : alignEntry(b, b.cueInMs ?? 0, barMs);

  const allowed = fallback === 'bassDrumsOnly'
    ? (['bass', 'drums'] as Stem[]).filter((s) => compat.allowed.includes(s))
    : compat.allowed;

  const templateBars = fallback === 'fixedEqualPower'
    ? Math.max(4, Math.round(16000 / barMs))
    : TEMPLATE_BARS[template];
  // 面板覆盖：0 表示「用模板默认」，否则按用户给的小节数，且不小于最后一个动作的落点。
  const tunedBars = input.tuning?.bars && input.tuning.bars > 0 ? Math.round(input.tuning.bars) : 0;
  const totalBars = tunedBars > 0 ? Math.max(2, tunedBars) : templateBars;

  let actions = actionsFor(template, allowed, input.correlation);
  // 手动换手时刻：只改 startBar，长度与曲线保持模板的定义（用户调的是「什么时候换」）。
  const tunedStart = input.tuning?.startBars;
  if (tunedStart) {
    actions = actions.map((a) => ({ ...a, startBar: tunedStart[a.stem] ?? a.startBar }));
  }
  // `vocalFirst` 的手法本来就是「A 的人声先甩一个回声尾巴，再让 B 的人声进」。
  // 甩尾挂在人声换手窗口的起点；没有 vocals 动作时挂在过渡起点，至少甩一次。
  let echo: TransitionPlan['echo'];
  if (template === 'vocalFirst') {
    const vocal = actionWindowsOf(actions, barMs, beatMs).find((w) => w.stem === 'vocals');
    echo = { startMs: vocal ? vocal.startMs : 0, lengthBeats: 1 };
  }
  // filterBuild 的真意：B 一进来是「窄带/闷」的，随换手把小节推到高潮时再放成全开。
  let filter: TransitionPlan['filter'];
  let filterOut: TransitionPlan['filterOut'];
  if (template === 'filterBuild' && actions.length) {
    const lastBar = actions.reduce((m, a) => Math.max(m, a.startBar + a.lengthBeats / 4), 0);
    filter = {
      startMs: 0,
      lengthBeats: Math.max(8, Math.round(lastBar * 4)),
      fromHz: input.tuning?.filterFromHz ?? 320,
      toHz: input.tuning?.filterToHz ?? 18000,
    };
    filterOut = {
      startMs: 0,
      lengthBeats: filter.lengthBeats,
      fromHz: 20000,
      toHz: 700,
    };
  }

  if (!actions.length) {
    warnings.push('没有任何可换轨，退化到 EQ 三段交叉');
    fallback = 'eq3band';
  }

  return {
    template,
    startMsA: Math.round(startMsA),
    startMsB: Math.round(startMsB),
    totalBars,
    beatMs: Number(beatMs.toFixed(3)),
    barMs: Number(barMs.toFixed(3)),
    rate: compat.tempoRatio,
    actions,
    ...(echo ? { echo } : {}),
    ...(filter ? { filter } : {}),
    ...(filterOut ? { filterOut } : {}),
    compat,
    fallback,
    warnings,
  };
}

/** actions → 绝对时间窗（内部小工具，避免主入口依赖导出的 `actionWindows`）。 */
function actionWindowsOf(actions: SwapAction[], barMs: number, beatMs: number) {
  return actions.map((a) => ({
    ...a,
    startMs: a.startBar * barMs,
    endMs: a.startBar * barMs + a.lengthBeats * beatMs,
  }));
}

/** 单条动作在进度 p（0~1）处的两端增益。 */
export function gainAt(action: Pick<SwapAction, 'curve'>, progress: number): { a: number; b: number } {
  const p = clamp(progress, 0, 1);
  switch (action.curve) {
    case 'linear':
      return { a: 1 - p, b: p };
    case 'shelfDip': {
      const dip = 1 - 0.3 * Math.sin(p * Math.PI);
      return { a: (1 - p) * dip, b: p * dip };
    }
    case 'equalPower':
    default:
      return { a: Math.cos((p * Math.PI) / 2), b: Math.sin((p * Math.PI) / 2) };
  }
}

/** 把动作展开成绝对时间窗（ms，相对过渡起点），供 Performer 排自动化。 */
export function actionWindows(plan: TransitionPlan): Array<SwapAction & { startMs: number; endMs: number }> {
  return plan.actions.map((a) => {
    const startMs = a.startBar * plan.barMs;
    return { ...a, startMs, endMs: startMs + (a.lengthBeats * plan.beatMs) };
  });
}

/**
 * 过渡模式：**标准模式保持原样**，进阶模式才走分轨换手。
 *
 * - `standard` —— 现有 `transitionMath.naturalGains()` 的整轨等功率交叉，
 *   行为一个字都不改（`crossfadeDeck.ts:957/972` 继续用它）。
 * - `advanced` —— 本模块的 `TransitionPlan` + 手法库（分轨换手 / EQ / 回声）。
 *
 * 用 `planForMode()` 做唯一入口：标准模式返回 `null`，调用方据此回落，
 * 这样两条链路彻底隔离，进阶版出任何问题都影响不到现有过渡。
 */
export type TransitionMode = 'standard' | 'advanced';

export function planForMode(
  mode: TransitionMode,
  input: PlanInput,
  hint?: Template,
): TransitionPlan | null {
  if (mode !== 'advanced') return null;
  return planTransition(input, hint);
}
