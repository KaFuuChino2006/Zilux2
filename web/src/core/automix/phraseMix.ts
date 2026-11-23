import type { BeatAnalysis } from '../../online/analysis';

interface PhraseInput {
  a: BeatAnalysis;
  b: BeatAnalysis;
  earliest: number;
  end: number;
  head: number;
  limit: number;
  release: number;
  entry: number;
  rateLimit: number;
  fixedMs: number;
  bar: number;
}

function precedingIndex(times: number[], ms: number): number {
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] <= ms) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

// Compare pitch-class profiles in the actual overlap, independent of overall volume.
function harmonyCost(a: BeatAnalysis, b: BeatAnalysis, x: number, y: number): number {
  const i = precedingIndex(a.barChromaMs ?? [], x) * 12;
  const j = precedingIndex(b.barChromaMs ?? [], y) * 12;
  if (i < 0 || j < 0 || !a.barChroma || !b.barChroma
    || i + 12 > a.barChroma.length || j + 12 > b.barChroma.length) return 0;
  let similarity = 0;
  for (let k = 0; k < 12; k++) similarity += a.barChroma[i+k] * b.barChroma[j+k];
  return 1 - Math.min(1, similarity);
}

// Compare the last two bars of actual drum accents at native playback speed.

/**
 * 「两边同时有人声」的比例（0…1）。全库体检里 15.9% 的组合在乐句窗口内 A/B 人声重叠，
 * 那是「听着很杂」最直接的来源 —— 高频咬字互相盖住，谁也听不清。
 * 只用 activity.vocal（250 ms 网格），10 个采样点足够。
 */
function vocalOverlap(a: BeatAnalysis, b: BeatAnalysis, x: number, y: number,
  span: number, rate: number, samples = 10): number {
  const left = a.activity, right = b.activity;
  if (!left || !right || !(left.hopMs > 0 && right.hopMs > 0)) return 0;
  let both = 0, n = 0;
  for (let k = 0; k < samples; k += 1) {
    const t = (k + 0.5) * span / samples;
    const av = left.vocal[Math.floor((x + t) / left.hopMs)] ?? 0;
    const bv = right.vocal[Math.floor((y + t * rate) / right.hopMs)] ?? 0;
    if (!Number.isFinite(av) || !Number.isFinite(bv)) continue;
    n += 1;
    if (av > 0.5 && bv > 0.5) both += 1;
  }
  return n === 0 ? 0 : both / n;
}


/**
 * 入点清晰度：B 在落点后一拍内是否「真的开唱」、而 A 在那时是否已经收声。
 * 鼓型相似只能保证律动接得上；真正让人觉得「接住了」的是 B 的第一句清楚地进来，
 * 而不是在 A 的拖音底下糊着开始。
 */
export function entryClarity(a: BeatAnalysis, b: BeatAnalysis, x: number, y: number, span: number, bar: number): number {
  const va = a.activity?.vocal, vb = b.activity?.vocal;
  const ha = a.activity?.hopMs ?? 0, hb = b.activity?.hopMs ?? 0;
  if (!va || !vb || !(ha > 0 && hb > 0)) return 0;
  const mean = (curve: number[], hop: number, from: number, to: number) => {
    let sum = 0, n = 0;
    for (let t = from; t < to; t += hop) {
      const v = curve[Math.round(t / hop)];
      if (Number.isFinite(v)) { sum += v; n += 1; }
    }
    return n ? sum / n : 0;
  };
  const before = mean(vb, hb, Math.max(0, y - bar * 0.5), y);
  const after = mean(vb, hb, y + bar * 0.5, y + bar * 1.5);
  const rise = Math.max(0, Math.min(1, (after - before) / 0.25));
  const aTail = mean(va, ha, x + Math.max(0, span - bar), x + span);
  return 0.35 * rise - 0.35 * Math.min(1, aTail);
}

export function matchDrumPhrase(a: BeatAnalysis, b: BeatAnalysis, end: number,
  earliest: number, head: number, lyric: number, limit: number, bar: number) {
  const left = a.activity, right = b.activity;
  if (!left || !right || !(left.hopMs > 0 && right.hopMs > 0)) return null;
  const span = Math.min(2*bar,end-earliest);
  const hop = Math.max(left.hopMs,right.hopMs);
  const count = Math.floor(span/hop);
  if (count < 8) return null;
  const x = end-span;
  const pattern = (activity: typeof left, start: number) =>
    Array.from({length:count}, (_,i) => activity.drum[Math.floor((start+(i+0.5)*hop)/activity.hopMs)]);
  const ref = pattern(left,x);
  const score = (candidate: number[]) => {
    if (![...ref,...candidate].every(Number.isFinite)) return -1;
    const mean = (v:number[]) => v.reduce((sum,n)=>sum+n,0)/count;
    const ma=mean(ref), mb=mean(candidate);
    let dot=0, aa=0, bb=0;
    for (let i=0;i<count;i++) {
      const l=ref[i]-ma, r=candidate[i]-mb;
      dot+=l*r; aa+=l*l; bb+=r*r;
    }
    if (Math.min(ma,mb)<0.10 || Math.min(aa,bb)/count<0.003) return -1;
    return dot/Math.sqrt(aa*bb)-0.25*Math.abs(ma-mb);
  };
  // 硬约束：淡化必须结束在 B 的第一句唱词之前（或刚到处），否则 B 会从歌中间的
  // 某一句开始唱——用户听到的「过渡完不是第一句 / 像跳了半首」就是这里漏掉约束。
  const landBy = lyric > 0 ? lyric + 300 : head + 16000;
  let best = null;
  const stop=Math.min(limit-span,landBy-span);
  for (let y=head;y<=stop;y+=hop/2) {
    if (y + span > landBy + 0.5) break;
    const drumSim = score(pattern(right,y));
    if (drumSim < 0) continue;
    // 硬约束只限定「落点在首句之前」，窗口仍然自由选；在自由范围内用
    // 和声（barChroma）与调性一起打分，自动模式才能真正挑到「听起来同调」的那两小节。
    const harmony = harmonyCost(a,b,x,y);
    // 人声重叠直接扣分：两边同时唱 = 两条咬字互相盖住，比鼓型差一点更明显更糟。
    const overlap = vocalOverlap(a,b,x,y,span,1);
    const clarity = entryClarity(a,b,x,y,span,bar);
    const similarity = drumSim - 0.45 * harmony - 1.2 * overlap + clarity
      - (lyric && y+span>lyric ? 0.035 : 0);
    if (similarity>=0.58 && (!best || similarity>best.similarity))
      best={x,y,span,rate:1,sync:false,similarity};
  }
  return best;
}

export function composePhrase(input: PhraseInput) {
  const { a, b, earliest, end, head, limit, entry, bar } = input;
  const ratio = a.bpm / b.bpm;
  const folded = 2 ** (Math.log2(ratio) - Math.round(Math.log2(ratio)));
  const sync = a.bpm >= 40 && b.bpm >= 40 && Math.min(a.bpmConfidence,b.bpmConfidence) >= 0.55
    && Math.abs(folded - 1) <= input.rateLimit;
  const rate = sync ? folded : 1;
  const release = input.release >= earliest && input.release <= end ? input.release : end;
  const landing = new Set([release, end]);
  if (sync) for (const t of a.downbeats ?? []) {
    if (t >= release && t <= Math.min(end, release + 2 * bar)) landing.add(t);
  }
  let best: { x: number; y: number; span: number; rate: number; sync: boolean; cost: number } | null = null;
  for (const endA of landing) {
    for (const length of input.fixedMs ? [input.fixedMs] : sync ? [bar, bar*2, bar*4] : [1200]) {
      const span = Math.min(length, endA-earliest, (limit-head)/rate,
        entry > head ? (entry-head)/rate : Infinity);
      if (!(span >= 250)) continue;
      const x = endA-span;
      const heads = new Set([entry > head ? entry-span*rate : head]);
      if (!entry && sync) for (const t of b.downbeats ?? []) {
        if (t >= head && t <= head + 2*bar) heads.add(t);
      }
      for (const y of heads) {
        if (y < head-0.01 || y+span*rate > limit+0.01) continue;
        let cost = (end-endA)/(8*bar) + (endA-release)/(4*bar) - span/(12*bar);
        if (sync) {
          // Align the nearest actual beat on each deck, including off-beat vocals.
          const offset = (track: BeatAnalysis, at: number) => {
            const grid = track.beatsMs ?? track.downbeats ?? [];
            const idx = precedingIndex(grid, at);
            const nearest = [grid[idx],grid[idx+1]].filter(Number.isFinite)
              .sort((u,v) => Math.abs(u-at)-Math.abs(v-at))[0];
            return nearest === undefined ? 0 : nearest-at;
          };
          cost += Math.min(1, Math.abs(offset(a,x)-offset(b,y)/rate)/(bar/4));
        }
        for (let k=0; k<8; k++) {
          const time = (k+0.5)*span/8;
          const ax=x+time, by=y+time*rate;
          cost += harmonyCost(a,b,ax,by)/8;
          const l=a.activity, r=b.activity;
          if (!l || !r) continue;
          const i=Math.floor(ax/l.hopMs), j=Math.floor(by/r.hopMs);
          cost += ((l.vocal[i]??0)*(r.vocal[j]??0)*3.2
            + Math.abs((l.drum[i]??0)-(r.drum[j]??0))*0.4
            + Math.abs((l.bass[i]??0)-(r.bass[j]??0))*0.25)/8;
        }
        if (!best || cost < best.cost) best={x,y,span,rate,sync,cost};
      }
    }
  }
  return best;
}

// Smooth endpoints avoid a sudden level change at the first or last audio block.
export function phraseGains(progress: number): [number,number] {
  const p = Math.min(1,Math.max(0,progress));
  const angle = p*p*(3-2*p)*Math.PI/2;
  return [p === 1 ? 0 : Math.cos(angle), Math.sin(angle)];
}

/**
 * 尾段散音（鼓组收尾后的镲片/混响/余振）分析。
 *
 * 「动次打次」最后一击之后，A 往往还有几百毫秒到几秒的散音。它们既不在拍网格上，
 * 也不该跟 B 的第一击叠在一起 —— 叠上去就是「糊」和「镲片嘶声」。所以要把这段
 * 单独量出来：最后一击在哪、散音有多长、是在衰减还是一直吊着。
 */
export interface TailResidue {
  /** 最后一击（鼓/贝斯/人声任一显著点）的文件时间。 */
  lastAccentMs: number;
  /** 散音长度 = endMs − lastAccentMs。 */
  residueMs: number;
  /** 散音段的峰值活动度。 */
  peak: number;
  /** 散音段的平均活动度。 */
  mean: number;
  /** 是否单调衰减（真散音）；false = 一直吊着（可能是持续音/噪声垫）。 */
  decaying: boolean;
}

/**
 * 找 A 的「最后一击」与它后面的散音。
 *
 * 判据用 activity 三曲线的加权最大值：鼓优先（散音多半是鼓组收尾），
 * 贝斯次之（低音余振），人声再次（尾音拖长）。阈值 0.35 与既有 `lastDrum` 一致。
 */
export function analyseResidue(a: BeatAnalysis, endMs: number, barMs: number): TailResidue | null {
  const act = a.activity;
  if (!act || !(act.hopMs > 0)) return null;
  const hop = act.hopMs;
  const from = Math.max(0, Math.floor((endMs - Math.max(2 * barMs, 4000)) / hop));
  const to = Math.min(act.drum.length, Math.ceil(endMs / hop));
  if (to - from < 4) return null;
  const level = (i: number): number =>
    Math.max(act.drum[i] ?? 0, (act.bass[i] ?? 0) * 0.8, (act.vocal[i] ?? 0) * 0.6);
  let lastAccent = -1;
  for (let i = to - 1; i >= from; i--) {
    if (level(i) >= 0.35) {
      lastAccent = i;
      break;
    }
  }
  if (lastAccent < 0) return null;
  const lastAccentMs = lastAccent * hop;
  const residueMs = Math.max(0, endMs - lastAccentMs);
  if (residueMs < 120) return { lastAccentMs, residueMs, peak: 0, mean: 0, decaying: true };
  const span = to - lastAccent - 1;
  const quarters = 4;
  const means: number[] = [];
  let peak = 0;
  let sum = 0;
  let counted = 0;
  for (let q = 0; q < quarters; q++) {
    const lo = lastAccent + 1 + Math.floor((span * q) / quarters);
    const hi = lastAccent + 1 + Math.floor((span * (q + 1)) / quarters);
    let acc = 0;
    for (let i = lo; i < hi; i++) {
      const v = level(i);
      acc += v;
      if (v > peak) peak = v;
      sum += v;
      counted++;
    }
    means.push(hi > lo ? acc / (hi - lo) : 0);
  }
  // 衰减判定：四段均值整体下降，且首段明显高于末段；允许 ±0.03 抖动
  let falling = 0;
  for (let q = 1; q < quarters; q++) if (means[q] <= means[q - 1] + 0.03) falling++;
  const decaying = falling >= quarters - 1 && means[0] >= means[quarters - 1] + 0.05;
  return {
    lastAccentMs,
    residueMs,
    peak: Math.round(peak * 1000) / 1000,
    mean: counted > 0 ? Math.round((sum / counted) * 1000) / 1000 : 0,
    decaying,
  };
}

/**
 * 散音段该保留多长再收干净。
 *
 * - 衰减型散音（镲片/混响尾巴）：留 0.4 小节（夹 300–1200 ms）让收尾听起来自然，
 *   剩下的直接不进过渡窗口 —— 这就是「绕过」。
 * - 吊着不放的持续音：只留 120 ms 防爆音，其余立刻退出，否则会一直垫在 B 底下。
 */
export function residueKeepMs(residue: TailResidue | null, barMs: number): number {
  // 不足一格（250 ms）不算散音：那只是最后一击本身的余振，不需要特殊处理
  if (!residue || residue.residueMs <= 250) return 0;
  if (!residue.decaying) return Math.min(residue.residueMs, 120);
  return Math.min(residue.residueMs, Math.max(300, Math.min(1200, Math.round(barMs * 0.4))));
}
