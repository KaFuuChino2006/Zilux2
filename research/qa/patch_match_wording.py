import io

# ---------- 1. lyricMatch.ts：给结果补 hasWord / belowThreshold ----------
p1 = r'E:\Zilux2开发\web\src\ui\lyricMatch.ts'
t = io.open(p1, 'r', encoding='utf-8', newline='').read()


def sub(old, new, label):
    global t
    n = t.count(old)
    assert n == 1, (label, n)
    t = t.replace(old, new)


sub(
    """  /** 命中的平台 id 与曲目 id，便于排查。 */""",
    """  /** 最佳候选是否真的带逐字歌词（false = 对方平台只有整行 LRC）。 */
  hasWord?: boolean;
  /** true = 找到逐字候选，但匹配度低于当前阈值，因此没替换。 */
  belowThreshold?: boolean;
  /** 命中的平台 id 与曲目 id，便于排查。 */""",
    'interface fields',
)

sub(
    """      const kind: WordLyricKind | 'lrc' = word?.kind ?? 'lrc';
      if (!best || score > best.score) {
        best = {
          score,
          label: labelOf(source, kind),
          kind,
          lines: word && score >= minScore ? word.lines : null,
          source,
          id: candidate.id,
          hasTranslation: word?.hasTranslation ?? false,
        };
      }""",
    """      const kind: WordLyricKind | 'lrc' = word?.kind ?? 'lrc';
      const hasWord = Boolean(word && word.lines.length > 0);
      if (!best || score > best.score) {
        best = {
          score,
          label: labelOf(source, kind),
          kind,
          lines: hasWord && score >= minScore ? word.lines : null,
          hasWord,
          belowThreshold: hasWord && score < minScore,
          source,
          id: candidate.id,
          hasTranslation: word?.hasTranslation ?? false,
        };
      }""",
    'best assign',
)

io.open(p1, 'w', encoding='utf-8', newline='').write(t)

# ---------- 2. lyrics.ts：文案区分「低于阈值」/「对方只有整行」 ----------
p2 = r'E:\Zilux2开发\web\src\ui\lyrics.ts'
t = io.open(p2, 'r', encoding='utf-8', newline='').read()

sub(
    """  return lyricMatchInfo.lines ? base : `${base}（无逐字，保留原歌词）`;""",
    """  if (lyricMatchInfo.lines) return base;
  if (lyricMatchInfo.belowThreshold) {
    return `${lyricMatchInfo.label} · ${percent(lyricMatchInfo.score)}%（低于阈值 ${percent(lyricMatchMinScore())}%，保留原歌词）`;
  }
  return `${base}（对方平台只有整行歌词，无逐字）`;""",
    'quick text',
)

sub(
    """  return info.lines ? `${base} · 逐字 ${info.label}` : `${base} · 无逐字，未替换`;""",
    """  if (info.lines) return `${base} · 逐字 ${info.label}`;
  if (info.belowThreshold) return `${base} · 低于阈值 ${percent(lyricMatchMinScore())}%，未替换`;
  return `${base} · 其它平台无逐字（只有整行）`;""",
    'source text',
)

io.open(p2, 'w', encoding='utf-8', newline='').write(t)

# ---------- 3. lyricPicker.ts：匹配度徽章加 title 说明估算口径 ----------
p3 = r'E:\Zilux2开发\web\src\ui\lyricPicker.ts'
t = io.open(p3, 'r', encoding='utf-8', newline='').read()

sub(
    """      const score = h('span', { class: `lp-score${scoreClass(item.score)}`, text: percent(item.score) });""",
    """      const score = h('span', {
        class: `lp-score${scoreClass(item.score)}`,
        text: percent(item.score),
        title: '按歌名 / 歌手 / 时长估算的匹配度，与歌词文本相似度无关',
      });""",
    'picker score title',
)

io.open(p3, 'w', encoding='utf-8', newline='').write(t)
print('ok')
