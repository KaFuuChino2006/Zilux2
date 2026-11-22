/**
 * Apple Music「Smart Transitions」风格配方的骨架（逆向自 TransitionStyles.json，24 种中的可映射子集）。
 *
 * 只保留我们用得到的字段：每个 instruction 的 parameterId + 相对时间窗 + 起止值 + 缓动。
 * 单位与 Apple 一致：`bars` 是小节数；时间是相对窗口的 0..1；频率 Hz；增益是 0..1 线性或 dB（见各参数名）。
 *
 * 原文件里的 REMIX_FX / AURemixFX 专用参数（repeater/gater/flanger/phaser/tape stop）不在此列——
 * 那些是 AURemixFX 的内部参数，我们的 WebAudio 图没有对应节点，映射见 `appleRecipeFor()` 的注释。
 */

export type AppleEasing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';

/** 一条参数自动化：relative 窗口 [t0,t1] 上从 v0 到 v1。 */
export interface AppleAutomation {
  param: string;
  t0: number;
  t1: number;
  v0: number | string;
  v1: number | string;
  easing: AppleEasing;
  /** 相对窗口之外的绝对偏移（秒），Apple 用来做「延迟一点点」的收尾。 */
  off0?: number;
  off1?: number;
}

export interface AppleRecipe {
  id: number;
  name: string;
  /** 过渡长度（小节）。0 表示配方本身不约束长度（Gapless / overlap 这类）。 */
  bars: number;
  out: AppleAutomation[];
  inc: AppleAutomation[];
}
export const APPLE_RECIPES: readonly AppleRecipe[] = [
  {
    id: 0, name: "Gapless", bars: 0.0,
    out: [
      { param: 'out_gain', t0: 0.0, t1: 1.0, v0: 1, v1: 0, easing: 'ease-in' },
    ],
    inc: [
      { param: 'out_gain', t0: 0.0, t1: 1.0, v0: 1, v1: 1, easing: 'ease-out' },
    ],
  },
  {
    id: 1, name: "constant-power cross-fade", bars: 0.0,
    out: [
      { param: 'out_gain', t0: 0.0, t1: 1.0, v0: 1, v1: 0, easing: 'ease-in' },
    ],
    inc: [
      { param: 'out_gain', t0: 0.0, t1: 1.0, v0: 0, v1: 1, easing: 'ease-out' },
    ],
  },
  {
    id: 2, name: "constant-power long fade-out short fade-in", bars: 0.0,
    out: [
      { param: 'out_gain', t0: 0.0, t1: 1.0, v0: 1, v1: 0, easing: 'ease-in' },
    ],
    inc: [
      { param: 'out_gain', t0: 0.0, t1: 1.0, v0: 0, v1: 1, easing: 'ease-out' },
    ],
  },
  {
    id: 5, name: "BM - Short filter high to low", bars: 2.0,
    out: [
      { param: 'ts_rate', t0: 0.0, t1: 1.0, v0: 1, v1: 2, easing: 'linear' },
      { param: 'lp_cutoff_freq', t0: 0.0, t1: 1.0, v0: 20000, v1: 200, easing: 'ease-out' },
      { param: 'out_gain', t0: 0.0, t1: 1.0, v0: 1, v1: 0, easing: 'linear' },
    ],
    inc: [
      { param: 'ts_rate', t0: 0.0, t1: 1.0, v0: 2, v1: 1, easing: 'linear' },
      { param: 'hp_cutoff_freq', t0: 0.0, t1: 1.0, v0: 20000, v1: 10, easing: 'ease-out' },
      { param: 'lp_cutoff_freq', t0: 0.0, t1: 1.0, v0: 1200, v1: 20000, easing: 'ease-in' },
      { param: 'out_gain', t0: 0.0, t1: 1.0, v0: 0, v1: 1, easing: 'linear' },
    ],
  },
  {
    id: 8, name: "BM - Filter high to low", bars: 8.0,
    out: [
      { param: 'ts_rate', t0: 0.0, t1: 1.0, v0: 1, v1: 2, easing: 'linear' },
      { param: 'lp_cutoff_freq', t0: 0.0, t1: 1.0, v0: 20000, v1: 200, easing: 'ease-out' },
      { param: 'out_gain', t0: 0.0, t1: 1.0, v0: 1, v1: 0, easing: 'linear' },
    ],
    inc: [
      { param: 'ts_rate', t0: 0.0, t1: 1.0, v0: 2, v1: 1, easing: 'linear' },
      { param: 'hp_cutoff_freq', t0: 0.0, t1: 1.0, v0: 20000, v1: 10, easing: 'ease-out' },
      { param: 'lp_cutoff_freq', t0: 0.0, t1: 1.0, v0: 1200, v1: 20000, easing: 'ease-in' },
      { param: 'out_gain', t0: 0.0, t1: 1.0, v0: 0, v1: 1, easing: 'linear' },
    ],
  },
  {
    id: 9, name: "BM - Filter expansion", bars: 8.0,
    out: [
      { param: 'ts_rate', t0: 0.0, t1: 1.0, v0: 1, v1: 2, easing: 'linear' },
      { param: 'lp_cutoff_freq', t0: 0.5, t1: 1.0, v0: 20000, v1: 20, easing: 'ease-out' },
      { param: 'hp_cutoff_freq', t0: 0.5, t1: 0.75, v0: 20, v1: 200, easing: 'ease-out' },
      { param: 'out_gain', t0: 0.0, t1: 1.0, v0: 1, v1: 0, easing: 'linear' },
    ],
    inc: [
      { param: 'ts_rate', t0: 0.0, t1: 1.0, v0: 2, v1: 1, easing: 'linear' },
      { param: 'lp_cutoff_freq', t0: 0.0, t1: 0.75, v0: 1000, v1: 20000, easing: 'ease-out' },
      { param: 'hp_cutoff_freq', t0: 0.5, t1: 0.75, v0: 1000, v1: 20, easing: 'ease-out' },
      { param: 'out_gain', t0: 0.0, t1: 1.0, v0: 0, v1: 1, easing: 'linear' },
    ],
  },
  {
    id: 13, name: "BM - Filter soft + Reverb", bars: 10.0,
    out: [
      { param: 'ts_rate', t0: 0.0, t1: 1.0, v0: 1, v1: 2, easing: 'linear' },
      { param: 'lp_cutoff_freq', t0: 0.4, t1: 0.8, v0: 20000, v1: 760, easing: 'ease-out' },
      { param: 'hp_cutoff_freq', t0: 0.0, t1: 0.8, v0: 10, v1: 760, easing: 'ease-out' },
      { param: 'out_gain', t0: 0.4, t1: 0.8, v0: 1, v1: 0.75, easing: 'linear' },
      { param: 'fx_reverb_high_frequency_decay_time', t0: 0.0, t1: 0.0, v0: 0.001, v1: 4, easing: 'linear' },
      { param: 'fx_reverb_low_frequency_decay_time', t0: 0.0, t1: 0.0, v0: 0.001, v1: 4, easing: 'linear' },
      { param: 'fx_reverb_min_delay_time', t0: 0.0, t1: 0.0, v0: 0.008, v1: 0.052, easing: 'linear' },
      { param: 'fx_reverb_max_delay_time', t0: 0.0, t1: 0.0, v0: 0.106, v1: 0.106, easing: 'linear' },
      { param: 'fx_reverb_randomize_reflections', t0: 0.0, t1: 0.0, v0: 333, v1: 333, easing: 'linear' },
      { param: 'fx_reverb_dry_wet', t0: 0.0, t1: 0.0, v0: 0, v1: 100, easing: 'linear' },
      { param: 'send_mixer_gain', t0: 0.0, t1: 0.8, v0: 0, v1: 1, easing: 'linear' },
      { param: 'fx_mixer_wet', t0: 0.0, t1: 1.0, v0: 0, v1: 1, easing: 'ease-in' },
      { param: 'fx_mixer_dry', t0: 0.0, t1: 1.0, v0: 1, v1: 0, easing: 'ease-in' },
      { param: 'player_gain', t0: 0.8, t1: 0.8, v0: 1, v1: 0, easing: 'linear', off0: -0.5 },
    ],
    inc: [
      { param: 'ts_rate', t0: 0.0, t1: 1.0, v0: 2, v1: 1, easing: 'linear' },
      { param: 'lp_cutoff_freq', t0: 0.0, t1: 0.0, v0: 250, v1: 250, easing: 'ease-out' },
      { param: 'lp_cutoff_freq', t0: 0.6, t1: 0.8, v0: 500, v1: 20000, easing: 'ease-in' },
      { param: 'lp_reso', t0: 0.0, t1: 0.0, v0: -5, v1: -5, easing: 'ease-in' },
      { param: 'hp_cutoff_freq', t0: 0.0, t1: 0.0, v0: 150, v1: 150, easing: 'ease-in' },
      { param: 'hp_cutoff_freq', t0: 0.7, t1: 0.8, v0: 150, v1: 20, easing: 'ease-in' },
      { param: 'out_gain', t0: 0.0, t1: 0.1, v0: 0, v1: 0.75, easing: 'linear' },
      { param: 'out_gain', t0: 0.65, t1: 0.7, v0: 0.75, v1: 1, easing: 'linear' },
    ],
  },
  {
    id: 15, name: "Hiphop - Delay out", bars: 4.0,
    out: [
      { param: 'ts_rate', t0: 0.0, t1: 0.75, v0: 1, v1: 2, easing: 'linear' },
      { param: 'fx_delay_dry_wet', t0: 0.0, t1: 0.0, v0: 0, v1: 100, easing: 'ease-out', off1: 1.0 },
      { param: 'fx_delay_delay_time', t0: 0.0, t1: 0.0, v0: "@dynamic_beat_length", v1: "@dynamic_beat_length", easing: 'ease-out' },
      { param: 'fx_delay_lp_cutoff_frequency', t0: 0.0, t1: 0.0, v0: 3000, v1: 3000, easing: 'linear' },
      { param: 'fx_delay_feedback', t0: 0.0, t1: 0.0, v0: 35, v1: 35, easing: 'linear' },
      { param: 'send_mixer_gain', t0: 0.0, t1: 0.0, v0: 1, v1: 0, easing: 'linear', off1: 0.1 },
      { param: 'hp_cutoff_freq', t0: 0.25, t1: 0.5, v0: 20, v1: 200, easing: 'ease-out' },
      { param: 'fx_mixer_wet', t0: 0.0, t1: 1.0, v0: 0, v1: 1, easing: 'ease-in' },
      { param: 'fx_mixer_dry', t0: 0.0, t1: 1.0, v0: 1, v1: 0, easing: 'ease-in' },
      { param: 'out_gain', t0: 0.0, t1: 1.0, v0: 1, v1: 0, easing: 'linear' },
    ],
    inc: [
      { param: 'ts_rate', t0: 0.0, t1: 0.75, v0: 2, v1: 1, easing: 'linear' },
      { param: 'lp_cutoff_freq', t0: 0.25, t1: 0.75, v0: 200, v1: 20000, easing: 'ease-in' },
      { param: 'hp_cutoff_freq', t0: 0.25, t1: 0.75, v0: 300, v1: 20, easing: 'ease-out' },
      { param: 'out_gain', t0: 0.0, t1: 1.0, v0: 0, v1: 1, easing: 'linear' },
    ],
  },
  {
    id: 16, name: "Pop - Delay out", bars: 4.0,
    out: [
      { param: 'ts_rate', t0: 0.0, t1: 0.5, v0: 1, v1: 2, easing: 'linear' },
      { param: 'lp_cutoff_freq', t0: 0.125, t1: 0.25, v0: 20000, v1: 3500, easing: 'ease-out' },
      { param: 'fx_delay_dry_wet', t0: 0.0, t1: 0.0, v0: 0, v1: 100, easing: 'ease-out' },
      { param: 'fx_delay_delay_time', t0: 0.0, t1: 0.0, v0: "@beat_length", v1: "@beat_length", easing: 'ease-out' },
      { param: 'fx_delay_lp_cutoff_frequency', t0: 0.0, t1: 0.0, v0: 3500, v1: 3500, easing: 'linear' },
      { param: 'fx_delay_feedback', t0: 0.0, t1: 0.0, v0: 60, v1: 60, easing: 'linear' },
      { param: 'send_mixer_gain', t0: 0.0, t1: 0.25, v0: 0, v1: 0.5, easing: 'linear' },
      { param: 'fx_mixer_wet', t0: 0.0, t1: 1.0, v0: 0, v1: 1, easing: 'ease-in' },
      { param: 'out_gain', t0: 0.375, t1: 0.5, v0: 1, v1: 0, easing: 'linear' },
      { param: 'player_gain', t0: 0.25, t1: 0.25, v0: 1, v1: 0, easing: 'linear' },
    ],
    inc: [
      { param: 'ts_rate', t0: 0.0, t1: 0.5, v0: 2, v1: 1, easing: 'linear' },
      { param: 'hp_cutoff_freq', t0: 0.1875, t1: 0.4375, v0: 5200, v1: 20, easing: 'ease-out' },
      { param: 'out_gain', t0: 0.0, t1: 1.0, v0: 0, v1: 1, easing: 'linear' },
    ],
  },
  {
    id: 20, name: "Pop - Reverb", bars: 4.0,
    out: [
      { param: 'ts_rate', t0: 0.0, t1: 1.0, v0: 1, v1: 2, easing: 'linear' },
      { param: 'remixfx_beats_per_minute', t0: 0.0, t1: 0.0, v0: "@bpm", v1: "@bpm", easing: 'ease-out' },
      { param: 'remixfx_filter_a_on', t0: 0.25, t1: 0.25, v0: 0, v1: 1, easing: 'ease-out' },
      { param: 'remixfx_filter_a_cutoff', t0: 0.25, t1: 0.75, v0: 20000, v1: 20, easing: 'ease-out' },
      { param: 'remixfx_filter_a_resonance', t0: 0.0, t1: 0.0, v0: 0, v1: 0, easing: 'ease-out' },
      { param: 'remixfx_filter_a_type', t0: 0.0, t1: 0.0, v0: 0, v1: 0, easing: 'ease-out' },
      { param: 'remixfx_filter_b_on', t0: 0.2813, t1: 0.2813, v0: 0, v1: 1, easing: 'ease-out' },
      { param: 'remixfx_filter_b_cutoff', t0: 0.2813, t1: 0.5, v0: 20, v1: 600, easing: 'linear' },
      { param: 'remixfx_filter_b_cutoff', t0: 0.5, t1: 0.75, v0: 600, v1: 927, easing: 'linear' },
      { param: 'remixfx_filter_b_resonance', t0: 0.0, t1: 0.0, v0: 0, v1: 0, easing: 'ease-out' },
      { param: 'remixfx_filter_b_type', t0: 0.0, t1: 0.0, v0: 1, v1: 1, easing: 'ease-out' },
      { param: 'remixfx_reverb_on', t0: 0.3125, t1: 0.3125, v0: 0, v1: 1, easing: 'ease-out' },
      { param: 'remixfx_reverb_time', t0: 0.0, t1: 0.0, v0: 6, v1: 6, easing: 'ease-out' },
      { param: 'remixfx_reverb_send', t0: 0.3125, t1: 0.525, v0: 0, v1: 1, easing: 'linear' },
      { param: 'remixfx_reverb_dry', t0: 0.0, t1: 0.0, v0: 1, v1: 1, easing: 'ease-out' },
      { param: 'remixfx_reverb_wet', t0: 0.0, t1: 0.0, v0: 0.8, v1: 0.8, easing: 'ease-out' },
      { param: 'remixfx_lfo_phase_sync', t0: 0.0, t1: 0.0, v0: 0, v1: 1, easing: 'ease-out' },
      { param: 'out_gain', t0: 0.375, t1: 0.75, v0: 1, v1: 0.4217, easing: 'linear' },
      { param: 'out_gain', t0: 0.75, t1: 1.0, v0: 0.4217, v1: 0, easing: 'linear' },
    ],
    inc: [
      { param: 'ts_rate', t0: 0.0, t1: 1.0, v0: 2, v1: 1, easing: 'linear' },
      { param: 'remixfx_beats_per_minute', t0: 0.0, t1: 0.0, v0: "@bpm", v1: "@bpm", easing: 'ease-out' },
      { param: 'remixfx_filter_a_on', t0: 0.0, t1: 0.0, v0: 1, v1: 1, easing: 'ease-out' },
      { param: 'remixfx_filter_a_cutoff', t0: 0.25, t1: 0.75, v0: 3300, v1: 20, easing: 'ease-out' },
      { param: 'remixfx_filter_a_resonance', t0: 0.0, t1: 0.0, v0: 0, v1: 0, easing: 'ease-out' },
      { param: 'remixfx_filter_a_type', t0: 0.0, t1: 0.0, v0: 1, v1: 1, easing: 'ease-out' },
      { param: 'remixfx_filter_b_on', t0: 0.25, t1: 0.25, v0: 0, v1: 1, easing: 'ease-out' },
      { param: 'remixfx_filter_b_cutoff', t0: 0.25, t1: 0.75, v0: 20, v1: 20000, easing: 'ease-in' },
      { param: 'remixfx_filter_b_resonance', t0: 0.0, t1: 0.0, v0: 0, v1: 0, easing: 'ease-out' },
      { param: 'remixfx_filter_b_type', t0: 0.0, t1: 0.0, v0: 0, v1: 0, easing: 'ease-out' },
      { param: 'out_gain', t0: 0.25, t1: 0.75, v0: 0, v1: 1, easing: 'ease-out' },
    ],
  },
  {
    id: 22, name: "splice", bars: 0.0,
    out: [],
    inc: [],
  },
];


/** 从配方里摘出来的、我们引擎真能用的参数。 */
export interface ApplePlan {
  id: number;
  name: string;
  /** 配方要求的小节数（0 = 不约束）。 */
  bars: number;
  /** A 的 out_gain 开始下降的位置（0..1），用来定低频换手起点。 */
  swapStartP: number;
  /** A 的 out_gain 到 0 的位置（0..1）。 */
  aGoneP: number;
  /** A 侧低通：窗口 + 起止频率（Hz）。 */
  aLp: { t0: number; t1: number; fromHz: number; toHz: number } | null;
  /** B 侧高通：窗口 + 起止频率。 */
  bHp: { t0: number; t1: number; fromHz: number; toHz: number } | null;
  /** B 侧低通：窗口 + 起止频率。 */
  bLp: { t0: number; t1: number; fromHz: number; toHz: number } | null;
  /** 延迟（echo out）：送出窗口 + 反馈 + 阻尼 + 以拍为单位的延迟长度。 */
  echo: { t0: number; t1: number; feedback: number; dampHz: number; divBeats: number | null } | null;
  /** 混响：送出窗口 + 干湿 + 衰减时间（秒）。 */
  reverb: { t0: number; t1: number; wet: number; decaySec: number } | null;
  /** 变速窗口（A 侧 ts_rate 从 v0 到 v1）。 */
  tsRate: { t0: number; t1: number; v0: number; v1: number } | null;
}

function num(v: number | string, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function pick(rec: AppleRecipe, side: 'out' | 'inc', param: string): AppleAutomation | null {
  const list = side === 'out' ? rec.out : rec.inc;
  for (const a of list) if (a.param === param) return a;
  return null;
}

function freqRange(a: AppleAutomation | null): { t0: number; t1: number; fromHz: number; toHz: number } | null {
  if (!a) return null;
  const from = num(a.v0, 0);
  const to = num(a.v1, 0);
  if (!(from > 0) || !(to > 0)) return null;
  return { t0: a.t0, t1: a.t1, fromHz: from, toHz: to };
}

/**
 * 把 Apple 配方翻成我们引擎的参数。
 *
 * 映射原则（与 `docs/zilux2-apple-recipe-adoption.md` 对照）：
 * - `out_gain` → 换手位置（A 从哪开始让、让到哪算没）
 * - `lp_cutoff_freq` / `hp_cutoff_freq` → 扫频窗口与目标频率
 * - `fx_delay_*` → 我们的 echo（delay + feedback + damp）；`@beat_length` 记成 1 拍
 * - `fx_reverb_*` / `remixfx_reverb_*` → 我们的 reverb（送出 + 干湿 + 衰减）
 * - `ts_rate` → 变速窗口（Apple 用 1→2 的相对倍率，我们用 1/rate）
 * - `remixfx_repeater_*` / `gater` / `flanger` / `phaser` / `tape_stop`：AURemixFX 专有，WebAudio 无对应节点，
 *   由我们自己的 loopRoll / doubling / backspin 原语实现，不在这里映射。
 */
export function applePlanFor(id: number | null | undefined): ApplePlan | null {
  if (id === null || id === undefined) return null;
  const rec = APPLE_RECIPES.find((r) => r.id === id);
  if (!rec) return null;

  const aOut = pick(rec, 'out', 'out_gain');
  // A 起落点：out_gain 从 1 开始掉的位置；没有就退化成「整个窗口都在淡」。
  const swapStartP = aOut && num(aOut.v0, 1) >= num(aOut.v1, 0) ? aOut.t0 : 0;
  const aGoneP = aOut && num(aOut.v0, 1) >= num(aOut.v1, 0) ? aOut.t1 : 1;

  const aLp = freqRange(pick(rec, 'out', 'lp_cutoff_freq'));
  const bHp = freqRange(pick(rec, 'inc', 'hp_cutoff_freq'));
  const bLp = freqRange(pick(rec, 'inc', 'lp_cutoff_freq'));

  const delayWet = pick(rec, 'out', 'fx_delay_dry_wet') ?? pick(rec, 'out', 'remixfx_reverb_send');
  const delayFb = pick(rec, 'out', 'fx_delay_feedback');
  const delayLp = pick(rec, 'out', 'fx_delay_lp_cutoff_frequency');
  const delayTime = pick(rec, 'out', 'fx_delay_delay_time');
  const echo = delayWet
    ? {
        t0: delayWet.t0,
        t1: delayWet.t1 === 0 && delayWet.off1 ? 1 : delayWet.t1 || 0,
        feedback: Math.max(0, Math.min(0.85, num(delayFb?.v0 ?? 35, 35) / 100)),
        dampHz: num(delayLp?.v0 ?? 3500, 3500),
        // `@beat_length` / `@dynamic_beat_length` = 以拍为单位（1 拍），`@bpm` 用于 LFO 同步不适用。
        divBeats: delayTime && typeof delayTime.v0 === 'string' && delayTime.v0.includes('beat') ? 1 : null,
      }
    : null;

  const rvSend = pick(rec, 'out', 'send_mixer_gain') ?? pick(rec, 'out', 'remixfx_reverb_send');
  const rvWet = pick(rec, 'out', 'fx_reverb_dry_wet') ?? pick(rec, 'out', 'remixfx_reverb_wet');
  const rvDecay = pick(rec, 'out', 'fx_reverb_high_frequency_decay_time') ?? pick(rec, 'out', 'remixfx_reverb_time');
  const reverb = rvSend
    ? {
        t0: rvSend.t0,
        t1: rvSend.t1 === 0 ? 1 : rvSend.t1,
        wet: Math.max(0, Math.min(1, num(rvWet?.v1 ?? 100, 100) / (num(rvWet?.v1 ?? 100, 100) > 1 ? 100 : 1))),
        decaySec: Math.max(0.3, Math.min(6, num(rvDecay?.v1 ?? 1.6, 1.6))),
      }
    : null;

  const ts = pick(rec, 'out', 'ts_rate');
  const tsRate = ts ? { t0: ts.t0, t1: ts.t1, v0: num(ts.v0, 1), v1: num(ts.v1, 1) } : null;

  return {
    id: rec.id,
    name: rec.name,
    bars: rec.bars,
    swapStartP: Math.max(0, Math.min(0.95, swapStartP)),
    aGoneP: Math.max(0.05, Math.min(1, aGoneP || 1)),
    aLp,
    bHp,
    bLp,
    echo,
    reverb,
    tsRate,
  };
}
