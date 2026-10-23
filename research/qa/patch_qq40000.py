# -*- coding: utf-8 -*-
"""QQ 歌单：按 QQ 音乐客户端协议补 comm 鉴权字段 + 补 uin cookie，修复登录态下 code=40000。"""
import io
import shutil

p = r'E:\Zilux2开发\src\Zilux2\Online\Library\QqLibraryProvider.cs'
shutil.copyfile(p, p + '.bak-qq40000')
s = io.open(p, 'r', encoding='utf-8', newline='').read()


def rep(old, new):
    global s
    assert s.count(old) == 1, ('anchor', old[:70], s.count(old))
    s = s.replace(old, new, 1)


rep(
    """    private string MusicuCookie => _accounts?.CookieHeader(Name, "u.y.qq.com") ?? string.Empty;""",
    """    private string MusicuCookie
    {
        get
        {
            var cookie = _accounts?.CookieHeader(Name, "u.y.qq.com") ?? string.Empty;
            var uin = _accounts?.GetUserId(Name);
            if (string.IsNullOrEmpty(uin) || CookieValue(cookie, "uin") is not null)
            {
                return cookie;
            }

            // QQ 音乐接口要求 cookie 里同时有 uin / qqmusic_uin 两套标识
            return cookie.Length > 0 ? $"uin={uin}; {cookie}" : $"uin={uin}";
        }
    }

    private static string? CookieValue(string cookie, string name)
    {
        foreach (var part in cookie.Split(';'))
        {
            var separator = part.IndexOf('=');
            if (separator <= 0)
            {
                continue;
            }

            if (part.AsSpan(0, separator).Trim().Equals(name, StringComparison.OrdinalIgnoreCase))
            {
                return part[(separator + 1)..].Trim();
            }
        }

        return null;
    }""",
)

rep(
    """            ["comm"] = new JsonObject { ["ct"] = 24, ["cv"] = 0, ["uin"] = uin },
            ["req_1"] = new JsonObject
            {
                ["module"] = "music.musicasset.PlaylistBaseRead",""",
    """            ["comm"] = BuildComm(uin),
            ["req_1"] = new JsonObject
            {
                ["module"] = "music.musicasset.PlaylistBaseRead",""",
)

rep(
    """    private static string? CookieValue(string cookie, string name)""",
    """    private JsonObject BuildComm(string uin)
    {
        // QQ 音乐客户端协议的 comm：只带 uin 的 web 形态在登录态下会返回 code=40000。
        var musicKey = CookieValue(MusicuCookie, "qqmusic_key") ?? CookieValue(MusicuCookie, "qm_keyst") ?? string.Empty;
        var uinNumber = long.TryParse(uin, out var parsedUin) ? parsedUin : 0;
        return new JsonObject
        {
            ["ct"] = 11,
            ["cv"] = 14090008,
            ["v"] = 14090008,
            ["tmeAppID"] = "qqmusic",
            ["format"] = "json",
            ["platform"] = "yqq",
            ["needNewCode"] = 1,
            ["uin"] = uinNumber,
            ["qq"] = uinNumber,
            ["authst"] = musicKey,
            ["tmeLoginType"] = 1,
        };
    }

    private static string? CookieValue(string cookie, string name)""",
)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('qq provider patched')
