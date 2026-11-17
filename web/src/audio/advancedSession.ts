/**
 * 进阶过渡的「会话」（WBS v2 §4 / T4 的可测内核）。
 *
 * 一个会话 = 一次过渡期间占用两条 deck 的四轨播放器 + 一张 StemGraph。
 * 它只做三件事，且全部可注入替身，便于在 node 里测：
 *
 *   1. **接管**：把两个 deck 的元素音量降到 0（不 pause，保住 currentTime），
 *      建图、加载四轨、在同一个 `when` 上启动；
 *   2. **排程**：`graph.applyAll(events, when)` 把曲线一次性交给音频时钟；
 *   3. **交还**：`cancel()` 停播放器、拆图，并用 20 ms 斜坡把元素音量还回去
 *      （G2：回退不许有咔哒；直接赋值会有一个阶跃）。
 *
 * 调用方（crossfadeDeck）只需要：
 *
 *   const session = await AdvancedSession.begin({ ... });
 *   if (!session.active) { 走原 naturalGains }
 *   // 过渡结束或用户插手
 *   session.cancel();
 *
 * 注意：元素只静音、不暂停；`playbackRate` 仍由原逻辑控制（元素支路在静音时依旧走时间线，
 * 这样回退时位置是对得上的）。
 */

import type { ResolvedTransition } from '../core/advancedTransition';
import type { ScheduledEvent } from '../core/stemSwap';
import type { Stem } from '../core/transitionPlan';
import { ECHO, echoDelaySec } from '../core/djMoves';
import { StemGraph, type DeckStemBus } from './stemGraph';
import { lowBandCorrelation } from '../core/correlation';

/** 播放器替身接口（`StemPlayer` 满足它）。 */
export interface StemPlayerLike {
  /** 返回 false 表示这次没真的出声（窗口内无音频 / ctx 已关闭），调用方应回退。 */
  start(options: { positionSec: number; when?: number; rate?: number; gain?: number }): void | boolean;
  /** 运行中改速率（拍点锁相用）；实现可以是空操作，调用方不能依赖它一定生效。 */
  setRate?(rate: number): void;
  /** 还能放多少真实秒（实现可不提供；不提供时调用方不做兜底）。 */
  remainingSec?: number;
  /** 取该分轨前 N 个采样（左右平均），用于低频互相关测量；实现可不提供。 */
  monoSamples?(stem: Stem, maxSamples?: number): Float32Array | null;
  stop(): void;
  dispose(): void;
}

/** 音频图替身接口（`StemGraph` 满足它）。 */
export interface StemGraphLike {
  bus(deck: 'A' | 'B'): DeckStemBus;
  applyAll(events: ScheduledEvent[], startTimeSec: number): boolean;
  dispose(): void;
}

/** 一条 deck 的接管信息。 */
export interface DeckSource {
  /** 原 `<audio>` 元素；会话期间只改 `volume`，不动 `currentTime`/`playbackRate`。 */
  element: HTMLAudioElement;
  /** 淡出前的基础音量（回退时按它恢复）。 */
  baseVolume: number;
  /** 从 `positionSec` 开始加载四轨；失败应抛错（由会话统一回退）。 */
  load(positionSec: number): Promise<StemPlayerLike>;
  /** 该 deck 的当前文件内位置（秒）。 */
  positionSec: number;
  /**
   * 该 deck **元素**当前的 `playbackRate`（含用户倍速与 tempoRate）。
   * 分轨必须与元素同速，否则「元素时间」与「分轨时间」会分叉：
   * PLL 用元素 currentTime 算相位，用它去纠正分轨，纠正的却是另一条时间轴。
   */
  rate?: number;
}

export interface BeginInput {
  ctx: AudioContext;
  destination: AudioNode;
  resolved: ResolvedTransition;
  a: DeckSource;
  b: DeckSource;
  /** 启动时刻（`ctx.currentTime` 基准）；不给则「尽快」。 */
  when?: number;
  /** 回退斜坡时长（ms），默认 20。 */
  releaseMs?: number;
  /**
   * 加载完四轨后按实测低频互相关重排事件（可选）。
   * 返回 `null`/空事件表示「沿用原 events」——调用方可以放心地只在需要时替换。
   */
  replan?: (correlation: Partial<Record<Stem, number>>) => { events: ScheduledEvent[] } | null;
  /** 测试注入：建图与计时。 */
  createGraph?: (ctx: AudioContext, destination: AudioNode) => StemGraphLike;
  /**
   * 减法引擎（内部测试版）：元素保持可听，四轨只作为「从混音里减掉」的量。
   * `g=1` 表示该轨在场（不減）、`g=0` 表示整条切除，曲线语义不变。
   */
  subtractive?: boolean;
  /** 面板调参：回声反馈/阻尼/拍分音符（缺省 = 现有常量）。 */
  tuning?: { echoFeedback?: number; echoDampHz?: number; echoDivision?: number };
  now?: () => number;
}

const DEFAULT_RELEASE_MS = 20;

/** 四轨固定顺序（相关性测量用，与 `stemPlayer.FOUR_STEMS` 一致）。 */
const FOUR_STEMS: Stem[] = ['drums', 'bass', 'other', 'vocals'];

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export class AdvancedSession {
  private readonly input: BeginInput;
  private graph: StemGraphLike | null = null;
  private players: StemPlayerLike[] = [];
  /** A 当前速率（起始 = 元素速率，用户推 tempo 时同步）。 */
  private aRateValue = 0;
  /** B 当前速率（起始 = plan.rate，PLL 之后是微调值）。 */
  private bRateValue = 0;
  private events: ScheduledEvent[] = [];
  /** 最近一次实测的分轨低频互相关（诊断/UI 用）。 */
  private correlationValue: Partial<Record<Stem, number>> = {};
  private startTimeSec = 0;
  private released = false;

  private constructor(input: BeginInput) {
    this.input = input;
  }

  /** 会话是否真的接管了音频（false ⇒ 调用方必须走标准等功率路径）。 */
  get active(): boolean {
    return this.graph !== null;
  }

  /** 过渡起点在音频时钟上的绝对时间。 */
  get startAt(): number {
    return this.startTimeSec;
  }

  /**
   * 起会话。任何一步失败都会把元素音量恢复并返回 inactive 会话，**不抛异常**：
   * 过渡链路不允许把声音搞没。
   */
  static async begin(input: BeginInput): Promise<AdvancedSession> {
    const session = new AdvancedSession(input);
    const resolved = input.resolved;
    if (resolved.mode !== 'advanced' || !resolved.plan || !resolved.events.length) {
      return session;
    }

    const release = input.releaseMs ?? DEFAULT_RELEASE_MS;
    const aVolume = input.a.element.volume;
    const bVolume = input.b.element.volume;
    try {
      // 1) 接管：加法引擎把元素静音（不暂停）；减法引擎元素必须继续出声，只靠分轨做减法。
      const subtractive = input.subtractive === true;
      if (!subtractive) {
        input.a.element.volume = 0;
        input.b.element.volume = 0;
      }

      // 2) 建图 + 加载四轨。
      const tuning = input.tuning ?? {};
      const echoOptions = {
        ...(typeof tuning.echoFeedback === 'number' ? { feedback: tuning.echoFeedback } : {}),
        ...(typeof tuning.echoDampHz === 'number' ? { dampHz: tuning.echoDampHz } : {}),
      };
      const graphOptions = {
        ...(subtractive ? { subtractive: true } : {}),
        ...(Object.keys(echoOptions).length ? { echo: { feedback: ECHO.feedback, dampHz: ECHO.dampHz, ...echoOptions } } : {}),
      };
      const createGraph = input.createGraph ?? ((ctx, dest) => new StemGraph(ctx, dest, graphOptions));
      session.graph = createGraph(input.ctx, input.destination);
      const [playerA, playerB] = await Promise.all([
        input.a.load(input.a.positionSec),
        input.b.load(input.b.positionSec),
      ]);
      session.players = [playerA, playerB];

      // 2.5) 实测两条 deck 的低频互相关，按 ρ 决定 linear / equalPower 并重排事件。
      //      放在这里是因为只有解码之后才有采样；曲线选错会在换手中点掉或顶 3 dB。
      session.correlationValue = session.measureCorrelation(playerA, playerB);
      let scheduledEvents = resolved.events;
      if (input.replan) {
        try {
          const next = input.replan(session.correlationValue);
          if (next && next.events.length > 0) scheduledEvents = next.events;
        } catch (error) {
          console.warn('[advancedSession] 按相关度重排失败，沿用原事件', error);
        }
      }

      // 3) 回声时间跟拍：1/4 拍（`plan.beatMs` 是 A 的一拍）。
      const echoTime = echoDelaySec(60000 / Math.max(1, resolved.plan.beatMs), tuning.echoDivision);
      session.graph.bus('A').setEchoTime(echoTime);
      session.graph.bus('B').setEchoTime(echoTime);

      // 3.5) 起播电平：A 满、B 静音。
      //      缺这一步，B 在它自己的第一条曲线到来前一直是 1.0 —— 两首歌同时出声。
      const graph = session.graph as { resetDeckGains?: (deck: 'A' | 'B', value: number) => void };
      graph.resetDeckGains?.('A', 1);
      graph.resetDeckGains?.('B', 0);

      // 4) 同一时刻启动两条 deck，再一次性排曲线。
      const now = input.now ? input.now() : input.ctx.currentTime;
      session.startTimeSec = Math.max(now, input.when ?? now);
      // A 保持自己的速率（不参与 tempo 匹配），B 用元素当前速率（= 用户倍速 × tempoRate）。
      // 之前两边都塞 plan.rate：A 被无谓变速，且 A/B 之间反而差一个 rate 因子 → 整场都慢/快几 %。
      const rateA = input.a.rate && input.a.rate > 0 ? input.a.rate : 1;
      const rateB = input.b.rate && input.b.rate > 0 ? input.b.rate : resolved.plan.rate;
      const startedA = playerA.start({ positionSec: input.a.positionSec, when: session.startTimeSec, rate: rateA }) !== false;
      const startedB = playerB.start({ positionSec: input.b.positionSec, when: session.startTimeSec, rate: rateB }) !== false;
      if (!startedA || !startedB) throw new Error('四轨起播失败（窗口内没有音频）');
      session.aRateValue = rateA;
      session.bRateValue = rateB;
      session.events = scheduledEvents;
      const scheduled = session.graph.applyAll(scheduledEvents, session.startTimeSec);
      if (!scheduled) throw new Error('事件起点早于当前时间');

      return session;
    } catch (error) {
      console.warn('[advancedSession] 起会话失败，回退标准过渡', error);
      session.disposeGraphAndPlayers();
      session.releaseElements(aVolume, bVolume, release);
      return session;
    }
  }

  /**
   * 分轨低频互相关（120 Hz 一阶低通后的 Pearson）。
   * 只取每条 deck 首个窗口前 4 s，足够反映「这两首歌的低频是不是一回事」。
   */
  private measureCorrelation(a: StemPlayerLike, b: StemPlayerLike): Partial<Record<Stem, number>> {
    const out: Partial<Record<Stem, number>> = {};
    if (typeof lowBandCorrelation !== 'function') return out;
    if (typeof a.monoSamples !== 'function' || typeof b.monoSamples !== 'function') return out;
    const sampleRate = this.input.ctx.sampleRate || 48000;
    for (const stem of FOUR_STEMS) {
      const x = a.monoSamples(stem);
      const y = b.monoSamples(stem);
      if (!x || !y) continue;
      out[stem] = lowBandCorrelation(x, y, sampleRate, 120);
    }
    return out;
  }

  /** 实测相关度（可能为空对象：测量不可用或该轨缺失）。 */
  get correlation(): Partial<Record<Stem, number>> {
    return this.correlationValue;
  }

  /**
   * 只改 B 的速率（拍点锁相用）。
   *
   * 为什么只改 B：A 是「基准」，动它就等于整体变速；PLL 要做的是让 B 追 A 的拍，
   * 所以 A 的速率固定为 `plan.rate`，B 在此基础上按中心速率微调。
   *
   * @param rate B 的目标速率；非有限值或 ≤0 直接忽略（宁可不动也不要把声音拉飞）
   */
  setRate(rate: number): void {
    this.setRates({ b: rate });
  }

  /**
   * 同时改 A / B 的速率。
   *
   * 为什么不只用 `setRate` 改 B：用户可能在过渡中推 tempo 推子，A 的元素速率变了而分轨
   * 还按旧速率播 —— 两条时间轴慢慢错开，几十秒后就听得出「鼓点和波形不同步」。
   * 所以元素速率一变，两侧分轨都要跟着。
   *
   * 每一侧独立校验：一侧非法不影响另一侧（宁可 A 跟上、B 保持）。
   */
  setRates(rates: { a?: number; b?: number }): void {
    if (this.released) return;
    const apply = (index: 0 | 1, rate: number | undefined, isB: boolean): void => {
      if (rate === undefined) return;
      if (!Number.isFinite(rate) || rate <= 0) return;
      const player = this.players[index];
      if (!player) return;
      try {
        player.setRate?.(rate);
        if (isB) this.bRateValue = rate;
        else this.aRateValue = rate;
      } catch {
        /* 忽略：播放器可能已停 */
      }
    };
    apply(0, rates.a, false);
    apply(1, rates.b, true);
  }

  /** 当前 A 的速率（调试/测试用）；未起会话时为 0。 */
  get aRate(): number {
    return this.aRateValue;
  }

  /** 当前 B 的速率（调试/测试用）；未起会话时为 0。 */
  /**
   * 两条 deck 里先放完的那条还剩多少真实秒。
   * 返回 `null` 表示「算不出来」（实现没提供），调用方不要据此回退。
   */
  get remainingSec(): number | null {
    if (!this.active) return null;
    const values = this.players
      .map((player) => (typeof player.remainingSec === 'number' ? player.remainingSec : null))
      .filter((v): v is number => v !== null && Number.isFinite(v));
    if (values.length === 0) return null;
    return Math.min(...values);
  }

  get bRate(): number {
    return this.bRateValue;
  }

  /** 过渡结束：交还控制权（播放器停掉、图拆掉、元素音量斜坡还原）。 */
  cancel(): void {
    if (this.released) return;
    const aVolume = this.input.a.baseVolume;
    const bVolume = this.input.b.baseVolume;
    this.disposeGraphAndPlayers();
    this.releaseElements(aVolume, bVolume, this.input.releaseMs ?? DEFAULT_RELEASE_MS);
    this.released = true;
  }

  private disposeGraphAndPlayers(): void {
    for (const player of this.players) {
      try { player.stop(); } catch { /* 已停 */ }
      try { player.dispose(); } catch { /* 已拆 */ }
    }
    this.players = [];
    this.aRateValue = 0;
    this.bRateValue = 0;
    if (this.graph) {
      try { this.graph.dispose(); } catch { /* 已拆 */ }
      this.graph = null;
    }
  }

  /**
   * 20 ms 斜坡恢复元素音量（G2：不允许阶跃）。
   * 用定时器而不是 AudioParam：这是 `<audio>` 元素的 volume，只有 WebAudio 图才走采样级调度。
   */
  private releaseElements(aVolume: number, bVolume: number, durationMs: number): void {
    // 8 步 / 20 ms ≈ 2.5 ms 一步、3 dB 一档；4 步会有 6 dB 台阶，听感偏硬。
    // 每步独立定时（绝对时刻），不靠链式回调——链式在窗口繁忙时会被推迟，
    // 落地时刻就不等于 durationMs 了（单测里表现为只跑到 5/8 步）。
    const steps = 8;
    const stepMs = Math.max(1, Math.round(durationMs / steps));
    for (let i = 1; i <= steps; i++) {
      const t = clamp01(i / steps);
      setTimeout(() => {
        try {
          this.input.a.element.volume = aVolume * t;
          this.input.b.element.volume = bVolume * t;
        } catch { /* 元素已移除 */ }
      }, stepMs * i);
    }
  }

  /** 本次会话实际排了多少条事件（验收与日志用）。 */
  get eventCount(): number {
    return this.events.length;
  }

  /** 回声时间（秒），验收脚本可直接比对 60/BPM×0.25。 */
  get echoTimeSec(): number {
    const beatMs = this.input.resolved.plan?.beatMs;
    return beatMs ? echoDelaySec(60000 / Math.max(1, beatMs)) : echoDelaySec(undefined);
  }

  /** 供 UI/日志：本次会话用的是哪套曲线参数。 */
  get echoParams(): { divisionBeats: number; feedback: number; dampHz: number } {
    return { divisionBeats: ECHO.divisionBeats, feedback: ECHO.feedback, dampHz: ECHO.dampHz };
  }
}
