/**
 * 进阶混音 v2 的音频图（低频换手 + 分段等功率 + 双向扫频）。
 *
 * 与标准路径完全隔离：标准路径只用 `audioTap` 里已有的 `gain/lowpass/highpass` 直通链，
 * 本模块在**过渡期间**把 deck 的 gain 从 `deckMix` 上摘下来，串一条自己的四段链，
 * 过渡结束后再原样接回（`attachDeckAutomixTap` 的 `restore()`）。
 *
 * 为什么必须另起一条链而不是复用 `buildDeckChain` 里的 lowpass/highpass：
 * 1. 那两只 biquad 是给「融合扫频」用的，参数所有权属于 `releaseDeckFx`，两边抢同一个
 *    AudioParam 会互相 cancel 掉对方的自动化；
 * 2. 低频换手需要**分频后独立增益**，单只 lowpass 拿不到「低频一路、高频一路」两条独立母线；
 * 3. 标准路径对节点图零改动，出问题只要切回 standard 就完全回到旧行为 —— 这是用户
 *    要求的「两种独立过渡」的物理保证，不是配置层的开关。
 *
 * 链路（每侧 deck）：
 *   element →（tap 插入点）→ input ┬→ LP120 → LP120 → lowGain → lowTrim ┬→ lowSum ┬→ sum → duck → sweepLp → sweepHp → deckMix
 *                                  └→ HP120 → HP120 → highGain → unfade → highSum ┘
 * 两级同频 Q=0.7071 的 Butterworth 级联 = 24 dB/oct Linkwitz-Riley，两路相加幅频平直，
 * 换手时不会有相位坑（单级 12 dB/oct 在分频点会凹 −6 dB）。
 */

import { attachDeckAutomixTap } from '../core/audioTap';
import { V2_CROSSOVER_HZ, type V2CurvePoint, type V2DeckCurves } from '../core/automix/v2Plan';

/** 分频用的单级 Q（Butterworth）。两级级联后即 LR4。 */
// Web Audio lowpass/highpass express Q in dB, including negative values.
const BUTTERWORTH_Q = 20 * Math.log10(Math.SQRT1_2);

/** 扫频滤波器的 Q：沿用平坦的 Butterworth 响应，避免额外谐振。 */
const SWEEP_Q = BUTTERWORTH_Q;

export interface AutomixV2Tap {
  input: GainNode;
  gate: GainNode;
  output: AudioNode;
  restore: () => void;
}

export interface AutomixV2Deck {
  element: HTMLAudioElement;
  /** 元素自己的门与共享输入（结构桥接要用：buffer 接 input，元素门压 0）。 */
  tap: AutomixV2Tap;
  /** 中低层增益（120–1200 Hz，乐器主体）：功率互补换手。 */
  midGain: GainNode;
  /** 低频段增益（线性换手）。 */
  lowGain: GainNode;
  /** 低频电平校准：换手前把 B 的低频拉到与 A 同响度，线性相加才不会越换越大。 */
  lowTrim: GainNode;
  /** B 低频支路极性（1 正常 / −1 反相），只在 A/B 低频反相时翻一次。 */
  lowPolarity: GainNode;
  /** 低频支路的电平探头（只测不发声）。 */
  lowAnalyser: AnalyserNode;
  /** 高频段增益（等功率交叉）。 */
  highGain: GainNode;
  /** 风格 EQ（A 侧）：6500 Hz 高频架，默认 0 dB。 */
  aStyleHigh: BiquadFilterNode;
  /** 风格 EQ（A 侧）：齿音/咬字区峰值，Q 0.9，默认 0 dB。 */
  aStylePresence: BiquadFilterNode;
  /** 风格 EQ（B 侧）：6500 Hz 高频架，默认 0 dB。 */
  bStyleHigh: BiquadFilterNode;
  /** 风格 EQ（B 侧）：咬字区峰值，Q 0.9，默认 0 dB。 */
  bStylePresence: BiquadFilterNode;
  /** 风格 EQ（B 侧）：120 Hz 低架，默认 0 dB。 */
  bStyleLow: BiquadFilterNode;
  /**
   * 本 deck 在过渡里的角色。风格 EQ 的两组节点都建在每条链上，
   * 排程时只动与角色匹配的一组，另一组保持 0 dB 直通。
   */
  styleSide: 'a' | 'b' | null;
  /** 分频点（LR4 低通/高通各两级）；换手前可按两边低频相关性微调。 */
  crossover: BiquadFilterNode[];
  /** 整侧低通（A 用来「变闷」）。 */
  sweepLp: BiquadFilterNode;
  /** 整侧高通（B 用来「从远处走近」）。 */
  sweepHp: BiquadFilterNode;
  /** 人声让位（层 C）：A 的 1.5–4 kHz 峰值滤波，被 B 的人声活动度压下去。 */
  duck: BiquadFilterNode;
  /** B 侧过渡期电平包络（只抬不降，0…+6 dB），随 B 自己顶上来回到 0。 */
  bTrim: GainNode;
  /** 湿声高通：B 侧只把 300 Hz 以上送进混响，低音保持干声。 */
  wetHp: BiquadFilterNode;
  /** 湿声让位：B 自己唱时把湿声压下去。 */
  wetDuck: GainNode;
  /** B 顶上来时给 A 的压音（电平），默认 1。 */
  aPress: GainNode;
  /** 压音同时把 A 的低通往下拉（Hz），默认 20000。 */
  aDarken: BiquadFilterNode;
  /** 响度补平：按规划期的响度曲线把窗口内的塌陷补回来（只抬不降，上限 +3 dB）。 */
  loudnessTrim: GainNode;
  /** 尾段渐隐补回：把母带 fade-out 抬回渐隐前的电平（只抬不降）。 */
  unfade: GainNode;
  /** 过渡尾段的混响送出（0 = 关）。 */
  reverbSend: GainNode;
  /** 送出点：'pre' = 从 duck 取（全带宽）；'post' = 从 sweepHp 取（尾巴跟主声道一起变暗，Apple 的结构）。 */
  readonly wetSendTap: 'pre' | 'post';
  setWetTap: (tap: 'pre' | 'post') => void;
  /** 混响返回电平。 */
  reverbGain: GainNode;
  /** 大声场（长尾、慢起）送出：从 duck 取，先挖掉人声与低频。 */
  hallSend: GainNode;
  /** 大声场返回电平。 */
  hallGain: GainNode;
  /** 大声场预延迟。 */
  hallPre: DelayNode;
  /** 大声场卷积（2.6 s）。 */
  hallConv: ConvolverNode;
  /** 大声场阻尼（低通）。 */
  hallDamp: BiquadFilterNode;
  /** 短过渡的尾段回声送出（0 = 关）。 */
  echoSend: GainNode;
  /** 回声延迟（拍点对齐）。 */
  echoDelay: DelayNode;
  /** 回声返回电平。 */
  echoOut: GainNode;
  /** 回声阻尼（低通）。 */
  echoDamp: BiquadFilterNode;
  /** 回声反馈量。 */
  echoFeedback: GainNode;
  /** 拆链并把 deck 接回 deckMix；幂等。 */
  dispose(): void;
}

/**
 * 合成一段「板式」混响脉冲响应（不加载外部 IR）。
 *
 * 做法：指数衰减的白噪声 × 低频加权的简单一阶低通，前 18 ms 留预延迟。
 * 目标不是录音棚级混响，而是「尾巴能听出来、又不糊掉 B 的第一击」：
 * 1.6 s 衰减到 −60 dB，高频先掉（人耳对 6 kHz 以上的长尾巴最敏感）。
 */
const irCache = new WeakMap<BaseAudioContext, Map<number, AudioBuffer>>();

export function transitionReverbIr(ctx: BaseAudioContext, seconds = 1.0): AudioBuffer {
  let perCtx = irCache.get(ctx);
  if (!perCtx) { perCtx = new Map<number, AudioBuffer>(); irCache.set(ctx, perCtx); }
  const cached = perCtx.get(seconds);
  if (cached) return cached;
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.round(seconds * rate));
  const pre = Math.round(0.018 * rate);
  const buffer = ctx.createBuffer(2, len, rate);
  let seed = 0x2f6e2b1;
  const rand = (): number => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) / 0xffffffff) * 2 - 1;
  };
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / (len - pre);
      const decay = Math.exp(-6.9 * t);           // −60 dB @ 末尾
      const noise = rand();
      lp += (noise - lp) * (0.55 - 0.35 * t);     // 越往后越暗
      data[i] = lp * decay * 0.6;
    }
    // 前 4 ms 淡入，避免直击爆音
    for (let i = pre; i < Math.min(len, pre + Math.round(0.004 * rate)); i++) {
      data[i] *= (i - pre) / (0.004 * rate);
    }
  }
  // 归一化到单位 RMS：否则 convolver 的实际湿声 = send + IR 能量（约 −16 dB），
  // 送出 −8 dB 就只剩 −24 dB —— 听不出来就是这么来的。归一后 send 的 dB 就是湿声的 dB。
  let acc = 0;
  let count = 0;
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      acc += data[i] * data[i];
      count++;
    }
  }
  const rms = Math.sqrt(acc / Math.max(1, count));
  if (rms > 1e-6) {
    // 目标 RMS 0.35（≈ −9 dB）：再小就听不出来，再大卷积后的峰值容易顶到削波。
    // 湿声相对干声 ≈ send + 20log10(0.35) + return ≈ send − 9 + return。
    const norm = 0.35 / rms;
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) data[i] *= norm;
    }
  }
  perCtx.set(seconds, buffer);
  return buffer;
}

function makeLr4(ctx: AudioContext, type: 'lowpass' | 'highpass', hz: number): [BiquadFilterNode, BiquadFilterNode] {
  const first = ctx.createBiquadFilter();
  first.type = type;
  first.frequency.value = hz;
  first.Q.value = BUTTERWORTH_Q;
  const second = ctx.createBiquadFilter();
  second.type = type;
  second.frequency.value = hz;
  second.Q.value = BUTTERWORTH_Q;
  return [first, second];
}

/**
 * 为一个已接入 Web Audio 图的 deck 建 v2 链。图未建立 / 元素未 attach 时返回 null
 * （调用方据此退回标准路径，不做任何降级猜测）。
 */
/**
 * 每个元素最多只允许**一条** v2 链。
 *
 * 为什么要这个注册表：`attachDeckAutomixTap` 对同一元素是复用同一个 tap，
 * 而 `buildAutomixV2Deck` 每次都会新建分频/增益/滤波一整套。只要有一条路径漏掉
 * `dispose()`（切歌抢跑、取消、异常分支），就会出现**两条并联链**同时接到 deckMix：
 * 同源信号经两种相位响应相加 → 低频处相关相加（+3~6 dB，听成「低音变大」）、
 * 高频处相位抵消/梳状（听成「混响/空洞」）。这正是「一进过渡像加了低音和混响」的机制。
 */
const liveDecks = new WeakMap<HTMLAudioElement, AutomixV2Deck>();

/** 调试用：当前有多少条 v2 链活着（正常过渡应为 2，空闲为 0）。 */
export function liveAutomixV2Count(): number {
  let count = 0;
  for (const element of registeredElements) {
    if (liveDecks.has(element)) count += 1;
  }
  return count;
}

const registeredElements = new Set<HTMLAudioElement>();

/**
 * 已经建好就复用。
 *
 * 过渡起点这一刻重建整条链（两组 LR4 biquad + Convolver + Delay）等于把图拓扑变更与
 * IR 分配放到可听瞬间；预热点火过的元素直接拿来用，起点只剩排曲线。
 */
export function ensureAutomixV2Deck(element: HTMLAudioElement): AutomixV2Deck | null {
  const existing = liveDecks.get(element);
  if (existing) return existing;
  return buildAutomixV2Deck(element);
}

export function buildAutomixV2Deck(element: HTMLAudioElement): AutomixV2Deck | null {
  const stale = liveDecks.get(element);
  if (stale) {
    try {
      stale.dispose();
    } catch {
      /* 忽略：旧链已经半拆 */
    }
    liveDecks.delete(element);
  }
  registeredElements.add(element);
  const tap = attachDeckAutomixTap(element);
  if (!tap) return null;
  const ctx = tap.input.context as AudioContext;
  let disposed = false;

  const [lowA, lowB] = makeLr4(ctx, 'lowpass', V2_CROSSOVER_HZ);
  const [highA, highB] = makeLr4(ctx, 'highpass', V2_CROSSOVER_HZ);
  const lowGain = ctx.createGain();
  // 默认必须为 0：曲线首点是「从 startSec 起」才生效，若这里是 1，
  // 元素起播到 startSec 之间会有一小段**满音量全频**直通（听感就是「一进过渡像加了低音+混响」）。
  lowGain.gain.value = 0;
  // 低频电平校准：只作用于 B 的低频支路。换手时两侧低频是**相关信号**，
  // 线性相加的正确前提是「两边一样响」；不同响度直接相加就会出现「越换越大」。
  const lowTrim = ctx.createGain();
  lowTrim.gain.value = 1;
  // 反相开关：两边低频波形反相时，线性换手会互相抵消（越换越薄）；
  //   把 B 的低频整体翻 180°，相关信号才谈得上相加。
  const lowPolarity = ctx.createGain();
  lowPolarity.gain.value = 1;
  // 探头接在 lowTrim 之前，量到的是未经校准的原始低频，便于反复校准。
  const lowAnalyser = ctx.createAnalyser();
  lowAnalyser.fftSize = 2048;
  lowAnalyser.smoothingTimeConstant = 0;
  const highGain = ctx.createGain();
  highGain.gain.value = 0;
  // 风格 EQ：默认全部 0 dB 直通。A 侧修「高频空气感 / 咬字亮度」，
  // B 侧额外补一点 120 Hz 低架（前奏常常偏薄）。两组节点同时存在于每条链，
  // 排程时按 deck.styleSide 只动对应一侧，另一侧保持透明。
  const aStyleHigh = ctx.createBiquadFilter();
  aStyleHigh.type = 'highshelf';
  aStyleHigh.frequency.value = 6500;
  aStyleHigh.Q.value = 0.7;
  aStyleHigh.gain.value = 0;
  const aStylePresence = ctx.createBiquadFilter();
  aStylePresence.type = 'peaking';
  aStylePresence.frequency.value = 3000;
  aStylePresence.Q.value = 0.9;
  aStylePresence.gain.value = 0;
  const bStyleHigh = ctx.createBiquadFilter();
  bStyleHigh.type = 'highshelf';
  bStyleHigh.frequency.value = 6500;
  bStyleHigh.Q.value = 0.7;
  bStyleHigh.gain.value = 0;
  const bStylePresence = ctx.createBiquadFilter();
  bStylePresence.type = 'peaking';
  bStylePresence.frequency.value = 3000;
  bStylePresence.Q.value = 0.9;
  bStylePresence.gain.value = 0;
  const bStyleLow = ctx.createBiquadFilter();
  bStyleLow.type = 'lowshelf';
  bStyleLow.frequency.value = 120;
  bStyleLow.Q.value = 0.7;
  bStyleLow.gain.value = 0;
  // 中低层：从 120 Hz 以上再切一刀（1200 Hz），让「乐器主体」与「人声/镲片」
  // 依次进场，而不是所有东西同时抬起来。
  const [midA, midB] = makeLr4(ctx, 'lowpass', 1200);
  const [hiA, hiB] = makeLr4(ctx, 'highpass', 1200);
  const midGain = ctx.createGain();
  midGain.gain.value = 0;
  const midSum = ctx.createGain();
  midSum.gain.value = 1;
  const sum = ctx.createGain();
  sum.gain.value = 1;
  const lowSum = ctx.createGain();
  lowSum.gain.value = 1;
  const highSum = ctx.createGain();
  highSum.gain.value = 1;
  // unfade（尾段渐隐补回）**只挂高频支路**。
  //
  // 以前它挂在合并之后的 sum 上，会把 A 的低频也一起抬高：换手窗口里
  // 总低频 = (1−p)·A·lift + p·B，lift 到 +6 dB 时中点会顶出 +3.5 dB，
  // 听感就是「低频在过渡里被放大一下」。而渐隐需要补的是**人声与亮度**
  // （母带 fade-out 的感知损失主要在 120 Hz 以上），低频交给换手去管。
  const unfade = ctx.createGain();
  unfade.gain.value = 1;

  const sweepLp = ctx.createBiquadFilter();
  sweepLp.type = 'lowpass';
  sweepLp.frequency.value = 20000;
  sweepLp.Q.value = SWEEP_Q;
  let wetSendTap: 'pre' | 'post' = 'pre';
  let wetHp: BiquadFilterNode;
  let wetDuck: GainNode;
  let reverbSend: GainNode;
  let reverbGain: GainNode;
  let hallSend: GainNode;
  let hallGain: GainNode;
  let hallPre: DelayNode;
  let hallConv: ConvolverNode;
  let hallDamp: BiquadFilterNode;
  let hallNotch: BiquadFilterNode;
  let hallHp: BiquadFilterNode;
  let wetIn: GainNode;
  let reverbDamp: BiquadFilterNode;
  let reverb: ConvolverNode;
  let echoSend: GainNode;
  let echoDelay: DelayNode;
  let echoFeedback: GainNode;
  let echoDamp: BiquadFilterNode;
  let echoOut: GainNode;
  const sweepHp = ctx.createBiquadFilter();
  sweepHp.type = 'highpass';
  sweepHp.frequency.value = 20;
  sweepHp.Q.value = SWEEP_Q;

  // 层 C：人声让位。2500 Hz、Q=1.2 的峰值滤波覆盖 1.5–4 kHz（汉语/英语的咬字区间），
  // 增益从 0 压到 −6 dB 就足以让另一首的人声"钻出来"，再深会让 A 变成电话音。
  // 响度补平：规划期已经把窗口内的合成响度算出来了（`quality.curve`），
  // 中段常见的 1.5–3 LU 塌陷（A 尾奏在掉、B 前奏还轻）在这里按曲线反补。
  // 只抬不降、上限 +3 dB——压下来会把本来合适的窗口压扁。
  const aPress = ctx.createGain();
  aPress.gain.value = 1;
  const aDarken = ctx.createBiquadFilter();
  aDarken.type = 'lowpass';
  aDarken.frequency.value = 20_000;
  aDarken.Q.value = 0.6;
  const loudnessTrim = ctx.createGain();
  loudnessTrim.gain.value = 1;

  const bTrim = ctx.createGain();
  bTrim.gain.value = 1;

  const duck = ctx.createBiquadFilter();
  duck.type = 'peaking';
  duck.frequency.value = 2500;
  duck.Q.value = 1.2;
  duck.gain.value = 0;

  try {
    tap.input.connect(lowA);
    lowA.connect(lowB);
    lowB.connect(lowPolarity);
    lowPolarity.connect(lowGain);
    lowGain.connect(lowTrim);
    lowTrim.connect(lowSum);
    // 探头接在**分频输出**而不是 lowGain 之后：量的是这一侧真实的低频电平，
    // 不含淡化曲线的斜坡，否则换手窗口里量到的永远是「正在变小」的值。
    lowB.connect(lowAnalyser);
    tap.input.connect(highA);
    highA.connect(highB);
    highB.connect(midA);
    midA.connect(midB);
    midB.connect(midGain);
    midGain.connect(midSum);
    midSum.connect(unfade);
    highB.connect(hiA);
    hiA.connect(hiB);
    // 风格 EQ 串在 highGain 之前：hiB → aStyleHigh → aStylePresence → bStyleHigh
    // → bStylePresence → bStyleLow → highGain。全部 0 dB 时链路与旧版等价。
    hiB.connect(aStyleHigh);
    aStyleHigh.connect(aStylePresence);
    aStylePresence.connect(bStyleHigh);
    bStyleHigh.connect(bStylePresence);
    bStylePresence.connect(bStyleLow);
    bStyleLow.connect(highGain);
    highGain.connect(highSum);
    highSum.connect(unfade);
    unfade.connect(sum);
    lowSum.connect(sum);
    sum.connect(bTrim);
    bTrim.connect(duck);
    duck.connect(loudnessTrim);
    loudnessTrim.connect(sweepLp);
    sweepLp.connect(sweepHp);
    sweepHp.connect(aPress);
    aPress.connect(aDarken);
    aDarken.connect(tap.output);
    // 混响送出/返回：从「A 已经变闷之前」的全频信号取，尾巴才自然
    reverbSend = ctx.createGain();
    reverbSend.gain.value = 0;
    reverbGain = ctx.createGain();
    reverbGain.gain.value = 0;
    reverbDamp = ctx.createBiquadFilter();
    reverbDamp.type = 'lowpass';
    reverbDamp.frequency.value = 5200;
    reverbDamp.Q.value = 0.5;
    reverb = ctx.createConvolver();
    reverb.buffer = transitionReverbIr(ctx, 1.0);
    // 湿声统一入口：切 wetSendTap（pre/post）时只断开 / 重接这一个节点，
    // 绝不能去 disconnect 干路上的 aPress/aDarken —— 那会把整条干声掐断，
    // 听感就是「一进过渡，正在播的这首直接没声」。
    wetIn = ctx.createGain();
    wetIn.gain.value = 1;
    wetHp = ctx.createBiquadFilter();
    wetHp.type = 'highpass';
    wetHp.frequency.value = 20;
    wetHp.Q.value = 0.707;
    wetDuck = ctx.createGain();
    wetDuck.gain.value = 1;
    duck.connect(wetIn);
    wetIn.connect(wetHp);
    wetHp.connect(wetDuck);
    wetDuck.connect(reverbSend);
    reverbSend.connect(reverb);
    reverb.connect(reverbDamp);
    reverbDamp.connect(reverbGain);
    reverbGain.connect(tap.output);
    // 大声场：慢起的长混响，只吃「除人声外」的部分。
    // 2500 Hz −7 dB 的峰值挖掉咬字区（人声主体），200 Hz 高通挡掉低频，
    // 剩下的鼓/贝斯泛音/键盘铺底进 2.6 s 的长尾 —— 听感是「整个人被推到大厅后排」。
    hallNotch = ctx.createBiquadFilter();
    hallNotch.type = 'peaking';
    hallNotch.frequency.value = 2500;
    hallNotch.Q.value = 1.1;
    hallNotch.gain.value = -7;
    hallHp = ctx.createBiquadFilter();
    hallHp.type = 'highpass';
    hallHp.frequency.value = 280;
    hallHp.Q.value = 0.7;
    hallPre = ctx.createDelay(0.2);
    hallPre.delayTime.value = 0.045;
    hallConv = ctx.createConvolver();
    hallConv.buffer = transitionReverbIr(ctx, 1.3);
    hallDamp = ctx.createBiquadFilter();
    hallDamp.type = 'lowpass';
    hallDamp.frequency.value = 6200;
    hallDamp.Q.value = 0.5;
    hallSend = ctx.createGain();
    hallSend.gain.value = 0;
    hallGain = ctx.createGain();
    hallGain.gain.value = 0;
    wetIn.connect(hallNotch);
    hallNotch.connect(hallHp);
    hallHp.connect(hallSend);
    hallSend.connect(hallPre);
    hallPre.connect(hallConv);
    hallConv.connect(hallDamp);
    hallDamp.connect(hallGain);
    hallGain.connect(tap.output);
    // 尾段回声：短过渡时让 A 的最后一句自己回到自己身上。
    // 取点和混响一样在 sweepLp 之前——A 后段被压到 700 Hz 之后取，回声里就没有咬字了。
    echoSend = ctx.createGain();
    echoSend.gain.value = 0;
    echoDelay = ctx.createDelay(2);
    echoDelay.delayTime.value = 0.375;
    echoFeedback = ctx.createGain();
    echoFeedback.gain.value = 0;
    echoDamp = ctx.createBiquadFilter();
    echoDamp.type = 'lowpass';
    echoDamp.frequency.value = 4200;
    echoDamp.Q.value = 0.5;
    echoOut = ctx.createGain();
    echoOut.gain.value = 0;
    wetIn.connect(echoSend);
    echoSend.connect(echoDelay);
    echoDelay.connect(echoDamp);
    echoDamp.connect(echoOut);
    echoOut.connect(tap.output);
    echoDamp.connect(echoFeedback);
    echoFeedback.connect(echoDelay);
  } catch (err) {
    console.warn('[automixV2] 建链失败', err);
    tap.restore();
    return null;
  }

  const dispose = (): void => {
    if (liveDecks.get(element) === deck) liveDecks.delete(element);
    if (disposed) return;
    disposed = true;
    const nodes: AudioNode[] = [
      lowA, lowB, highA, highB, midA, midB, hiA, hiB, lowGain, midGain, lowTrim, lowAnalyser, highGain,
      aStyleHigh, aStylePresence, bStyleHigh, bStylePresence, bStyleLow,
      lowSum, midSum, highSum, sum, duck, loudnessTrim, unfade,
      sweepLp, sweepHp, aPress, aDarken, wetIn, reverbSend, reverbGain, reverbDamp, reverb,
      hallSend, hallGain, hallPre, hallConv, hallDamp, hallNotch, hallHp,
      echoSend, echoDelay, echoFeedback, echoDamp, echoOut,
    ];
    for (const node of nodes) {
      try {
        node.disconnect();
      } catch {
        /* 已断开时忽略 */
      }
    }
    try {
      tap.input.disconnect();
    } catch {
      /* 忽略 */
    }
    tap.restore();
  };

  const deck: AutomixV2Deck = {
    element, tap, lowGain, midGain, lowTrim, lowPolarity, lowAnalyser, highGain, sweepLp, sweepHp, duck, bTrim, loudnessTrim, unfade,
    crossover: [lowA, lowB, highA, highB],
    aStyleHigh, aStylePresence, bStyleHigh, bStylePresence, bStyleLow, styleSide: null,
    aPress, aDarken, wetHp, wetDuck, reverbSend, reverbGain, echoSend, echoDelay, echoOut, echoDamp, echoFeedback,
    hallSend, hallGain, hallPre, hallConv, hallDamp, dispose,
    get wetSendTap() { return wetSendTap; },
    setWetTap(next: 'pre' | 'post') {
      if (next === wetSendTap) return;
      wetSendTap = next;
      const from: AudioNode = next === 'post' ? sweepHp : duck;
      // 只断开发送边（`disconnect(destination)` 只断开这一条），干路一根都不碰。
      try { duck.disconnect(wetIn); } catch { /* 未连 */ }
      try { sweepHp.disconnect(wetIn); } catch { /* 未连 */ }
      from.connect(wetIn);
    },
  };
  liveDecks.set(element, deck);
  return deck;
}

/**
 * 低频支路的 RMS（0–1 线性幅度）。
 *
 * 用 `getFloatTimeDomainData`（时域）而不是频域：我们要的是「这一段低频有多响」，
 * 时域 RMS 才直接对应响度；FFT 求和还得多算窗与归一化，误差更大。
 */
export function measureLowRms(deck: AutomixV2Deck): number {
  const size = deck.lowAnalyser.fftSize;
  const buffer = new Float32Array(size);
  deck.lowAnalyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / buffer.length);
}

/** 设置低频校准量（dB，夹 ±8）；0 dB 等价直通。 */
/**
 * 分频点自适应：把 LR4 低通/高通同时挪到 hz（90–200 Hz）。
 * 低频段仍是线性换手，抬高只是让「相位打架」的一段缩窄。
 */
export function setCrossoverHz(deck: AutomixV2Deck, hz: number): void {
  const target = Math.max(90, Math.min(200, hz));
  const now = deck.crossover[0]?.context.currentTime ?? 0;
  for (const filter of deck.crossover) {
    filter.frequency.cancelScheduledValues(now);
    filter.frequency.setTargetAtTime(target, now, 0.02);
  }
}

export function setLowPolarity(deck: AutomixV2Deck, inverted: boolean): void {
  const value = inverted ? -1 : 1;
  try {
    deck.lowPolarity.gain.setTargetAtTime(value, deck.lowPolarity.context.currentTime, 0.01);
  } catch {
    deck.lowPolarity.gain.value = value;
  }
}

export function setLowTrimDb(deck: AutomixV2Deck, db: number): void {
  const clamped = Math.max(-8, Math.min(8, Number.isFinite(db) ? db : 0));
  const gain = 10 ** (clamped / 20);
  try {
    deck.lowTrim.gain.setTargetAtTime(gain, deck.lowTrim.context.currentTime, 0.05);
  } catch {
    deck.lowTrim.gain.value = gain;
  }
}

/** 把一条曲线排到 AudioParam 上：先撤旧自动化，再逐点 linear ramp。 */
function scheduleGain(
  param: AudioParam,
  points: readonly V2CurvePoint[],
  startSec: number,
  durationSec: number,
  primeSec = 0,
): void {
  if (!points.length) return;
  try {
    param.cancelScheduledValues(startSec);
  } catch {
    /* 忽略：极端情况下 context 已关闭 */
  }
  const first = points[0]!;
  if (primeSec > 0) param.setValueAtTime(first.v, primeSec);
  param.setValueAtTime(first.v, startSec);
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i]!;
    const at = startSec + point.t * durationSec;
    try {
      param.linearRampToValueAtTime(point.v, at);
    } catch {
      /* 忽略：时间点早于当前时间时浏览器会拒绝，跳过该点不影响整体形状 */
      return;
    }
  }
}

/** 同上，但频率走指数斜坡（人耳对频率是对数感知）。 */
function scheduleFreq(
  param: AudioParam,
  points: readonly V2CurvePoint[],
  startSec: number,
  durationSec: number,
  primeSec = 0,
): void {
  if (!points.length) return;
  try {
    param.cancelScheduledValues(startSec);
  } catch {
    /* 忽略 */
  }
  if (primeSec > 0) param.setValueAtTime(Math.max(20, points[0]!.v), primeSec);
  param.setValueAtTime(Math.max(20, points[0]!.v), startSec);
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i]!;
    const at = startSec + point.t * durationSec;
    try {
      param.exponentialRampToValueAtTime(Math.max(20, point.v), at);
    } catch {
      return;
    }
  }
}

/**
 * 把 A/B 两侧的曲线排到音频时钟上。
 *
 * `startSec` 必须与元素播放起点同一个 clock（`audioTapClock()`），否则换手点会整体偏移；
 * 排程只做一次，之后不再改参数 —— 实时循环里改参数会和自动化打架，产生锯齿。
 */
export function scheduleAutomixV2(
  deck: AutomixV2Deck,
  startSec: number,
  durationSec: number,
  curves: V2DeckCurves,
): void {
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 1;
  // 「预热」：曲线首点通常排在 startSec（未来几十毫秒），这段时间里若不把参数先钉到首点，
  // 分频支路会停留在别的值上（A 会静一帧、B 会满音量冲出来）。所以先在 now 钉一次。
  const nowSec = Math.max(0, deck.lowGain.context.currentTime);
  const prime = nowSec < startSec - 0.004 ? nowSec : 0;
  scheduleGain(deck.lowGain.gain, curves.low, startSec, dur, prime);
  scheduleGain(deck.midGain.gain, curves.mid, startSec, dur, prime);
  scheduleGain(deck.highGain.gain, curves.high, startSec, dur, prime);
  scheduleFreq(deck.sweepLp.frequency, curves.sweepLp, startSec, dur, prime);
  scheduleFreq(deck.sweepHp.frequency, curves.sweepHp, startSec, dur, prime);
}

/**
 * 层 C：按 B 的人声活动度给 A 排「让位」曲线。
 *
 * `events[i] = { atSec, db }`，`db` 是 0（不让）到 −6（让到底）。调用方已经做过
 * attack/release 平滑；这里只负责映射成 AudioParam 斜坡，步长 40 ms 足够平滑
 * （biquad 的 gain 是线性参数，40 ms 一档听不出台阶）。
 */
export function scheduleAutomixV2Duck(
  deck: AutomixV2Deck,
  events: readonly { atSec: number; db: number }[],
  releaseAtSec?: number,
): void {
  if (!events.length) return;
  const param = deck.duck.gain;
  try {
    param.cancelScheduledValues(events[0]!.atSec);
  } catch {
    /* 忽略 */
  }
  param.setValueAtTime(clampDb(events[0]!.db), events[0]!.atSec);
  for (let i = 1; i < events.length; i += 1) {
    try {
      param.linearRampToValueAtTime(clampDb(events[i]!.db), events[i]!.atSec);
    } catch {
      return;
    }
  }
  // 让位必须在窗口收尾前自己回 0 dB。
  //
  // 以前最后一条事件就停在那儿：人声撞完停唱、曲线也不再有新点，
  // `duck.gain` 就一直挂在 −2…−3 dB（2500 Hz 咬字区），
  // 直到 `tap.restore()` 把整条链旁路才一步恢复 ——
  // 听感就是「过渡完成的一瞬间，压着人声/高音的那层东西突然消失」。
  const last = events[events.length - 1]!;
  const end = Number.isFinite(releaseAtSec) ? (releaseAtSec as number) : NaN;
  // 曲线自己已经在窗口里放平（`buildDuckEvents` 留了 settle 区）时不再补 ramp：
  // 一条贴着边界的 30 ms ramp 反而会把「最后一点让位」拍成台阶。
  if (Number.isFinite(end) && last.db < -0.25 && end > last.atSec + 0.05) {
    try {
      param.linearRampToValueAtTime(0, end);
    } catch {
      /* 忽略 */
    }
  }
}

function clampDb(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-9, Math.min(0, value));
}

/**
 * B 侧过渡期电平包络：只抬不降（0…+6 dB），随 B 自己顶上来回到 0。
 *
 * 体检里最差的响度塌陷不是换手时机，而是「B 前奏比 A 尾段低 10–12 LU」：
 * 换手按小节数把 A 关掉后，中间那几秒只剩 B 的轻前奏。
 * 这条包络在 A 还在响的时候把 B 抬起来（听感上被 A 掩蔽），
 * 等 B 的鼓/人声进来再回到 0，避免「过渡完 B 突然变大」。
 */
export function scheduleAutomixV2BTrim(
  deck: AutomixV2Deck,
  atSec: number,
  points: readonly { offsetMs: number; db: number }[],
): void {
  if (!points.length) return;
  const param = deck.bTrim.gain;
  const now = deck.bTrim.context.currentTime;
  const at = Math.max(now, atSec);
  try {
    param.cancelScheduledValues(now);
    param.setValueAtTime(1, now);
  } catch {
    /* 忽略 */
  }
  for (const point of points) {
    const seconds = at + Math.max(0, point.offsetMs) / 1000;
    const gain = Math.pow(10, Math.max(-6, Math.min(9, point.db)) / 20);
    try {
      param.linearRampToValueAtTime(gain, seconds);
    } catch {
      return;
    }
  }
}

/**
 * 尾段渐隐补回：把 A 的母带 fade-out 抬回渐隐前的电平。
 *
 * 与其它曲线不同，这条是「只抬不降」的单向曲线，所以用线性 ramp 直接排；
 * 首点必须显式 setValueAtTime，否则浏览器会从「上一次的默认值」开始插值，
 * 出现开头一小段莫名其妙的渐强。
 */
/**
 * 人声叠加（`acapellaOverlay`，零分轨降级）：把某侧的 `duck` 滤波当成
 * 「1.5–4 kHz 存在感」的旋钮，从 `fromDb` 爬到 `toDb`，到 `releaseP` 再回 0。
 *
 * `clampDb()` 只能压（−9..0），所以这里单独夹 −9..+4：A 侧靠 +2..4 dB 抬咬字，
 * B 侧仍是负值（让位）。
 */
export function scheduleAutomixV2Presence(
  deck: AutomixV2Deck,
  atSec: number,
  durSec: number,
  plan: { fromDb: number; toDb: number; fromP?: number; releaseP?: number },
): void {
  const param = deck.duck.gain;
  const dur = Math.max(0.2, Number.isFinite(durSec) ? durSec : 0.2);
  const clampPresence = (v: number): number =>
    Number.isFinite(v) ? Math.max(-9, Math.min(4, v)) : 0;
  const fromP = Math.max(0, Math.min(0.9, plan.fromP ?? 0));
  const releaseP = Math.max(fromP, Math.min(1, plan.releaseP ?? 1));
  try {
    param.cancelScheduledValues(atSec);
    param.setValueAtTime(0, atSec);
    param.linearRampToValueAtTime(clampPresence(plan.fromDb), atSec + dur * fromP);
    param.linearRampToValueAtTime(clampPresence(plan.toDb), atSec + dur * releaseP);
    param.linearRampToValueAtTime(0, atSec + dur);
  } catch {
    /* 调度失败就当没加，不影响过渡 */
  }
}

/** 风格 EQ 的目标值（对应 StylePolicy.eq）。 */
export interface AutomixV2StyleEqPlan {
  aHighDb?: number;
  aPresenceDb?: number;
  aPresenceHz?: number;
  bHighDb?: number;
  bPresenceDb?: number;
  bPresenceHz?: number;
  bLowDb?: number;
  /** 这组值作用于哪一侧；缺省用 deck.styleSide，再缺省按 A 侧处理。 */
  side?: 'a' | 'b';
}

/** 风格 EQ 的基准存在感频率：过渡结束后回到这里，下一次过渡从透明起步。 */
const STYLE_PRESENCE_BASE_HZ = 3000;

function clampStyleDb(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-6, Math.min(6, value as number));
}

function clampStyleHz(value: number | undefined): number {
  if (!Number.isFinite(value)) return STYLE_PRESENCE_BASE_HZ;
  return Math.max(200, Math.min(12_000, value as number));
}

function scheduleStyleGain(param: AudioParam, targetDb: number, startSec: number, dur: number): void {
  // BiquadFilterNode.gain 的单位是 dB，不要在这里换成线性增益。
  const target = clampStyleDb(targetDb);
  const peak = startSec + dur * 0.3;
  const release = startSec + dur * 0.85;
  try {
    param.cancelScheduledValues(startSec);
    param.setValueAtTime(param.value, startSec);
    param.linearRampToValueAtTime(target, peak);
    param.setValueAtTime(target, release);
    // 契约：补偿只在过渡窗口内生效，末 15% 回到 0 dB。
    param.linearRampToValueAtTime(0, startSec + dur);
  } catch {
    /* 调度失败就当没加，不影响过渡 */
  }
}

function scheduleStyleFreq(param: AudioParam, targetHz: number, startSec: number, dur: number): void {
  const target = clampStyleHz(targetHz);
  try {
    param.cancelScheduledValues(startSec);
    param.setValueAtTime(param.value, startSec);
    param.linearRampToValueAtTime(target, startSec + dur * 0.3);
    param.setValueAtTime(target, startSec + dur * 0.85);
    param.linearRampToValueAtTime(STYLE_PRESENCE_BASE_HZ, startSec + dur);
  } catch {
    /* 忽略 */
  }
}

/**
 * 把风格 EQ 排到过渡窗口上：
 * - 前 30% 爬到目标（不做阶跃，避免「一进过渡突然变亮/变厚」）；
 * - 保持到 85%；
 * - 末 15% 回 0 dB（契约要求过渡补偿必须收干净，否则下一首会继承 EQ）。
 *
 * `plan.side` 决定写哪一组节点：A 侧 aStyleHigh/aStylePresence，B 侧 bStyleHigh/
 * bStylePresence/bStyleLow。两组都常驻链上，未命中的一组保持 0 dB 直通。
 */
export function scheduleAutomixV2Style(
  deck: AutomixV2Deck,
  atSec: number,
  durSec: number,
  plan: AutomixV2StyleEqPlan,
): void {
  const ctx = deck.aStyleHigh.context;
  const start = Math.max(0, Number.isFinite(atSec) ? atSec : 0, ctx.currentTime);
  const dur = Math.max(0.2, Number.isFinite(durSec) && durSec > 0 ? durSec : 0.2);
  const side = plan.side ?? deck.styleSide ?? 'a';
  if (side === 'a') {
    scheduleStyleGain(deck.aStyleHigh.gain, clampStyleDb(plan.aHighDb), start, dur);
    scheduleStyleGain(deck.aStylePresence.gain, clampStyleDb(plan.aPresenceDb), start, dur);
    scheduleStyleFreq(deck.aStylePresence.frequency, plan.aPresenceHz ?? STYLE_PRESENCE_BASE_HZ, start, dur);
    return;
  }
  scheduleStyleGain(deck.bStyleHigh.gain, clampStyleDb(plan.bHighDb), start, dur);
  scheduleStyleGain(deck.bStylePresence.gain, clampStyleDb(plan.bPresenceDb), start, dur);
  scheduleStyleGain(deck.bStyleLow.gain, clampStyleDb(plan.bLowDb), start, dur);
  scheduleStyleFreq(deck.bStylePresence.frequency, plan.bPresenceHz ?? STYLE_PRESENCE_BASE_HZ, start, dur);
}

export function scheduleAutomixV2Unfade(
  deck: AutomixV2Deck,
  startSec: number,
  points: { ms: number; liftDb: number }[],
): void {
  if (!points.length) return;
  const param = deck.unfade.gain;
  const toGain = (db: number): number => 10 ** (Math.max(0, Math.min(12, db)) / 20);
  try {
    param.cancelScheduledValues(startSec - 0.02);
  } catch {
    /* 忽略：老内核不支持负时间 cancel 时直接排 */
  }
  const first = points[0];
  const start = Math.max(0, startSec);
  // 起手不能是「一步跳上去」：+6 dB 的阶跃听起来就是「突然变亮、像加了混响」。
  // 从 1（0 dB）在 250 ms 内爬到头一个目标值，之后按点走。
  const firstTarget = toGain(first.liftDb);
  param.setValueAtTime(1, start);
  // 起手斜坡按「渐隐段总长」的 15% 算（最少 0.8 s）：缓速补偿，不是一步跳上去。
  const spanMs = Math.max(600, (points[points.length - 1]?.ms ?? first.ms) - first.ms);
  const leadSec = Math.max(0.8, Math.min(3.5, (spanMs / 1000) * 0.15));
  if (firstTarget > 1.002) param.linearRampToValueAtTime(firstTarget, start + leadSec);

  for (const point of points.slice(1)) {
    const at = startSec + (point.ms - first.ms) / 1000;
    if (!(at > startSec)) continue;
    const envelope = Math.min(1,(at-start)/0.6);
    param.linearRampToValueAtTime(toGain(point.liftDb*envelope), at);
  }
}

/**
 * 过渡尾段的混响：A 在换手区间里把一部分信号送进混响，尾巴铺进 B 的第一击下面。
 *
 * 关键在「什么时候开始」和「送多少」：
 * - 太早：A 还在主体段落，混响一进来就变糊（这就是之前听起来「像加了混响」的反面）；
 * - 太晚：尾巴来不及长出来，等于没做。
 * 所以默认从窗口的 25% 处开始送、两段爬到窗口末端，再在 B 接管后 1.2–2.2 s 指数衰减收掉。
 * 取点必须在 sweepLp 之前：A 后段被压到 700 Hz 后，从后级取只剩低频，听不出是混响。
 */
/**
 * 大声场（hall）：慢起的长混响，把「除人声外」的部分推进一个大空间。
 *
 * 与短混响的区别不在于音量，而在**时间形状**：
 * - 短混响 25% 起送、窗口末端到满，作用是给尾巴加湿；
 * - 大声场从 `fromP` 起送、用整个 `attackP` 段慢慢爬（默认 55% 的窗口长度），
 *   听感是「空间一点点打开、人声没被裹住」，而不是一刀切的回声。
 * 送出链里已经挖掉 2500 Hz（咬字区）与 200 Hz 以下（低频），所以人声不会被拉进大厅。
 */
/**
 * 「B 抬起来的那一下压 A 并让 A 变闷」。
 *
 * 两件事一次排：
 * - `aPress`：电平按 `pressDb` 下压（默认最多 −5 dB），让新歌顶上来时 A 不抢；
 * - `aDarken`：低通从 20 kHz 收到 `floorHz`（默认 1.5 kHz），A 从「在场」退成「门后」。
 *
 * 只在 drive > 0.02 的段落写点，其余位置写回原值——避免每个采样点都排一次自动化
 * （48000 Hz 的节点上，几千个 `setTargetAtTime` 会让主线程卡）。
 */
export function scheduleAutomixV2Press(
  deck: AutomixV2Deck,
  startSec: number,
  durSec: number,
  points: readonly { p: number; drive: number }[],
  options: { pressDb?: number; floorHz?: number } = {},
): void {
  const pressDb = Math.min(0, options.pressDb ?? -5);
  const floorHz = Math.max(200, Math.min(20_000, options.floorHz ?? 1_500));
  if (!points.length || durSec <= 0) return;
  const at = (p: number): number => Math.max(0, startSec + durSec * Math.max(0, Math.min(1, p)));
  const gainOf = (drive: number): number => Math.max(0.05, 10 ** ((pressDb * drive) / 20));
  const hzOf = (drive: number): number => 20_000 + (floorHz - 20_000) * Math.max(0, Math.min(1, drive));
  try {
    deck.aPress.gain.cancelScheduledValues(startSec);
    deck.aDarken.frequency.cancelScheduledValues(startSec);
    deck.aPress.gain.setValueAtTime(1, Math.max(0, startSec));
    deck.aDarken.frequency.setValueAtTime(20_000, Math.max(0, startSec));
    // 回正必须留出一段真斜坡。`risingPressure` 的尾巴会把 `p≈1` 的点也带进来，
    // 若最后一条 ramp 和 `at(1)` 落在同一时刻，WebAudio 看到的是「0 时长阶跃」：
    // 低通从 6 kHz 一步弹回 20 kHz、压音量一步回到 0 dB ——
    // 听感就是过渡完成的那一瞬间，之前被削掉的高音/电平「啪」地回来。
    // 所以最后 `releaseSec` 之内不再写压点，把它们夹到回正起点上，再线性放开。
    const releaseAt = at(1);
    const releaseSec = Math.min(0.45, Math.max(0.12, durSec * 0.12));
    const clampUntil = Math.max(startSec, releaseAt - releaseSec);
    let lastDrive = 0;
    for (const point of points) {
      const drive = Math.max(0, Math.min(1, point.drive));
      if (Math.abs(drive - lastDrive) < 0.02) continue;
      lastDrive = drive;
      const t = Math.min(at(point.p), clampUntil);
      deck.aPress.gain.linearRampToValueAtTime(gainOf(drive), t);
      deck.aDarken.frequency.linearRampToValueAtTime(hzOf(drive), t);
    }
    deck.aPress.gain.linearRampToValueAtTime(1, releaseAt);
    deck.aDarken.frequency.linearRampToValueAtTime(20_000, releaseAt);
  } catch {
    deck.aPress.gain.value = 1;
    deck.aDarken.frequency.value = 20_000;
  }
}

export function scheduleAutomixV2Hall(
  deck: AutomixV2Deck,
  startSec: number,
  durSec: number,
  options: { sendDb?: number; fromP?: number; attackP?: number; releaseP?: number; tailMs?: number } = {},
): void {
  const sendDb = options.sendDb ?? -22;
  const fromP = Math.max(0.5, Math.min(0.85, options.fromP ?? 0.5));
  const attackP = Math.max(0.15, Math.min(0.85, options.attackP ?? 0.55));
  const releaseP = Math.max(fromP + attackP + 0.02, Math.min(0.98, options.releaseP ?? fromP + attackP));
  const tailMs = Math.max(600, options.tailMs ?? Math.min(2600, Math.max(1200, durSec * 1000 * 0.18)));
  const start = Math.max(0, startSec + durSec * fromP);
  const peakAt = Math.max(start + 0.05, startSec + durSec * releaseP);
  const peak = Math.max(0, Math.min(2, 10 ** (sendDb / 20)));
  const endSec = startSec + durSec;
  const tailSec = tailMs / 1000;
  try {
    deck.hallSend.gain.cancelScheduledValues(startSec);
    deck.hallGain.gain.cancelScheduledValues(startSec);
    // 返回电平固定（空间大小不变），靠送出量控制「进来多少」。
    deck.hallGain.gain.setValueAtTime(1, Math.max(0, startSec));
    deck.hallSend.gain.setValueAtTime(0, Math.max(0, startSec));
    // 慢起：用平方曲线逼近人耳对混响密度的感知，前 1/3 段落几乎听不出来。
    deck.hallSend.gain.linearRampToValueAtTime(peak * 0.18, start + (peakAt - start) * 0.35);
    deck.hallSend.gain.linearRampToValueAtTime(peak * 0.55, start + (peakAt - start) * 0.7);
    deck.hallSend.gain.linearRampToValueAtTime(peak, peakAt);
    deck.hallSend.gain.setValueAtTime(peak, Math.max(peakAt + 0.01, endSec));
    deck.hallSend.gain.exponentialRampToValueAtTime(Math.max(0.0005, peak * 0.01), endSec + tailSec);
    deck.hallSend.gain.linearRampToValueAtTime(0, endSec + tailSec + 0.08);
  } catch {
    deck.hallSend.gain.value = peak;
  }
}

/** B 专用：湿声只取 300 Hz 以上（低音保持干声），并给湿声留一条可被 duck 的增益。 */
export function setWetHighpass(deck: AutomixV2Deck, hz: number): void {
  const f = Math.max(20, Math.min(4_000, hz));
  try { deck.wetHp.frequency.setTargetAtTime(f, deck.wetHp.context.currentTime, 0.02); } catch { /* 老 deck */ }
}

/**
 * 过渡前段「B 在混响里」的湿声包络：50% 起送，80% 前保持，之后在 92% 之前收干。
 * 与 scheduleAutomixV2Reverb 相比，它显式保证「80% 前湿、80% 后干」。
 */
export function scheduleAutomixV2WetBed(
  deck: AutomixV2Deck,
  startSec: number,
  durSec: number,
  options: { sendDb?: number; returnDb?: number; fromP?: number; dryAtP?: number; endDb?: number } = {},
): void {
  const sendDb = Math.max(-30, Math.min(-2, options.sendDb ?? -5));
  const ret = Math.pow(10, Math.max(-6, Math.min(9, options.returnDb ?? 5)) / 20);
  const fromP = Math.max(0.35, Math.min(0.85, options.fromP ?? 0.5));
  const dryAtP = Math.max(fromP + 0.05, Math.min(0.95, options.dryAtP ?? 0.8));
  const endDb = Math.min(-18, options.endDb ?? -30);
  const start = startSec + durSec * fromP;
  const dry = startSec + durSec * dryAtP;
  const end = startSec + durSec * 0.97;
  const peak = 10 ** (sendDb / 20);
  const endGain = 10 ** (endDb / 20);
  try {
    const send = deck.reverbSend.gain;
    const retGain = deck.reverbGain.gain;
    send.cancelScheduledValues(startSec);
    retGain.cancelScheduledValues(startSec);
    send.setValueAtTime(0, Math.max(0, startSec));
    send.linearRampToValueAtTime(peak, start);
    send.setValueAtTime(peak, dry);
    send.exponentialRampToValueAtTime(Math.max(1e-4, endGain), Math.max(dry + 0.05, end));
    retGain.setValueAtTime(0, Math.max(0, startSec));
    retGain.linearRampToValueAtTime(ret, start);
    retGain.setValueAtTime(ret, dry);
    retGain.linearRampToValueAtTime(0, Math.max(dry + 0.05, end));
  } catch {
    deck.reverbSend.gain.value = peak;
    deck.reverbGain.gain.value = ret;
  }
}

/** 湿声让位：B 自己唱的时候把湿声压下去，保证人声是干的。 */
export function scheduleWetDuck(
  deck: AutomixV2Deck,
  startSec: number,
  durSec: number,
  points: readonly { p: number; db: number }[],
): void {
  if (!points.length || !(durSec > 0)) return;
  const g = deck.wetDuck.gain;
  try {
    g.cancelScheduledValues(startSec);
    g.setValueAtTime(1, Math.max(0, startSec));
    for (const pt of points) {
      const at = startSec + Math.max(0, Math.min(1, pt.p)) * durSec;
      g.setTargetAtTime(10 ** (Math.max(-12, Math.min(0, pt.db)) / 20), at, 0.045);
    }
    g.setTargetAtTime(1, startSec + durSec * 0.98, 0.08);
  } catch { /* 忽略 */ }
}

export function scheduleAutomixV2Reverb(
  deck: AutomixV2Deck,
  startSec: number,
  durSec: number,
  options: { sendDb?: number; returnDb?: number; fromP?: number; tailMs?: number } = {},
): void {
  const sendDb = Math.min(-6, options.sendDb ?? -9);
  const returnDb = options.returnDb ?? 8;
  // 用户口径：混响/声场在过渡 50% 之后才从 0 开始，之前一点不送。
  const fromP = Math.max(0.5, Math.min(0.92, options.fromP ?? 0.5));
  // 尾巴长度：过渡完成后还要响一段才自然收掉；按窗口长度缩放，1.2–2.2 s。
  const tailMs = Math.max(600, options.tailMs ?? Math.min(2200, Math.max(1200, durSec * 1000 * 0.12)));
  const start = Math.max(0, startSec + durSec * fromP);
  const peak = Math.max(0, Math.min(2, 10 ** (sendDb / 20)));
  const ret = Math.max(0, Math.min(3, 10 ** (returnDb / 20)));
  const endSec = startSec + durSec;
  const tailSec = tailMs / 1000;
  try {
    deck.reverbGain.gain.cancelScheduledValues(startSec);
    deck.reverbSend.gain.cancelScheduledValues(startSec);
    deck.reverbGain.gain.setValueAtTime(ret, Math.max(0, startSec));
    deck.reverbSend.gain.setValueAtTime(0, Math.max(0, startSec));
    // 从 0 平滑爬升：先到 40% 目标（避免 50% 处一个台阶），再在窗口末端到目标量。
    const riseSec = Math.max(0.35, (endSec - start) * 0.35);
    deck.reverbSend.gain.setValueAtTime(0, Math.max(0, startSec));
    deck.reverbSend.gain.linearRampToValueAtTime(peak * 0.4, start + riseSec * 0.5);
    deck.reverbSend.gain.linearRampToValueAtTime(peak, Math.min(endSec, start + riseSec));
    deck.reverbSend.gain.setValueAtTime(peak, endSec + 0.01);
    deck.reverbSend.gain.exponentialRampToValueAtTime(Math.max(0.0005, peak * 0.004), endSec + tailSec);
    deck.reverbSend.gain.linearRampToValueAtTime(0, endSec + tailSec + 0.05);
  } catch {
    deck.reverbSend.gain.value = peak;
    deck.reverbGain.gain.value = ret;
  }
}

/**
 * 排一条尾段回声：送出在窗口后段爬升，延迟按拍对齐，窗口结束后 dB 线性收干。
 * 反馈链固定 `echoDelay → echoDamp → echoFeedback → echoDelay`，阻尼越短尾巴越暗。
 */
export function scheduleAutomixV2Echo(
  deck: AutomixV2Deck,
  startSec: number,
  durationSec: number,
  plan: { delayMs: number; feedback: number; outDb: number; dampHz: number; tailMs: number; sendFromP: number },
): void {
  const ctx = deck.echoSend.context;
  const now = ctx.currentTime;
  const start = Math.max(now, startSec);
  const end = start + Math.max(0.05, durationSec);
  // 回声同属声场：50% 前不送，从 0 起。
  const sendFrom = start + Math.max(0.5, Math.min(0.9, plan.sendFromP)) * (end - start);
  const outGain = Math.pow(10, Math.max(-24, Math.min(0, plan.outDb)) / 20);
  try {
    deck.echoDelay.delayTime.cancelScheduledValues(now);
    deck.echoDelay.delayTime.setValueAtTime(Math.max(0.02, Math.min(1.9, plan.delayMs / 1000)), now);
    deck.echoFeedback.gain.cancelScheduledValues(now);
    deck.echoFeedback.gain.setValueAtTime(Math.max(0, Math.min(0.7, plan.feedback)), now);
    deck.echoDamp.frequency.cancelScheduledValues(now);
    deck.echoDamp.frequency.setValueAtTime(Math.max(1200, Math.min(12000, plan.dampHz)), now);
    const send = deck.echoSend.gain;
    send.cancelScheduledValues(now);
    send.setValueAtTime(sendFrom > now ? 0 : 0.0001, now);
    if (sendFrom > now) send.setValueAtTime(0.0001, sendFrom);
    send.linearRampToValueAtTime(1, end);
    send.linearRampToValueAtTime(0.0001, end + Math.max(0.2, plan.tailMs / 1000));
    const out = deck.echoOut.gain;
    out.cancelScheduledValues(now);
    out.setValueAtTime(outGain, now);
    out.setValueAtTime(outGain, end);
    out.linearRampToValueAtTime(0.0001, end + Math.max(0.3, plan.tailMs / 1000) + 0.2);
  } catch {
    /* 排程失败就当没有回声，不影响主路 */
  }
}

/**
 * 窗口结束后把 A 剩下的高频收干（A 的长尾巴当乐器铺在 B 底下时用）。
 *
 * 曲线在窗口末停在 `aTailHold` 上，这里从那个电平指数衰减到 −80 dB。
 * 低频不再处理：换手结束时 A 的低频本来就是 0。
 */
/**
 * 过渡结束时的「余响释放」：混响/回声不是断头台。
 *   直接把整条链 disconnect 会把 return 从当前值一步砍到 0，
 *   听感就是「过渡一结束混响啪没了」。这里先把两条 return 指数收到 0，
 *   调用方再延迟 dispose（默认 ~1 s），尾巴自己走完。
 */
export function releaseAutomixV2Tail(deck: AutomixV2Deck, seconds = 0.95): void {
  const now = deck.reverbGain.context.currentTime;
  const tau = Math.max(0.12, seconds / 3);
  try {
    deck.reverbGain.gain.setTargetAtTime(0, now, tau);
    deck.echoOut.gain.setTargetAtTime(0, now, tau);
  } catch {
    /* 参数已排空时忽略 */
  }
}

/**
 * 过渡收尾的「链上放平」：把还挂在节点上的过渡状态用一段真斜坡送回中性。
 *
 * 为什么必须有：`tap.restore()` 是 0 时长的旁路（gate/input 直接 disconnect，
 * 元素 gain 一步接回干路）。链上只要还剩一点扫频、压音、让位、风格 EQ，
 * 这一步就会把「过渡期间被削掉的部分」一次性弹回来 —— 听感是过渡结束的瞬间
 * 高音/电平突然恢复，像是有一个压低声音的东西凭空消失。
 *
 * 曲线正常排完时这里基本是空操作（参数本来就在中性位）；
 * 真正救的是三种收尾：手动取消、图被激活时的硬切、以及进度与曲线差几十毫秒的收尾。
 */
export function relaxAutomixV2Chain(deck: AutomixV2Deck, seconds = 0.18, continuing = false): void {
  const ctx = deck.sweepLp.context;
  const now = Math.max(0, ctx.currentTime);
  const end = now + Math.max(0.02, seconds);
  const glide = (param: AudioParam, target: number): void => {
    try {
      if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(now);
      else {
        const held = param.value;
        param.cancelScheduledValues(now);
        param.setValueAtTime(held, now);
      }
      param.linearRampToValueAtTime(target, end);
    } catch {
      /* 参数已排空 / 上下文已关闭时忽略 */
    }
  };
  glide(deck.sweepLp.frequency, ctx.sampleRate / 2);
  glide(deck.sweepHp.frequency, 0);
  glide(deck.duck.gain, 0);
  glide(deck.aPress.gain, 1);
  glide(deck.aDarken.frequency, ctx.sampleRate / 2);
  if (continuing) {
    glide(deck.lowGain.gain, 1);
    glide(deck.midGain.gain, 1);
    glide(deck.highGain.gain, 1);
    glide(deck.lowTrim.gain, 1);
  }
  glide(deck.loudnessTrim.gain, 1);
  glide(deck.bTrim.gain, 1);
  glide(deck.unfade.gain, 1);
  glide(deck.aStyleHigh.gain, 0);
  glide(deck.aStylePresence.gain, 0);
  glide(deck.bStyleHigh.gain, 0);
  glide(deck.bStylePresence.gain, 0);
  glide(deck.bStyleLow.gain, 0);
}

export function scheduleAutomixV2TailBleed(
  deck: AutomixV2Deck,
  atSec: number,
  bleedSec: number,
  hold: number,
): void {
  const ctx = deck.highGain.context;
  const now = ctx.currentTime;
  const at = Math.max(now, atSec);
  const dur = Math.max(0.15, bleedSec);
  const from = Math.max(0.0001, Math.min(0.4, hold));
  try {
    const g = deck.highGain.gain;
    // 先掐掉上一段自动化再排：A 的长尾常常排在本窗口之后，
    // 若此时又开了一次过渡，旧的 `exponentialRampToValueAtTime` 会和新曲线抢同一个参数，
    // 结果是从旧目标值直接跳过来（听感是「咔」一下），不是从当前值平滑接上。
    if (typeof g.cancelAndHoldAtTime === 'function') g.cancelAndHoldAtTime(at);
    else g.cancelScheduledValues(at);
    // cancelAndHold 之后参数停在当前值；指数斜坡不能从 0 起，先垫到最小值。
    const held = (g as AudioParam & { value?: number }).value ?? from;
    if (!(held > 0.0002)) {
      g.setValueAtTime(0.0002, at);
    }
    g.exponentialRampToValueAtTime(0.0001, at + dur);
  } catch {
    /* 排程失败就当没有尾巴 */
  }
}

/**
 * 响度补平：把窗口内合成响度的塌陷按曲线反补回来。
 *
 * `points` 是窗口内的相对位置（0–1）与要补的 dB（≥0）。采样点之间用线性斜坡，
 * 不做指数——响度是 dB 量，指数斜坡会在两头过冲。
 */
export function scheduleLoudnessTrim(
  deck: AutomixV2Deck,
  startSec: number,
  durationSec: number,
  points: { p: number; db: number }[],
): void {
  if (!points.length || !(durationSec > 0)) return;
  const param = deck.loudnessTrim.gain;
  const at = (p: number): number => startSec + Math.max(0, Math.min(1, p)) * durationSec;
  try {
    param.cancelScheduledValues(startSec);
    // 起手必须是 0 dB：曲线首点常常已经有 +1…3 dB，直接 setValueAtTime
    // 就是「一进过渡 A 瞬间被抬高一点」的来源。改成从 0 dB 用 lead-in 缓上来。
    const leadSec = Math.max(0.6, Math.min(2.5, durationSec * 0.12));
    param.setValueAtTime(1, startSec);
    let ramped = false;
    for (let i = 0; i < points.length; i += 1) {
      const t = at(points[i].p);
      const gain = 10 ** (points[i].db / 20);
      if (t <= startSec + leadSec) continue;
      if (!ramped) {
        param.linearRampToValueAtTime(gain, startSec + leadSec);
        ramped = true;
      }
      param.linearRampToValueAtTime(gain, t);
    }
  } catch {
    /* 调度失败不影响主链 */
  }
}
