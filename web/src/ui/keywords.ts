/**
 * 歌词「重点词」自动提取（纯字档「关键字染色」与房间档「重点词染色」共用）。
 *
 * Zilux2 没有人工维护的词表，这里从整首歌词里自动挑「反复出现的长词」：
 *  - 英文按单词统计，中文按 2~3 字的连续片段统计；
 *  - 去掉语气词/虚词这类停用词，至少出现 2 次；
 *  - 长词优先，被长词包含的短词不再单独上色；
 *  - 颜色取「歌词颜色」的封面色板；没有色板（纯色档）时用香槟金三色。
 */

export interface LyricKeyword {
  /** 词面：英文为小写原文，中文为连续片段。 */
  text: string;
  /** 上色颜色。 */
  color: string;
  /** 英文按整词匹配，中文按片段包含匹配。 */
  latin: boolean;
}

/** 纯色档（没有封面取色）时重点词用的香槟金三色，和纯字档主题一致。 */
export const KEYWORD_FALLBACK_COLORS = ['#e6b877', '#8fd3c0', '#e59a9a'] as const;
/** 最多挑几个重点词。 */
const MAX_KEYWORDS = 12;

const KEYWORD_STOPWORDS = new Set<string>([
  'the', 'and', 'you', 'your', 'that', 'this', 'with', 'for', 'have', 'are', 'was', 'were', 'not',
  'but', 'all', 'can', 'out', 'get', 'got', 'just', 'like', 'love', 'know', 'from', 'what', 'when',
  'how', 'why', 'who', 'she', 'her', 'him', 'his', 'they', 'them', 'will', 'would', 'could', 'should',
  'about', 'there', 'here', 'then', 'than', 'into', 'over', 'also', 'still', 'even', 'only', 'some',
  '我的', '你的', '他的', '她的', '我们', '你们', '他们', '因为', '所以', '如果', '但是', '就是', '一个',
  '这个', '那个', '什么', '怎么', '现在', '可以', '还是', '已经', '没有', '不是', '自己', '这样', '那样',
  '时候', '真的', '其实', '所以', '不要', '一起', '知道', '觉得', '应该', '一直', '开始', '不想',
  '的', '了', '吗', '呢', '啊', '吧', '哦', '呀', '是', '我', '你', '他', '她', '它', '们', '在', '有',
  '不', '就', '也', '还', '又', '把', '被', '给', '让', '对', '和', '跟', '从', '到', '去', '来',
]);

const CJK_RUN_RE = /[㐀-鿿぀-ヿ가-힯]+/g;
const LATIN_WORD_RE = /[A-Za-z][A-Za-z'’]{2,}/g;

const asLines = (lines: ReadonlyArray<{ text: string; words: ReadonlyArray<{ text: string }> }>): string[] =>
  lines.map((line) => line.text.trim() || line.words.map((word) => word.text).join(' '));

export function extractLyricKeywords(
  lines: ReadonlyArray<{ text: string; words: ReadonlyArray<{ text: string }> }>,
  palette: string[] | null,
  fallbackColors: readonly string[] = KEYWORD_FALLBACK_COLORS,
): LyricKeyword[] {
  if (lines.length === 0) return [];

  const counts = new Map<string, { text: string; count: number; latin: boolean }>();
  const bump = (text: string, latin: boolean) => {
    const key = latin ? text.toLowerCase() : text;
    if (KEYWORD_STOPWORDS.has(key)) return;
    const entry = counts.get(key) ?? { text, count: 0, latin };
    entry.count += 1;
    counts.set(key, entry);
  };

  for (const text of asLines(lines)) {
    for (const match of text.match(LATIN_WORD_RE) ?? []) bump(match, true);
    for (const run of text.match(CJK_RUN_RE) ?? []) {
      const longest = Math.min(3, run.length);
      for (let size = 2; size <= longest; size += 1) {
        for (let index = 0; index + size <= run.length; index += 1) bump(run.slice(index, index + size), false);
      }
    }
  }

  const ranked = [...counts.values()]
    .filter((entry) => entry.count >= 2)
    .map((entry) => ({
      ...entry,
      score: entry.count * (entry.latin ? 1.6 : 1) * Math.min(2.2, entry.text.length / 2),
    }))
    .sort((a, b) => b.score - a.score);

  const chosen: Array<{ text: string; latin: boolean }> = [];
  for (const entry of ranked) {
    if (chosen.length >= MAX_KEYWORDS) break;
    if (chosen.some((other) => other.latin === entry.latin && (other.text.includes(entry.text) || entry.text.includes(other.text)))) continue;
    chosen.push({ text: entry.text, latin: entry.latin });
  }

  const colors = palette && palette.length > 0 ? palette : [...fallbackColors];
  return chosen.map((entry, index) => ({
    text: entry.text,
    latin: entry.latin,
    color: colors[index % colors.length]!,
  }));
}

/** 判断一个词条是不是重点词；中文按片段包含（和纯字档 folia 的口径一致），英文按整词。 */
export function keywordForWord(word: string, keywords: readonly LyricKeyword[]): LyricKeyword | null {
  if (keywords.length === 0) return null;
  // 逐词时间来自 QRC/YRC，词条常带标点（"baby，"、"（我）"），先剥掉首尾非文字字符再比。
  const clean = word.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
  if (clean.length === 0) return null;
  const latinWord = /^[A-Za-z][A-Za-z'’]*$/.test(clean);
  if (latinWord) {
    const lower = clean.toLowerCase();
    for (const keyword of keywords) {
      if (keyword.latin && keyword.text === lower) return keyword;
    }
    return null;
  }
  for (const keyword of keywords) {
    if (!keyword.latin && clean.includes(keyword.text)) return keyword;
  }
  return null;
}
