/**
 * 分段变速曲线（Apple `speedRamp: [CMTimeMapping]` 的最小平替）。
 *
 * Apple 的做法不是一条直线：日志里风格 8 用了 **77 段**、风格 16 用了 **39 段** time mapping，
 * 两端速率逐渐靠拢/分离。WebAudio 只有一个 `playbackRate`，做不到逐帧重映射，
 * 但可以把它近似成**少量折线**（默认 4 段），听感上已经去掉「一条直线拉到底」的机械感。
 *
 * 约定（与 `crossfadeDeck` 的 `tempoRate` 一致）：
 * - `rate` = 「每秒墙钟对应多少 B 文件毫秒」，即 B 侧播放速率。
 * - A 侧要贴到 B，速率是 `1 / rate`。
 * - 返回的是**相对基准速率的倍数**：A 从 1 走到 `1/rate`，B 恒 1（倒置模式）。
 */

export interface SpeedRampKnot {
  /** 归一化窗口位置 0..1。 */
  p: number;
  /** 相对基准速率的倍数。 */
  mul: number;
}

export interface SpeedRampPlan {
  /** A 侧倍数折线（多点）。 */
  a: SpeedRampKnot[];
  /**
   * A 侧最终倍数（= 1/rate）。
   */
  aEnd: number;
  /** 分段数（不含起点）。 */
  segments: number;
  /** 到哪个位置变速完成。 */
  rampEndP: number;
  note: string;
}

/** 缓动：ease-in-out（cosine），与 `smoothStep` 同形但更平缓。 */
function easeInOut(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return 0.5 - 0.5 * Math.cos(Math.PI * t);
}

/**
 * 生成 A 侧分段变速折线。
 *
 * @param rate        B 侧速率（`1` = 不变速）
 * @param segments    折线段数，默认 4；`1` 退化成单段直线
 * @param rampEndP    变速在窗口的哪个位置完成，默认 0.85（留 15% 稳定给 PLL 收尾）
 */
export function planSpeedRamp(rate: number, segments = 4, rampEndP = 0.85): SpeedRampPlan {
  const r = Number.isFinite(rate) && rate > 0 ? Math.max(0.5, Math.min(2, rate)) : 1;
  const aEnd = 1 / r;
  const segs = Math.max(1, Math.min(8, Math.round(Number.isFinite(segments) ? segments : 4)));
  const endP = Math.max(0.1, Math.min(1, Number.isFinite(rampEndP) ? rampEndP : 0.85));

  if (Math.abs(aEnd - 1) < 0.002) {
    return {
      a: [
        { p: 0, mul: 1 },
        { p: 1, mul: 1 },
      ],
      aEnd: 1,
      segments: 1,
      rampEndP: 1,
      note: '不需要变速',
    };
  }

  const a: SpeedRampKnot[] = [{ p: 0, mul: 1 }];
  for (let i = 1; i <= segs; i += 1) {
    const t = easeInOut(i / segs);
    a.push({ p: Number((endP * (i / segs)).toFixed(4)), mul: Number((1 + (aEnd - 1) * t).toFixed(6)) });
  }
  // 变速完成后保持到窗口末尾，方便调用方直接按 p 取样。
  a.push({ p: 1, mul: aEnd });

  const pct = (aEnd > 1 ? '加速' : '减速');
  return {
    a,
    aEnd,
    segments: segs,
    rampEndP: endP,
    note: `A ${pct}到 ×${aEnd.toFixed(3)}（${segs} 段，${(endP * 100).toFixed(0)}% 完成）`,
  };
}

/** 在折线上线性取样（超出范围夹到端点）。 */
export function speedRampAt(knots: readonly SpeedRampKnot[], p: number): number {
  if (!knots.length) return 1;
  const x = Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : 0;
  if (x <= knots[0].p) return knots[0].mul;
  for (let i = 1; i < knots.length; i += 1) {
    const prev = knots[i - 1];
    const cur = knots[i];
    if (x <= cur.p) {
      const span = cur.p - prev.p;
      if (span <= 1e-9) return cur.mul;
      const t = (x - prev.p) / span;
      return prev.mul + (cur.mul - prev.mul) * t;
    }
  }
  return knots[knots.length - 1].mul;
}
