/**
 * 循环滚奏（loop roll）：把 A 过渡窗口开头的那一小段循环两遍，再让 B 进来。
 *
 * 和结构桥接（E8）的区别：E8 是「A 尾奏不够长，循环补到够长」；loopRoll 是**故意的**
 * ——即使尾奏够长，也把最后那几小节重复一次，用重复制造的「蓄力」接 B。
 *
 * 元素上做不到无缝循环（`HTMLMediaElement.loop` 在缓冲边界会掉 1–2 个采样，低频可闻），
 * 所以和桥接/倒带一样走 `AudioBuffer` + 第三路 source，平铺与接缝由 `tileLoopChannels` 负责。
 */

export interface LoopRollPlan {
  enabled: boolean;
  /** 一遍的长度（毫秒）：2–4 小节，且不超过窗口的一半（要留位置给 B）。 */
  unitMs: number;
  /** 播几遍：固定 2 遍（再多就成 effect 表演）。 */
  passes: number;
  declickMs: number;
  note: string;
}

export interface LoopRollInput {
  fadeMs: number;
  barMs: number;
  /** A 的 loop 单元小节数（没有可用单元时传 0，回落到 2 小节）。 */
  unitBars?: number;
}

/** 一遍至少 1 s，否则听不出是「循环」而像卡带。 */
export const LOOP_ROLL_MIN_MS = 1_000;
/** 一遍最多 4.8 s（≈4 小节 120 BPM）。 */
export const LOOP_ROLL_MAX_MS = 4_800;
export const LOOP_ROLL_SEAM_MS = 2;

export function planLoopRoll(input: LoopRollInput): LoopRollPlan {
  const fadeMs = Number.isFinite(input.fadeMs) ? Math.max(0, input.fadeMs) : 0;
  const barMs = Number.isFinite(input.barMs) && input.barMs > 200 ? input.barMs : 2_000;
  const off: LoopRollPlan = {
    enabled: false, unitMs: 0, passes: 2, declickMs: LOOP_ROLL_SEAM_MS, note: '循环滚奏：窗口太短，不启用',
  };
  if (fadeMs < LOOP_ROLL_MIN_MS * 2) return off;

  const bars = Math.max(2, Math.min(4, Math.round(input.unitBars ?? 0) || 2));
  const half = Math.floor(fadeMs / 2);
  const unitMs = Math.max(LOOP_ROLL_MIN_MS, Math.min(LOOP_ROLL_MAX_MS, Math.round(barMs * bars), half));
  if (unitMs * 2 > fadeMs + 200) return off;
  return {
    enabled: true,
    unitMs,
    passes: 2,
    declickMs: LOOP_ROLL_SEAM_MS,
    note: `循环滚奏：A 的 ${bars} 小节重复一遍（${(unitMs / 1000).toFixed(2)}s ×2）再进 B`,
  };
}
