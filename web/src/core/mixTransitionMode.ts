/**
 * 「混音过渡模式」设置（WBS v2 §1.2 P4 / T4-1）。
 *
 * 注意键名：`transitionMode` 已经被壁纸转场占用
 * （`web/src/ui/wallpaperSettings.ts:201/733`），这里必须用 `mixTransitionMode`，
 * 否则用户切壁纸风格会把 DJ 过渡一起改掉（这就是 v2 里点名的 P4 陷阱）。
 *
 * 语义：
 *   standard —— 现有整轨等功率交叉（冻结不动，默认值，保证老行为零变化）
 *   advanced —— 分轨换手（4 轨 + 速度门控 + 真人手法）
 *
 * 读取永远不抛：localStorage 被禁用、值被手改成乱码，都回落 standard。
 */

/**
 * 三档（WBS v2 T5-1）：
 * - standard：老路径，整轨等功率交叉，永不换手；
 * - advanced：尽量换手；置信度不足时降级为「只换 bass+drums」；
 * - advancedSafe：只有置信度足够（tempoGate 判 full）才换手，否则直接回落标准。
 */
export type MixTransitionMode = 'standard' | 'advanced' | 'advancedSafe';

/** 与壁纸的 `transitionMode` 区分开，别复用。 */
export const MIX_TRANSITION_KEY = 'mixTransitionMode';

export const MIX_TRANSITION_LABELS: Record<MixTransitionMode, string> = {
  standard: '标准（整轨等功率）',
  advanced: '进阶（分轨换手）',
  advancedSafe: '进阶·稳妥（置信度不足就回落标准）',
};

export const MIX_TRANSITION_HINTS: Record<MixTransitionMode, string> = {
  standard: '保持现在的等功率交叉，不做分轨换手。',
  advanced: '按小节逐轨交换鼓/低音/旋律/人声；置信度不足时只换低音与鼓。首次切歌要先算分轨，会等几秒。',
  advancedSafe: '只有拍点/调性都足够可信时才换手，否则当场回落标准，宁可不换也不乱换。',
};

export const MIX_TRANSITION_ORDER: readonly MixTransitionMode[] = ['standard', 'advanced', 'advancedSafe'];

const VALID: readonly MixTransitionMode[] = MIX_TRANSITION_ORDER;

export function isMixTransitionMode(value: unknown): value is MixTransitionMode {
  return typeof value === 'string' && (VALID as readonly string[]).includes(value);
}

/** 读当前模式；任何异常/非法值都返回 standard。 */
export function readMixTransitionMode(): MixTransitionMode {
  // 实验特性已停用：恒定返回标准，保证过渡只有冻结的整轨等功率这一条路。
  return 'standard';
}

/** 写模式；返回最终生效值（写失败也不抛）。 */
export function writeMixTransitionMode(mode: MixTransitionMode): MixTransitionMode {
  const next = isMixTransitionMode(mode) ? mode : 'standard';
  try {
    localStorage.setItem(MIX_TRANSITION_KEY, next);
  } catch {
    /* 隐私模式下 localStorage 可能抛错，忽略：本次会话仍按返回值生效 */
  }
  return next;
}

/** 切换（UI 开关用）：standard ↔ advanced。 */
export function toggleMixTransitionMode(): MixTransitionMode {
  const index = MIX_TRANSITION_ORDER.indexOf(readMixTransitionMode());
  return writeMixTransitionMode(MIX_TRANSITION_ORDER[(index + 1) % MIX_TRANSITION_ORDER.length]);
}

/** 是否要尝试换手（两档「进阶」都算）。 */
export function wantsStemSwap(mode: MixTransitionMode): boolean {
  return mode === 'advanced' || mode === 'advancedSafe';
}

/** 置信度不足时是否允许降级为「只换低音+鼓」；稳妥档一律不允许，直接回落标准。 */
export function allowsDegradedSwap(mode: MixTransitionMode): boolean {
  return mode === 'advanced';
}

/**
 * 手法（模板）选择：`auto` 交给能量/段落/调性规则自动选；另外两档是「手动加戏」。
 * 与模式分开存，避免用户切回标准模式时丢掉自己挑的手法。
 */
export const MIX_TEMPLATE_KEY = 'mixTransitionTemplate';

export type MixTransitionTemplate = 'auto' | 'vocalFirst' | 'doubleDrop';

export const MIX_TEMPLATE_ORDER: MixTransitionTemplate[] = ['auto', 'vocalFirst', 'doubleDrop'];

export const MIX_TEMPLATE_LABELS: Record<MixTransitionTemplate, string> = {
  auto: '自动',
  vocalFirst: '人声先行',
  doubleDrop: '双歌齐响',
};

export const MIX_TEMPLATE_HINTS: Record<MixTransitionTemplate, string> = {
  auto: '按能量、段落与调性自动选手法',
  vocalFirst: 'A 的人声先甩一个回声尾巴，再把 B 的人声放进来（16 小节）',
  doubleDrop: '两首齐响 8 小节，四轨同时换手，适合两首都很热的段落',
};

export function isMixTransitionTemplate(value: unknown): value is MixTransitionTemplate {
  return value === 'auto' || value === 'vocalFirst' || value === 'doubleDrop';
}

export function readMixTransitionTemplate(): MixTransitionTemplate {
  try {
    const raw = localStorage.getItem(MIX_TEMPLATE_KEY);
    return isMixTransitionTemplate(raw) ? raw : 'auto';
  } catch {
    return 'auto';
  }
}

export function writeMixTransitionTemplate(value: MixTransitionTemplate): MixTransitionTemplate {
  const next = isMixTransitionTemplate(value) ? value : 'auto';
  try {
    localStorage.setItem(MIX_TEMPLATE_KEY, next);
  } catch {
    /* 隐私模式下写不进去也不影响本次会话 */
  }
  return next;
}

/** 引擎：加法（四轨重建求和，老路径）/ 减法（mix − Σ，DJUCED 同款；内部测试版默认）。 */
export type MixTransitionEngine = 'subtractive' | 'additive';

export const MIX_ENGINE_KEY = 'mixTransitionEngine';

export const MIX_ENGINE_ORDER: readonly MixTransitionEngine[] = ['subtractive', 'additive'];

export const MIX_ENGINE_LABELS: Record<MixTransitionEngine, string> = {
  subtractive: '减法（mix − Σ）',
  additive: '加法（四轨求和）',
};

export const MIX_ENGINE_HINTS: Record<MixTransitionEngine, string> = {
  subtractive: '不重建，未被切的声部走原始混音：相位无损、不发糊；只能「切」，不能「加」。',
  additive: '四轨各自重建再相加：能独奏任意一轨，但每条误差叠加，听感偏糊。',
};

export function isMixTransitionEngine(value: unknown): value is MixTransitionEngine {
  return value === 'subtractive' || value === 'additive';
}

export function readMixTransitionEngine(): MixTransitionEngine {
  try {
    const raw = localStorage.getItem(MIX_ENGINE_KEY);
    return isMixTransitionEngine(raw) ? raw : 'subtractive';
  } catch {
    return 'subtractive';
  }
}

export function writeMixTransitionEngine(value: MixTransitionEngine): MixTransitionEngine {
  const next = isMixTransitionEngine(value) ? value : 'subtractive';
  try {
    localStorage.setItem(MIX_ENGINE_KEY, next);
  } catch {
    /* 忽略 */
  }
  return next;
}
