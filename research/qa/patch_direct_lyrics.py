import io

# ============================================================
# 1) lyricMatch.ts：新增「无任何歌词时直接线上取」模式
# ============================================================
p = r'E:\Zilux2开发\web\src\ui\lyricMatch.ts'
t = io.open(p, 'r', encoding='utf-8', newline='').read()


def sub(old, new, label):
    global t
    n = t.count(old)
    assert n == 1, (label, n)
    t = t.replace(old, new)


sub(
    """  /** 最佳候选是否真的带逐字歌词（false = 对方平台只有整行 LRC）。 */""",
    """  /** true = 当前曲目本身没有任何歌词，直接线上取，不计算文本匹配度。 */
  direct?: boolean;
  /** 最佳候选是否真的带逐字歌词（false = 对方平台只有整行 LRC）。 */""",
    'direct field',
)

# LRC → 内部行结构
sub(
    """const cache = new Map<string, LyricMatchResult | null>();""",
    """function linesFromLrc(lrc: string | null | undefined, translation: string | null | undefined): LyricLine[] {
  const translated = applyTranslation(parseLrc(lrc ?? ''), translation ?? '');
  return translated
    .filter((line) => line.text.trim().length > 0)
    .map((line, index, all) => {
      const next = all[index + 1];
      const durationMs = next ? Math.max(200, next.timeMs - line.timeMs) : 3200;
      return { timeMs: line.timeMs, durationMs, text: line.text, translation: line.translation ?? '', words: [] };
    });
}

const cache = new Map<string, LyricMatchResult | null>();""",
    'linesFromLrc',
)

# 直接线上取
sub(
    """async function runMatch(
  track: OnlineTrack,
  baseLines: LyricLine[],
): Promise<LyricMatchResult | null> {""",
    """/** 曲目完全没有歌词时：直接按歌名/歌手去线上取，优先逐字版本，忽略匹配度阈值。 */
async function runDirectMatch(track: OnlineTrack): Promise<LyricMatchResult | null> {
  const targets = lyricSourceIds().filter((id) => id !== track.source && id !== 'local');
  for (const source of targets) {
    let results: OnlineTrack[] = [];
    for (const query of searchQueries(track)) {
      try {
        results = (await searchOnline(source, query, 6)).tracks;
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
      const word = wordDocOf(lyric);
      const lines = word ? word.lines : linesFromLrc(lyric.lrc, lyric.translation);
      if (lines.length === 0) continue;
      const kind: WordLyricKind | 'lrc' = word?.kind ?? 'lrc';
      return {
        direct: true,
        score: meta,
        label: labelOf(source, kind),
        kind,
        lines,
        hasWord: Boolean(word && word.lines.length > 0),
        source,
        id: candidate.id,
        hasTranslation: word?.hasTranslation ?? Boolean((lyric.translation ?? '').trim()),
      };
    }
  }
  return null;
}

async function runMatch(
  track: OnlineTrack,
  baseLines: LyricLine[],
): Promise<LyricMatchResult | null> {""",
    'runDirectMatch',
)

sub(
    """  if (!baseText.trim()) {
    cache.set(cacheKey, null);
    return null;
  }""",
    """  if (!baseText.trim()) {
    // 完全没有歌词（本地没配 lrc / 平台也没有）：直接线上取，忽略匹配度
    const direct = await runDirectMatch(track);
    cache.set(cacheKey, direct);
    return direct;
  }""",
    'direct branch',
)

io.open(p, 'w', encoding='utf-8', newline='').write(t)

# ============================================================
# 2) lyrics.ts：直接模式文案
# ============================================================
p2 = r'E:\Zilux2开发\web\src\ui\lyrics.ts'
t = io.open(p2, 'r', encoding='utf-8', newline='').read()

sub(
    """let lyricMatchMode: 'word' | 'translation' = 'word';""",
    """let lyricMatchMode: 'word' | 'translation' | 'direct' = 'word';""",
    'mode type',
)

sub(
    """  const alreadyWordLevel = base.kind === 'qrc' || base.kind === 'yrc';
  lyricMatchMode = alreadyWordLevel ? 'translation' : 'word';
  lyricMatchSkipped = alreadyWordLevel && baseHasTranslation;""",
    """  const alreadyWordLevel = base.kind === 'qrc' || base.kind === 'yrc';
  const hasLyrics = base.lines.length > 0;
  // 当前曲目完全没有歌词 → 直接线上取（不比较匹配度）
  lyricMatchMode = !hasLyrics ? 'direct' : alreadyWordLevel ? 'translation' : 'word';
  lyricMatchSkipped = hasLyrics && alreadyWordLevel && baseHasTranslation;""",
    'mode assign',
)

# lyricMatchText：直接模式文案
sub(
    """  const translationMode = lyricMatchMode === 'translation';
  if (lyricMatchSkipped) return '当前平台已自带逐字与翻译，无需匹配';
  if (!lyricMatchDone) return translationMode ? '正在搜索翻译…' : '匹配中…';
  if (!lyricMatchInfo) {
    return translationMode ? '没找到其它平台的翻译，保留原歌词' : '没找到其它平台的逐字歌词，保留原歌词';
  }""",
    """  const translationMode = lyricMatchMode === 'translation';
  const directMode = lyricMatchMode === 'direct';
  if (lyricMatchSkipped) return '当前平台已自带逐字与翻译，无需匹配';
  if (!lyricMatchDone) {
    return directMode ? '正在线上查找歌词…' : translationMode ? '正在搜索翻译…' : '匹配中…';
  }
  if (!lyricMatchInfo) {
    if (directMode) return '线上也没找到歌词';
    return translationMode ? '没找到其它平台的翻译，保留原歌词' : '没找到其它平台的逐字歌词，保留原歌词';
  }
  if (lyricMatchInfo.direct) {
    return `线上歌词：${lyricMatchInfo.label}（${percent(lyricMatchInfo.score)}%）`;
  }""",
    'matchText direct',
)

# lyricSourceText：直接模式
sub(
    """  const translationMode = lyricMatchMode === 'translation';
  if (manualLyricLabel) return `${lyricSource} · 手动选择`;
  if (lyricMatchSkipped) return `${lyricSource} · 已自带逐字与翻译`;
  if (!lyricMatchDone) return `${lyricSource} · ${translationMode ? '正在搜索翻译…' : '正在匹配逐字…'}`;
  if (!info) {
    return `${lyricSource} · ${translationMode ? '未找到其它平台的翻译' : '其它平台未匹配到逐字'}`;
  }""",
    """  const translationMode = lyricMatchMode === 'translation';
  const directMode = lyricMatchMode === 'direct';
  if (manualLyricLabel) return `${lyricSource} · 手动选择`;
  if (lyricMatchSkipped) return `${lyricSource} · 已自带逐字与翻译`;
  if (!lyricMatchDone) {
    return directMode ? '线上歌词 · 正在查找…' : `${lyricSource} · ${translationMode ? '正在搜索翻译…' : '正在匹配逐字…'}`;
  }
  if (!info) {
    if (directMode) return '线上歌词 · 未找到';
    return `${lyricSource} · ${translationMode ? '未找到其它平台的翻译' : '其它平台未匹配到逐字'}`;
  }
  if (info.direct) {
    return `线上歌词 · ${info.label} · 匹配 ${percent(info.score)}%`;
  }""",
    'sourceText direct',
)

io.open(p2, 'w', encoding='utf-8', newline='').write(t)
print('ok')
