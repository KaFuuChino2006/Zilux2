# -*- coding: utf-8 -*-
"""自带逐字但没有翻译时：也去其它平台搜索翻译并贴到现有逐字行上。"""
import io

LM = r'E:\Zilux2开发\web\src\ui\lyricMatch.ts'
LY = r'E:\Zilux2开发\web\src\ui\lyrics.ts'


def read(path):
    return io.open(path, 'r', encoding='utf-8', newline='').read()


def write(path, text):
    io.open(path, 'w', encoding='utf-8', newline='').write(text)


# ---------- lyricMatch.ts ----------
t = read(LM)
nl = '\r\n' if '\r\n' in t else '\n'
L = lambda s: s.replace('\n', nl)

anchor = L("  /** 逐字来自候选平台、翻译取自另一个平台（例如 QQ 逐字 + 网易云翻译）。 */\n  translationFromOther?: string;")
assert t.count(anchor) == 1, 'result anchor'
t = t.replace(anchor, anchor + L("\n  /** true = 当前平台自带逐字，只从其它平台补翻译（locally 已有逐字，不替换）。 */\n  translationOnly?: boolean;"))

# 追加「只搜翻译」的实现
anchor2 = L("export function matchCacheSize(): number {")
assert t.count(anchor2) == 1, 'cache size anchor'
extra = L("""const translationCache = new Map<string, LyricMatchResult | null>();
const translationInflight = new Map<string, Promise<LyricMatchResult | null>>();

/**
 * 当前平台自带逐字、但没有翻译时：只去其它平台找翻译，按时间戳贴到现有逐字行上。
 * 返回的 result.lines 为 null（不替换逐字），translationOnly 为 true。
 */
export function matchTranslation(track: OnlineTrack, baseLines: LyricLine[]): Promise<LyricMatchResult | null> {
  const key = `${track.source}:${track.id}`;
  const running = translationInflight.get(key);
  if (running) return running;
  const task = runTranslationMatch(track, baseLines).finally(() => {
    translationInflight.delete(key);
  });
  translationInflight.set(key, task);
  return task;
}

async function runTranslationMatch(track: OnlineTrack, baseLines: LyricLine[]): Promise<LyricMatchResult | null> {
  const key = `${track.source}:${track.id}`;
  if (translationCache.has(key)) return translationCache.get(key) ?? null;
  const targets = sourceIds().filter((id) => id !== track.source && id !== 'local');
  let best: { lines: TimedLine[]; label: string; meta: number } | null = null;
  for (const source of targets) {
    let results: OnlineTrack[] = [];
    for (const query of searchQueries(track)) {
      try {
        results = (await searchOnline(source, query, 8)).tracks;
      } catch {
        results = [];
      }
      if (results.length > 0) break;
    }
    const scored = results
      .map((candidate) => ({ candidate, meta: metaScore(track, candidate) }))
      .filter((item) => item.meta >= 0.5)
      .sort((a, b) => b.meta - a.meta)
      .slice(0, 3);
    for (const { candidate, meta } of scored) {
      let lyric;
      try {
        lyric = await fetchLyric(source, candidate.id);
      } catch {
        continue;
      }
      const raw = (lyric.translation ?? '').trim();
      if (!raw) continue;
      const lines = parseLrc(raw).filter((line) => line.text.trim().length > 0) as TimedLine[];
      if (lines.length === 0) continue;
      if (!best || meta > best.meta) {
        best = { lines, label: `${SOURCE_LABEL[source] ?? source} · 翻译`, meta };
      }
      if (best.meta >= 0.85) break;
    }
    if (best && best.meta >= 0.85) break;
  }
  let result: LyricMatchResult | null = null;
  if (best && attachTranslationLines(baseLines, best.lines)) {
    result = {
      score: best.meta,
      label: '当前平台逐字',
      kind: 'lrc',
      lines: null,
      source: track.source,
      id: track.id,
      hasTranslation: true,
      translationOnly: true,
      translationFromOther: best.label,
    };
  }
  translationCache.set(key, result);
  return result;
}

""")
t = t.replace(anchor2, extra + anchor2)
write(LM, t)
print('lyricMatch ok')

# ---------- lyrics.ts ----------
t2 = read(LY)
nl2 = '\r\n' if '\r\n' in t2 else '\n'
L2 = lambda s: s.replace('\n', nl2)

# 1) 文案：只补翻译的情况
old_text = L2("""  if (lyricMatchInfo.translationFromBase) {
    return `${base}（逐字来自对方平台，翻译取自当前平台）`;
  }""")
assert t2.count(old_text) == 1, 'text branch'
t2 = t2.replace(old_text, L2("""  if (lyricMatchInfo.translationOnly) {
    return `自带逐字 · 翻译取自 ${lyricMatchInfo.translationFromOther ?? '其它平台'}（${percent(lyricMatchInfo.score)}%）`;
  }
  if (lyricMatchInfo.translationFromBase) {
    return `${base}（逐字来自对方平台，翻译取自当前平台）`;
  }"""))

old_src = L2("""  if (info.translationFromBase) {
    return `${base} · 逐字 ${info.label} · 翻译取自当前平台`;
  }""")
assert t2.count(old_src) == 1, 'source branch'
t2 = t2.replace(old_src, L2("""  if (info.translationOnly) {
    return `${lyricSource} · 自带逐字 · 翻译取自 ${info.translationFromOther ?? '其它平台'}`;
  }
  if (info.translationFromBase) {
    return `${base} · 逐字 ${info.label} · 翻译取自当前平台`;
  }"""))

# 2) startLyricMatch：自带逐字但没翻译 → 只搜翻译
old_start = L2("""function startLyricMatch(track: OnlineTrack, base: LyricDoc): void {
  lyricMatchInfo = null;
  // 当前平台歌词本身就有逐字数据时不需要再跨平台替换。
  const alreadyWordLevel = base.kind === 'qrc' || base.kind === 'yrc';
  lyricMatchSkipped = alreadyWordLevel;
  lyricMatchDone = false;
  notifyMatch();
  if (alreadyWordLevel) return;""")
assert t2.count(old_start) == 1, 'start match block'
new_start = L2("""function startLyricMatch(track: OnlineTrack, base: LyricDoc): void {
  lyricMatchInfo = null;
  const baseHasTranslation = base.lines.some((line) => (line.translation ?? '').trim().length > 0);
  // 当前平台歌词本身就有逐字数据：有翻译就不用再匹配，没翻译仍去其它平台找翻译。
  const alreadyWordLevel = base.kind === 'qrc' || base.kind === 'yrc';
  lyricMatchSkipped = alreadyWordLevel && baseHasTranslation;
  lyricMatchDone = false;
  notifyMatch();
  if (alreadyWordLevel) {
    if (baseHasTranslation) return;
    void matchTranslation(track, base.lines)
      .then((result) => {
        if (lastDoc?.trackKey !== base.trackKey) return;
        lyricMatchDone = true;
        lyricMatchInfo = result;
        if (result) updateCurrentLyricLine();
        notifyMatch();
      })
      .catch(() => {
        if (lastDoc?.trackKey !== base.trackKey) return;
        lyricMatchDone = true;
        lyricMatchInfo = null;
        notifyMatch();
      });
    return;
  }""")
t2 = t2.replace(old_start, new_start)

# 3) import matchTranslation
old_imp = L2("import { matchWordLyrics, matchMinScore, setMatchMinScore } from './lyricMatch';")
if t2.count(old_imp) == 1:
    t2 = t2.replace(old_imp, L2("import { matchTranslation, matchWordLyrics, matchMinScore, setMatchMinScore } from './lyricMatch';"))
else:
    # 兼容：找出 import 行
    import re
    m = re.search(r"import \{[^}]*matchWordLyrics[^}]*\} from './lyricMatch';", t2)
    assert m, 'lyricMatch import'
    line = m.group(0)
    t2 = t2.replace(line, line.replace('matchWordLyrics', 'matchTranslation, matchWordLyrics', 1))
write(LY, t2)
print('lyrics ok')
