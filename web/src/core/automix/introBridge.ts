/**
 * B 侧「前奏桥」：把下一首的前奏循环延长，撑到上一首末句之后的接唱点。
 *
 * 为什么需要：很多歌的前奏只有 4–8 小节（8–16 秒），而一个干净的交接需要一个乐句以上。
 * 老做法是「跳到唱词前 1.5 秒起播」，等于把前奏扔掉 —— 交接瞬间就变成「上一首说完最后
 * 一句，下一首立刻开口」，中间没有任何器乐桥。
 *
 * 新做法：整段前奏照播（鼓/贝斯先入场、没有人声），不够长就把其中最干净的 2–4 小节
 * 循环补齐，并按调性关系移几个半音贴住上一首。执行时元素推迟起播 `delayMs`，
 * 这段由预渲染的 buffer 顶住（元素 `currentTime` 回跳会有 20–40 ms 空洞，不能现切）。
 */

import type { BeatAnalysis } from '../../online/analysis';
import { PITCH_MAX_SEMITONES, semitonesForBridge } from '../../audio/pitchShift';

/** 循环单元最多重复几遍（再长就听出「卡带」了）。 */
export const INTRO_MAX_PASSES = 4;
/** 前奏至少要有这么多小节才值得当桥。 */
export const INTRO_MIN_BARS = 2;

export interface IntroBridgePlan {
  /** 循环单元在 B 文件里的起点（绝对毫秒，整小节对齐）。 */
  loopStartFileMs: number;
  /** 单元长度（毫秒，整小节）。 */
  loopMs: number;
  unitBars: number;
  /** 单元总播放次数（含元素自己播的那一次）。 */
  passes: number;
  /** 元素推迟起播 = loopMs × (passes − 1)；这段时间由 buffer 顶住。 */
  delayMs: number;
  /** 预渲染 buffer 需要覆盖的墙钟时长 = delayMs。 */
  bufferMs: number;
  /** B 的第一句唱词（目标接唱点，文件毫秒）。 */
  firstVocalMs: number;
  /** 移调量（半音，0 = 不移）。 */
  semitones: number;
  /** 给人看的一句话说明。 */
  note: string;
}

export interface IntroBridgeInput {
  /** B 的曲首（文件毫秒）。 */
  introStartMs: number;
  /** B 的第一句唱词（文件毫秒）；<= 0 表示没有可用的人声锚点。 */
  firstVocalMs: number;
  barMs: number;
  /** 希望前奏覆盖的墙钟时长（≈ A 的末句之后到接唱点）。 */
  targetMs: number;
  /** 宿主给的循环素材（可能为空）。 */
  loopUnits?: { startMs: number; endMs: number; bars: number; score: number }[];
  /** A 的调性主音、B 的调性主音（0=C … 11=B，-1 未知）。 */
  keyFrom?: number;
  keyTo?: number;
  /** 已知的 B 变速率（元素会被设成这个 rate）。 */
  playbackRate?: number;
  maxPasses?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 规划前奏桥；返回 null 表示「不值得做」（前奏太短/没有唱词锚点/已经够长）。
 *
 * `targetMs` 只决定要循环几遍，不会把前奏砍短：**够长就用原样**，这是「保持听感」的前提。
 */
export function planIntroBridge(input: IntroBridgeInput): IntroBridgePlan | null {
  const barMs = Number.isFinite(input.barMs) && input.barMs > 0 ? input.barMs : 2000;
  const introStart = Math.max(0, Number(input.introStartMs) || 0);
  const firstVocal = Number(input.firstVocalMs) || 0;
  if (!(firstVocal > introStart + barMs * INTRO_MIN_BARS)) return null;

  const introMs = firstVocal - introStart;
  // 前奏已经够长：直接原样播，不循环（循环反而破坏「一次听完的旋律」）。
  const target = Math.max(0, Number(input.targetMs) || 0);
  if (introMs >= target) return null;

  // 选循环单元：优先宿主给的 loopUnits（结构重复、能量稳定），且必须整段落在前奏里、
  // 且至少留 1 小节给「进唱前的过门」。退化到「前奏开头 4/2 小节」。
  const maxUnitBars = Math.max(INTRO_MIN_BARS, Math.min(4, Math.floor(introMs / barMs) - 1));
  let unitBars = maxUnitBars;
  let loopStart = introStart;
  const units = (input.loopUnits ?? [])
    .filter((unit) => {
      const start = Number(unit.startMs);
      const end = Number(unit.endMs);
      const bars = Number(unit.bars);
      return (
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        Number.isFinite(bars) &&
        bars >= INTRO_MIN_BARS &&
        bars <= maxUnitBars &&
        start >= introStart - 40 &&
        end <= firstVocal - barMs * 0.5
      );
    })
    .sort((a, b) => b.score - a.score || b.bars - a.bars);
  if (units.length > 0) {
    const best = units[0];
    unitBars = Math.max(INTRO_MIN_BARS, Math.round(best.bars));
    loopStart = Math.round(best.startMs);
  }

  const loopMs = Math.round(unitBars * barMs);
  const need = target - introMs;
  if (need <= 0) return null;
  const maxPasses = Math.max(2, Math.min(INTRO_MAX_PASSES, input.maxPasses ?? INTRO_MAX_PASSES));
  const passes = clamp(1 + Math.ceil(need / loopMs), 2, maxPasses);
  const delayMs = loopMs * (passes - 1);
  if (delayMs <= 0) return null;

  const rate = Number.isFinite(input.playbackRate) && (input.playbackRate as number) > 0
    ? (input.playbackRate as number)
    : 1;
  // 元素以 rate 播放时前奏本身的音高已经被抬/压了 12·log2(rate) 个半音；
  // buffer 也按同一 rate 播放，所以移调量要把这部分补回来，才能落在「相对 A 的调」上。
  const base = semitonesForBridge(input.keyFrom ?? -1, input.keyTo ?? -1);
  const compensated = clamp(
    base - 12 * Math.log2(rate),
    -PITCH_MAX_SEMITONES,
    PITCH_MAX_SEMITONES,
  );
  const semitones = Math.round(compensated * 10) / 10;

  const keyNote = semitones === 0 ? '不移调' : `移 ${semitones > 0 ? '+' : ''}${semitones} 半音`;
  return {
    loopStartFileMs: loopStart,
    loopMs,
    unitBars,
    passes,
    delayMs,
    // buffer 要按元素同速播放，所以需要「材料时长」= 墙钟 × rate。
    bufferMs: Math.round(delayMs * rate),
    firstVocalMs: firstVocal,
    semitones,
    note: `前奏桥：${unitBars} 小节 × ${passes} 遍（元素推迟 ${(delayMs / 1000).toFixed(1)}s 起播，${keyNote}）`,
  };
}

/**
 * 唱词均衡时间：A 的句间间隔中位数。
 *
 * 用途有两个：① 决定 B 的第一句应该在 A 末句之后留多久（至少一个换气单位，避免
 * 「上一句刚完、下一句立刻顶上来」）；② 作为目标值喂给 `planIntroBridge().targetMs`。
 *
 * 只有一个句段时返回 `fallbackMs`（默认一个乐句的一半），没有句段时返回 0。
 */
export function vocalGapMs(
  segments: { startMs: number; endMs: number }[],
  fallbackMs = 2000,
): number {
  if (!Array.isArray(segments) || segments.length < 2) {
    return segments && segments.length === 1 ? Math.max(400, fallbackMs) : 0;
  }
  const gaps: number[] = [];
  for (let i = 1; i < segments.length; i += 1) {
    const gap = segments[i].startMs - segments[i - 1].endMs;
    if (Number.isFinite(gap) && gap >= 120) gaps.push(gap);
  }
  if (gaps.length === 0) return Math.max(400, fallbackMs);
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  // 换气单位不该超过一个乐句（8 拍）——超过就说明中间有间奏，那不是「换气」。
  return Math.round(Math.min(median, fallbackMs));
}

/** 从分析里挑出「第一句唱词」的绝对位置（没有 vocal 曲线/器乐返回 0）。 */
export function firstVocalMsOf(analysis: BeatAnalysis | undefined): number {
  const curve = analysis?.activity?.vocal;
  const hop = analysis?.activity?.hopMs ?? 250;
  if (!Array.isArray(curve) || curve.length === 0 || !(hop > 0)) return 0;
  // activity 曲线是文件时间（index 0 = 第 0 秒），不加 cueInMs（那是「建议从哪开始播」）。
  for (let i = 0; i < curve.length; i += 1) {
    if (curve[i] > 0.45) return Math.round(i * hop);
  }
  return 0;
}
