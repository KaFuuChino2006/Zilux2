using System;
using System.Globalization;
using System.Text.Json.Nodes;
using System.Windows.Threading;
using Zilux2.Wallpaper.Data;
using Zilux2.Wallpaper.Model;

namespace Zilux2.Wallpaper.Rules;

/// <summary>
/// 条件规则引擎（规格书 §5.4 / 第 58 轮）：按优先级从高到低找第一条命中的规则，交给宿主执行。
///
/// 已支持的条件：
/// - <c>{"type":"time","from":"08:00","to":"18:00"}</c>：当前本地时间落在区间内（支持跨午夜，from &gt; to）。
///
/// 已支持的动作（交给宿主）：
/// - <c>{"type":"asset","assetId":3}</c>：切到指定素材。
/// - <c>{"type":"sequence","sequenceId":1}</c>：按序列播放。
///
/// 前台应用与电量条件本轮只做解析占位：条件缺失时视为「只按时间判断」，
/// 免得写了一条还没支持的条件就把规则永久判成不命中。
/// </summary>
internal sealed class RuleEngine : IDisposable
{
    private readonly LibraryStore _store;
    private readonly DispatcherTimer _timer;
    private bool _running;

    public RuleEngine(LibraryStore store)
    {
        _store = store;
        _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(60) };
        _timer.Tick += OnTick;
    }

    /// <summary>命中规则时触发（参数是规则本身，宿主自己解释动作）。</summary>
    public event Action<WallpaperRule>? Matched;

    /// <summary>当前命中的规则名，没有命中时为 null（诊断面板会显示）。</summary>
    public string? ActiveRuleName { get; private set; }

    public void Start()
    {
        if (_running) return;
        _running = true;
        _timer.Start();
        Evaluate();
    }

    public void Stop()
    {
        _running = false;
        _timer.Stop();
    }

    public void Dispose()
    {
        Stop();
        _timer.Tick -= OnTick;
    }

    /// <summary>立刻评估一次（改完规则 / 手动触发时调）。</summary>
    public void Evaluate()
    {
        var now = DateTime.Now;
        WallpaperRule? hit = null;

        foreach (var rule in _store.ListRules())
        {
            if (!rule.Enabled) continue;
            if (!Matches(rule, now)) continue;
            if (hit is null || rule.Priority < hit.Priority) hit = rule;
        }

        ActiveRuleName = hit?.Name;
        if (hit is not null) Matched?.Invoke(hit);
    }

    private static bool Matches(WallpaperRule rule, DateTime now)
    {
        JsonNode? condition;
        try
        {
            condition = JsonNode.Parse(rule.ConditionJson);
        }
        catch
        {
            return false;
        }

        if (condition is not JsonObject conditionObject) return false;

        var type = conditionObject["type"]?.GetValue<string>();
        if (string.IsNullOrEmpty(type)) return false;

        return type switch
        {
            "time" => MatchesTime(conditionObject, now),
            // 尚未实现的条件类型：不阻塞（返回 true 表示"这条规则只看已实现的部分"）。
            "app" or "battery" => true,
            _ => false,
        };
    }

    private static bool MatchesTime(JsonObject condition, DateTime now)
    {
        var from = ParseClock(condition["from"]?.GetValue<string>());
        var to = ParseClock(condition["to"]?.GetValue<string>());
        if (from is null || to is null) return false;

        var current = now.Hour * 60 + now.Minute;
        return from <= to
            ? current >= from && current < to
            : current >= from || current < to; // 跨午夜，例如 22:00–06:00
    }

    private static int? ParseClock(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var parts = text.Split(':');
        if (parts.Length is not 2) return null;
        if (!int.TryParse(parts[0], CultureInfo.InvariantCulture, out var hour)) return null;
        if (!int.TryParse(parts[1], CultureInfo.InvariantCulture, out var minute)) return null;
        if (hour is < 0 or > 23 || minute is < 0 or > 59) return null;
        return hour * 60 + minute;
    }

    private void OnTick(object? sender, EventArgs e) => Evaluate();
}
