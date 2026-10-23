# -*- coding: utf-8 -*-
"""歌词手动选择：把歌词解析抽成 docFromLyric，并支持按曲目手动指定来源（记住选择）。"""
import io

LY = r'E:\Zilux2开发\web\src\ui\lyrics.ts'


def read(path):
    return io.open(path, 'r', encoding='utf-8', newline='').read()


def write(path, text):
    io.open(path, 'w', encoding='utf-8', newline='').write(text)


t = read(LY)
nl = '\r\n' if '\r\n' in t else '\n'
L = lambda s: s.replace('\n', nl)


def rep(old, new):
    global t
    old, new = L(old), L(new)
    assert t.count(old) == 1, old[:70]
    t = t.replace(old, new)


# ---------- 1. 模块状态：手动选择 ----------
rep("""let lyricMatchMode: 'word' | 'translation' = 'word';""",
    """let lyricMatchMode: 'word' | 'translation' = 'word';
/** 手动选择的歌词来源（非空时不再自动匹配）。 */
let manualLyricLabel = '';
/** 每首歌记住的手动歌词来源：trackKey -> { source, id, label }。 */
const MANUAL_KEY = 'zilux2.lyricManual';
interface ManualLyric {
  source: string;
  id: string;
  label: string;
}
function readManual(): Record<string, ManualLyric> {
  try {
    const raw = window.localStorage.getItem(MANUAL_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, ManualLyric>;
  } catch {
    return {};
  }
}
function writeManual(map: Record<string, ManualLyric>): void {
  try {
    window.localStorage.setItem(MANUAL_KEY, JSON.stringify(map));
  } catch {
    /* 忽略写入失败 */
  }
}""")

# ---------- 2. 抽出 docFromLyric（放在 loadLyricDoc 之前） ----------
anchor = L("/** 拉取并解析当前曲目歌词。 */\nexport async function loadLyricDoc(track: OnlineTrack | null): Promise<LyricDoc> {")
assert t.count(anchor) == 1, 'loadLyricDoc anchor'
helper = L("""interface PlatformLyric {
  qrc?: string | null;
  yrc?: string | null;
  lrc?: string | null;
  translation?: string | null;
}

/** 平台歌词负载（QRC / YRC / LRC）→ 统一歌词文档 + 来源说明。 */
function docFromLyric(
  track: OnlineTrack,
  lyric: PlatformLyric,
  prefix = '',
): { doc: LyricDoc; label: string } {
  const key = trackKeyOf(track);
  const platform = SOURCE_LABEL[track.source] ?? track.source;
  if (lyric.qrc) {
    try {
      const payload = extractQrcPayload(decryptQrc(lyric.qrc));
      const qrcLines = parseQrcLyric(payload);
      if (qrcLines.length > 0) {
        return {
          doc: {
            kind: 'qrc',
            trackKey: key,
            lines: qrcLines.map((line) => ({
              timeMs: line.timeMs,
              durationMs: line.durationMs,
              text: joinWords(line.words),
              translation: '',
              words: line.words.map((word) => ({ ...word })),
            })),
          },
          label: `${prefix}${platform} · 逐字（QRC）`,
        };
      }
    } catch (err) {
      console.warn('[lyrics] qrc decode failed', err);
    }
  }
  if (lyric.yrc) {
    const charLines = parseCharLyric(lyric.yrc);
    if (charLines.length > 0) {
      return {
        doc: {
          kind: 'yrc',
          trackKey: key,
          lines: charLines.map((line) => ({
            timeMs: line.timeMs,
            durationMs: line.durationMs,
            text: line.chars.map((char) => char.text).join(''),
            translation: '',
            words: line.chars.map((char) => ({ text: char.text, startMs: char.startMs, endMs: char.endMs })),
          })),
        },
        label: `${prefix}${platform} · 逐字（YRC）`,
      };
    }
  }
  return {
    doc: {
      kind: 'lrc',
      trackKey: key,
      lines: toDocLines(applyTranslation(parseLrc(lyric.lrc), lyric.translation)),
    },
    label: `${prefix}${platform} · LRC${lyric.translation ? ' + 翻译' : ''}`,
  };
}

/** 拉取并解析当前曲目歌词。 */
export async function loadLyricDoc(track: OnlineTrack | null): Promise<LyricDoc> {""")
t = t.replace(anchor, helper)

# ---------- 3. 在线分支改用手动来源优先 + docFromLyric ----------
rep("""  let lyric;
  try {
    lyric = await fetchLyric(track.source, track.id);
  } catch (err) {
    console.warn('[lyrics] fetch failed', err);
    return { ...EMPTY, trackKey: key };
  }

  // 1) QQ QRC：解密 → 取 LyricContent → 按「字在前」解析
  if (lyric.qrc) {
    try {
      const payload = extractQrcPayload(decryptQrc(lyric.qrc));
      const qrcLines = parseQrcLyric(payload);
      if (qrcLines.length > 0) {
        lyricSource = 'QQ 音乐 · 逐字（QRC）';
        return {
          kind: 'qrc',
          trackKey: key,
          lines: qrcLines.map((line) => ({
            timeMs: line.timeMs,
            durationMs: line.durationMs,
            text: joinWords(line.words),
            translation: '',
            words: line.words.map((word) => ({ ...word })),
          })),
        };
      }
    } catch (err) {
      console.warn('[lyrics] qrc decode failed', err);
    }
  }

  // 2) 网易云 yrc 逐字（`(start,dur,0)字`）
  if (lyric.yrc) {
    const charLines = parseCharLyric(lyric.yrc);
    if (charLines.length > 0) {
      lyricSource = '网易云 · 逐字（YRC）';
      return {
        kind: 'yrc',
        trackKey: key,
        lines: charLines.map((line) => ({
          timeMs: line.timeMs,
          durationMs: line.durationMs,
          text: line.chars.map((char) => char.text).join(''),
          translation: '',
          words: line.chars.map((char) => ({ text: char.text, startMs: char.startMs, endMs: char.endMs })),
        })),
      };
    }
  }

  // 3) 普通 LRC（含翻译）
  lyricSource = `${SOURCE_LABEL[track.source] ?? track.source} · LRC${lyric.translation ? ' + 翻译' : ''}`;
  const lines = applyTranslation(parseLrc(lyric.lrc), lyric.translation);
  return {
    kind: 'lrc',
    trackKey: key,
    lines: toDocLines(lines),
  };
}""",
    """  // 0) 手动选择的来源优先（记住到本曲目）
  const manual = readManual()[key];
  if (manual) {
    try {
      const picked = await fetchLyric(manual.source, manual.id);
      const built = docFromLyric(track, picked, `${manual.label} · 手动选择 · `);
      if (built.doc.lines.length > 0) {
        manualLyricLabel = manual.label;
        lyricSource = built.label;
        return built.doc;
      }
    } catch (err) {
      console.warn('[lyrics] manual lyric failed', err);
    }
  }

  let lyric;
  try {
    lyric = await fetchLyric(track.source, track.id);
  } catch (err) {
    console.warn('[lyrics] fetch failed', err);
    return { ...EMPTY, trackKey: key };
  }
  const built = docFromLyric(track, lyric);
  lyricSource = built.label;
  return built.doc;
}""")

# ---------- 4. 手动选择 API + 自动匹配跳过 ----------
anchor2 = L("/** 找出当前应高亮的行（最近一条 timeMs ≤ position + 120ms）。 */")
if t.count(anchor2) != 1:
    import re
    m = re.search(r"/\*\* 找出当前应高亮的行[^\n]*\*/\n", t)
    assert m, 'activeIndex anchor'
    anchor2 = m.group(0)

api = L("""/** 当前曲目是否手动选了歌词来源。 */
export function manualLyricLabelOf(): string {
  return manualLyricLabel;
}

/** 手动指定这首歌用哪个平台的哪份歌词（会记住）。 */
export async function applyManualLyric(
  track: OnlineTrack,
  source: string,
  id: string,
  label: string,
): Promise<boolean> {
  try {
    const lyric = await fetchLyric(source, id);
    const built = docFromLyric(track, lyric, `${label} · 手动选择 · `);
    if (built.doc.lines.length === 0) return false;
    const key = trackKeyOf(track);
    const map = readManual();
    map[key] = { source, id, label };
    writeManual(map);
    manualLyricLabel = label;
    lyricSource = built.label;
    lyricMatchInfo = null;
    lyricMatchSkipped = true;
    lyricMatchDone = true;
    lastDoc = built.doc;
    updateCurrentLyricLine();
    notifyMatch();
    return true;
  } catch (err) {
    console.warn('[lyrics] apply manual failed', err);
    return false;
  }
}

/** 恢复自动匹配（清掉本曲目的手动选择）。 */
export function clearManualLyric(track: OnlineTrack): void {
  const key = trackKeyOf(track);
  const map = readManual();
  if (map[key]) {
    delete map[key];
    writeManual(map);
  }
  manualLyricLabel = '';
}

""")
t = t.replace(anchor2, api + anchor2)

# startLyricMatch 开头：手动选择时不再自动匹配
rep("""  lyricMatchInfo = null;
  const baseHasTranslation = base.lines.some((line) => (line.translation ?? '').trim().length > 0);""",
    """  lyricMatchInfo = null;
  if (manualLyricLabel) {
    // 用户手动选了歌词来源：以手动选择为准，不再后台替换。
    lyricMatchSkipped = true;
    lyricMatchDone = true;
    notifyMatch();
    return;
  }
  const baseHasTranslation = base.lines.some((line) => (line.translation ?? '').trim().length > 0);""")

# 文案：手动选择
rep("""export function lyricMatchText(): string {
  const translationMode = lyricMatchMode === 'translation';""",
    """export function lyricMatchText(): string {
  if (manualLyricLabel) return `手动选择：${manualLyricLabel}`;
  const translationMode = lyricMatchMode === 'translation';""")

rep("""  if (lyricMatchSkipped) return `${lyricSource} · 已自带逐字与翻译`;""",
    """  if (manualLyricLabel) return `${lyricSource} · 手动选择`;
  if (lyricMatchSkipped) return `${lyricSource} · 已自带逐字与翻译`;""")

# loadLyricDoc 开头重置手动状态
rep("""  lyricSource = '';
  lyricMatchInfo = null;
  lyricMatchSkipped = false;
  lyricMatchDone = false;""",
    """  lyricSource = '';
  lyricMatchInfo = null;
  lyricMatchSkipped = false;
  lyricMatchDone = false;
  manualLyricLabel = '';""")

write(LY, t)
print('lyrics manual ok')
