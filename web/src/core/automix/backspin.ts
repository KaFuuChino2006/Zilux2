/**
 * 回旋刹车（backspin / brake）：把 A 最后一小节倒着放，用「音乐性的倒带」收掉 A，
 * 让 B 在倒带的尾巴上原速进场。DJ 用它救「BPM 差太远、怎么拉都听得出来」的场面。
 *
 * 只算参数，不碰音频：倒放本身在 `audio/automixV2Bridge.ts` 里用 buffer 做
 * （元素上没法倒放，`playbackRate` 不能为负）。
 */

/** 倒带太短听不出是「倒带」，只是「噗」一下。 */
export const BACKSPIN_MIN_MS = 1_000;
/** 再长就变成 effect 表演了；DJ 一般一小节（≈2 s）。 */
export const BACKSPIN_MAX_MS = 2_400;
/** 首尾各 5 ms 淡入淡出，避免倒放接缝的爆音。 */
export const BACKSPIN_DECLICK_MS = 5;

export interface BackspinPlan {
  enabled: boolean;
  /** 倒带时长（毫秒）：一小节，夹在 1.0–2.4 s，且不超过整个过渡窗口。 */
  tailMs: number;
  /** 播放速率：保持 1.0，倒带的「音高上扬」由素材本身的倒放产生。 */
  rate: number;
  declickMs: number;
  note: string;
}

export interface BackspinInput {
  fadeMs: number;
  barMs: number;
  /** 调性距离只影响文案：差得远时倒带更像「救场」，差得近则更像装饰。 */
  keyGap?: number;
  aInstrumental?: boolean;
}

export function planBackspin(input: BackspinInput): BackspinPlan {
  const fadeMs = Number.isFinite(input.fadeMs) ? Math.max(0, input.fadeMs) : 0;
  const barMs = Number.isFinite(input.barMs) && input.barMs > 200 ? input.barMs : 2_000;
  const off: BackspinPlan = {
    enabled: false, tailMs: 0, rate: 1, declickMs: BACKSPIN_DECLICK_MS, note: '回旋刹车：窗口太短，不启用',
  };
  if (fadeMs < BACKSPIN_MIN_MS) return off;

  const tailMs = Math.max(
    BACKSPIN_MIN_MS,
    Math.min(BACKSPIN_MAX_MS, Math.round(barMs), Math.round(fadeMs)),
  );
  const keyGap = Number.isFinite(input.keyGap) ? Math.max(0, input.keyGap as number) : 0;
  const why = keyGap >= 4
    ? `调性差 ${keyGap}，用倒带当「休止」比硬拉拍体面`
    : input.aInstrumental
      ? 'A 是器乐尾段，倒带不切人声'
      : '一小节倒带收尾';
  return {
    enabled: true,
    tailMs,
    rate: 1,
    declickMs: BACKSPIN_DECLICK_MS,
    note: `回旋刹车：倒放 A 最后 ${(tailMs / 1000).toFixed(2)}s（${why}）`,
  };
}
