/**
 * 歌词播放样式：只作用于「播放效果 = 关闭」时默认 DOM 歌词页（纯字 / 房间由 canvas 画字，不受影响）。
 *
 * ===== 歌词效果制作模板（新增样式照这 7 条做） =====
 * 1. 在 LyricStyle 与 LYRIC_STYLES 里登记 id / 中文名 / 一句 hint；需要「逐字时机」的样式加 charTiming: true。
 * 2. 在 web/src/styles/app.css 末尾加 `.lyrics-view.lyric-style-<id> …` 规则；根节点 class 由本文件 + lyrics.ts 切换。
 * 3. 只改「动」：颜色一律走 --lyric-* 语义令牌（由「歌词颜色」等设置写入，见 app.css 末尾语义令牌段），
 *    样式里不要写死颜色，也不要只靠颜色/发光当效果——那属于颜色设置，不是播放动画。
 * 4. 可用的动效钩子（lyrics.ts 写进 DOM）：
 *    - 行：.lyric-line.is-active（当前句）/ .is-near（相邻句）；内联 --p（当前句演唱进度 0→1）、
 *      --fade（离当前句的可见度）、--grow（字号弹入曲线，动效档位控制）、
 *      --scatter（整列歌词的散开系数 0~1：当前行 0.6 半散、往后每远一行更散、最远 1，已唱行为 0，
 *      由 applyFade() 写；旋入这类样式用它缩放逐字漂移，换行时不会重新组装）；
 *    - 字：.lyric-char 的 --ci（字在句内的序号，用来错开动画相位）、.is-sung（已唱）、.is-hot（正在唱）；
 *      --drift-x / --drift-y / --drift-rot / --drift-dur（每个字一组稳定的随机「飘入」偏移，供旋入这类
 *      「先散在各处、唱到再飘回来组成句子」的动画用），四个变量由 lyrics.ts 在 render() 时按字写好。
 *    - 没有逐字数据的歌词行由 lyrics.ts 合成 --ci 与逐字时机（charTiming 样式才启用），普通 LRC 也能逐字动。
 * 5. 注意：.lyric-line / .lyric-char 的 transform 被历史规则用 !important 锁死（见 app.css 中段），
 *    动画请用独立的 translate / rotate / scale 属性（与 transform 叠加），不要抢 transform。
 * 6. 连续动画只挂当前行（.is-active），别给全页所有字挂无限动画；入退场用 is-sung/is-hot 的状态切换或一次性 keyframes。
 * 7. 逐字时机必须跟着「演唱」走：优先用 is-sung/is-hot 和 --p，不要用固定 setTimeout/固定 delay 假装逐字。
 */

export type LyricStyle = 'classic' | 'rise' | 'wave' | 'swing' | 'typewriter' | 'spin';

const STORE_KEY = 'zilux2.lyricStyle';

export const LYRIC_STYLES: Array<{ id: LyricStyle; label: string; hint: string; charTiming?: boolean }> = [
  { id: 'classic', label: '经典', hint: '默认样式：当前行放大，远处歌词逐行淡出' },
  {
    id: 'rise',
    label: '上浮',
    hint: '唱到的字从下方浮起、归位到行里，一句唱完整齐停在当前行',
    charTiming: true,
  },
  { id: 'wave', label: '波浪', hint: '当前行的字像水波一样依次起伏，随演唱一直流动' },
  { id: 'swing', label: '摇曳', hint: '每个字唱完的瞬间像被轻轻拨了一下，左右摆两下再停稳，跟着演唱一个字一个字摇', charTiming: true },
  {
    id: 'typewriter',
    label: '打字机',
    hint: '字跟着演唱一个一个出现，还没唱到的字和下面的歌词都不显形',
    charTiming: true,
  },
  {
    id: 'spin',
    label: '旋入',
    hint: '还没唱到的字散在句子周围，唱到哪个字就从随机方向飘回来、带一点旋转落进原位，一句唱完组成完整的句子',
    charTiming: true,
  },
];

/** 已下线的旧样式 → 新的等价样式：老存档尽量落在接近的效果上，而不是直接回到经典。 */
const LEGACY_STYLES: Record<string, LyricStyle> = {
  bounce: 'swing',
};

function readLyricStyle(): LyricStyle {
  try {
    const value = window.localStorage.getItem(STORE_KEY);
    if (value && LYRIC_STYLES.some((item) => item.id === value)) return value as LyricStyle;
    const migrated = value ? LEGACY_STYLES[value] : undefined;
    if (migrated) {
      window.localStorage.setItem(STORE_KEY, migrated);
      return migrated;
    }
    // 旧版本存的发光/渐变/频谱样式已下线：直接清掉，避免一直读到无效值。
    if (value) window.localStorage.removeItem(STORE_KEY);
  } catch {
    // ignore
  }
  return 'classic';
}

let current: LyricStyle = readLyricStyle();

const listeners = new Set<() => void>();

/** 当前歌词播放样式（快捷设置里展示用）。 */
export function lyricStyle(): LyricStyle {
  return current;
}

/** 当前样式是否依赖逐字演唱时机（is-sung / is-hot）：普通 LRC 行要靠它合成逐字状态。 */
export function lyricStyleNeedsCharTiming(): boolean {
  return LYRIC_STYLES.some((item) => item.id === current && item.charTiming === true);
}

/** 修改歌词播放样式；歌词页开着时立即生效（不重载歌词）。 */
export function setLyricStyle(style: LyricStyle): void {
  if (style === current) return;
  current = style;
  try {
    window.localStorage.setItem(STORE_KEY, style);
  } catch {
    // ignore
  }
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.warn('[lyrics] lyric style listener failed', error);
    }
  }
}

/** 订阅样式变化（lyrics.ts 用它给打开的歌词页换样式）。 */
export function onLyricStyle(listener: () => void): (() => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
