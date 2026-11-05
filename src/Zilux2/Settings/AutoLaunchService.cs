using System;
using System.IO;
using Microsoft.Win32;

namespace Zilux2.Settings;

// Contract docs/zilux2-settings-contract.md §2 / §5: general.autoLaunch maps to the per-user
// Run key. Registration is idempotent: the current value is compared first so a no-op patch never
// touches the registry, and every failure only costs this one feature (never the window).
internal static class AutoLaunchService
{
    internal const string DefaultRunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";

    // 自测用隔离：settings-selftest.ps1 指向临时子键，避免测试删/写用户真实的开机自启项。
    internal const string RunKeyPathEnvironmentVariable = "ZILUX2_AUTOLAUNCH_RUN_KEY";

    internal const string ValueName = "Zilux2";

    private static string RunKeyPath
    {
        get
        {
            var overridden = Environment.GetEnvironmentVariable(RunKeyPathEnvironmentVariable);
            return string.IsNullOrWhiteSpace(overridden) ? DefaultRunKeyPath : overridden;
        }
    }

    /// <summary>
    /// 把目标状态幂等地写进 HKCU Run；返回是否已经生效（失败返回 false，只记日志）。
    /// startHidden 决定命令行是否带 --hidden（开机自启后不显示主界面）。
    /// </summary>
    internal static bool Apply(bool enabled, bool startHidden = false)
    {
        var exePath = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(exePath) || !File.Exists(exePath))
        {
            HostLog.Warn($"[autolaunch] skipped: process path unavailable ({exePath ?? "<null>"})");
            return false;
        }

        // §2: the command is the full exe path, quoted (paths contain spaces on most machines);
        // startHidden 时追加 --hidden，让开机自启只驻留托盘、不弹主界面。
        var command = "\"" + exePath + "\"" + (startHidden ? " --hidden" : "");
        var current = ReadCurrentCommand();

        if (enabled && string.Equals(current, command, StringComparison.Ordinal))
        {
            HostLog.Info($"[autolaunch] unchanged enabled=true command={command}");
            return true;
        }

        try
        {
            // 关闭时只打开已有键，避免在没有 Run 键的机器上凭空创建空键。
            using var key = enabled
                ? Registry.CurrentUser.CreateSubKey(RunKeyPath, writable: true)
                : Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true);
            if (key is null)
            {
                if (enabled)
                {
                    HostLog.Warn("[autolaunch] apply failed: Run key unavailable");
                    return false;
                }

                HostLog.Info("[autolaunch] unregistered");
                return true;
            }

            if (enabled)
            {
                key.SetValue(ValueName, command, RegistryValueKind.String);
                HostLog.Info($"[autolaunch] registered command={command}");
            }
            else
            {
                key.DeleteValue(ValueName, throwOnMissingValue: false);
                HostLog.Info("[autolaunch] unregistered");
            }

            return true;
        }
        catch (Exception exception)
        {
            // 组策略/安全软件可能禁写 Run：只丢开机自启这一项，设置本身照常保存。
            HostLog.Warn(
                $"[autolaunch] apply failed enabled={enabled} err={exception.GetType().Name}: {exception.Message}");
            return false;
        }
    }

    /// <summary>当前注册的命令（未注册 / 读取失败返回 null）。</summary>
    internal static string? ReadCurrentCommand()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath);
            return key?.GetValue(ValueName) as string;
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[autolaunch] read failed: {exception.GetType().Name}: {exception.Message}");
            return null;
        }
    }
}
