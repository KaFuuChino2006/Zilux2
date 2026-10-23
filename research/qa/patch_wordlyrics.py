import io
from pathlib import Path

ROOT = Path(r"E:\Zilux2开发")


def patch(rel, steps):
    p = ROOT / rel
    with io.open(str(p), "r", encoding="utf-8", newline="") as f:
        raw = f.read()
    nl = "\r\n" if "\r\n" in raw else "\n"
    text = raw.replace("\r\n", "\n")
    for name, old, new in steps:
        assert text.count(old) == 1, f"{name}: count={text.count(old)}"
        text = text.replace(old, new)
    out = text.replace("\n", nl)
    with io.open(str(p), "w", encoding="utf-8", newline="") as f:
        f.write(out)
    print("OK:", rel, len(steps), "steps")


patch("src/Zilux2/Online/IOnlineMusicProvider.cs", [
    ("lyric-data-qrc",
     """    // 逐字歌词原文（网易云 yrc / QQ qrc，格式 `[start,dur](start,dur)字…`），前端自行解析
    public string? Yrc { get; init; }
""",
     """    // 逐字歌词原文（网易云 yrc，格式 `[start,dur](start,dur)字…`），前端自行解析
    public string? Yrc { get; init; }

    // QQ QRC 加密十六进制原文（前端用 qrc-decoder 本地解密），仅 QQ 有
    public string? Qrc { get; init; }
"""),
])

patch("src/Zilux2/Online/OnlineMusicModels.cs", [
    ("lyric-response-qrc",
     """    [JsonPropertyName("hasYrc")] public bool HasYrc { get; init; }
""",
     """    [JsonPropertyName("hasYrc")] public bool HasYrc { get; init; }

    // QQ QRC 加密十六进制（可选）：前端解密后得到逐字时间轴
    [JsonPropertyName("qrc")] public string? Qrc { get; init; }

    [JsonPropertyName("hasQrc")] public bool HasQrc { get; init; }
"""),
])

patch("src/Zilux2/Online/QqProvider.cs", [
    ("lyric-qrc-call",
     """            var lrc = retcode == 0 ? DecodeHtml(ReadString(root, "lyric")) : string.Empty;
            var translation = retcode == 0 ? DecodeHtml(ReadString(root, "trans")) : string.Empty;
            OnlineHttp.Info($"GET qq/lyric id={id} ok lrcChars={lrc.Length} {upstream.TookMs}ms");
            return new LyricData { Lrc = lrc, Translation = string.IsNullOrWhiteSpace(translation) ? null : translation };
""",
     """            var lrc = retcode == 0 ? DecodeHtml(ReadString(root, "lyric")) : string.Empty;
            var translation = retcode == 0 ? DecodeHtml(ReadString(root, "trans")) : string.Empty;
            var qrc = retcode == 0 ? await TryFetchQrcAsync(id, cancellationToken).ConfigureAwait(false) : null;
            OnlineHttp.Info($"GET qq/lyric id={id} ok lrcChars={lrc.Length} qrcHexChars={qrc?.Length ?? 0} {upstream.TookMs}ms");
            return new LyricData
            {
                Lrc = lrc,
                Translation = string.IsNullOrWhiteSpace(translation) ? null : translation,
                Qrc = qrc,
            };
"""),
    ("lyric-qrc-method",
     """    public async Task<StreamResolution> ResolveStreamAsync(string id, CancellationToken cancellationToken)
""",
     """    /// <summary>QQ QRC 逐词歌词（加密十六进制）：失败返回 null，不影响普通 LRC 主流程。</summary>
    private async Task<string?> TryFetchQrcAsync(string id, CancellationToken cancellationToken)
    {
        var body =
            "{\\"comm\\":{\\"ct\\":11,\\"cv\\":\\"1003006\\",\\"v\\":\\"1003006\\",\\"uin\\":\\"0\\"}," +
            "\\"req\\":{\\"module\\":\\"music.musichallSong.PlayLyricInfo\\",\\"method\\":\\"GetPlayLyricInfo\\"," +
            $"\\"param\\":{{\\"songMID\\":\\"{id}\\",\\"format\\":\\"qrc\\",\\"qrc\\":1}}}}}}";
        try
        {
            var upstream = await OnlineHttp.FetchTextAsync(
                    VkeyEndpoint,
                    RefererUrl,
                    LyricTimeout,
                    cancellationToken,
                    HttpMethod.Post,
                    body,
                    VkeyCookie)
                .ConfigureAwait(false);
            using var document = JsonDocument.Parse(upstream.Body);
            if (!document.RootElement.TryGetProperty("req", out var req) ||
                !req.TryGetProperty("data", out var data))
            {
                OnlineHttp.Warn($"GET qq/qrc id={id} failed: no data");
                return null;
            }

            var hex = ReadString(data, "lyric");
            if (string.IsNullOrWhiteSpace(hex))
            {
                OnlineHttp.Warn($"GET qq/qrc id={id} failed: empty lyric");
                return null;
            }

            OnlineHttp.Info($"GET qq/qrc id={id} ok hexChars={hex.Length} {upstream.TookMs}ms");
            return hex;
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            OnlineHttp.Warn($"GET qq/qrc id={id} failed: {OnlineHttp.Describe(exception)}");
            return null;
        }
    }

    public async Task<StreamResolution> ResolveStreamAsync(string id, CancellationToken cancellationToken)
"""),
])

patch("src/Zilux2/Online/LocalMusicServer.cs", [
    ("lyric-response-build",
     """                Yrc = lyric.Yrc,
                HasYrc = !string.IsNullOrWhiteSpace(lyric.Yrc),
""",
     """                Yrc = lyric.Yrc,
                HasYrc = !string.IsNullOrWhiteSpace(lyric.Yrc),
                Qrc = lyric.Qrc,
                HasQrc = !string.IsNullOrWhiteSpace(lyric.Qrc),
"""),
])

patch("web/src/online/types.ts", [
    ("online-lyric-qrc",
     """  /** 逐字歌词原文（YRC/QRC 同构：`[start,dur](start,dur)字…`），可空 */
  yrc?: string | null;
  hasYrc?: boolean;
""",
     """  /** 逐字歌词原文（QRC 解密后同构：`[start,dur](start,dur)字…`），可空 */
  yrc?: string | null;
  hasYrc?: boolean;
  /** QQ QRC 加密十六进制（需要 qrc-decoder 解密），可空 */
  qrc?: string | null;
  hasQrc?: boolean;
"""),
])

patch("web/src/online/lrc.ts", [
    ("lyric-line-words",
     """export interface LyricLine {
  /** 行开始时间（毫秒） */
  timeMs: number;
  text: string;
  /** 翻译（若有） */
  translation?: string;
}
""",
     """export interface LyricLine {
  /** 行开始时间（毫秒） */
  timeMs: number;
  text: string;
  /** 翻译（若有） */
  translation?: string;
  /** 增强 LRC 的行内词级时间轴（`<mm:ss.xx>词`），有则前端按词点亮 */
  words?: LyricWord[];
}

/** 增强 LRC 里的一个词：时间来自行内 `<mm:ss.xx>` 标签。 */
export interface LyricWord {
  text: string;
  startMs: number;
}
"""),
    ("word-segments-helper",
     """const TIME_TAG = /\\[(\\d{1,3}):(\\d{1,2})(?:[.:](\\d{1,3}))?\\]/g;
""",
     """const TIME_TAG = /\\[(\\d{1,3}):(\\d{1,2})(?:[.:](\\d{1,3}))?\\]/g;
const WORD_TAG = /<(\\d{1,3}):(\\d{1,2})(?:[.:](\\d{1,3}))?>/g;

/**
 * 解析增强 LRC 的行内词级标签：`<00:12.34>第一<00:12.80>个字`。
 * 纯 LRC 返回 null（由调用方按整句处理）。
 */
function parseWordSegments(text: string): { plain: string; words: LyricWord[] } | null {
  WORD_TAG.lastIndex = 0;
  if (!WORD_TAG.test(text)) return null;
  WORD_TAG.lastIndex = 0;
  const words: LyricWord[] = [];
  let lastIndex = 0;
  let pendingStart = -1;
  let pendingText = '';
  let match: RegExpExecArray | null;
  while ((match = WORD_TAG.exec(text)) !== null) {
    const prefix = text.slice(lastIndex, match.index);
    if (pendingStart >= 0) {
      pendingText += prefix;
      const trimmed = pendingText.trim();
      if (trimmed) words.push({ text: trimmed, startMs: pendingStart });
    }
    pendingStart = toMs(match[1] ?? '0', match[2] ?? '0', match[3]);
    pendingText = '';
    lastIndex = match.index + match[0].length;
  }
  if (pendingStart >= 0) {
    pendingText += text.slice(lastIndex);
    const trimmed = pendingText.trim();
    if (trimmed) words.push({ text: trimmed, startMs: pendingStart });
  }
  if (words.length === 0) return null;
  return { plain: words.map((word) => word.text).join(''), words };
}
"""),
    ("parse-lrc-words",
     """    const text = line.slice(lastIndex).trim();
    if (!text) continue;
    for (const timeMs of stamps) {
      lines.push({ timeMs: Math.max(0, timeMs + offset), text });
    }
""",
     """    const text = line.slice(lastIndex).trim();
    if (!text) continue;
    const wordSegments = parseWordSegments(text);
    for (const timeMs of stamps) {
      const entry: LyricLine = {
        timeMs: Math.max(0, timeMs + offset),
        text: wordSegments ? wordSegments.plain : text,
      };
      if (wordSegments) entry.words = wordSegments.words;
      lines.push(entry);
    }
"""),
    ("extract-qrc",
     """/**
 * 解析逐字歌词。网易云 yrc 与 QQ qrc 同构：
""",
     """const QRC_CONTENT = /LyricContent="([\\s\\S]*?)"/;

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\\d+);/g, (_, code: string) => String.fromCodePoint(Number(code) || 32))
    .replace(/&amp;/g, '&');
}

/**
 * 从解密后的 QRC XML 里取出逐字歌词正文（`[start,dur](start,dur)字…`）。
 * 非 XML（已是纯正文）时原样返回；解析失败返回空串。
 */
export function extractQrcPayload(decrypted: string): string {
  if (!decrypted) return '';
  const match = QRC_CONTENT.exec(decrypted);
  const body = match ? unescapeXml(match[1] ?? '') : decrypted;
  if (!body.includes('[')) return '';
  return body
    .replace(/\\[(ti|ar|al|by|offset|re|ve):[^\\]]*\\]/gi, '')
    .replace(/\\r/g, '');
}

/**
 * 解析逐字歌词。网易云 yrc 与 QQ qrc 同构：
"""),
])

patch("web/src/ui/spaceShell.ts", [
    ("lrc-import",
     "import { applyTranslation, parseCharLyric, parseLrc } from '../online/lrc';",
     """import { decryptQrc } from 'qrc-decoder';
import { applyTranslation, extractQrcPayload, parseCharLyric, parseLrc } from '../online/lrc';"""),
    ("qrc-helper",
     """  function lyricLinesFromText(lrcText: string, translation?: string | null, yrc?: string | null): LyricLineData[] {
""",
     """  /** QQ QRC 加密十六进制 → 逐字正文；失败返回空串（退回普通 LRC）。 */
  function qrcPayloadToText(hex: string): string {
    try {
      return extractQrcPayload(decryptQrc(hex));
    } catch (error) {
      host.log('warn', `[lyrics] qrc decode failed: ${String(error)}`);
      return '';
    }
  }

  function lyricLinesFromText(lrcText: string, translation?: string | null, yrc?: string | null): LyricLineData[] {
"""),
    ("lyric-lines-words",
     """      const glyphs = Array.from(line.text).filter((char) => char.trim().length > 0);
      const timed = charLines.find((entry) => Math.abs(entry.timeMs - line.timeMs) <= 260);
      let chars = timed
        ? timed.chars.map((char) => ({ text: char.text, start: char.startMs / 1000, end: char.endMs / 1000 }))
        : [];
""",
     """      const glyphs = Array.from(line.text).filter((char) => char.trim().length > 0);
      const wordTimed = (line.words ?? []).map((word, i) => {
        const nextMs = line.words?.[i + 1]?.startMs ?? word.startMs + 900;
        return { text: word.text, start: word.startMs / 1000, end: Math.max(word.startMs + 120, nextMs) / 1000 };
      });
      const timed = charLines.find((entry) => Math.abs(entry.timeMs - line.timeMs) <= 260);
      const chars = wordTimed.length > 0
        ? wordTimed
        : timed
          ? timed.chars.map((char) => ({ text: char.text, start: char.startMs / 1000, end: char.endMs / 1000 }))
          : [];
"""),
    ("search-online-qrc",
     """        const lines = lyricLinesFromText(lyric.lrc, lyric.translation, lyric.yrc);
""",
     """        const qrcPlain = lyric.qrc ? qrcPayloadToText(lyric.qrc) : '';
        const lines = lyricLinesFromText(lyric.lrc, lyric.translation, qrcPlain || lyric.yrc);
"""),
    ("online-qrc-prefer",
     """      // 逐字时间轴：优先用 yrc/qrc；没有时按行时长把整句均分给每个字（也能逐字点亮）
      const charLines = parseCharLyric(lyric.yrc);
""",
     """      // 逐字时间轴：优先 QQ QRC（本地解密），其次网易云 yrc；都没有时按行时长均分到字
      const qrcPlain = lyric.qrc ? qrcPayloadToText(lyric.qrc) : '';
      const charLines = parseCharLyric(qrcPlain || lyric.yrc);
"""),
])
