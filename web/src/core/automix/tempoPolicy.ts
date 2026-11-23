/**
 * 变速对齐策略（进阶 v2）——按「变调被听出来」的临界点定上限，而不是按 BPM 差本身。
 *
 * 判据依据（人耳对 playbackRate 变调的敏感度，未做变调补偿时）：
 * - ±1%：几乎不可闻，只有长音/钢琴独奏能听出拍频；
 * - ±2%：受过训练的人能听出「偏高/偏低」，普通听众多半只觉得「哪里不对」；
 * - ±3%：持续音、人声长音可明确听出音高变化；
 * - ±5–6%：明显走音，整首歌像换了个调；
 * - ±8% 以上：卡通化。
 *
 * 所以这里把「单侧」拉伸夹在 A ±3%、B ±4.5%：
 * - A 是当前正在放的主曲，听众有完整的音高记忆，容差更小；
 * - B 是刚进来的新歌，且前几秒被换手掩蔽，容差略大；
 * - 两侧合计最多覆盖 ~7% 的 BPM 差；再大就不拉音高，交给拍点相位/错拍处理。
 *
 * 规则：
 * - 近似整倍/整半（80 vs 160，误差 <3.5%）：按半/倍拍对齐，不变速；
 * - 差 ≤4.5%：B 贴到 A（只拉 B）；
 * - 4.5–7%：两边各走一半（A ≤3%、B ≤4.5%）；
 * - >7%：不拉音高（free），由节拍相位与过渡窗口吸收；
 *   ——大于 7% 还强行对齐，音高一定被听出来，宁可不齐也不走音。
 */
export type TempoPolicyMode = 'same' | 'b-to-a' | 'meet' | 'octave' | 'free';

export interface TempoPolicy {
  mode: TempoPolicyMode;
  /** A 在过渡期间的播放速率（1 = 原速） */
  aRate: number;
  /** B 在过渡期间的播放速率（1 = 原速） */
  bRate: number;
  /** 给 HUD / 日志的一句话 */
  label: string;
}

/** 单侧听感上限：超过这个比例，音高变化会被明确听出来。 */
export const TEMPO_POLICY_LIMITS = {
  /** A 侧最大拉伸（正在播放、有音高记忆） */
  aMax: 0.03,
  /** B 侧最大拉伸（刚进来、被换手掩蔽） */
  bMax: 0.045,
  /** 只拉 B 的最大 BPM 差 */
  bToAMax: 0.045,
  /** 两侧各走一半的最大 BPM 差（≈ aMax + bMax） */
  meetMax: 0.07,
  /** 整倍/整半判定的对数容差（≈3.5%） */
  octaveTolerance: 0.035,
} as const;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

export function planTempoPolicy(bpmA: number, bpmB: number): TempoPolicy {
  if (!(bpmA > 0) || !(bpmB > 0)) {
    return { mode: 'free', aRate: 1, bRate: 1, label: 'BPM 未知，不变速' };
  }
  const raw = bpmB / bpmA;
  const lg = Math.log2(raw);
  const oct = Math.round(lg);

  // 近似整倍/整半：80 vs 160、70 vs 140 …… 按“错拍”对齐，不拉音高。
  if (oct !== 0 && Math.abs(lg - oct) < TEMPO_POLICY_LIMITS.octaveTolerance) {
    return {
      mode: 'octave',
      aRate: 1,
      bRate: 1,
      label: `约 ${oct > 0 ? 2 ** oct : `1/${2 ** -oct}`}× 关系：按半/倍拍对齐，不变速`,
    };
  }

  // 折到 1 附近看差距（处理 2/3、3/4 这类非整倍关系）。
  const folded = raw / 2 ** oct;
  const gap = Math.abs(folded - 1);

  if (gap < 0.004) {
    return { mode: 'same', aRate: 1, bRate: 1, label: '同速，不变速' };
  }
  if (gap <= TEMPO_POLICY_LIMITS.bToAMax) {
    const bRate = round3(clamp(folded, 1 - TEMPO_POLICY_LIMITS.bMax, 1 + TEMPO_POLICY_LIMITS.bMax));
    return {
      mode: 'b-to-a',
      aRate: 1,
      bRate,
      label: `差 ${(gap * 100).toFixed(1)}%：B 贴到 A（B ×${bRate.toFixed(3)}，音高偏移 ${((bRate - 1) * 100).toFixed(1)}%）`,
    };
  }
  if (gap <= TEMPO_POLICY_LIMITS.meetMax) {
    // 双方都只承担一半，再各自夹进听感上限；差额留给拍点相位。
    const meet = Math.sqrt(folded);
    const aRate = round3(clamp(meet, 1 - TEMPO_POLICY_LIMITS.aMax, 1 + TEMPO_POLICY_LIMITS.aMax));
    const bRate = round3(clamp(folded / aRate, 1 - TEMPO_POLICY_LIMITS.bMax, 1 + TEMPO_POLICY_LIMITS.bMax));
    return {
      mode: 'meet',
      aRate,
      bRate,
      label: `差 ${(gap * 100).toFixed(1)}%：两侧向中点靠（A ×${aRate.toFixed(3)} · B ×${bRate.toFixed(3)}）`,
    };
  }
  return {
    mode: 'free',
    aRate: 1,
    bRate: 1,
    label: `差 ${(gap * 100).toFixed(0)}%，超出听感安全范围（>${(TEMPO_POLICY_LIMITS.meetMax * 100).toFixed(0)}%），不变速`,
  };
}
