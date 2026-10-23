import io

path = r'E:\Zilux2开发\src\Zilux2\Online\Account\KugouLoginProvider.cs'
text = io.open(path, encoding='utf-8', newline='').read()

def apply(label, old, new):
    global text
    assert text.count(old) == 1, f'{label}: {text.count(old)}'
    text = text.replace(old, new)
    print('ok', label)

apply('consts',
'''    private const string ProfileClientVer = "20489";''',
'''    private const string ProfileClientVer = "20489";
    private const string LoginTokenHost = "http://login.user.kugou.com";
    private const string TokenAesKey = "90b8382a1bb4ccdcf063102053fd75b8";
    private const string TokenAesIv = "f063102053fd75b8";
    private const string AndroidSalt = "OIlwieks28dk2k092lksi2UIkp";''')

apply('login exchange',
'''        var profile = await TryFetchProfileAsync(token, userId, session.Mid, session.Dfid, cookies, cancellationToken).ConfigureAwait(false);''',
'''        var exchanged = await ExchangeTokenAsync(token, userId, session.Mid, session.Dfid, cancellationToken).ConfigureAwait(false);
        if (exchanged is { Length: > 0 } && exchanged != token)
        {
            token = exchanged;
            cookies[0] = new StoredCookie(".kugou.com", "token", token);
        }

        var profile = await TryFetchProfileAsync(token, userId, session.Mid, session.Dfid, cookies, cancellationToken).ConfigureAwait(false);''')

apply('refresh exchange',
'''        var profile = await TryFetchProfileAsync(token, userId, mid, dfid, cookies, cancellationToken).ConfigureAwait(false);
        if (profile.Nickname is null && profile.Avatar is null)
        {
            return null;
        }''',
'''        var profile = await TryFetchProfileAsync(token, userId, mid, dfid, cookies, cancellationToken).ConfigureAwait(false);
        if (profile.Nickname is null && profile.Avatar is null && token.Length > 0)
        {
            var exchanged = await ExchangeTokenAsync(token, userId, mid, dfid, cancellationToken).ConfigureAwait(false);
            if (exchanged is { Length: > 0 } && exchanged != token)
            {
                token = exchanged;
                var next = cookies.Where(item => !string.Equals(item.Name, "token", StringComparison.Ordinal)).ToList();
                next.Insert(0, new StoredCookie(".kugou.com", "token", token));
                cookies = next;
                profile = await TryFetchProfileAsync(token, userId, mid, dfid, cookies, cancellationToken).ConfigureAwait(false);
            }
        }

        if (profile.Nickname is null && profile.Avatar is null)
        {
            return null;
        }''')

methods = '''    // 扫码只下发短期 token；真机客户端会立刻调 /v5/login_by_token 换成长期 token。
    // 不换的话后面 relation.user.kugou.com 的资料接口会稳定返回 error_code 20018。
    private async Task<string?> ExchangeTokenAsync(
        string token,
        string userId,
        string mid,
        string dfid,
        CancellationToken cancellationToken)
    {
        try
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var seconds = now / 1000;
            var p3 = AesEncryptHex(JsonSerializer.Serialize(new { clienttime = seconds, token }), TokenAesKey, TokenAesIv);
            var tempKey = Guid.NewGuid().ToString("N").Substring(0, 16).ToLowerInvariant();
            var encryptKey = Md5Hex(tempKey);
            var paramsEncrypted = AesEncryptHex("{}", encryptKey, encryptKey.Substring(16));
            var pk = RsaEncryptHex(JsonSerializer.Serialize(new { clienttime_ms = now, key = tempKey }), ProfileRsaPem);
            var body = JsonSerializer.Serialize(new
            {
                dfid,
                p3,
                plat = 1,
                t1 = 0,
                t2 = 0,
                t3 = "MCwwLDAsMCwwLDAsMCwwLDA=",
                pk,
                userid = userId,
                clienttime_ms = now,
                @params = paramsEncrypted,
            });

            var query = new SortedDictionary<string, string>(StringComparer.Ordinal)
            {
                ["appid"] = ProfileAppId.ToString(CultureInfo.InvariantCulture),
                ["clienttime"] = seconds.ToString(CultureInfo.InvariantCulture),
                ["clientver"] = ProfileClientVer,
                ["dfid"] = dfid,
                ["mid"] = mid,
                ["token"] = token,
                ["userid"] = userId,
                ["uuid"] = "-",
            };
            query["signature"] = AndroidSign(query, body);

            var fullUrl = LoginTokenHost + "/v5/login_by_token?" + BuildQuery(query);
            using var request = OnlineHttp.NewRequest(HttpMethod.Post, fullUrl, Referer);
            request.Content = new StringContent(body, Encoding.UTF8, "application/json");
            request.Headers.TryAddWithoutValidation("dfid", dfid);
            request.Headers.TryAddWithoutValidation("mid", mid);
            request.Headers.TryAddWithoutValidation("clienttime", query["clienttime"]);
            request.Headers.TryAddWithoutValidation("kg-rc", "1");
            request.Headers.TryAddWithoutValidation("kg-thash", "5d816a0");
            request.Headers.TryAddWithoutValidation("kg-rec", "1");
            request.Headers.TryAddWithoutValidation("kg-rf", "B9EDA08A64250DEFFBCADDEE00F8F25F");
            using var response = await OnlineHttp.Client.SendAsync(request, cancellationToken).ConfigureAwait(false);
            var text = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            OnlineHttp.Info($"[account] kugou token exchange status={(int)response.StatusCode} body={Truncate(text)}");
            if (!response.IsSuccessStatusCode)
            {
                return null;
            }

            using var document = JsonDocument.Parse(text);
            if (!document.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            if (data.TryGetProperty("secu_params", out var secu) && secu.ValueKind == JsonValueKind.String)
            {
                var decrypted = AesDecryptHex(secu.GetString() ?? string.Empty, encryptKey, encryptKey.Substring(16));
                if (decrypted is not null)
                {
                    using var secuDocument = JsonDocument.Parse(decrypted);
                    if (TryGetProperty(secuDocument.RootElement, "token", out var inner)
                        && inner.ValueKind == JsonValueKind.String)
                    {
                        return inner.GetString();
                    }
                }
            }

            return TryGetProperty(data, "token", out var direct) && direct.ValueKind == JsonValueKind.String
                ? direct.GetString()
                : null;
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            OnlineHttp.Warn($"[account] kugou token exchange failed: {OnlineHttp.Describe(exception)}");
            return null;
        }
    }

    private static string AndroidSign(SortedDictionary<string, string> query, string body)
    {
        var builder = new StringBuilder();
        foreach (var pair in query)
        {
            builder.Append(pair.Key).Append('=').Append(pair.Value);
        }

        var hash = MD5.HashData(Encoding.UTF8.GetBytes(AndroidSalt + builder + body + AndroidSalt));
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    private static string AesEncryptHex(string text, string key, string iv)
    {
        using var aes = Aes.Create();
        aes.Mode = CipherMode.CBC;
        aes.Padding = PaddingMode.PKCS7;
        aes.Key = Encoding.UTF8.GetBytes(key);
        aes.IV = Encoding.UTF8.GetBytes(iv);
        using var encryptor = aes.CreateEncryptor();
        var bytes = Encoding.UTF8.GetBytes(text);
        var output = encryptor.TransformFinalBlock(bytes, 0, bytes.Length);
        return Convert.ToHexString(output).ToLowerInvariant();
    }

    private static string? AesDecryptHex(string hex, string key, string iv)
    {
        try
        {
            using var aes = Aes.Create();
            aes.Mode = CipherMode.CBC;
            aes.Padding = PaddingMode.PKCS7;
            aes.Key = Encoding.UTF8.GetBytes(key);
            aes.IV = Encoding.UTF8.GetBytes(iv);
            using var decryptor = aes.CreateDecryptor();
            var bytes = Convert.FromHexString(hex);
            var output = decryptor.TransformFinalBlock(bytes, 0, bytes.Length);
            return Encoding.UTF8.GetString(output);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            OnlineHttp.Warn($"[account] kugou token decrypt failed: {OnlineHttp.Describe(exception)}");
            return null;
        }
    }

'''

idx = text.rfind('}')
text = text[:idx] + methods + text[idx:]
print('ok helpers')

io.open(path, 'w', encoding='utf-8', newline='').write(text)
