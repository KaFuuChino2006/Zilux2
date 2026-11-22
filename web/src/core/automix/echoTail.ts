/**
 * 短过渡（1–3 s）的「尾段回声接曲」。
 *
 * 短过渡没有空间做两首歌的长时间共存：A 的末句刚唱完，B 就得进来。
 * 这时最好用的手法不是继续压 A，而是**让 A 的最后一句自己回到自己身上**——
 * 一个跟着拍点走的反馈延迟（+ 阻尼），把 A 的尾巴拖进 B 的开头。
 *
 * 回声的音程不需要「移调」：延迟重复的是 A 自己的素材，天然还在 A 的调上。
 * 需要按调性调整的是**它能响多久**：
 * - 两首调性接近（Camelot 距离 ≤1）→ 可以多绕几圈、慢一点衰减；
 * - 调性冲突（距离 ≥4）→ 少绕圈、衰减更快，否则会在 B 的调上留下不协和的余音。
 */

export interface EchoTailInput {
  /** 过渡窗口时长（毫秒）。只有短窗口才启用。 */
  fadeMs: number;
  /** 一拍多少毫秒（用来把延迟对齐到拍）。 */
  beatMs: number;
  /** 两首歌的 Camelot 距离（0–6），未知传 0。 */
  keyGap?: number;
  /** 超过这个窗口就不做回声（默认 4200 ms）。 */
  maxFadeMs?: number;
}

export interface EchoTailPlan {
  enabled: boolean;
  /** 延迟 = divBeats × 一拍。 */
  divBeats: number;
  delayMs: number;
  feedback: number;
  outDb: number;
  dampHz: number;
  /** 窗口结束后尾巴再响多久。 */
  tailMs: number;
  /** 从窗口的百分之几开始送。 */
  sendFromP: number;
  note: string;
}

export const ECHO_MAX_FADE_MS = 4_200;
export const ECHO_SEND_FROM_P = 0.55;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function planEchoTail(input: EchoTailInput): EchoTailPlan {
  const fadeMs = Number.isFinite(input.fadeMs) ? Math.max(0, input.fadeMs) : 0;
  const beatMs = Number.isFinite(input.beatMs) && input.beatMs > 60 ? input.beatMs : 500;
  const gap = Number.isFinite(input.keyGap ?? NaN) ? clamp(input.keyGap as number, 0, 6) : 0;
  const maxFadeMs = Number.isFinite(input.maxFadeMs ?? NaN) ? (input.maxFadeMs as number) : ECHO_MAX_FADE_MS;
  const enabled = fadeMs > 0 && fadeMs <= maxFadeMs;
  // 调性越远，绕的圈数越少、尾巴越短。
  const divBeats = gap <= 1 ? 1 : gap <= 3 ? 0.75 : 0.5;
  const feedback = gap <= 1 ? 0.44 : gap <= 3 ? 0.36 : 0.28;
  const outDb = gap <= 1 ? -2 : gap <= 3 ? -3 : -4;
  const dampHz = gap <= 1 ? 4600 : gap <= 3 ? 4200 : 3600;
  const tailCap = gap <= 1 ? 1500 : gap <= 3 ? 1100 : 800;
  const tailMs = Math.round(clamp(Math.min(tailCap, fadeMs * 0.8), 400, tailCap));
  const delayMs = Math.round(beatMs * divBeats);
  return {
    enabled,
    divBeats,
    delayMs,
    feedback,
    outDb,
    dampHz,
    tailMs,
    sendFromP: ECHO_SEND_FROM_P,
    note: enabled
      ? `短过渡 ${(fadeMs / 1000).toFixed(1)}s：A 的尾巴按 1/${Math.round(1 / divBeats)} 拍回响 ${(tailMs / 1000).toFixed(1)}s（调性距离 ${gap}，反馈 ${feedback.toFixed(2)}）`
      : `窗口 ${(fadeMs / 1000).toFixed(1)}s，不需要尾段回声`,
  };
}

/** 回声送出的包络（0…1），给测试与浮层预览用。 */
export function echoSendAt(plan: EchoTailPlan, progress: number): number {
  if (!plan.enabled) return 0;
  const p = clamp(progress, 0, 1);
  if (p <= plan.sendFromP) return 0;
  return clamp((p - plan.sendFromP) / (1 - plan.sendFromP), 0, 1);
}
