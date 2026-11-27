/**
 * 文闪里「先匀速跑一段、再缓速刹停」的相位累加器。
 *
 * 返回从起点算起走过的圈数（可能是小数），调用方自己取小数部分决定位置。
 * - runSeconds <= 0：一直匀速跑，不刹停；
 * - 前 runSeconds 秒按 1 / cycleSeconds 圈每秒前进；
 * - 之后用二次缓出把速度降到 0，额外多走的圈数等于刹停时长内三角形速度面积的三分之一；
 * - 刹停结束后圈数冻结，位置停在原地，不再回绕。
 */
export const wenflashEasedCycles = (
  elapsedSeconds: number,
  cycleSeconds: number,
  runSeconds: number,
  brakeSeconds: number,
): number => {
  if (!(cycleSeconds > 0) || !Number.isFinite(elapsedSeconds)) return 0;
  const elapsed = Math.max(0, elapsedSeconds);
  const rate = 1 / cycleSeconds;
  if (!(runSeconds > 0)) return elapsed * rate;
  if (elapsed <= runSeconds) return elapsed * rate;
  const brake = Math.max(0, brakeSeconds);
  if (brake <= 0) return runSeconds * rate;
  const tau = Math.min(1, (elapsed - runSeconds) / brake);
  // ∫0^tau (1 - x)^2 dx = (1 - (1 - tau)^3) / 3
  const extra = brake * (1 - Math.pow(1 - tau, 3)) / 3;
  return (runSeconds + extra) * rate;
};
