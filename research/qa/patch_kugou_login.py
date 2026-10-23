# -*- coding: utf-8 -*-
"""酷狗扫码登录：宿主接线（catalog / account service / cookie 读取）。"""
import io
import re


def read(path):
    return io.open(path, 'r', encoding='utf-8', newline='').read()


def write(path, text):
    io.open(path, 'w', encoding='utf-8', newline='').write(text)


def apply(path, label, edits):
    text = read(path)
    nl = '\r\n' if '\r\n' in text else '\n'
    for old, new in edits:
        old = old.replace('\n', nl)
        new = new.replace('\n', nl)
        count = text.count(old)
        if count != 1:
            raise SystemExit(f'{label}: anchor count={count} -> {old[:70]!r}')
        text = text.replace(old, new)
    write(path, text)
    print('ok', label)


# 1) 平台描述：酷狗改为扫码登录
apply(r'E:\Zilux2开发\src\Zilux2\Online\MusicSourceCatalog.cs', 'catalog kugou login', [(
"""            // 酷狗网页端没有可用的二维码登录接口，改为导入浏览器 Cookie（token/userid/dfid/mid）。
            LoginMode = "cookie",
            LoginHint = "在浏览器登录 kugou.com 后，把 Cookie 粘贴进来（需要 token、userid、dfid、mid）",""",
"""            // 酷狗 H5 扫码登录：/v2/qrcode 取二维码，/v2/get_userinfo_qrcode 轮询授权。
            LoginMode = "code",
            LoginHint = "打开手机酷狗音乐 App → 扫一扫，扫描二维码登录",""",
)])

# 2) AccountSources 常量
apply(r'E:\Zilux2开发\src\Zilux2\Online\Account\AccountModels.cs', 'account sources', [(
"""    public const string Netease = "netease";
    public const string Qq = "qq";""",
"""    public const string Netease = "netease";
    public const string Qq = "qq";
    public const string Kugou = "kugou";""",
)])

# 3) AccountService 接线
apply(r'E:\Zilux2开发\src\Zilux2\Online\Account\AccountService.cs', 'account service', [
(
"""    private static readonly string[] AllSources = [AccountSources.Netease, AccountSources.Qq];""",
"""    private static readonly string[] AllSources = [AccountSources.Netease, AccountSources.Qq, AccountSources.Kugou];""",
),
(
"""    private readonly QqLoginProvider _qq;""",
"""    private readonly QqLoginProvider _qq;
    private readonly KugouLoginProvider _kugou;""",
),
(
"""        _qq = new QqLoginProvider(_store);""",
"""        _qq = new QqLoginProvider(_store);
        _kugou = new KugouLoginProvider(_store);""",
),
(
"""        OnlineHttp.Info($"[account] ready sources=netease,qq path={_store.FilePath}");""",
"""        OnlineHttp.Info($"[account] ready sources=netease,qq,kugou path={_store.FilePath}");""",
),
(
"""            var refreshed = source == AccountSources.Qq
                ? await _qq.RefreshAsync(cookies, timeout.Token).ConfigureAwait(false)
                : await _netease.RefreshAsync(cookies, timeout.Token).ConfigureAwait(false);""",
"""            // 酷狗没有单独的资料刷新接口：昵称在登录时就取好了，这里跳过。
            if (source == AccountSources.Kugou)
            {
                continue;
            }

            var refreshed = source == AccountSources.Qq
                ? await _qq.RefreshAsync(cookies, timeout.Token).ConfigureAwait(false)
                : await _netease.RefreshAsync(cookies, timeout.Token).ConfigureAwait(false);""",
),
(
"""        NormalizeSource(source) switch
        {
            AccountSources.Qq => _qq.CreateQrAsync(cancellationToken),
            _ => _netease.CreateQrAsync(cancellationToken),
        };""",
"""        NormalizeSource(source) switch
        {
            AccountSources.Qq => _qq.CreateQrAsync(cancellationToken),
            AccountSources.Kugou => _kugou.CreateQrAsync(cancellationToken),
            _ => _netease.CreateQrAsync(cancellationToken),
        };""",
),
(
"""        NormalizeSource(source) switch
        {
            AccountSources.Qq => _qq.PollAsync(key, cancellationToken),
            _ => _netease.PollAsync(key, cancellationToken),
        };""",
"""        NormalizeSource(source) switch
        {
            AccountSources.Qq => _qq.PollAsync(key, cancellationToken),
            AccountSources.Kugou => _kugou.PollAsync(key, cancellationToken),
            _ => _netease.PollAsync(key, cancellationToken),
        };""",
),
(
"""    private static string NormalizeSource(string source) =>
        string.Equals(source, AccountSources.Qq, StringComparison.OrdinalIgnoreCase)
            ? AccountSources.Qq
            : AccountSources.Netease;""",
"""    private static string NormalizeSource(string source) =>
        string.Equals(source, AccountSources.Qq, StringComparison.OrdinalIgnoreCase)
            ? AccountSources.Qq
            : string.Equals(source, AccountSources.Kugou, StringComparison.OrdinalIgnoreCase)
                ? AccountSources.Kugou
                : AccountSources.Netease;""",
),
])

