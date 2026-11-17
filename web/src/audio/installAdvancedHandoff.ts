/**
 * 进阶过渡的「安装器」：把四轨混音器接到 crossfadeDeck 的交接点上（T4-3）。
 *
 * 为什么之前是死代码：`setHandoffFactory` 一直没人调用，`requestHandoff()` 恒返回 null，
 * 于是 `crossfadeDeck` 里的进阶分支永远走不到。这个模块就是那个缺失的调用方。
 *
 * 接线策略（保守，绝不把声音搞没）：
 *
 *   1. 只接受 `kind === 'auto'`、字段齐全、且**两条 deck 的四轨窗口都已预热**的请求；
 *      任何一个条件不满足就返回 null，调用方继续走等功率曲线（标准路径逐字节不变）。
 *   2. 返回的 `Handoff.start(clockSec)` 立即返回，真正加载四轨是异步的；加载结果通过
 *      `whenReady()` 交给调用方——失败时调用方从当前进度回退，不会重现「从头再来」。
 *   3. `cancel()` / `dispose()` 幂等，重复调用不会重复归还音量。
 *
 * 依赖全部可注入（`begin` / `loadPlayer` / `createGraph` / `ensureContext` / `destination`），
 * 所以 node 里可以用假 ctx/graph/player 完整测这条链路，不需要真的 WebAudio。
 */

import type { Handoff, HandoffRequest } from '../core/advancedHandoff';
import { setHandoffFactory } from '../core/advancedHandoff';
import { fallbackToStandard, resolveTransition, type ResolvedTransition } from '../core/advancedTransition';
import { allowsDegradedSwap, readMixTransitionEngine, wantsStemSwap } from '../core/mixTransitionMode';
import { readTuning } from '../core/transitionTuning';
import { noteHandoffStatus } from '../core/advancedHandoff';
import { FOUR_STEMS, MAX_SPAN_WINDOWS } from './stemPlayer';
import { stemSpanKeys, isStemReady, isStemSpanReady } from './advancedReadiness';
import { appMusicOutputNode, ensureAppAudioGraph } from '../core/audioTap';
import {
  AdvancedSession,
  type BeginInput,
  type DeckSource,
  type StemGraphLike,
  type StemPlayerLike,
} from './advancedSession';
import { StemGraph } from './stemGraph';
import { StemPlayer } from './stemPlayer';
import type { OnlineTrack } from '../online/types';

export interface InstallAdvancedHandoffDeps {
  /** 预热登记查询（测试注入，单窗口口径）。 */
  isReady?: (key: string) => boolean;
  /** 跨窗预热查询（测试注入；不给则用 `isStemSpanReady`）。 */
  isSpanReady?: (track: OnlineTrack | null | undefined, positionSec: number, spanSec: number) => boolean;
  /** 取共享 AudioContext（默认走 audioTap 的本地播放图）。 */
  ensureContext?: () => AudioContext | null;
  /** 四轨混音器接到哪个节点（默认音乐输出节点）。 */
  destination?: () => AudioNode | null;
  /** 起会话（测试注入）。 */
  begin?: (input: BeginInput) => Promise<{ active: boolean; cancel(): void }>;
  /** 载入一条 deck 的四轨（测试注入）。 */
  loadPlayer?: (
    ctx: AudioContext,
    track: OnlineTrack,
    startSec: number,
    spanSec: number,
    bus: ReturnType<StemGraphLike['bus']>,
    options: { stems: readonly string[]; fourStem: boolean },
  ) => Promise<StemPlayerLike>;
  /** 建图（测试注入）。 */
  createGraph?: (ctx: AudioContext, destination: AudioNode) => StemGraphLike;
  /** 日志（默认 console.info；测试里可静音）。 */
  log?: (message: string, detail?: unknown) => void;
}

const LOG_PREFIX = '[advancedHandoff]';

/** 请求是否具备走进阶的全部条件（缺一项就返回 null）。 */
function readyRequest(request: HandoffRequest): boolean {
  if (request.kind !== 'auto') return false;
  if (!request.analysisA || !request.analysisB) return false;
  if (!request.trackA || !request.trackB) return false;
  if (!request.elementA || !request.elementB) return false;
  if (!Number.isFinite(request.positionMsA) || !Number.isFinite(request.positionMsB)) return false;
  return true;
}

/**
 * 安装进阶交接工厂，返回卸载函数（测试/热重载用）。
 * 重复调用会覆盖上一个工厂（不会叠加）。
 */
export function installAdvancedHandoff(deps: InstallAdvancedHandoffDeps = {}): () => void {
  const isReady = deps.isReady ?? isStemReady;
  const ensureContext = deps.ensureContext ?? ensureAppAudioGraph;
  const destination = deps.destination ?? appMusicOutputNode;
  const log = deps.log ?? ((message: string, detail?: unknown) => console.info(LOG_PREFIX, message, detail ?? ''));

  const factory = (request: HandoffRequest): Handoff | null => {
    if (!readyRequest(request)) {
      noteHandoffStatus(false, '请求字段不全（缺分析/曲目/元素/位置），或不是 auto 过渡');
      return null;
    }

    const ctx = ensureContext();
    const dest = destination();
    if (!ctx || !dest) {
      log('音频图不可用，本次走标准过渡');
      noteHandoffStatus(false, '音频图不可用（AudioContext / 输出节点为空）');
      return null;
    }

    let resolved: ResolvedTransition;
    try {
      resolved = resolveTransition({
        mode: wantsStemSwap(request.mode) ? 'advanced' : 'standard',
        analysisA: request.analysisA!,
        analysisB: request.analysisB!,
        positionMsA: request.positionMsA!,
        hint: request.hint,
      });
    } catch (error) {
      // 兜底文案由 advancedTransition 统一给，避免各处自己拼。
      const fb = fallbackToStandard(error);
      log(`规划失败，本次走标准过渡（${fb.summary[0] ?? '未知原因'}）`, error);
      noteHandoffStatus(false, `规划失败：${fb.summary[0] ?? '未知原因'}`);
      return null;
    }
    if (!resolved.plan || !resolved.events.length) {
      log(`没有可执行的换手计划（${resolved.summary.join(' / ')}）`);
      noteHandoffStatus(false, `没有可执行的换手计划：${resolved.summary[0] ?? ''}`);
      return null;
    }

    // 「进阶·稳妥」档：只要速度/拍点置信度没到 full，就当场回落标准，
    // 不允许像 advanced 那样降级成「只换低音+鼓」（T5-1 承诺的语义）。
    if (!allowsDegradedSwap(request.mode) && resolved.gate && resolved.gate.tier !== 'full') {
      log(`稳妥档要求置信度 full，本次判定 ${resolved.gate.tier}，回落标准过渡`);
      noteHandoffStatus(false, `稳妥档要求置信度 full，本次判定 ${resolved.gate.tier ?? '未知'}`);
      return null;
    }

    // 第 13 轮：过渡可能是 32 小节（128 BPM 下 60 s），单窗 30 s 放完就断了。
    // 这里按 plan 算出整段跨度，要求**全部窗口**都预热好，否则宁可回退。
    const spanSec = Math.max(0, (resolved.plan.totalBars * resolved.plan.beatMs * 4) / 1000);
    const startA = (request.positionMsA ?? 0) / 1000;
    const startB = (request.positionMsB ?? 0) / 1000;
    const forcedNow = typeof readTuning === 'function' ? readTuning().forceAdvanced : false;
    if (!forcedNow && spanSec > 0 && spanSec / 30 > MAX_SPAN_WINDOWS) {
      log(`过渡跨度 ${(spanSec / 30).toFixed(1)} 窗超过上限 ${MAX_SPAN_WINDOWS}，本次走标准过渡`);
      noteHandoffStatus(false, `过渡跨度 ${(spanSec / 30).toFixed(1)} 窗 > 上限 ${MAX_SPAN_WINDOWS}`);
      return null;
    }
    const spanReady = deps.isSpanReady ?? isStemSpanReady;
    const aReady = spanReady(request.trackA, startA, spanSec);
    const bReady = spanReady(request.trackB, startB, spanSec);
    if (!forcedNow && (!aReady || !bReady)) {
      noteHandoffStatus(false, '四轨窗口还没预热完（首次分离一窗约 7 s，等它排完再放下一首）');
      log('四轨窗口未预热（跨窗口径），本次走标准过渡', {
        keysA: stemSpanKeys(request.trackA, startA, spanSec),
        keysB: stemSpanKeys(request.trackB, startB, spanSec),
      });
      return null;
    }
    // 兼容老的单键查询：调用方显式给了 key 时也认（单窗场景两者等价）。
    if (!forcedNow && request.stemKeyA && !isReady(request.stemKeyA)) {
      noteHandoffStatus(false, 'A 的四轨窗口未预热');
      return null;
    }
    if (!forcedNow && request.stemKeyB && !isReady(request.stemKeyB)) {
      noteHandoffStatus(false, 'B 的四轨窗口未预热');
      return null;
    }

    const createGraph = deps.createGraph ?? ((c: AudioContext, d: AudioNode) => new StemGraph(c, d));
    const loadPlayer =
      deps.loadPlayer ??
      ((
        c: AudioContext,
        track: OnlineTrack,
        startSec: number,
        spanSec: number,
        bus: ReturnType<StemGraphLike['bus']>,
      ) => StemPlayer.loadSpan(c, track, startSec, spanSec, bus as never, {
        stems: [...FOUR_STEMS],
        fourStem: true,
      }));
    const begin = deps.begin ?? ((input: BeginInput) => AdvancedSession.begin(input));

    const baseVolume = request.elementA!.volume;

    // 图在 begin 内部创建（AdvancedSession 负责失败清理），这里只留引用给 load 用。
    // 先给一个「尚未创建」的占位，load 只在 begin 之后才会被调用。
    let graphRef: StemGraphLike = {
      bus: () => {
        throw new Error('StemGraph 尚未创建');
      },
      applyAll: () => false,
      dispose: () => undefined,
    };
    const createGraphTracked = (c: AudioContext, d: AudioNode): StemGraphLike => {
      graphRef = createGraph(c, d);
      return graphRef;
    };

    const sourceA: DeckSource = {
      element: request.elementA!,
      baseVolume,
      rate: Number.isFinite(request.elementA!.playbackRate) ? request.elementA!.playbackRate : 1,
      positionSec: startA,
      load: (_positionSec: number) => loadPlayer(ctx, request.trackA!, startA, spanSec, graphRef.bus('A'), {
        stems: FOUR_STEMS,
        fourStem: true,
      }),
    };
    const sourceB: DeckSource = {
      element: request.elementB!,
      baseVolume: request.elementB!.volume,
      rate: Number.isFinite(request.elementB!.playbackRate) ? request.elementB!.playbackRate : 1,
      positionSec: startB,
      load: (_positionSec: number) => loadPlayer(ctx, request.trackB!, startB, spanSec, graphRef.bus('B'), {
        stems: FOUR_STEMS,
        fourStem: true,
      }),
    };

    let session: {
    active: boolean;
    cancel(): void;
    setRate?(rate: number): void;
    setRates?(rates: { a?: number; b?: number }): void;
    remainingSec?: number | null;
  } | null = null;
    let settled = false;
    let resolveReady: (ok: boolean) => void = () => undefined;
    const ready = new Promise<boolean>((resolve) => {
      resolveReady = resolve;
    });
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolveReady(ok);
    };

    const handoff: Handoff = {
      start(clockSec: number): void {
        void (async () => {
          try {
            session = await begin({
              ctx,
              destination: dest,
              resolved,
              a: sourceA,
              b: sourceB,
              when: clockSec,
              createGraph: createGraphTracked,
              subtractive: typeof readMixTransitionEngine === 'function'
                ? readMixTransitionEngine() === 'subtractive'
                : true,
              ...(typeof readTuning === 'function' ? { tuning: readTuning() } : {}),
              // 解码之后按实测低频互相关重排：两首不同的歌 ρ≈0 → equalPower；
              // 同源/同 loop ρ 高 → linear（幅度守恒）。模板默认曲线只在拿不到 ρ 时生效。
              replan: (correlation) => {
                try {
                  const again = resolveTransition({
                    mode: 'advanced',
                    analysisA: request.analysisA!,
                    analysisB: request.analysisB!,
                    positionMsA: startA * 1000,
                    correlation,
                  });
                  if (!again.plan || again.events.length === 0) return null;
                  const decided = again.plan.actions.map((x) => `${x.stem}:${x.curve}`).join(' ');
                  log(`按相关度重排曲线 ${decided}`);
                  return { events: again.events };
                } catch (error) {
                  log(`按相关度重排失败：${String(error)}`);
                  return null;
                }
              },
            });
            const ok = session.active === true;
            if (ok) {
              noteHandoffStatus(true, `四轨已接管：${resolved.summary[0] ?? resolved.plan?.template ?? ''}`);
              log(`四轨已接管：${resolved.summary[0] ?? resolved.plan?.template ?? ''}`);
            } else {
              noteHandoffStatus(false, '四轨起播失败（窗口内没有音频或加载失败）');
              log('四轨接管失败，回退标准曲线');
            }
            settle(ok);
          } catch (error) {
            log('起会话抛错，回退标准曲线', error);
            settle(false);
          }
        })();
      },
      whenReady(): Promise<boolean> {
        return ready;
      },
      setRate(rate: number): void {
        if (!session || session.active !== true) return;
        try {
          session.setRate?.(rate);
        } catch {
          /* 忽略：会话可能正在拆 */
        }
      },
      setRates(rates: { a?: number; b?: number }): void {
        if (!session || session.active !== true) return;
        try {
          if (session.setRates) session.setRates(rates);
          else if (rates.b !== undefined) session.setRate?.(rates.b);
        } catch {
          /* 忽略：会话可能正在拆 */
        }
      },
      // G6：crossfadeDeck 用这个值判断「分轨快放完了，提前接回等功率」。
      // 之前只声明在类型里、没实现 ⇒ 调用方永远拿到 undefined，兜底从不触发
      // （单测用的是替身 handoff，所以没暴露）。这里补上真实现。
      remainingSec(): number | null {
        if (!session || session.active !== true) return null;
        try {
          const value = session.remainingSec;
          return typeof value === 'number' && Number.isFinite(value) ? value : null;
        } catch {
          return null;
        }
      },
      cancel(): void {
        try {
          session?.cancel();
        } catch {
          /* 忽略 */
        }
        settle(false);
      },
      dispose(): void {
        try {
          session?.cancel();
        } catch {
          /* 忽略 */
        }
        settle(false);
      },
    };
    return handoff;
  };

  setHandoffFactory(factory);
  return () => setHandoffFactory(null);
}
