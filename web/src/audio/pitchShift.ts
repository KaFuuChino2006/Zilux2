/**
 * 离线移调（granular SOLA）。
 *
 * 用途：把下一首的**前奏**移几个半音去贴上一首的调，再当桥段用。只在过渡前做一次，
 * 不参与实时渲染，所以可以接受几百毫秒的 JS 计算。
 *
 * 为什么不用 `playbackRate`：那会同时改速度。这里要的是「音高变了、长度不变」，
 * 唯一省事的办法就是颗粒合成 + 互相关对齐（SOLA），否则会听到相位跳变的「嗡嗡」声。
 *
 * 代价与边界：
 * - 移调 ≤ ±5 个半音时鼓/贝斯还能接受；再大就开始有金属味（所以 clamp 在 ±6）。
 * - 纯打击乐（无音高）本来不该移调，调用方先用 `semitonesForBridge()` 判断。
 */

/** 颗粒长度（样本）。48 kHz 下 ≈ 43 ms，足够容纳 40 Hz 的四个周期。 */
export const PITCH_GRAIN = 2048;
/** 互相关搜索半径（样本）≈ 5 ms：只搜这么远，再远就是另一个音了。 */
export const PITCH_SEARCH = 256;
/** 允许的最大移调（半音）。 */
export const PITCH_MAX_SEMITONES = 6;

function hann(length: number): Float32Array {
  const win = new Float32Array(length);
  for (let i = 0; i < length; i += 1) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / length);
  return win;
}

/**
 * 把一条单声道样本移调 `semitones` 个半音，长度保持不变。
 *
 * `sampleRate` 只用于把「搜索半径」限制在 5 ms 内，避免低采样率下搜过头。
 */
/** 一次移调的全部时序参数：与具体声道无关，多声道共用同一份。 */
export interface PitchPlan {
  grain: number;
  hop: number;
  search: number;
  ratio: number;
  win: Float32Array;
  /** 每个颗粒的读点偏移（互相关结果）。所有声道共用，才不会左右各走各的相位。 */
  offsets: number[];
}

function planSize(length: number, sampleRate: number): { grain: number; hop: number; search: number } {
  const grain = Math.min(PITCH_GRAIN, Math.max(256, Math.floor(length / 8)));
  const hop = Math.floor(grain / 2);
  const search = Math.min(
    PITCH_SEARCH,
    Math.max(32, Math.floor((sampleRate * 0.005) | 0)),
    Math.max(32, hop - 1),
  );
  return { grain, hop, search };
}

/**
 * 用一条参考信号算出「每个颗粒该从哪里读」。
 *
 * 多声道必须共用这一份：互相关是**逐颗粒独立**求的，如果左右声道各算一次，
 * 弱侧（或被伴奏掩蔽的那一侧）很容易选到相邻的另一峰，几十毫秒下来就是声像漂移 +
 * 中频梳状——听感是「人声偏到一边，而且有点空」。
 */
export function planPitch(reference: Float32Array, sampleRate: number, semitones: number): PitchPlan {
  const length = reference.length;
  const { grain, hop, search } = planSize(length, sampleRate);
  const clamped = Math.max(-PITCH_MAX_SEMITONES, Math.min(PITCH_MAX_SEMITONES, semitones));
  const ratio = 2 ** (clamped / 12);
  const win = hann(grain);
  const offsets: number[] = [];
  if (!(length > 0)) return { grain, hop, search, ratio, win, offsets };

  // 参考信号自己先跑一遍，只为拿到 offsets。
  const scratch = new Float32Array(length);
  let readPos = 0;
  for (let outPos = 0; outPos < length; outPos += hop) {
    let bestOffset = 0;
    if (outPos > 0) {
      let bestScore = -Infinity;
      const prev = outPos - hop;
      for (let offset = -search; offset <= search; offset += 1) {
        const candidate = Math.round(readPos) + offset;
        let score = 0;
        for (let i = 0; i < hop; i += 1) {
          const a = scratch[prev + hop + i] ?? 0;
          const b = reference[candidate + hop + i] ?? 0;
          score += a * b;
        }
        if (score > bestScore) {
          bestScore = score;
          bestOffset = offset;
        }
      }
    }
    offsets.push(bestOffset);
    const start = Math.round(readPos) + bestOffset;
    for (let i = 0; i < grain; i += 1) {
      const src = start + i;
      if (src < 0 || src >= length) continue;
      scratch[outPos + i] += reference[src] * win[i];
    }
    readPos += hop * ratio;
    if (readPos >= length) break;
  }
  return { grain, hop, search, ratio, win, offsets };
}

/** 按既定计划渲染一条声道：读点、窗、归一化全部与参考信号一致。 */
export function renderPitchPlan(input: Float32Array, plan: PitchPlan): Float32Array {
  const length = input.length;
  const out = new Float32Array(length);
  if (!(length > 0)) return out;
  const { grain, hop, ratio, win, offsets } = plan;
  const norm = new Float32Array(length + grain);
  let readPos = 0;
  for (let outPos = 0, g = 0; outPos < length; outPos += hop, g += 1) {
    const start = Math.round(readPos) + (offsets[g] ?? 0);
    for (let i = 0; i < grain; i += 1) {
      const src = start + i;
      if (src < 0 || src >= length) continue;
      const w = win[i];
      out[outPos + i] += input[src] * w;
      norm[outPos + i] += w;
    }
    readPos += hop * ratio;
    if (readPos >= length) break;
  }
  for (let i = 0; i < length; i += 1) {
    const n = norm[i];
    if (n > 1e-4) out[i] /= n;
    else out[i] = input[i] ?? 0;
  }
  return out;
}

function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const length = channels[0].length;
  const mono = new Float32Array(length);
  for (const channel of channels) {
    if (channel.length !== length) continue;
    for (let i = 0; i < length; i += 1) mono[i] += channel[i];
  }
  for (let i = 0; i < length; i += 1) mono[i] /= channels.length;
  return mono;
}

/** 单声道移调（长度不变）。 */
export function shiftPitchMono(input: Float32Array, sampleRate: number, semitones: number): Float32Array {
  if (!(input.length > 0)) return new Float32Array(0);
  if (!Number.isFinite(semitones) || Math.abs(semitones) < 0.01) return input.slice();
  return renderPitchPlan(input, planPitch(input, sampleRate, semitones));
}

/**
 * 多声道移调：先用单声道混合算一份计划，再让各声道按同一组读点渲染。
 *
 * 这一步不能省：逐声道独立求互相关，左右会选到不同峰 → 声像漂移、中频梳状。
 */
export function shiftPitchChannels(
  channels: Float32Array[],
  sampleRate: number,
  semitones: number,
): Float32Array[] {
  if (!Array.isArray(channels) || channels.length === 0) return [];
  if (!Number.isFinite(semitones) || Math.abs(semitones) < 0.01) return channels;
  const plan = planPitch(mixToMono(channels), sampleRate, semitones);
  return channels.map((channel) => renderPitchPlan(channel, plan));
}

/**
 * 两个调之间「最省力的移调量」：取环上最近的那个方向，范围 [−6, +5]。
 *
 * `from`/`to` 是主音音级（0 = C … 11 = B）。任一非法时返回 0（不移调）。
 */
export function semitonesForBridge(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < 0) return 0;
  if (from > 11 || to > 11) return 0;
  const raw = (((to - from) % 12) + 12) % 12;
  // 三全音（6 个半音）两个方向一样远，取向下：抬音高更容易听出「卡通味」。
  const shift = raw >= 6 ? raw - 12 : raw;
  return Math.max(-PITCH_MAX_SEMITONES, Math.min(PITCH_MAX_SEMITONES, shift));
}
