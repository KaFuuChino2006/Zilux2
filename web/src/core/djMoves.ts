/**
 * 真人化手法库（P1）：把「DJ 会做的动作」编码成可执行的自动化数据。
 *
 * 设计原则（和 transitionPlan 保持一致）：
 * - **结构严格、手感松弛**：动作的 `startBar` 锚在小节线上，只有 `humanizeMs`
 *   与曲线给 ±12 ms / ±10% 的抖动。抖结构会变成「拍不准」，抖手感才像真人。
 * - 输出是纯数据（`Automation[]`），由 `web/src/audio/stemGraph.ts` 转成
 *   `AudioParam.setValueAtTime / linearRampToValueAtTime`，全程不碰 setTimeout。
 * - 每个 Move 自带 `reason`，UI 可以直接显示「这一下在干什么」。
 */

export type Deck = 'A' | 'B';

export type Stem = 'bass' | 'drums' | 'other' | 'vocals' | 'mix';

/** 可自动化的参数。`delaySend` 是送进回声总线的干湿比（0~1）。 */
export type Param = 'gain' | 'eqLow' | 'eqMid' | 'eqHigh' | 'hpf' | 'lpf' | 'delaySend';

export type MoveCurve = 'linear' | 'equalPower' | 'easeIn' | 'easeOut' | 'shelfDip';

export interface Automation {
  deck: Deck;
  stem: Stem;
  param: Param;
  from: number;
  to: number;
  /** 相对过渡起点的第几小节（0 起）。 */
  startBar: number;
  /** 动作持续多少拍。 */
  lengthBeats: number;
  curve: MoveCurve;
}

export interface Move {
  id: string;
  name: string;
  /** 给 UI 的一句话说明。 */
  reason: string;
  actions: Automation[];
  /** 只抖时间的幅度（ms），0 表示完全机械。 */
  humanizeMs?: number;
}

/** 回声甩尾的固定参数：1/4 拍、反馈 0.35、阻尼低通 3 kHz。 */
export const ECHO = {
  /** 1/4 拍。delay 时间 = 60 / BPM × 该值（见 `echoDelaySec`）。 */
  divisionBeats: 0.25,
  feedback: 0.35,
  dampHz: 3000,
  /** 新歌总线侧链压低量（dB）与 attack（ms）。 */
  duckDb: -3,
  duckAttackMs: 5,
} as const;

/**
 * 回声延迟时间（秒）。BPM 无效时回落到 120 BPM。
 * 四个 stem 图在过渡开始前用它调 `DeckStemBus.setEchoTime()`，保证甩尾跟着拍子。
 */
export function echoDelaySec(bpm: number | undefined | null, divisionBeats?: number): number {
  const safe = typeof bpm === 'number' && Number.isFinite(bpm) && bpm >= 40 && bpm <= 220 ? bpm : 120;
  const division = typeof divisionBeats === 'number' && Number.isFinite(divisionBeats) && divisionBeats > 0
    ? divisionBeats
    : ECHO.divisionBeats;
  return (60 / safe) * division;
}

const a = (
  deck: Deck, stem: Stem, param: Param, from: number, to: number,
  startBar: number, lengthBeats: number, curve: MoveCurve = 'linear',
): Automation => ({ deck, stem, param, from, to, startBar, lengthBeats, curve });

/** 低频交接：A 的 bass 半拍内让位，B 的 bass 在下一个「1」进来。 */
export function bassSwapMove(startBar = 0): Move {
  return {
    id: 'bassSwap',
    name: '低频交接',
    reason: '低频只留一路，避免 30–120 Hz 叠加 +3 dB',
    humanizeMs: 8,
    actions: [
      a('A', 'bass', 'gain', 1, 0, startBar, 0.5, 'shelfDip'),
      a('B', 'bass', 'gain', 0, 1, startBar + 1, 0.5, 'linear'),
    ],
  };
}

/** EQ 三段互换：真人不推推子，靠 EQ 换频段。 */
export function eqSwapMove(startBar = 2): Move {
  return {
    id: 'eqSwap',
    name: 'EQ 三段互换',
    reason: '逐段交换频段，听感上比整轨交叉干净',
    humanizeMs: 12,
    actions: [
      a('A', 'mix', 'eqLow', 0, -6, startBar, 2, 'easeIn'),
      a('B', 'mix', 'eqLow', -6, 0, startBar + 2, 2, 'easeOut'),
      a('A', 'mix', 'eqHigh', 0, -4, startBar + 1, 2, 'easeIn'),
      a('B', 'mix', 'eqHigh', -4, 0, startBar + 3, 2, 'easeOut'),
    ],
  };
}

/** 人声叠鼓：留 A 的人声，B 的鼓与低音接管（最有「人味」的一手）。 */
export function vocalOverBeatMove(startBar = 8): Move {
  return {
    id: 'vocalOverBeat',
    name: '人声叠鼓',
    reason: 'A 的人声留在前，B 的鼓点先进来，两首人声重叠不超过 1 拍',
    humanizeMs: 10,
    actions: [
      a('B', 'drums', 'gain', 0, 1, startBar - 4, 2, 'linear'),
      a('A', 'bass', 'gain', 1, 0, startBar, 0.5, 'shelfDip'),
      a('B', 'bass', 'gain', 0, 1, startBar + 1, 0.5, 'linear'),
      a('A', 'other', 'gain', 1, 0.35, startBar, 4, 'equalPower'),
      a('A', 'vocals', 'gain', 1, 1, startBar, 4, 'linear'),
      a('B', 'vocals', 'gain', 0, 1, startBar + 4, 1, 'equalPower'),
      a('A', 'vocals', 'gain', 1, 0, startBar + 5, 1, 'easeOut'),
    ],
  };
}

/** 人声回声甩尾：最后一句进 delay，尾巴飘进新歌，下一小节线切干声。 */
export function vocalEchoThrowMove(startBar = 12): Move {
  return {
    id: 'vocalEchoThrow',
    name: '人声回声甩尾',
    reason: `人声送 1/4 拍 delay（反馈 ${ECHO.feedback}、阻尼 ${ECHO.dampHz} Hz），尾巴落进新歌`,
    humanizeMs: 6,
    actions: [
      a('A', 'vocals', 'delaySend', 0, 0.6, startBar, 2, 'easeIn'),
      a('B', 'vocals', 'gain', 0, 1, startBar + 1, 1, 'equalPower'),
      a('A', 'vocals', 'gain', 1, 0, startBar + 1, 0.05, 'linear'),
      a('A', 'mix', 'delaySend', 0.6, 0.6, startBar + 1, 2, 'linear'),
      a('A', 'mix', 'delaySend', 0.6, 0, startBar + 4, 1, 'easeOut'),
    ],
  };
}

/** 滤波扫频：A 高通上扬、B 低通打开，做出「推上去」的 build。 */
/*
 * 以下 move 构造器与 MOVE_TEMPLATES / expandMoves / humanize 属于**设计预留 API**：
 * 运行时换手走的是 transitionPlan.actionsFor() + stemSwap.schedulePlan()，
 * 这套「按手法编排 + 手感抖动」尚未接线（见 docs/zilux2-advanced-transition-acceptance.md §22）。
 * 保留原因：①它是下一步「滤波扫频 / 手感抖动」的实现蓝本；②单元测试用它验证曲线与时间表。
 * 接线的正确时机是 stemGraph 支持 hpf/lpf 自动化之后。
 */
export function filterSweepMove(startBar = 4): Move {
  return {
    id: 'filterSweep',
    name: '滤波扫频',
    reason: 'A 抽掉低频、B 慢慢打开，制造向上推进感',
    humanizeMs: 12,
    actions: [
      a('A', 'mix', 'hpf', 20, 1200, startBar, 8, 'easeIn'),
      a('B', 'mix', 'lpf', 400, 20000, startBar + 4, 8, 'easeOut'),
    ],
  };
}

/** 硬切 + 回声收尾：8 小节快速换歌。 */
export function echoCutMove(startBar = 0): Move {
  return {
    id: 'echoCut',
    name: '回声硬切',
    reason: '人声甩尾后直接切，尾巴衰减不盖住新歌 downbeat',
    humanizeMs: 6,
    actions: [
      a('A', 'bass', 'gain', 1, 0, startBar, 0.25, 'linear'),
      a('A', 'drums', 'gain', 1, 0, startBar, 0.25, 'linear'),
      a('A', 'vocals', 'delaySend', 0, 0.7, startBar + 3, 1, 'easeIn'),
      a('A', 'mix', 'gain', 1, 0, startBar + 4, 0.05, 'linear'),
      a('B', 'mix', 'gain', 0, 1, startBar + 4, 0.05, 'linear'),
    ],
  };
}

/** 三个成品模板：直接喂给 Performer 即可。 */
export const MOVE_TEMPLATES = {
  /** 标准俱乐部式 32 小节。 */
  club32: (): Move[] => [bassSwapMove(0), eqSwapMove(2), vocalOverBeatMove(8), vocalEchoThrowMove(12)],
  /** 人声叠鼓 16 小节。 */
  vocalOverBeat16: (): Move[] => [vocalOverBeatMove(8)],
  /** 回声硬切 8 小节。 */
  echoCut8: (): Move[] => [echoCutMove(0)],
} as const;

/** 把多个 Move 摊平成一条自动化列表，按时间排序。 */
export function expandMoves(moves: Move[]): Automation[] {
  return moves.flatMap((m) => m.actions).slice().sort((x, y) => x.startBar - y.startBar || x.deck.localeCompare(y.deck));
}

/** 可复现的伪随机（同一个 seed 得到同一条「表演」）。 */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 人味注入：**只抖时间与曲线，不抖结构**。
 * - `startBar` 一字不改（换手点必须落在小节线）
 * - `lengthBeats` ±10%
 * - `jitterMs` 落在 ±humanizeMs 内，供 Performer 平移时间
 */
export function humanize(moves: Move[], seed: number): Array<Automation & { jitterMs: number }> {
  const rnd = mulberry32(seed);
  return expandMoves(moves).map((act) => {
    const span = moves.find((m) => m.actions.includes(act))?.humanizeMs ?? 0;
    return {
      ...act,
      lengthBeats: Number((act.lengthBeats * (0.9 + rnd() * 0.2)).toFixed(4)),
      curve: act.curve === 'linear' && rnd() > 0.7 ? 'easeOut' : act.curve,
      jitterMs: Math.round((rnd() - 0.5) * 2 * span),
    };
  });
}
