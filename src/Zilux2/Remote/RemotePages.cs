using System.IO;

namespace Zilux2.Remote;

/// <summary>
/// 手机页的取件逻辑。
///
/// 页面是 `web/remote/index.html`（单文件、内联 CSS/JS，不参与 Vite 构建），直接从磁盘读——
/// 改完不用重新编译就能在手机上刷新看到。找不到文件时退化成一份内置的极简控制页并在日志里
/// 说明缺什么，而不是给手机一个 404 白屏。
/// </summary>
internal static class RemotePages
{
    private static readonly object Gate = new();
    private static string? _resolved;
    private static bool _resolvedOnce;

    /// <summary>返回 index.html 的实际路径；找不到返回 null（调用方会退回内置页）。</summary>
    internal static string? ResolveIndex()
    {
        lock (Gate)
        {
            if (_resolvedOnce)
            {
                return _resolved;
            }

            _resolvedOnce = true;
            _resolved = Locate();
            if (_resolved is null)
            {
                HostLog.Warn("[remote] 未找到 web/remote/index.html，手机页将使用内置极简版本；" +
                             "发布包里请把 web/remote 复制到 exe 旁边的 web/remote。");
            }
            else
            {
                HostLog.Info($"[remote] page={_resolved}");
            }

            return _resolved;
        }
    }

    private static string? Locate()
    {
        var env = Environment.GetEnvironmentVariable("ZILUX2_REMOTE_WEB");
        if (!string.IsNullOrWhiteSpace(env))
        {
            var candidate = env.Trim();
            if (Directory.Exists(candidate))
            {
                candidate = Path.Combine(candidate, "index.html");
            }

            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        var baseDir = AppContext.BaseDirectory;
        var roots = new List<string> { baseDir };
        try
        {
            // bin\Debug\net10.0-… → 一路走到仓库根；只在存在的目录上枚举，最多 8 层。
            var directory = new DirectoryInfo(baseDir);
            for (var i = 0; i < 8 && directory?.Parent is not null; i += 1)
            {
                directory = directory.Parent;
                roots.Add(directory.FullName);
            }
        }
        catch
        {
            // 路径异常不影响后面的候选。
        }

        foreach (var root in roots)
        {
            foreach (var relative in new[]
                     {
                         Path.Combine("web", "remote", "index.html"),
                         Path.Combine("web", "dist", "remote", "index.html"),
                         Path.Combine("remote", "index.html"),
                         Path.Combine("web", "dist", "index.html"),
                     })
            {
                try
                {
                    var candidate = Path.GetFullPath(Path.Combine(root, relative));
                    if (File.Exists(candidate))
                    {
                        return candidate;
                    }
                }
                catch
                {
                    // 非法路径，跳过。
                }
            }
        }

        return null;
    }

    internal static RemoteResponse Index()
    {
        var path = ResolveIndex();
        if (path is not null)
        {
            try
            {
                return RemoteResponse.Html(File.ReadAllText(path));
            }
            catch (Exception exception)
            {
                HostLog.Warn($"[remote] page read failed path={path} err={exception.GetType().Name}");
            }
        }

        return RemoteResponse.Html(FallbackPage());
    }

    /// <summary>根路径 `/` 的说明页：只提示「链接要带令牌」，不泄露任何令牌。</summary>
    internal static string HelpPage() => """
<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Zilux2 手机遥控</title>
<style>
html,body{margin:0;height:100%;background:#0d0d12;color:#e8e8ef;font:15px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif}
main{max-width:32rem;margin:0 auto;padding:16vh 24px}
h1{font-size:20px;margin:0 0 12px}
p{color:#9a9aa8;margin:0 0 10px}
code{background:#1b1b24;border-radius:6px;padding:2px 6px;color:#cfcfe0}
</style></head>
<body><main>
<h1>Zilux2 手机遥控</h1>
<p>这个地址需要带配对令牌才能用。</p>
<p>请在桌面端「设置 → 通用 → 系统 → 手机遥控」里打开开关，然后用手机访问 <code>http://电脑IP:端口/r/</code>。</p>
</main></body></html>
""";

    /// <summary>发布包里没带页面时的兜底：能开关播放、能看到当前曲目，不假装有别的按钮。</summary>
    private static string FallbackPage() => """
<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Zilux2 遥控（精简）</title>
<style>
html,body{margin:0;height:100%;background:#0d0d12;color:#e8e8ef;font:15px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif}
main{max-width:32rem;margin:0 auto;padding:28px 20px}
.badge{display:inline-block;font-size:12px;color:#f0b429;border:1px solid #4a3a12;background:#241c07;border-radius:999px;padding:2px 10px;margin-bottom:14px}
h1{font-size:18px;margin:0 0 4px;word-break:break-word}
.sub{color:#9a9aa8;font-size:13px;margin:0 0 18px}
.bar{height:6px;border-radius:999px;background:#1e1e28;overflow:hidden;margin:0 0 6px}
.bar i{display:block;height:100%;width:0;background:#7c5cff}
.time{font-size:12px;color:#7a7a88;display:flex;justify-content:space-between;margin-bottom:20px}
.row{display:flex;gap:10px}
button{flex:1;padding:14px;border-radius:14px;border:1px solid #2a2a36;background:#191922;color:#e8e8ef;font-size:16px}
button:active{background:#242432}
</style></head>
<body><main>
<span class="badge">精简版 · 未找到 web/remote/index.html</span>
<h1 id="title">未在播放</h1>
<p class="sub" id="artist"></p>
<div class="bar"><i id="fill"></i></div>
<div class="time"><span id="pos">0:00</span><span id="dur">0:00</span></div>
<div class="row"><button id="prev">上一首</button><button id="toggle">播放/暂停</button><button id="next">下一首</button></div>
</main>
<script>
const BASE = location.pathname.replace(/\/+$/, '') + '/api';
const $ = (id) => document.getElementById(id);
const api = (path, opts) => fetch(BASE + path, Object.assign({ cache: 'no-store' }, opts)).then((r) => r.json());
const fmt = (ms) => { const s = Math.max(0, Math.floor((ms || 0) / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
async function tick() {
  try {
    const state = await api('/state');
    const now = state.now || {};
    $('title').textContent = now.title || '未在播放';
    $('artist').textContent = [now.artist, now.album].filter(Boolean).join(' · ');
    const pct = now.durationMs > 0 ? Math.min(100, (now.positionMs / now.durationMs) * 100) : 0;
    $('fill').style.width = pct + '%';
    $('pos').textContent = fmt(now.positionMs);
    $('dur').textContent = fmt(now.durationMs);
  } catch (err) { /* 掉线就等下一轮 */ }
}
$('toggle').onclick = () => api('/command?action=togglePlay', { method: 'POST' }).then(tick);
$('prev').onclick = () => api('/command?action=prev', { method: 'POST' }).then(tick);
$('next').onclick = () => api('/command?action=next', { method: 'POST' }).then(tick);
setInterval(tick, 1000);
tick();
</script></body></html>
""";
}
