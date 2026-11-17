/**
 * 两段音频的归一化互相关（Pearson）。
 *
 * 用途：过渡排程要决定某条分轨用 `linear`（幅度守恒，`a+b=1`）还是 `equalPower`（功率守恒）。
 * - 两轨该分轨**相关**（同一首歌、同一低频持续音、同相位 loop）时，线性交叉才是对的；
 * - **不相关**（两首不同的歌）时，等功率交叉才是对的；硬用 linear 会在中点掉 −3 dB。
 *
 * 实现要点：先去均值再算，长度取两者较短者；任何非有限输入或过短输入一律返回 0（= 当作不相关，
 * 走更安全的 equalPower），绝不返回 NaN 污染下游。
 */
export function normalizedCorrelation(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length ?? 0, b.length ?? 0);
  if (!(n >= 64)) return 0;

  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i += 1) {
    sa += a[i] as number;
    sb += b[i] as number;
  }
  const ma = sa / n;
  const mb = sb / n;

  let num = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = (a[i] as number) - ma;
    const y = (b[i] as number) - mb;
    num += x * y;
    va += x * x;
    vb += y * y;
  }
  const den = Math.sqrt(va * vb);
  if (!(den > 0) || !Number.isFinite(den)) return 0;
  const rho = num / den;
  return Number.isFinite(rho) ? Math.max(-1, Math.min(1, rho)) : 0;
}

/**
 * 低频版：先做一阶低通（单极点，`alpha` 由采样率与截止频率算出），再算互相关。
 * 过渡里真正会「撞」的是 30–120 Hz 的低频，全带互相关容易被 hi-hat / 人声带偏。
 */
export function lowBandCorrelation(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  sampleRate: number,
  cutoffHz = 120,
): number {
  if (!(sampleRate > 0) || !(cutoffHz > 0)) return normalizedCorrelation(a, b);
  const dt = 1 / sampleRate;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const alpha = dt / (rc + dt);

  const n = Math.min(a.length ?? 0, b.length ?? 0);
  if (!(n >= 64)) return 0;
  const la = new Float64Array(n);
  const lb = new Float64Array(n);
  let ya = 0;
  let yb = 0;
  for (let i = 0; i < n; i += 1) {
    ya += alpha * ((a[i] as number) - ya);
    yb += alpha * ((b[i] as number) - yb);
    la[i] = ya;
    lb[i] = yb;
  }
  return normalizedCorrelation(la, lb);
}
