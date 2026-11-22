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
 * 四档：
 * - standard：老路径，整轨等功率交叉，冻结不动（默认值）；
 * - automixV2：进阶混音 v2 —— 低频换手 + 分段等功率 + 双向扫频，零分轨，只在图模式下生效；
 * - advanced：分轨换手（旧实验路径，播放期跑分轨，已判死刑，仅留作对照）；
 * - advancedSafe：旧实验路径的稳妥档。
 *
 * 注意 v2 与 advanced 是**两条互斥的实现**：v2 走 `web/src/audio/automixV2Graph.ts`
 * 自己的分频链，不碰分轨、不碰标准路径的节点；切回 standard 就是完全回到旧行为。
 */
export type MixTransitionMode = 'standard' | 'automixV2' | 'advanced' | 'advancedSafe';

/** 与壁纸的 `transitionMode` 区分开，别复用。 */
export const MIX_TRANSITION_KEY = 'mixTransitionMode';

export const MIX_TRANSITION_LABELS: Record<MixTransitionMode, string> = {
  standard: '标准（整轨等功率）',
  automixV2: '进阶混音（智能选点）',
  advanced: '进阶（分轨换手·已停用）',
  advancedSafe: '进阶·稳妥（分轨换手·已停用）',
};

export const MIX_TRANSITION_HINTS: Record<MixTransitionMode, string> = {
  standard: '保持现在的整轨等功率交叉，一分钱不加，行为与旧版完全一致。',
  automixV2:
    '按两首歌的重拍、鼓点、低音活动和人声位置选择接歌点，速度相近时自动对拍。',
  advanced: '旧的四轨分轨换手，播放期要跑分离、会变调发糊，已停用；保留只为对照。',
  advancedSafe: '旧分轨路线的稳妥档，同样已停用。',
};

/**
 * 切换循环用的顺序：保持旧三档不动（`toggleMixTransitionMode` 与老测试依赖它）。
 * UI 下拉另用 `MIX_TRANSITION_UI_ORDER`，把 v2 排进去。
 */
export const MIX_TRANSITION_ORDER: readonly MixTransitionMode[] = ['standard', 'advanced', 'advancedSafe'];

/** UI 下拉顺序：v2 紧跟标准档，因为它是标准档的「升级版」而不是旧分轨路。 */
export const MIX_TRANSITION_UI_ORDER: readonly MixTransitionMode[] = [
  'standard',
  'automixV2',
  'advanced',
  'advancedSafe',
];

const VALID: readonly MixTransitionMode[] = MIX_TRANSITION_UI_ORDER;

export function isMixTransitionMode(value: unknown): value is MixTransitionMode {
  return typeof value === 'string' && (VALID as readonly string[]).includes(value);
}

/**
 * 读当前模式；任何异常/非法值都返回 standard。
 *
 * 默认仍是 standard：没手动切过的用户，行为与旧版逐样本一致。
 * `automixV2` 是显式选择才生效的独立路径（用户要求「两种独立过渡」）。
 */
export function readMixTransitionMode(): MixTransitionMode {
  try {
    const raw = localStorage.getItem(MIX_TRANSITION_KEY);
    return isMixTransitionMode(raw) ? raw : 'standard';
  } catch {
    return 'standard';
  }
}

/** 是否是进阶混音 v2（低频换手路径）。 */
export function isAutomixV2(mode: MixTransitionMode): boolean {
  return mode === 'automixV2';
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

/** 是否要尝试分轨换手（只算旧的两档实验路径；v2 零分轨，永远不走这里）。 */
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
