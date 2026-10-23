import io, os, re

root = r'E:\Zilux2开发'

def read(path):
    return io.open(os.path.join(root, path), encoding='utf-8', newline='').read()

def write(path, text):
    io.open(os.path.join(root, path), 'w', encoding='utf-8', newline='').write(text)

def sub(text, label, old, new):
    assert text.count(old) == 1, f'{label}: {text.count(old)}'
    return text.replace(old, new)

# ---------- 1. KugouProvider: 删除播放 / 登录，歌词加 KRC 逐字 ----------
p = 'src/Zilux2/Online/KugouProvider.cs'
t = read(p)
t = sub(t, 'drop using account',
        'using Zilux2.Online.Account;\n\n', '')
t = sub(t, 'header comment',
        '''// 酷狗音乐接入：
//   搜索 / 歌词走公开接口（匿名可用）；
//   播放地址需要登录态（网页 Cookie 里的 token / userid / dfid / mid）才拿得到，
//   所以登录模式是 cookie：用户在设置里导入一次浏览器 Cookie 即可。''',
        '''// 酷狗只作为「歌词来源」使用（不参与播放 / 登录 / 收藏）：
//   搜索 + 歌词都走公开接口，匿名可用；
//   歌词优先取 KRC（逐字，自行解密），失败再退 LRC。''')
t = sub(t, 'consts',
        '''    private const string PlayEndpoint = "https://wwwapi.kugou.com/yy/index.php";
    private const string PlaySignatureSecret = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt";
''', '')
t = sub(t, 'timeouts',
        '''    private static readonly TimeSpan StreamTimeout = TimeSpan.FromSeconds(8);
''', '')
t = sub(t, 'fields',
        '''    private readonly AccountService? _accounts;

    public KugouProvider(AccountService? accounts = null) => _accounts = accounts;

    public string Name => "kugou";

    private string AccountCookie => _accounts?.CookieHeader(Name, "kugou.com") ?? string.Empty;
''',
        '''    public string Name => "kugou";
''')
t = t.replace('cookie: AccountCookie)', ')')

# 歌词：KRC 优先 + LRC 兜底
start = t.index('    public async Task<LyricData> GetLyricAsync(')
end = t.index('    public async Task<StreamResolution> ResolveStreamAsync(')
lyric = '''    public async Task<LyricData> GetLyricAsync(string id, CancellationToken cancellationToken)
    {
        var (hash, duration, _, _) = DecodeId(id);
        if (hash.Length == 0)
        {
            return new LyricData();
        }

        var searchUrl = $"{LyricSearchEndpoint}?ver=1&man=yes&client=mobi&keyword=&duration={duration}&hash={hash}";
        var search = await OnlineHttp
            .FetchTextAsync(searchUrl, RefererUrl, LyricTimeout, cancellationToken)
            .ConfigureAwait(false);

        using var searchDocument = JsonDocument.Parse(search.Body);
        if (!searchDocument.RootElement.TryGetProperty("candidates", out var candidates) ||
            candidates.ValueKind != JsonValueKind.Array)
        {
            OnlineHttp.Info($"GET kugou/lyric id={hash} no candidates {search.TookMs}ms");
            return new LyricData();
        }

        var lrc = string.Empty;
        var wordLyric = string.Empty;
        foreach (var candidate in candidates.EnumerateArray())
        {
            var lyricId = ReadString(candidate, "id");
            var accessKey = ReadString(candidate, "accesskey");
            if (lyricId.Length == 0 || accessKey.Length == 0)
            {
                continue;
            }

            if (wordLyric.Length == 0)
            {
                wordLyric = await TryFetchKrcAsync(lyricId, accessKey, cancellationToken).ConfigureAwait(false);
            }

            if (lrc.Length == 0)
            {
                lrc = await TryFetchLrcAsync(lyricId, accessKey, cancellationToken).ConfigureAwait(false);
            }

            if (wordLyric.Length > 0 && (lrc.Length > 0 || wordLyric.Length > 0))
            {
                break;
            }
        }

        if (wordLyric.Length == 0 && lrc.Length == 0)
        {
            return new LyricData();
        }

        if (lrc.Length == 0)
        {
            lrc = wordLyric;
        }

        OnlineHttp.Info($"GET kugou/lyric id={hash} ok lrcChars={lrc.Length} krcChars={wordLyric.Length}");
        return new LyricData
        {
            Lrc = lrc,
            Yrc = wordLyric.Length > 0 ? wordLyric : null,
        };
    }

    // KRC 下载：base64 → 跳过 4 字节头 → 与 16 字节密钥循环 XOR → zlib 解压 → UTF8 明文
    private async Task<string> TryFetchKrcAsync(string lyricId, string accessKey, CancellationToken cancellationToken)
    {
        try
        {
            var url = $"{LyricDownloadEndpoint}?ver=1&client=android&id={lyricId}&accesskey={Uri.EscapeDataString(accessKey)}&fmt=krc&charset=utf8";
            var download = await OnlineHttp
                .FetchTextAsync(url, RefererUrl, LyricTimeout, cancellationToken)
                .ConfigureAwait(false);
            using var document = JsonDocument.Parse(download.Body);
            var encoded = ReadString(document.RootElement, "content");
            if (encoded.Length == 0)
            {
                return string.Empty;
            }

            var bytes = Convert.FromBase64String(encoded);
            if (!TryDecodeKrc(bytes, out var text) || text.Length == 0)
            {
                return string.Empty;
            }

            return ConvertKrcToCharLyric(text);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            OnlineHttp.Warn($"kugou/lyric krc failed: {OnlineHttp.Describe(exception)}");
            return string.Empty;
        }
    }

    private async Task<string> TryFetchLrcAsync(string lyricId, string accessKey, CancellationToken cancellationToken)
    {
        try
        {
            var url = $"{LyricDownloadEndpoint}?ver=1&client=pc&id={lyricId}&accesskey={Uri.EscapeDataString(accessKey)}&fmt=lrc&charset=utf8";
            var download = await OnlineHttp
                .FetchTextAsync(url, RefererUrl, LyricTimeout, cancellationToken)
                .ConfigureAwait(false);
            using var document = JsonDocument.Parse(download.Body);
            var encoded = ReadString(document.RootElement, "content");
            if (encoded.Length == 0)
            {
                return string.Empty;
            }

            var lrc = Encoding.UTF8.GetString(Convert.FromBase64String(encoded)).TrimStart('\\uFEFF');
            return lrc.Contains('[', StringComparison.Ordinal) ? lrc : string.Empty;
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            return string.Empty;
        }
    }

    private static bool TryDecodeKrc(byte[] bytes, out string text)
    {
        text = string.Empty;
        if (bytes.Length < 8)
        {
            return false;
        }

        // 前 4 字节是 "krc1"/"krc18" 之类的文件头
        var key = new byte[] { 64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105 };
        var payload = new byte[bytes.Length - 4];
        Buffer.BlockCopy(bytes, 4, payload, 0, payload.Length);
        for (var index = 0; index < payload.Length; index += 1)
        {
            payload[index] ^= key[index % key.Length];
        }

        try
        {
            using var input = new MemoryStream(payload);
            using var deflate = new System.IO.Compression.ZLibStream(input, System.IO.Compression.CompressionMode.Decompress);
            using var output = new MemoryStream();
            deflate.CopyTo(output);
            text = Encoding.UTF8.GetString(output.ToArray()).TrimStart('\\uFEFF');
            return text.Length > 0;
        }
        catch (Exception)
        {
            return false;
        }
    }

    // KRC 正文：`[行开始,行时长]<词偏移,词时长>词…`；转成和网易云 yrc 同样的
    // `[行开始,行时长](词绝对开始,词时长)词…`，前端沿用 parseCharLyric 就能逐字点亮。
    private static string ConvertKrcToCharLyric(string krc)
    {
        var lineHead = new System.Text.RegularExpressions.Regex(@"^\\[(\\d+),(\\d+)\\](.*)$");
        var wordTag = new System.Text.RegularExpressions.Regex(@"<(\\d+),(\\d+)(?:,\\d+)?>([^<]*)");
        var builder = new StringBuilder();
        foreach (var rawLine in krc.Split('\\n'))
        {
            var line = rawLine.Trim();
            var head = lineHead.Match(line);
            if (!head.Success)
            {
                continue;
            }

            var lineStart = long.Parse(head.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture);
            var lineDuration = long.Parse(head.Groups[2].Value, System.Globalization.CultureInfo.InvariantCulture);
            var body = head.Groups[3].Value;
            var words = new StringBuilder();
            foreach (System.Text.RegularExpressions.Match match in wordTag.Matches(body))
            {
                var offset = long.Parse(match.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture);
                var duration = long.Parse(match.Groups[2].Value, System.Globalization.CultureInfo.InvariantCulture);
                var word = match.Groups[3].Value;
                if (word.Length == 0)
                {
                    continue;
                }

                words.Append('(').Append(lineStart + offset).Append(',').Append(duration).Append(')').Append(word);
            }

            if (words.Length == 0)
            {
                continue;
            }

            builder.Append('[').Append(lineStart).Append(',').Append(lineDuration).Append(']')
                .Append(words).Append('\\n');
        }

        return builder.ToString();
    }

'''
t = t[:start] + lyric + t[end:]

# 播放：只返回不可播
start = t.index('    public async Task<StreamResolution> ResolveStreamAsync(')
end = t.index('    private static string ReadString(JsonElement element, string name)')
t = t[:start] + '''    public Task<StreamResolution> ResolveStreamAsync(string id, string? quality, CancellationToken cancellationToken) =>
        Task.FromResult(StreamResolution.NotPlayable("酷狗仅用于歌词搜索，不提供播放"));

''' + t[end:]

# 清掉播放遗留 helper（ParseCookie / Md5Hex）
t = re.sub(r'    private static Dictionary<string, string> ParseCookie\(string header\)[\s\S]*?\n    }\n\n', '', t)
t = re.sub(r'    private static string Md5Hex\(string value\)[\s\S]*?\n    }\n\n', '', t)
write(p, t)
print('ok KugouProvider')

# ---------- 2. 平台登记表：酷狗隐藏，仅歌词 ----------
p = 'src/Zilux2/Online/MusicSourceCatalog.cs'
t = read(p)
t = sub(t, 'hidden prop',
        '''    [JsonPropertyName("hasDaily30")] public bool HasDaily30 { get; init; }
''',
        '''    [JsonPropertyName("hasDaily30")] public bool HasDaily30 { get; init; }

    // 隐藏平台：只在「歌词搜索/匹配」里出现，不参与播放、登录、收藏、推荐
    [JsonPropertyName("hidden")] public bool Hidden { get; init; }
''')
t = sub(t, 'kugou descriptor',
        '''            Id = Kugou,
            Label = "酷狗音乐",
            Short = "酷",
            Accent = "#2fb0ff",
            // 酷狗 H5 扫码登录：/v2/qrcode 取二维码，/v2/get_userinfo_qrcode 轮询授权。
            LoginMode = "code",
            LoginHint = "打开手机酷狗音乐 App → 扫一扫，扫描二维码登录",
            FeedKinds = [],
            // 酷狗只返回整行 LRC，新版 krc18 逐字格式未公开算法。
            SupportsWordLyrics = false,
            SupportsLikedWrite = false,
            HasDaily30 = false,
            // 酷狗网页接口只返回一条播放地址，音质跟随账号权限，暂不支持切换
            Qualities =
            [
                new SourceQuality { Id = "high", Label = "平台默认", Detail = "跟随酷狗会员权限" },
            ],''',
        '''            Id = Kugou,
            Label = "酷狗音乐",
            Short = "酷",
            Accent = "#2fb0ff",
            // 酷狗只当歌词来源：不做登录 / 播放 / 收藏。
            Hidden = true,
            LoginMode = "",
            LoginHint = "仅用于歌词搜索",
            FeedKinds = [],
            // KRC 逐字歌词可解密，前端能逐字点亮
            SupportsWordLyrics = true,
            SupportsLikedWrite = false,
            HasDaily30 = false,
            Qualities = [],''')
write(p, t)
print('ok catalog')

# ---------- 3. 注册 provider 时不再传账号 ----------
p = 'src/Zilux2/Online/OnlineMusicService.cs'
t = read(p)
t = sub(t, 'provider ctor', 'new KugouProvider(Accounts)', 'new KugouProvider()')
write(p, t)
print('ok service')

# ---------- 4. AccountService 回到只有网易云 + QQ ----------
p = 'src/Zilux2/Online/Account/AccountService.cs'
t = read(p)
t = sub(t, 'all sources',
        'private static readonly string[] AllSources = [AccountSources.Netease, AccountSources.Qq, AccountSources.Kugou];',
        'private static readonly string[] AllSources = [AccountSources.Netease, AccountSources.Qq];')
t = sub(t, 'field', '''    private readonly QqLoginProvider _qq;
    private readonly KugouLoginProvider _kugou;
''', '''    private readonly QqLoginProvider _qq;
''')
t = sub(t, 'ctor', '''        _kugou = new KugouLoginProvider(_store);
''', '')
t = sub(t, 'log', 'sources=netease,qq,kugou', 'sources=netease,qq')
t = sub(t, 'refresh switch', '''                    AccountSources.Kugou => await _kugou.RefreshAsync(cookies, timeout.Token).ConfigureAwait(false),
''', '')
t = sub(t, 'qr switch', '''            AccountSources.Kugou => _kugou.CreateQrAsync(cancellationToken),
''', '')
t = sub(t, 'poll switch', '''            AccountSources.Kugou => _kugou.PollAsync(key, cancellationToken),
''', '')
t = sub(t, 'normalize', '''            : string.Equals(source, AccountSources.Kugou, StringComparison.OrdinalIgnoreCase)
                ? AccountSources.Kugou
                : AccountSources.Netease;''', '''            : AccountSources.Netease;''')
write(p, t)
print('ok account service')

# ---------- 5. AccountModels 去掉 Kugou 常量 ----------
p = 'src/Zilux2/Online/Account/AccountModels.cs'
t = read(p)
t = sub(t, 'kugou const', '    public const string Kugou = "kugou";\n', '')
write(p, t)
print('ok account models')

# ---------- 6. 删除酷狗登录 provider ----------
os.remove(os.path.join(root, 'src/Zilux2/Online/Account/KugouLoginProvider.cs'))
print('ok delete KugouLoginProvider')
