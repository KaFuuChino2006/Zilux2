/**
 * 从歌词里取「人声区间」：第一句真正开始唱的时间 + 最后一句唱完的时间。
 *
 * 用途：无缝衔接（crossfadeDeck）的两个判断——
 * - B 的「开始唱词」用来安排过渡终点（前奏长就跳过前奏、前奏短就把整段前奏当过渡）；
 * - A 的「最后一句唱完」用来实现「歌词衔接」：末句刚落就接下一首首句（人声先出、伴奏渐入）。
 *
 * 为什么需要过滤：很多歌词文件会把制作人员名单（作词 : 某某 / 作曲 : 某某 / Lyrics by …）、
 * 纯音乐 / 间奏标记也当普通歌词行放进时间轴。它们出现在开头时会把「开始唱词」算到名单上，
 * 出现在结尾时会把「最后一句」算到名单上，过渡点就落在没人唱的地方。这里用启发式过滤掉
 * 这些行；过滤只影响「衔接判断」，不影响歌词页显示。
 */

import { parseCharLyric, parseLrc } from './lrc';

export interface SingingRange {
  /** 第一句人声开始时间（曲内毫秒） */
  firstMs: number;
  /** 最后一句人声开始时间（曲内毫秒） */
  lastStartMs: number;
  /** 最后一句人声结束时间（曲内毫秒；LRC 没有逐字时长，按句间隔估算） */
  lastEndMs: number;
}

/** 中文制作人员标签（只在行首 + 分隔符 / 整行标签 时才判定，避免误伤正常歌词）。 */
const CREDIT_LABELS: string[] = [
  '作词',
  '作詞',
  '填词',
  '填詞',
  '作曲',
  '编曲',
  '編曲',
  '词曲',
  '詞曲',
  '制作人',
  '製作人',
  '出品人',
  '监制',
  '監製',
  '出品',
  '发行',
  '發行',
  '唱片公司',
  '发行公司',
  '录音',
  '錄音',
  '录音师',
  '錄音師',
  '混音',
  '混音师',
  '混音師',
  '母带',
  '母帶',
  '母带师',
  '和声',
  '和聲',
  '和音',
  '配唱',
  '人声',
  '人聲',
  '吉他',
  '吉他手',
  '贝斯',
  '貝斯',
  '鼓手',
  '键盘',
  '鍵盤',
  '键盘手',
  '弦乐',
  '弦樂',
  '钢琴',
  '鋼琴',
  '合成器',
  'program',
  'programming',
  '企划',
  '企劃',
  '策划',
  '策劃',
  '统筹',
  '統籌',
  '宣传',
  '宣傳',
  '封面',
  '美术',
  '美術',
  '设计',
  '設計',
  '文案',
  '版权',
  '版權',
  'op',
  'sp',
  '词',
  '詞',
  '曲',
];

/** 整行只有一个「不是歌词」的标记（纯音乐、间奏等）时也跳过。 */
const INSTRUMENTAL_LINE =
  /^(纯音乐[，,、\s]*请欣赏|纯音乐|純音樂|暂无歌词|暂无歌词内容|无歌词|間奏|间奏|前奏|尾奏|intro|outro|interlude|instrumental|inst\.?|music|solo|no lyrics?)$/i;

/** 英文制作人员行：Lyrics by … / Composed by … / Produced by … / Guitar: … */
const EN_CREDIT =
  /^(lyrics?|words|music|composed|composer|arranged|arrangement|produced|producer|executive producer|mixed|mix|mastered|mastering|recorded|recording|vocals?|guitar|bass|drums?|keyboards?|strings|piano|programming|label|publisher|published|op|sp)\b[\s\S]{0,48}\b(by|:)/i;

/** 行首标签后面紧跟的分隔符（作词：/ 作词 : / 作词- 等）。 */
const LABEL_SEPARATOR = /^[\s：:／/\-—·.、]+/;

function hasContent(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/** 这一行是不是「不是人声歌词」的制作人员 / 标记行。 */
export function isCreditLine(text: string): boolean {
  const line = text.trim();
  if (!line || !hasContent(line)) return true;

  // 整体被括号包起来的说明行：（作词：某某）
  const bare = line.replace(/^[（(\[【]+|[）)\]】]+$/g, '').trim();
  if (INSTRUMENTAL_LINE.test(bare)) return true;
  if (EN_CREDIT.test(line)) return true;

  // 行首制作人员标签：要求标签后紧跟分隔符、或整行就是标签；否则当正常歌词（如「作曲的人是我」）。
  const lower = line.toLowerCase();
  for (const label of CREDIT_LABELS) {
    if (!lower.startsWith(label)) continue;
    const rest = line.slice(label.length);
    if (!rest) return true;
    if (LABEL_SEPARATOR.test(rest)) return true;
  }

  // 一行多条信息：「作词：A / 作曲：B」——按斜杠切开后每段都是标签开头才算名单行。
  if (/[\/／]/.test(line)) {
    const segments = line
      .split(/[\/／]/)
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    if (segments.length > 1) {
      const creditSegments = segments.filter((segment) => {
        const segmentLower = segment.toLowerCase();
        return CREDIT_LABELS.some((label) => {
          if (!segmentLower.startsWith(label)) return false;
          const rest = segment.slice(label.length);
          return rest.length === 0 || LABEL_SEPARATOR.test(rest);
        });
      });
      if (creditSegments.length === segments.length) return true;
    }
  }

  return false;
}

/** 歌词行是否算「人声句子」：有文字内容且不是制作人员 / 标记行。 */
function isSingingLine(text: string | undefined): boolean {
  const value = (text ?? '').trim();
  if (!value || !hasContent(value)) return false;
  return !isCreditLine(value);
}

/** 逐字歌词（YRC/QRC）：第一句/最后一句人声，结束时间用逐字时长，精确。 */
function rangeFromCharLyric(raw: string | null | undefined): SingingRange | null {
  const lines = parseCharLyric(raw).filter((line) => isSingingLine(line.text ?? line.chars.map((char) => char.text).join('')));
  if (lines.length === 0) return null;
  const first = lines[0]!;
  const last = lines[lines.length - 1]!;
  const firstMs = Math.max(0, Math.round(first.timeMs));
  const lastStartMs = Math.max(0, Math.round(last.timeMs));
  const duration = Number.isFinite(last.durationMs) && last.durationMs > 0 ? last.durationMs : 4_000;
  return { firstMs, lastStartMs, lastEndMs: Math.round(lastStartMs + duration) };
}

/** 普通 LRC：第一句人声；最后一句结束时间用最后几声间隔的中位数估算（夹在 1.5–9 秒）。 */
function rangeFromLrc(raw: string | null | undefined): SingingRange | null {
  if (!raw) return null;
  const lines = parseLrc(raw).filter((line) => line.timeMs > 0 && isSingingLine(line.text));
  if (lines.length === 0) return null;
  const firstMs = Math.max(0, Math.round(lines[0]!.timeMs));
  const lastStartMs = Math.max(0, Math.round(lines[lines.length - 1]!.timeMs));

  const gaps: number[] = [];
  for (let index = Math.max(1, lines.length - 4); index < lines.length; index += 1) {
    const gap = lines[index]!.timeMs - lines[index - 1]!.timeMs;
    if (gap > 200 && gap < 15_000) gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  const median = gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)]! : 4_000;
  const estimate = Math.min(9_000, Math.max(1_500, median));
  return { firstMs, lastStartMs, lastEndMs: Math.round(lastStartMs + estimate) };
}

/**
 * 从一份歌词（YRC 优先、LRC 兜底）里取人声区间；都取不到返回 null。
 * 逐字歌词有时间精确的结束时间；LRC 只能估算最后一句时长。
 */
export function singingRangeFromLyric(lyric: { lrc?: string | null; yrc?: string | null } | null | undefined): SingingRange | null {
  if (!lyric) return null;
  return rangeFromCharLyric(lyric.yrc) ?? rangeFromLrc(lyric.lrc);
}

/** 只有普通 LRC 文本时（本地同名 .lrc）用这个。 */
export function singingRangeFromLrcText(raw: string | null | undefined): SingingRange | null {
  return rangeFromLrc(raw);
}
