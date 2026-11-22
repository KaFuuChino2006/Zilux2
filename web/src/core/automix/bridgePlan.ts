/**
 * 结构桥接（E8）：A 的尾奏不够长时，把最后一小段循环补齐，让过渡能撑满一个乐句。
 *
 * 为什么不直接让 A 提前结束：A 的淡化终点被钉在「可听结尾」，尾奏只剩 6 小节而目标是 8 小节时，
 * 整段过渡就被压成 6 小节 —— 乐句断了，听感是「匆匆收尾」。DJ 的做法是把尾奏 loop 一次再走。
 *
 * 本模块只做决策与纯数学，不碰 Web Audio：
 * - `pickBridgeUnit`：在 A 的可听结尾处找一个能安全循环的尾段（贴强拍、不跨段落）。
 * - `buildBridgePlan`：算出补几次、从哪一点切换、A 的有效结尾延到哪。
 * - `tileLoopChannels`：把一段 PCM 平铺成 N 遍（接缝做极短缺口，避免爆音）。
 *
 * 执行层在 `web/src/audio/automixV2Bridge.ts`：因为 `HTMLMediaElement.currentTime` 回跳有
 * 20–40 ms 空洞，回跳不可用，必须把这段 PCM 预渲染成 AudioBuffer，用第三路 source 播。
 */

/** 最多补到这么多遍（1 遍 = 不延长，所以 passes ≥ 2 才是真延长）。 */
export const BRIDGE_MAX_PASSES = 3;

/** 接缝处理宽度（ms）：2 ms 的等功率缺口，落在小节线上通常被鼓点瞬态掩住。 */
export const BRIDGE_SEAM_MS = 2;

/** 候选尾段长度（小节），从长到短试：4 小节最像「一句」，2 小节兜底。 */
export const BRIDGE_UNIT_BARS = [4, 2] as const;

/** 尾段必须落在同一个段落里（跨段落循环会听到和声跳变）。 */
export const BRIDGE_MIN_SECTION_CONFIDENCE = 0.3;

export interface BridgeSection {
  startMs: number;
  endMs: number;
  label: string;
  confidence?: number;
}

export interface BridgeUnit {
  /** 尾段起点（文件毫秒） */
  startMs: number;
  /** 尾段终点（文件毫秒）= A 的可听结尾 */
  endMs: number;
  bars: number;
}

export interface PickBridgeUnitInput {
  audibleEndMs: number;
  barMs: number;
  /** 尾段起点不得早于这一毫秒（= 淡化起点附近，早于此就来不及切换） */
  minStartMs?: number;
  downbeats?: readonly number[];
  sections?: readonly BridgeSection[];
  unitBars?: readonly number[];
}

export interface BuildBridgePlanInput {
  /** A 的淡化起点（文件毫秒） */
  fadeStartFileMs: number;
  /** 想要的过渡时长（毫秒）：`小节数 × 小节时长` */
  desiredMs: number;
  audibleEndMs: number;
  barMs: number;
  unit: BridgeUnit;
  maxPasses?: number;
}

export interface BridgePlan {
  /** 从这一毫秒开始，A 的声音改由预渲染 buffer 提供 */
  unitStartFileMs: number;
  /** 一遍的长度（毫秒） */
  unitMs: number;
  unitBars: number;
  /** buffer 要播几遍（≥ 2） */
  passes: number;
  /** A 的有效结尾 = 原可听结尾 + extensionMs */
  extendedEndMs: number;
  /** 比原来多出来的时长 */
  extensionMs: number;
  note: string;
}

function finite(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * 在可听结尾处挑一个可循环尾段。
 *
 * 判据（全部来自已有分析字段，不需要分轨）：
 * 1. 起点必须贴着强拍（±0.25 小节内），否则循环点会切在反拍上；
 * 2. 尾段必须落在**同一个段落**里，且该段落置信度 ≥ 0.3（跨段落 = 和声会突变）；
 * 3. 长度按 4 → 2 小节试，取第一个通过的。
 */
export function pickBridgeUnit(input: PickBridgeUnitInput): BridgeUnit | null {
  const end = finite(input.audibleEndMs);
  const barMs = finite(input.barMs);
  if (!(end > 0) || !(barMs > 0)) return null;
  const downbeats = (input.downbeats ?? []).filter((value) => Number.isFinite(value));
  const sections = input.sections ?? [];
  const candidates = input.unitBars ?? BRIDGE_UNIT_BARS;
  for (const bars of candidates) {
    if (!(bars > 0)) continue;
    const unitMs = bars * barMs;
    const start = end - unitMs;
    if (!(start > 0)) continue;
    if (typeof input.minStartMs === 'number' && start < input.minStartMs) continue;
    // 起点贴强拍：找最近的强拍，偏差不得超过 1/4 小节。
    if (downbeats.length > 0) {
      // 不能早退 break：宿主/缓存里的强拍不保证升序（已在 analysis 层规范化，
      // 但工具与测试会直接喂数组），早退会漏掉更近的那一下。
      let best: number | null = null;
      for (const value of downbeats) {
        if (!Number.isFinite(value)) continue;
        if (best === null || Math.abs(value - start) < Math.abs(best - start)) best = value;
      }
      if (best !== null && Math.abs(best - start) > barMs * 0.25) continue;
    }
    // 不跨段落。
    if (sections.length > 0) {
      const mid = start + unitMs * 0.5;
      const host = sections.find((item) => mid >= item.startMs && mid < item.endMs);
      if (host) {
        const crosses = sections.some(
          (item) => item !== host && item.startMs < end - 1 && item.endMs > start + 1,
        );
        const confident = finite(host.confidence) >= BRIDGE_MIN_SECTION_CONFIDENCE;
        if (crosses || !confident) continue;
      }
    }
    return { startMs: Math.round(start), endMs: Math.round(end), bars };
  }
  return null;
}

/**
 * 算出桥接方案。
 *
 * `passes` 是 **buffer 播放遍数**：A 播到 `unit.startMs` 时切成 buffer，buffer 播 `passes` 遍，
 * 所以 A 的有效结尾 = `unit.startMs + passes × unitMs` = 原结尾 + (passes−1) × unitMs。
 *
 * 拒绝条件（宁可不补，也不能补出一段接不上的东西）：
 * - 自然尾奏已经够长（不需要补）；
 * - 循环点落在淡化起点之前 —— 那时 A 已经在淡出了，来不及切换；
 * - 补满最大遍数仍填不满缺口。
 */
export function buildBridgePlan(input: BuildBridgePlanInput): BridgePlan | null {
  const audibleEnd = finite(input.audibleEndMs);
  const fadeStart = finite(input.fadeStartFileMs);
  const desired = finite(input.desiredMs);
  const barMs = finite(input.barMs);
  const unitMs = input.unit ? Math.round(input.unit.endMs - input.unit.startMs) : 0;
  if (!(audibleEnd > 0) || !(desired > 0) || !(unitMs > 0) || !(barMs > 0)) return null;
  const naturalRoom = audibleEnd - fadeStart;
  if (!(naturalRoom > 0)) return null;
  const shortfall = desired - naturalRoom;
  // 已经够长（留 1 拍余量，避免为了 20 ms 去补一整遍）。
  if (shortfall <= barMs * 0.25) return null;
  const loopPoint = Math.round(input.unit.startMs);
  // 循环点必须在淡化起点之后至少半小节，否则切换动作会落在淡化区里。
  if (loopPoint < fadeStart + barMs * 0.5) return null;
  const maxPasses = Math.max(2, Math.min(BRIDGE_MAX_PASSES, input.maxPasses ?? BRIDGE_MAX_PASSES));
  // 只需要满足一个下界：补出来的时长盖住缺口。
  // 旧版还要求 unitMs*passes >= desired，那是拿「整个 buffer 长度」跟「整段过渡目标」比，
  // 缺口 4 s 时会硬补到 16 s（过渡比目标长 67%），缺口 12 s 时反而判死。
  // 循环点是否早于淡化起点已由上面的 loopPoint 守卫单独保证。
  let passes = 2;
  while (passes < maxPasses && unitMs * (passes - 1) < shortfall) {
    passes += 1;
  }
  const extensionMs = unitMs * (passes - 1);
  if (extensionMs < shortfall * 0.9) return null;
  return {
    unitStartFileMs: loopPoint,
    unitMs,
    unitBars: input.unit.bars,
    passes,
    extendedEndMs: Math.round(audibleEnd + extensionMs),
    extensionMs,
    note: `A 尾奏补 ${passes - 1} 遍 ${input.unit.bars} 小节（+${(extensionMs / 1000).toFixed(1)}s，循环点 ${(loopPoint / 1000).toFixed(1)}s）`,
  };
}

/**
 * 把一段 PCM 平铺成 `passes` 遍（纯函数，便于单测）。
 *
 * 每遍长度严格等于 `unitSamples`（不缩短、不重叠），接缝处做 2 ms 等功率缺口：
 * 循环点通常落在小节线上（有鼓点瞬态），这个量级的缺口听不出来，但能避免波形硬接的爆音。
 */
export function tileLoopChannels(
  channels: readonly Float32Array[],
  unitSamples: number,
  passes: number,
  seamSamples: number,
): Float32Array[] {
  const unit = Math.max(1, Math.floor(unitSamples));
  const count = Math.max(1, Math.floor(passes));
  const seam = Math.max(0, Math.min(Math.floor(seamSamples), Math.floor(unit / 4)));
  const total = unit * count;
  const out: Float32Array[] = [];
  for (const source of channels) {
    const dst = new Float32Array(total);
    for (let pass = 0; pass < count; pass += 1) {
      const offset = pass * unit;
      const limit = Math.min(unit, source.length);
      for (let i = 0; i < limit; i += 1) dst[offset + i] = source[i]!;
    }
    if (seam > 0) {
      for (let pass = 1; pass < count; pass += 1) {
        const boundary = pass * unit;
        for (let i = 0; i < seam; i += 1) {
          const left = boundary - seam + i;
          const right = boundary + i;
          // 越靠接缝缺口越深：两端 0，中间最浅 —— 用 1 − sin 形状，避免线性尖角引入高频。
          const depth = Math.sin((Math.PI * (i + 0.5)) / seam);
          const scale = 1 - 0.5 * depth;
          if (left >= 0 && left < total) dst[left] = dst[left]! * scale;
          if (right >= 0 && right < total) dst[right] = dst[right]! * scale;
        }
      }
    }
    out.push(dst);
  }
  return out;
}
