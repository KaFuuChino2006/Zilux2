/**
 * 进阶过渡的「交接点」：crossfadeDeck 与四轨混音器之间唯一的耦合面。
 *
 * 为什么要有这一层：
 * - `crossfadeDeck` 只管时间轴（什么时候起播、什么时候收尾），它不该知道音频图、四轨、门控；
 * - 真正的进阶实现（StemGraph + StemPlayer + tempoGate）在 `audio/advancedSession.ts`，
 *   由更上层（player/app）注入工厂；
 * - 标准模式的路径必须**逐字节不变**，所以这里先判 `mode !== 'advanced'` 就返回 null，
 *   连工厂都不调用。
 *
 * 失败语义：工厂抛错、返回 null、或模式不是 advanced，一律返回 null 让调用方走原来的
 * 等功率曲线——过渡绝不能因为进阶模块挂掉而静音。
 */

import type { BeatAnalysis } from '../online/analysis';
import type { OnlineTrack } from '../online/types';
import type { MixTransitionMode } from './mixTransitionMode';
import type { Template } from './transitionPlan';

/** 交接点只关心「要不要换手」：两档进阶都算 advanced，具体降到哪一档由 tempoGate 决定。 */
export type HandoffMode = MixTransitionMode;

export interface HandoffRequest {
  mode: HandoffMode;
  /** 与 crossfadeDeck 的 plan.kind 对齐。 */
  kind: 'auto' | 'manual' | 'loop';
  /** 本次过渡总时长（毫秒）。 */
  fadeMs: number;
  /** 本次给 B 的播放速率（1 = 不变速）。 */
  tempoRate: number;

  /* ---- 以下字段只在 kind === 'auto' 时给全；缺任何一个，工厂都必须返回 null ---- */

  /** A 的节拍分析（决定换手模板与速度门控）。 */
  analysisA?: BeatAnalysis;
  /** B 的节拍分析。 */
  analysisB?: BeatAnalysis;
  /** A 的曲目（四轨音频要按 track 去宿主取）。 */
  trackA?: OnlineTrack;
  /** B 的曲目。 */
  trackB?: OnlineTrack;
  /** A 的曲内位置（毫秒）：分轨窗口按它取。 */
  positionMsA?: number;
  /** B 的起播位置（毫秒）。 */
  positionMsB?: number;
  /** A 的曲内总时长（毫秒），用于判断窗口是否够长。 */
  currentDurationMs?: number;
  /** B 的曲内总时长（毫秒）。 */
  nextDurationMs?: number;
  /** A 的 deck 元素：会话期间静音、回退时还原。 */
  elementA?: HTMLAudioElement;
  /** B 的 deck 元素。 */
  elementB?: HTMLAudioElement;
  /** A 这一窗四轨的预热键（见 audio/advancedReadiness.ts）；未预热就不接进阶。 */
  stemKeyA?: string;
  /** B 这一窗四轨的预热键。 */
  stemKeyB?: string;
  /** 显式模板（试放台 / 调试用）；缺省由 tempoGate + 模板自动选择决定。 */
  hint?: Template;
}

export interface Handoff {
  /** 在音频时钟 `clockSec` 时刻启动；必须在同一时刻启动所有分轨，保证轨间零偏移。 */
  start(clockSec: number): void;
  /**
   * 异步就绪结果：`true` = 四轨已经接管；`false` = 没能接管，调用方必须在这里回退到
   * 等功率曲线（从当前进度接着走，而不是从头再来）。
   * 不实现 = 视为同步成功（旧实现/测试替身）。
   */
  whenReady?: () => Promise<boolean>;
  /** 中断（回退标准路径或用户取消）：必须把元素音量还原。 */
  cancel(): void;
  /** 正常收尾：停止分轨、拆图并归还资源。 */
  dispose(): void;
  /**
   * 拍点锁相：只微调 B 的速率（A 是基准，不动）。
   * 未实现 = 这条路径不支持速率微调，调用方忽略即可。
   */
  setRate?(rate: number): void;
  /**
   * 同时改 A / B 的速率：用户推 tempo 推子时，两侧分轨必须跟住各自的元素。
   * 某侧未给或非法 = 该侧保持不变。
   */
  setRates?(rates: { a?: number; b?: number }): void;
  /** 分轨音频还能撑多少真实秒（`null`/未实现 = 不做兜底）。 */
  remainingSec?(): number | null;
}

export type HandoffFactory = (request: HandoffRequest) => Handoff | null;

let factory: HandoffFactory | null = null;

/** 由上层注入（测试里也可注入假实现）。传 null 清除。 */
export function setHandoffFactory(next: HandoffFactory | null): void {
  factory = next;
}

export function hasHandoffFactory(): boolean {
  return factory !== null;
}

/**
 * 最近一次进阶交接的结果（给调参窗显示用）。
 * 排查「高级过渡没生效」时，这里是第一现场：到底是没工厂、模式是标准，还是四轨没预热。
 */
let lastStatus: { ok: boolean; reason: string; at: number } = { ok: false, reason: '还没触发过过渡', at: 0 };

export function noteHandoffStatus(ok: boolean, reason: string): void {
  lastStatus = { ok, reason, at: Date.now() };
}

export function handoffStatus(): { ok: boolean; reason: string; at: number } {
  return lastStatus;
}

/** 标准模式或任何异常都返回 null，表示「继续走原有等功率路径」。 */
export function requestHandoff(request: HandoffRequest): Handoff | null {
  if (request.mode === 'standard') {
    noteHandoffStatus(false, '模式是「标准」：本来就不走分轨换手');
    return null;
  }
  const current = factory;
  if (!current) {
    noteHandoffStatus(false, '交接工厂没装（installAdvancedHandoff 未执行）');
    return null;
  }
  try {
    const handoff = current(request);
    if (!handoff) return null;
    if (typeof handoff.start !== 'function' || typeof handoff.cancel !== 'function' || typeof handoff.dispose !== 'function') {
      console.warn('[advancedHandoff] 工厂返回的对象缺少 start/cancel/dispose，忽略');
      return null;
    }
    return handoff;
  } catch (error) {
    console.warn('[advancedHandoff] 工厂抛错，回落标准过渡', error);
    return null;
  }
}
