// T5 / SentencePiece(Unigram) 分词：只读 tokenizer.json，不依赖 Python。
using System.IO;
using System.Text;
using System.Text.Json;

namespace Zilux2.Analysis;

/// <summary>
/// HuggingFace <c>tokenizer.json</c> 的最小 Unigram 实现（T5 用的就是 Unigram）。
/// <para>
/// 说明：T5 的 normalizer 是 Precompiled（SentencePiece 的 DARTS 字符映射表），
/// 这里用 <see cref="NormalizationForm.FormKC"/> 近似；英文/数字/常用标点与官方分词一致，
/// 少数非拉丁字符可能差一个 token。分词结果只影响生成风格，不影响宿主稳定性。
/// </para>
/// </summary>
internal sealed class T5Tokenizer
{
    private const float UnkScorePenalty = 10f;
    private const int MaxPieceChars = 64;

    private readonly Dictionary<string, int> _vocab;
    private readonly float[] _scores;
    private readonly int[] _lengths;
    private readonly int _unkId;
    private readonly int _padId;
    private readonly int _eosId;
    private readonly float _unkScore;

    private T5Tokenizer(
        Dictionary<string, int> vocab,
        float[] scores,
        int[] lengths,
        int unkId,
        int padId,
        int eosId)
    {
        _vocab = vocab;
        _scores = scores;
        _lengths = lengths;
        _unkId = unkId;
        _padId = padId;
        _eosId = eosId;

        var min = 0f;
        foreach (var score in scores)
        {
            if (score < min)
            {
                min = score;
            }
        }

        _unkScore = min - UnkScorePenalty;
    }

    internal int VocabularySize => _scores.Length;

    internal static T5Tokenizer? TryLoad(string path, out string? error)
    {
        error = null;
        try
        {
            if (!File.Exists(path))
            {
                error = "tokenizer.json 不存在：" + path;
                return null;
            }

            using var document = JsonDocument.Parse(File.ReadAllBytes(path));
            if (!document.RootElement.TryGetProperty("model", out var model) ||
                !model.TryGetProperty("vocab", out var vocabElement) ||
                vocabElement.ValueKind != JsonValueKind.Array)
            {
                error = "tokenizer.json 缺少 model.vocab";
                return null;
            }

            var vocab = new Dictionary<string, int>(StringComparer.Ordinal);
            var scores = new List<float>(4096);
            var index = 0;

            foreach (var item in vocabElement.EnumerateArray())
            {
                string? piece = null;
                var score = 0f;

                if (item.ValueKind == JsonValueKind.Array)
                {
                    var enumerator = item.EnumerateArray();
                    if (enumerator.MoveNext())
                    {
                        piece = enumerator.Current.GetString();
                    }

                    if (enumerator.MoveNext() && enumerator.Current.ValueKind == JsonValueKind.Number)
                    {
                        score = (float)enumerator.Current.GetDouble();
                    }
                }
                else if (item.ValueKind == JsonValueKind.Object)
                {
                    piece = item.TryGetProperty("piece", out var pieceElement) ? pieceElement.GetString() : null;
                    if (item.TryGetProperty("score", out var scoreElement) && scoreElement.ValueKind == JsonValueKind.Number)
                    {
                        score = (float)scoreElement.GetDouble();
                    }
                }

                if (!string.IsNullOrEmpty(piece))
                {
                    vocab[piece] = index;
                }

                scores.Add(score);
                index++;
            }

            var maxLengths = new HashSet<int>();
            foreach (var piece in vocab.Keys)
            {
                maxLengths.Add(Math.Min(piece.Length, MaxPieceChars));
            }

            var lengths = new List<int>(maxLengths);
            lengths.Sort();

            var unkId = ReadInt(model, "unk_id", 2);
            var padId = FindSpecial(vocab, document.RootElement, "<pad>", 0);
            var eosId = FindSpecial(vocab, document.RootElement, "</s>", 1);

            return new T5Tokenizer(vocab, scores.ToArray(), lengths.ToArray(), unkId, padId, eosId);
        }
        catch (Exception exception)
        {
            error = $"{exception.GetType().Name}: {exception.Message}";
            return null;
        }
    }

    /// <summary>编码为 T5 的 input_ids（含 EOS、右侧补 pad），mask 同步。</summary>
    internal (long[] Ids, long[] Mask) Encode(string text, int maxLength)
    {
        maxLength = Math.Max(2, maxLength);
        var ids = new List<int>(maxLength);
        var normalized = Normalize(text);

        if (normalized.Length > 0)
        {
            var chars = normalized.Length;
            var best = new double[chars + 1];
            var choice = new int[chars + 1];
            best[chars] = 0;

            for (var i = chars - 1; i >= 0; i--)
            {
                double bestScore = double.NegativeInfinity;
                var bestLength = 0;

                foreach (var length in _lengths)
                {
                    if (i + length > chars)
                    {
                        break;
                    }

                    if (!_vocab.TryGetValue(normalized.Substring(i, length), out var id))
                    {
                        continue;
                    }

                    var score = _scores[id] + best[i + length];
                    if (score > bestScore)
                    {
                        bestScore = score;
                        bestLength = length;
                    }
                }

                if (bestLength == 0)
                {
                    // 词表里没有：按一个 UTF-16 单元（代理对取两个）当 unk。
                    var length = char.IsHighSurrogate(normalized[i]) && i + 1 < chars ? 2 : 1;
                    bestScore = _unkScore + best[i + length];
                    bestLength = length;
                }

                best[i] = bestScore;
                choice[i] = bestLength;
            }

            for (var i = 0; i < chars && ids.Count < maxLength - 1;)
            {
                var length = choice[i];
                ids.Add(_vocab.TryGetValue(normalized.Substring(i, length), out var id) ? id : _unkId);
                i += length;
            }
        }

        ids.Add(_eosId);

        var resultIds = new long[maxLength];
        var mask = new long[maxLength];
        for (var i = 0; i < maxLength; i++)
        {
            resultIds[i] = i < ids.Count ? ids[i] : _padId;
            mask[i] = i < ids.Count ? 1 : 0;
        }

        return (resultIds, mask);
    }

    private static string Normalize(string text)
    {
        if (string.IsNullOrEmpty(text))
        {
            return string.Empty;
        }

        string normalized;
        try
        {
            normalized = text.Normalize(NormalizationForm.FormKC);
        }
        catch
        {
            normalized = text;
        }

        var builder = new StringBuilder(normalized.Length + 2);
        var pendingSpace = false;
        foreach (var ch in normalized)
        {
            if (char.IsWhiteSpace(ch))
            {
                pendingSpace = builder.Length > 0;
                continue;
            }

            if (pendingSpace)
            {
                builder.Append('\u2581');
                pendingSpace = false;
            }

            builder.Append(ch);
        }

        if (builder.Length == 0)
        {
            return string.Empty;
        }

        // SentencePiece 的 add_dummy_prefix。
        return "\u2581" + builder.ToString().Replace(' ', '\u2581');
    }

    private static int ReadInt(JsonElement model, string name, int fallback) =>
        model.TryGetProperty(name, out var element) && element.ValueKind == JsonValueKind.Number
            ? element.GetInt32()
            : fallback;

    private static int FindSpecial(
        Dictionary<string, int> vocab,
        JsonElement root,
        string content,
        int fallback)
    {
        if (vocab.TryGetValue(content, out var id))
        {
            return id;
        }

        if (root.TryGetProperty("added_tokens", out var added) && added.ValueKind == JsonValueKind.Array)
        {
            foreach (var token in added.EnumerateArray())
            {
                if (token.TryGetProperty("content", out var contentElement) &&
                    string.Equals(contentElement.GetString(), content, StringComparison.Ordinal) &&
                    token.TryGetProperty("id", out var idElement) &&
                    idElement.ValueKind == JsonValueKind.Number)
                {
                    return idElement.GetInt32();
                }
            }
        }

        return fallback;
    }
}
