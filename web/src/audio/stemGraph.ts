/**
 * 4 轨音频图（Performer 的执行层）。
 *
 * 结构（每个 deck 一套，**每轨一个独立入口**）：
 *
 *   src(bass)   ─► in(bass)  ─► gain(bass)  ─┐
 *   src(drums)  ─► in(drums) ─► gain(drums) ─┤
 *   src(other)  ─► in(other) ─► gain(other) ─┼─► bus ─► hpf ─► lpf ─► duck ─► destination
 *   src(vocals) ─► in(vocals)─► gain(vocals)─┘        │
 *                                  └─► echoSend ─► delay ─► damp ─► feedback ↺
 *                                                        └─► destination
 *
 * 为什么要「每轨独立入口」：早期版本只有一个 `input`，四路 gain 并联在同一入口上，
 * `scheduleCurve('bass')` 与 `scheduleCurve('drums')` 实际调的是同一路混合声的不同音量，
 * 分轨换手名存实亡。`input` 现在只作为「整轨混合」兼容口保留，新代码一律用
 * `inputOf(stem)` / `connectSource(stem, node)`。
 *
 * 所有时间推进都走 `AudioParam.setValueCurveAtTime / linearRampToValueAtTime`，
 * **禁止 setTimeout**：主线程卡一下就会跑偏，而 AudioParam 在音频线程按采样执行。
 *
 * 这一层只在进阶模式（`TransitionMode === 'advanced'`）里构建；标准模式根本不 new。
 */

import type { DeckId, ScheduledEvent } from '../core/stemSwap';
import type { Stem } from '../core/transitionPlan';
import { ECHO } from '../core/djMoves';

export interface StemGraphOptions {
  /** 参与路由的轨；默认四轨全开。 */
  stems?: Stem[];
  /** 回声总线参数，默认取 `ECHO`；`delayTimeSec` 不给时用 0.5 s，接入方按 BPM 调 `setEchoTime`。 */
  echo?: { feedback: number; dampHz: number; delayTimeSec?: number };
  /** 事件起点早于当前时间多少秒以内仍允许排程（见 `applyAll`）。 */
  pastToleranceSec?: number;
  /**
   * 减法模式：分轨不再相加，而是从原混音里**减掉**（`gain=1` 表示这一轨被完全切除）。
   * 接线方式变为「元素（mix）→ `connectMix` → bus，四轨经 −1 反相器进 bus」。
   * 这样未被切掉的声部走的是原始混音，相位/瞬态无损——正是 DJUCED 听感好的原因。
   */
  subtractive?: boolean;
}

export const STEM_ORDER: readonly Stem[] = ['drums', 'bass', 'other', 'vocals'];

export class DeckStemBus {
  readonly deck: DeckId;
  /** 兼容口：把「整轨混合」接到这里等价于四路同源，老代码仍可用。 */
  readonly input: GainNode;
  private readonly ctx: AudioContext;
  private readonly stems: Stem[];
  private readonly stemIn = new Map<Stem, GainNode>();
  private readonly stemGain = new Map<Stem, GainNode>();
  private readonly stemDuck = new Map<Stem, GainNode>();
  /** 减法模式下的 −1 反相器：mix + Σ(−g·stem)。 */
  private readonly stemInvert = new Map<Stem, GainNode>();
  readonly subtractive: boolean;
  private readonly bus: GainNode;
  /** 滤波扫频用的高通：`filterBuild` 把 B 从 320 Hz 放回 18 kHz。 */
  private readonly hpf: BiquadFilterNode;
  /** 出场关门用的低通：`filterBuild` 把 A 从 20 kHz 收到 700 Hz。 */
  private readonly lpf: BiquadFilterNode;
  private readonly duck: GainNode;
  private readonly echoSend: GainNode;
  private readonly delay: DelayNode;
  private readonly damp: BiquadFilterNode;
  private readonly feedback: GainNode;
  /** 各参数最近排过的自动化点（时间, 值），供 `hold()` 兜底路径插值用。 */
  private readonly points = new WeakMap<AudioParam, { t: number; v: number }[]>();
  /** 四轨静态电平（面板滑杆）：只作为起始值参与，过渡曲线仍按计划走。 */
  private readonly trim: Record<Stem, number> = { drums: 1, bass: 1, other: 1, vocals: 1 };
  private disposed = false;

  constructor(ctx: AudioContext, deck: DeckId, destination: AudioNode, options: StemGraphOptions = {}) {
    this.ctx = ctx;
    this.deck = deck;
    this.stems = options.stems ?? [...STEM_ORDER];
    this.subtractive = options.subtractive === true;
    const echo = options.echo ?? { feedback: ECHO.feedback, dampHz: ECHO.dampHz };

    this.input = ctx.createGain();
    this.bus = ctx.createGain();
    this.hpf = ctx.createBiquadFilter();
    this.hpf.type = 'highpass';
    this.hpf.frequency.value = 20;
    this.hpf.Q.value = 0.707;
    this.lpf = ctx.createBiquadFilter();
    this.lpf.type = 'lowpass';
    this.lpf.frequency.value = 20000;
    this.lpf.Q.value = 0.707;
    this.duck = ctx.createGain();
    this.echoSend = ctx.createGain();
    this.echoSend.gain.value = 0;

    this.delay = ctx.createDelay(4);
    this.delay.delayTime.value = echo.delayTimeSec ?? 0.5;
    this.damp = ctx.createBiquadFilter();
    this.damp.type = 'lowpass';
    this.damp.frequency.value = echo.dampHz;
    this.feedback = ctx.createGain();
    this.feedback.gain.value = Math.max(0, Math.min(0.45, echo.feedback));

    for (const stem of this.stems) {
      const inNode = ctx.createGain();
      const gain = ctx.createGain();
      const duck = ctx.createGain();
      gain.gain.value = 1;
      duck.gain.value = 1;
      inNode.connect(gain);
      // 每轨一条 duck：人声换手时只躲人声，不该把整条 deck 的低频一起压低。
      gain.connect(duck);
      if (this.subtractive) {
        // 减法模式：分轨经 −1 反相后进 bus，输出 = mix − Σ(g·stem)。
        const invert = ctx.createGain();
        invert.gain.value = -1;
        duck.connect(invert);
        invert.connect(this.bus);
        this.stemInvert.set(stem, invert);
      } else {
        duck.connect(this.bus);
      }
      // 兼容口：整轨混合同时喂四路（等价于四路同源）。
      this.input.connect(inNode);
      this.stemIn.set(stem, inNode);
      this.stemGain.set(stem, gain);
      this.stemDuck.set(stem, duck);
      if (stem === 'vocals') gain.connect(this.echoSend);
    }

    this.bus.connect(this.hpf);
    this.hpf.connect(this.lpf);
    this.lpf.connect(this.duck);
    this.duck.connect(destination);

    // 回声总线：send → delay → damp → destination，并用 feedback 环回。
    this.echoSend.connect(this.delay);
    this.delay.connect(this.damp);
    this.damp.connect(this.feedback);
    this.feedback.connect(this.delay);
    this.damp.connect(destination);
  }

  get stemOrder(): readonly Stem[] {
    return this.stems;
  }

  /** 每轨独立入口：把该轨的播放节点接到这里。 */
  inputOf(stem: Stem): GainNode {
    const node = this.stemIn.get(stem);
    if (!node) throw new Error(`stem 未参与路由：${stem}`);
    return node;
  }

  /** 便捷方法：把一个音频节点接到指定的分轨。 */
  connectSource(stem: Stem, node: AudioNode): void {
    node.connect(this.inputOf(stem));
  }

  /**
   * 减法模式专用：把**原混音**（通常是 `<audio>` 的 MediaElementSource）接到 bus。
   * 输出 = mix − Σ(g·stem)。非减法模式下调用它等于把整轨混音又加一遍，别这么用。
   */
  connectMix(node: AudioNode): void {
    node.connect(this.bus);
  }

  /**
   * 面板滑杆：设定某轨的静态电平（0 = 该轨切掉，1 = 原样，>1 推响）。
   * 只影响「当前这一刻」的起点；随后的过渡曲线按计划继续走，不会打掉排好的自动化。
   */
  setStemGain(stem: Stem, value: number): void {
    const v = Number.isFinite(value) ? Math.min(1.5, Math.max(0, value)) : 1;
    this.trim[stem] = v;
    const gain = this.stemGain.get(stem);
    if (!gain) return;
    const now = this.ctx.currentTime;
    const target = this.subtractive ? v - 1 : v;
    try {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(target, now);
    } catch {
      /* 忽略：参数不可写就算了 */
    }
  }

  /** 某一路的增益节点（测试与调试用，比返回值更直接）。 */
  gainOf(stem: Stem): GainNode | undefined {
    return this.stemGain.get(stem);
  }

  /**
   * 设定这条 deck 的「起播电平」：出场 deck 1.0、进场 deck 0.0。
   *
   * 必须在第一条 gainCurve 之前调用——否则进场 deck 在自己的换手窗口到来前
   * 一直保持默认 1.0，听感就是「两首歌一起播」。
   */
  resetGains(value: number): void {
    if (this.disposed) return;
    const g = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
    // 减法模式：g=1 表示「该轨在场」⇒ 不减（写 0）；g=0 ⇒ 整条减掉（写 −1）。
    const v = this.subtractive ? g - 1 : g;
    const at = this.ctx.currentTime;
    for (const node of this.stemGain.values()) {
      try {
        node.gain.cancelScheduledValues(at);
        node.gain.setValueAtTime(v, at);
      } catch {
        /* 节点已拆：忽略 */
      }
    }
  }

  /** 设置回声延迟时间（秒）；随 BPM 变化时调用。 */
  setEchoTime(seconds: number): void {
    if (this.disposed) return;
    const clamped = Math.max(0.01, Math.min(4, seconds));
    this.delay.delayTime.setValueAtTime(clamped, this.ctx.currentTime);
  }

  /**
   * 取消已排程值并「保持当前值」。
   * 直接 `cancelScheduledValues` 会让参数立即回到该时间的默认值（可闻咔哒），
   * 优先用 `cancelAndHoldAtTime`；老浏览器不支持时退化为「算当前值 → setValueAtTime」。
   *
   * 兜底路径不能读 `param.value`：真浏览器实测（E18）它在自动化运行期间返回的是
   * **内在值**（本例 1.0），而曲线上此刻是 0.5 ⇒ 会凭空拉高 +6 dB。
   * 所以自己记账（{@link recordPoints}），按时间线性插值算出该时刻的真实值。
   */
  private hold(param: AudioParam, atTime: number): void {
    const withHold = param as AudioParam & { cancelAndHoldAtTime?: (t: number) => void };
    if (typeof withHold.cancelAndHoldAtTime === 'function') {
      withHold.cancelAndHoldAtTime(atTime);
      return;
    }
    const current = this.valueAt(param, atTime);
    param.cancelScheduledValues(atTime);
    param.setValueAtTime(current, atTime);
  }

  /** 记录自动化目标点，供兜底路径按时间插值（保留最近 128 个点 / 5 s）。 */
  private recordPoints(param: AudioParam, points: { t: number; v: number }[]): void {
    const kept = (this.points.get(param) ?? []).concat(points);
    const cutoff = this.ctx.currentTime - 5;
    this.points.set(param, kept.filter((p) => p.t >= cutoff).slice(-128));
  }

  /** 参数在 `atTime` 时刻的值：优先用自己记的自动化点线性插值。 */
  private valueAt(param: AudioParam, atTime: number): number {
    const arr = this.points.get(param);
    if (!arr || arr.length === 0) return param.value;
    let prev = arr[0];
    let next: { t: number; v: number } | null = null;
    for (const p of arr) {
      if (p.t <= atTime) prev = p;
      else { next = p; break; }
    }
    if (!next || next.t <= prev.t) return prev.v;
    const k = (atTime - prev.t) / (next.t - prev.t);
    return prev.v + (next.v - prev.v) * Math.max(0, Math.min(1, k));
  }

  /**
   * 按曲线调度某一路增益（时间为 `ctx.currentTime` 基准的绝对值）。
   *
   * **用 32 段 `linearRampToValueAtTime`，不用 `setValueCurveAtTime`**：
   * 真浏览器实测（E18）发现，曲线事件跑到一半时若走兜底路径
   * `cancelScheduledValues(t)`，Chrome 会把这个**从 0.2 s 起**的曲线事件整条移除，
   * 于是 0.2 s 之后的输出直接跳回默认增益（实测 +5.2 dB 阶跃，且发生在打断点之前）。
   * 换成若干 ramp 后：插值结果与曲线逐点线性插值完全一致（曲线本来就是线性插值），
   * 而 `cancelScheduledValues(t)` 只摘掉 t 之后的目标点，已过去的包络不受影响。
   */
  scheduleCurve(stem: Stem, curve: number[], atTime: number, durationSec: number): void {
    const node = this.stemGain.get(stem);
    if (!node || this.disposed || curve.length === 0) return;
    // 减法模式下同一条曲线含义翻转：g=1（该轨「在场」）→ 写入 0（不减），
    // g=0（该轨被换出）→ 写入 −1（把这条从混音里整条减掉）。
    const mapped = this.subtractive ? curve.map((g) => g - 1) : curve;
    const param = node.gain;
    this.hold(param, atTime);
    const span = Math.max(0.001, durationSec);
    if (mapped.length === 1) {
      param.setValueAtTime(mapped[0], atTime);
      return;
    }
    const pts = mapped.map((v, i) => ({ t: atTime + (span * i) / (mapped.length - 1), v }));
    this.recordPoints(param, pts);
    param.setValueAtTime(mapped[0], atTime);
    for (let i = 1; i < mapped.length; i += 1) {
      param.linearRampToValueAtTime(mapped[i], pts[i].t);
    }
  }

  /** 回声干湿（0~1）。 */
  scheduleEchoSend(from: number, to: number, atTime: number, durationSec: number): void {
    if (this.disposed) return;
    const param = this.echoSend.gain;
    const span = Math.max(0.001, durationSec);
    this.hold(param, atTime);
    this.recordPoints(param, [{ t: atTime, v: from }, { t: atTime + span, v: to }]);
    param.setValueAtTime(from, atTime);
    param.linearRampToValueAtTime(to, atTime + span);
  }

  /** 侧链躲避：压到 `db` 再回到 1。起点用 hold 保持当前值，避免阶跃。 */
  scheduleDuck(db: number, atTime: number, durationSec: number, smoothSec = 0.005): void {
    if (this.disposed) return;
    const param = this.duck.gain;
    const linear = 10 ** (db / 20);
    const attack = Math.max(0.001, smoothSec);
    const peak = Math.max(attack, durationSec * 0.5);
    const end = Math.max(attack * 2, durationSec);
    this.hold(param, atTime);
    this.recordPoints(param, [
      { t: atTime, v: this.valueAt(param, atTime) },
      { t: atTime + attack, v: linear },
      { t: atTime + peak, v: linear },
      { t: atTime + end, v: 1 },
    ]);
    param.linearRampToValueAtTime(linear, atTime + attack);
    param.setValueAtTime(linear, atTime + peak);
    param.linearRampToValueAtTime(1, atTime + end);
  }

  /** 单轨躲避：只压这条分轨（人声换手时用），不影响其它轨。 */
  scheduleStemDuck(stem: Stem, db: number, atTime: number, durationSec: number, smoothSec = 0.005): void {
    if (this.disposed) return;
    const node = this.stemDuck.get(stem);
    if (!node) return;
    const param = node.gain;
    const linear = 10 ** (db / 20);
    const attack = Math.max(0.001, smoothSec);
    const peak = Math.max(attack, durationSec * 0.5);
    const end = Math.max(attack * 2, durationSec);
    this.hold(param, atTime);
    this.recordPoints(param, [
      { t: atTime, v: this.valueAt(param, atTime) },
      { t: atTime + attack, v: linear },
      { t: atTime + peak, v: linear },
      { t: atTime + end, v: 1 },
    ]);
    param.linearRampToValueAtTime(linear, atTime + attack);
    param.setValueAtTime(linear, atTime + peak);
    param.linearRampToValueAtTime(1, atTime + end);
  }

  /**
   * 滤波扫频：把该 deck 的高通从 `fromHz` 推到 `toHz`。
   *
   * 频率用**指数**斜坡：听感上「从闷到亮」是等比的，线性斜坡前 1/3 就冲到 6 kHz，
   * 后面几乎听不出变化。指数斜坡要求两端都 > 0（这里夹到 20–20000 Hz）。
   */
  private scheduleFilterSweep(
    band: 'highpass' | 'lowpass',
    fromHz: number,
    toHz: number,
    atTime: number,
    durationSec: number,
  ): void {
    const filter = band === 'lowpass' ? this.lpf : this.hpf;
    const param = filter.frequency;
    const clampHz = (hz: number) => Math.max(20, Math.min(20000, Number.isFinite(hz) ? hz : 20));
    // 起点必须是 `fromHz` 而不是「当前值」：高通默认 20 Hz（等于全开），
    // 若按当前值起扫，B 从第一拍就是全开，扫频等于没发生。
    this.hold(param, atTime);
    const from = clampHz(fromHz);
    const to = clampHz(toHz);
    param.setValueAtTime(from, atTime);
    this.recordPoints(param, [
      { t: atTime, v: from },
      { t: atTime + durationSec, v: to },
    ]);
    param.exponentialRampToValueAtTime(to, atTime + durationSec);
  }

  /** 执行一条调度事件；`startTimeSec` 是过渡起点的绝对时间。 */
  apply(event: ScheduledEvent, startTimeSec: number): void {
    const at = startTimeSec + event.atMs / 1000;
    const dur = Math.max(0.001, event.durationMs / 1000);
    switch (event.kind) {
      case 'gainCurve':
        this.scheduleCurve(event.stem, event.curve, at, dur);
        break;
      case 'delaySend':
        this.scheduleEchoSend(event.from, event.to, at, dur);
        break;
      case 'filter':
        this.scheduleFilterSweep(event.band === 'lowpass' ? 'lowpass' : 'highpass', event.fromHz, event.toHz, at, dur);
        break;
      case 'duck':
        if (event.stem) this.scheduleStemDuck(event.stem, event.db, at, dur, event.attackMs / 1000);
        else this.scheduleDuck(event.db, at, dur, event.attackMs / 1000);
        break;
    }
  }

  /** 拆图：断开所有连接并停掉反馈环。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.feedback.gain.value = 0;
    for (const node of [this.input, this.bus, this.hpf, this.lpf, this.duck, this.echoSend, this.delay, this.damp, this.feedback]) {
      try { node.disconnect(); } catch { /* 已断开 */ }
    }
    for (const node of [...this.stemIn.values(), ...this.stemGain.values(), ...this.stemDuck.values(), ...this.stemInvert.values()]) {
      try { node.disconnect(); } catch { /* 已断开 */ }
    }
    this.stemIn.clear();
    this.stemGain.clear();
    this.stemDuck.clear();
    this.stemInvert.clear();
  }
}

/** 双 deck 的一套图：A 出场、B 进场。 */
export class StemGraph {
  readonly a: DeckStemBus;
  readonly b: DeckStemBus;
  private readonly ctx: AudioContext;
  private readonly pastToleranceSec: number;

  constructor(ctx: AudioContext, destination: AudioNode, options: StemGraphOptions = {}) {
    this.ctx = ctx;
    this.pastToleranceSec = options.pastToleranceSec ?? 0.05;
    this.a = new DeckStemBus(ctx, 'A', destination, options);
    this.b = new DeckStemBus(ctx, 'B', destination, options);
  }

  bus(deck: DeckId): DeckStemBus {
    return deck === 'A' ? this.a : this.b;
  }

  /** 起播电平：A 满、B 静音（见 `DeckStemBus.resetGains`）。 */
  resetDeckGains(deck: DeckId, value: number): void {
    this.bus(deck).resetGains(value);
  }

  /**
   * 把事件列表整体排进去。
   * 起点早于当前时间（超过容差）时整批丢弃并返回 false：
   * 排到过去会让所有曲线立即生效，等于瞬间切歌。
   */
  applyAll(events: ScheduledEvent[], startTimeSec: number): boolean {
    if (!Number.isFinite(startTimeSec)) {
      console.warn('[stemGraph] 事件起点不是有限值，整批丢弃', { startTimeSec });
      return false;
    }
    if (startTimeSec < this.ctx.currentTime - this.pastToleranceSec) {
      console.warn('[stemGraph] 事件起点早于当前时间，整批丢弃', { startTimeSec, now: this.ctx.currentTime });
      return false;
    }
    for (const event of events) this.bus(event.deck).apply(event, startTimeSec);
    return true;
  }

  dispose(): void {
    this.a.dispose();
    this.b.dispose();
  }
}
