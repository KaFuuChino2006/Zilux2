# -*- coding: utf-8 -*-
"""酷狗资料（昵称/头像）修复 + 匹配歌词窗口实时跟随播放进度。"""
import io

def read(path):
    with io.open(path, 'r', encoding='utf-8', newline='') as f:
        text = f.read()
    eol = '\r\n' if '\r\n' in text else '\n'
    return text, eol

def write(path, text):
    with io.open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(text)

def apply(path, label, edits):
    text, eol = read(path)
    for idx, (old, new) in enumerate(edits, 1):
        if not old:
            continue
        old2 = old.replace('\n', eol)
        new2 = new.replace('\n', eol)
        count = text.count(old2)
        if count != 1:
            raise SystemExit('%s: 第 %d 处锚点命中 %d 次 -> %r' % (label, idx, count, old2[:70]))
        text = text.replace(old2, new2)
    write(path, text)
    print('OK %s (%d 处)' % (label, len(edits)))

BASE = r'E:\Zilux2开发'
kugou = BASE + r'\src\Zilux2\Online\Account\KugouLoginProvider.cs'
text, eol = read(kugou)

old_nick_call = """        var nickname = await TryFetchNicknameAsync(token, userId, cancellationToken).ConfigureAwait(false);
        var account = new AccountInfo
        {
            Source = AccountSources.Kugou,
            LoggedIn = true,
            Nickname = nickname ?? "酷狗音乐用户",
            UserId = userId,
        };"""

new_nick_call = """        var profile = await TryFetchProfileAsync(token, userId, session.Mid, session.Dfid, cookies, cancellationToken).ConfigureAwait(false);
        var account = new AccountInfo
        {
            Source = AccountSources.Kugou,
            LoggedIn = true,
            Nickname = profile.Nickname ?? "酷狗音乐用户",
            UserId = userId,
            AvatarDataUrl = profile.Avatar,
        };"""

profile_block = '''    /// <summary>启动时用已保存的 Cookie 刷新昵称 / 头像（酷狗没有独立的资料刷新接口）。</summary>
    public async Task<AccountInfo?> RefreshAsync(IReadOnlyList<StoredCookie> cookies, CancellationToken cancellationToken)
    {
        var userId = CookieValue(cookies, "userid") ?? string.Empty;
        if (userId.Length == 0)
        {
            return null;
        }

        var token = CookieValue(cookies, "token") ?? string.Empty;
        var mid = CookieValue(cookies, "mid") ?? CookieValue(cookies, "kg_mid") ?? RandomHex(32).ToLowerInvariant();
        var dfid = CookieValue(cookies, "dfid") ?? CookieValue(cookies, "kg_dfid") ?? string.Empty;
        var profile = await TryFetchProfileAsync(token, userId, mid, dfid, cookies, cancellationToken).ConfigureAwait(false);
        if (profile.Nickname is null && profile.Avatar is null)
        {
            return null;
        }

        return new AccountInfo
        {
            Source = AccountSources.Kugou,
            LoggedIn = true,
            Nickname = profile.Nickname ?? "酷狗音乐用户",
            UserId = userId,
            AvatarDataUrl = profile.Avatar,
        };
    }

    // 昵称/头像只是锦上添花：酷狗用户信息接口必须带登录 Cookie，否则会被 WAF 挡回 HTML。
    private static async Task<(string? Nickname, string? Avatar)> TryFetchProfileAsync(
        string token,
        string userId,
        string mid,
        string dfid,
        IReadOnlyList<StoredCookie> cookies,
        CancellationToken cancellationToken)
    {
        if (token.Length == 0 || userId.Length == 0)
        {
            return (null, null);
        }

        var cookieHeader = CookieHeader(cookies);
        foreach (var endpoint in new[] { "/v2/get_userinfo", "/v1/get_userinfo" })
        {
            try
            {
                var query = new SortedDictionary<string, string>(StringComparer.Ordinal)
                {
                    ["appid"] = AppId,
                    ["clienttime"] = NowSeconds(),
                    ["clientver"] = ClientVer,
                    ["dfid"] = dfid.Length > 0 ? dfid : "-",
                    ["mid"] = mid,
                    ["srcappid"] = SrcAppId,
                    ["token"] = token,
                    ["userid"] = userId,
                    ["uuid"] = "-",
                };
                query["signature"] = Signature(query);
                var url = QrHost + endpoint + "?" + BuildQuery(query);
                using var request = OnlineHttp.NewRequest(HttpMethod.Get, url, Referer);
                if (cookieHeader.Length > 0)
                {
                    request.Headers.TryAddWithoutValidation("Cookie", cookieHeader);
                }

                using var response = await OnlineHttp.Client.SendAsync(request, cancellationToken).ConfigureAwait(false);
                var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
                if (body.Length == 0 || body.TrimStart().StartsWith("<", StringComparison.Ordinal))
                {
                    OnlineHttp.Warn($"[account] kugou profile rejected status={(int)response.StatusCode} bytes={body.Length}");
                    continue;
                }

                using var document = JsonDocument.Parse(body);
                if (!TryGetProperty(document.RootElement, "data", out var data))
                {
                    continue;
                }

                var nickname = FirstString(data, "nickname", "nick_name", "user_nickname", "kugou_nickname", "nick");
                var avatar = await FetchAvatarAsync(
                    FirstString(data, "pic", "user_pic", "avatar", "img", "big_pic", "pic_url"),
                    cancellationToken).ConfigureAwait(false);
                if (nickname is not null || avatar is not null)
                {
                    OnlineHttp.Info($"[account] kugou profile ok nickname={nickname ?? "-"} avatar={(avatar is null ? "no" : "yes")}");
                    return (nickname, avatar);
                }
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                OnlineHttp.Warn($"[account] kugou profile failed: {OnlineHttp.Describe(exception)}");
            }
        }

        return (null, null);
    }

    private static async Task<string?> FetchAvatarAsync(string? avatarUrl, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(avatarUrl))
        {
            return null;
        }

        try
        {
            var upstream = await OnlineHttp
                .FetchBytesAsync(avatarUrl, Referer, TimeSpan.FromSeconds(12), cancellationToken)
                .ConfigureAwait(false);
            if (upstream.Bytes.Length == 0 || upstream.Bytes.Length > 512 * 1024)
            {
                OnlineHttp.Warn($"[account] kugou avatar skipped size={upstream.Bytes.Length}");
                return null;
            }

            var mediaType = upstream.ContentType?.Split(';')[0].Trim();
            if (string.IsNullOrEmpty(mediaType) || !mediaType.Contains('/'))
            {
                mediaType = "image/jpeg";
            }

            return $"data:{mediaType};base64,{Convert.ToBase64String(upstream.Bytes)}";
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            OnlineHttp.Warn($"[account] kugou avatar failed: {OnlineHttp.Describe(exception)}");
            return null;
        }
    }

    private static string CookieHeader(IReadOnlyList<StoredCookie> cookies)
    {
        var builder = new StringBuilder();
        foreach (var cookie in cookies)
        {
            if (cookie.Name.Length == 0)
            {
                continue;
            }

            if (builder.Length > 0)
            {
                builder.Append("; ");
            }

            builder.Append(cookie.Name).Append('=').Append(cookie.Value);
        }

        return builder.ToString();
    }

    private static string? CookieValue(IReadOnlyList<StoredCookie> cookies, string name)
    {
        foreach (var cookie in cookies)
        {
            if (string.Equals(cookie.Name, name, StringComparison.OrdinalIgnoreCase) && cookie.Value.Length > 0)
            {
                return cookie.Value;
            }
        }

        return null;
    }

    private static string? FirstString(JsonElement element, params string[] names)
    {
        foreach (var name in names)
        {
            if (TryGetString(element, name, out var value) && value.Length > 0)
            {
                return value;
            }
        }

        return null;
    }

'''

start_marker = '    // 昵称只是锦上添花：酷狗用户信息接口需要额外签名，失败就回退成默认昵称。'
end_marker = '    private static SortedDictionary<string, string> BuildBaseQuery'
start = text.index(start_marker)
end = text.index(end_marker, start)
old_block = text[start:end]
if 'TryFetchNicknameAsync' not in old_block:
    raise SystemExit('kugou: 旧昵称方法块定位失败')

text = text[:start] + profile_block.replace('\n', eol) + text[end:]
if old_nick_call.replace('\n', eol) not in text:
    raise SystemExit('kugou: CompleteAsync 旧代码块未命中')
text = text.replace(old_nick_call.replace('\n', eol), new_nick_call.replace('\n', eol))
write(kugou, text)
print('OK KugouLoginProvider (资料/头像)')

svc = BASE + r'\src\Zilux2\Online\Account\AccountService.cs'
apply(svc, 'AccountService', [
("""            // 酷狗没有单独的资料刷新接口：昵称在登录时就取好了，这里跳过。
            if (source == AccountSources.Kugou)
            {
                continue;
            }

            try
            {
                var refreshed = source == AccountSources.Qq
                    ? await _qq.RefreshAsync(cookies, timeout.Token).ConfigureAwait(false)
                    : await _netease.RefreshAsync(cookies, timeout.Token).ConfigureAwait(false);""",
"""            try
            {
                var refreshed = source switch
                {
                    AccountSources.Qq => await _qq.RefreshAsync(cookies, timeout.Token).ConfigureAwait(false),
                    AccountSources.Kugou => await _kugou.RefreshAsync(cookies, timeout.Token).ConfigureAwait(false),
                    _ => await _netease.RefreshAsync(cookies, timeout.Token).ConfigureAwait(false),
                };"""),
])

picker = BASE + r'\web\src\ui\lyricPicker.ts'
apply(picker, 'lyricPicker', [
("""function previewLines(lyric: OnlineLyric): { lines: PreviewLine[]; word: boolean; translation: boolean } {
  const trimmed = (value: string | null | undefined): string => (value ?? '').trim();
""",
"""function previewLines(lyric: OnlineLyric): { lines: PreviewLine[]; word: boolean; translation: boolean } {
  const trimmed = (value: string | null | undefined): string => (value ?? '').trim();
  const translationLines = trimmed(lyric.translation) ? parseLrc(lyric.translation ?? '') : [];
  const pickTranslation = (timeMs: number): string | undefined =>
    translationLines.find((item) => Math.abs(item.timeMs - timeMs) <= 500)?.text;
"""),
("""            timeMs: line.timeMs,
            text: line.words.map((word) => word.text).join(''),
            word: true,
            words: line.words.map((word) => ({ text: word.text, startMs: word.startMs, endMs: word.endMs })),
          })),
          word: true,
          translation: false,""",
"""            timeMs: line.timeMs,
            text: line.words.map((word) => word.text).join(''),
            translation: pickTranslation(line.timeMs),
            word: true,
            words: line.words.map((word) => ({ text: word.text, startMs: word.startMs, endMs: word.endMs })),
          })),
          word: true,
          translation: translationLines.length > 0,"""),
("""            timeMs: line.timeMs,
            text: line.chars.map((char) => char.text).join(''),
            word: true,
            words: line.chars.map((char) => ({ text: char.text, startMs: char.startMs, endMs: char.endMs })),
          })),
          word: true,
          translation: false,""",
"""            timeMs: line.timeMs,
            text: line.chars.map((char) => char.text).join(''),
            translation: pickTranslation(line.timeMs),
            word: true,
            words: line.chars.map((char) => ({ text: char.text, startMs: char.startMs, endMs: char.endMs })),
          })),
          word: true,
          translation: translationLines.length > 0,"""),
("""  const base = parseLrc(lyric.lrc ?? '');
  const translated = trimmed(lyric.translation) ? parseLrc(lyric.translation ?? '') : [];
  return {
    lines: base.slice(0, PREVIEW_LINES).map((line) => ({
      timeMs: line.timeMs,
      text: line.text,
      translation: translated.find((item) => Math.abs(item.timeMs - line.timeMs) <= 500)?.text,
      word: false,
    })),
    word: false,
    translation: translated.length > 0,
  };""",
"""  const base = parseLrc(lyric.lrc ?? '');
  return {
    lines: base.slice(0, PREVIEW_LINES).map((line) => ({
      timeMs: line.timeMs,
      text: line.text,
      translation: pickTranslation(line.timeMs),
      word: false,
    })),
    word: false,
    translation: translationLines.length > 0,
  };"""),
("""  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    root.classList.add('is-leaving');
    unsubscribePlayer();""",
"""  let closing = false;
  // 预览进度用独立 rAF 驱动：不依赖播放状态推送的时机，打开期间始终跟着当前播放位置走。
  let rafId = 0;
  const progressLoop = (): void => {
    if (closing) return;
    syncPreviewProgress();
    rafId = window.requestAnimationFrame(progressLoop);
  };
  rafId = window.requestAnimationFrame(progressLoop);
  const close = (): void => {
    if (closing) return;
    closing = true;
    window.cancelAnimationFrame(rafId);
    root.classList.add('is-leaving');
    unsubscribePlayer();"""),
])

css = BASE + r'\web\src\styles\app.css'
csstext, ceol = read(css)
if '.source-dot.kugou' not in csstext:
    csstext += ("""
/* 酷狗平台角标 */
.source-dot.kugou {
  background: #2fb0ff;
  color: #0b1a24;
}
""").replace('\n', ceol)
    write(css, csstext)
print('OK app.css (kugou dot)')
