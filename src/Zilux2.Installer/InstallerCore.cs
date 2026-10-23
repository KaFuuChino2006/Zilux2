using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Zilux2.Installer;

internal static class InstallerCore
{
    public const string AppName = "Zilux2";
    public const string DisplayName = "Zilux2 沉浸式音乐空间";
    public static string Version =>
        typeof(InstallerCore).Assembly.GetName().Version?.ToString(3) ?? "2.0.0";
    public const string ExeName = "Zilux2.exe";
    public const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Zilux2";

    public static string DefaultInstallDir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Zilux2");

    public static void KillRunning()
    {
        foreach (var process in Process.GetProcessesByName("Zilux2"))
        {
            try
            {
                if (!process.CloseMainWindow()) process.Kill();
                process.WaitForExit(2500);
                if (!process.HasExited) process.Kill();
            }
            catch
            {
                // ignore
            }
        }
    }

    public static void Install(string targetDir, IProgress<(int Percent, string Message)> progress, bool createShortcuts = true, bool register = true)
    {
        Directory.CreateDirectory(targetDir);
        var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip")
                       ?? throw new InvalidOperationException("安装包内缺少 payload.zip");
        using var archive = new ZipArchive(resource, ZipArchiveMode.Read);
        var entries = archive.Entries.Where(e => !string.IsNullOrEmpty(e.Name)).ToList();
        long total = entries.Sum(e => Math.Max(1, e.Length));
        long done = 0;
        foreach (var entry in entries)
        {
            progress.Report((total <= 0 ? 0 : (int)(done * 100 / total), $"正在释放 {entry.FullName}"));
            var destination = Path.Combine(targetDir, entry.FullName.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            entry.ExtractToFile(destination, true);
            done += Math.Max(1, entry.Length);
        }
        progress.Report((100, "正在创建快捷方式"));
        if (createShortcuts) CreateShortcuts(targetDir);
        if (register)
        {
            WriteUninstaller(targetDir);
            WriteUninstallRegistry(targetDir);
        }
        progress.Report((100, "安装完成"));
    }

    public static void Uninstall(string installDir, IProgress<(int Percent, string Message)>? progress = null)
    {
        progress?.Report((5, "正在删除快捷方式"));
        RemoveShortcuts();
        progress?.Report((25, "正在清理注册表"));
        try
        {
            Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);
        }
        catch
        {
            // ignore
        }
        progress?.Report((50, "正在删除安装目录"));
        // 自己可能就在安装目录里：交给 cmd 延迟删除
        var cmd = $"/c ping 127.0.0.1 -n 3 >nul & rmdir /s /q \"{installDir}\"";
        try
        {
            Process.Start(new ProcessStartInfo("cmd.exe", cmd) { CreateNoWindow = true, UseShellExecute = false });
        }
        catch
        {
            // ignore
        }
        progress?.Report((100, "卸载完成"));
    }

    public static string DesktopShortcutPath =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Zilux2.lnk");

    public static string StartMenuShortcutPath =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Zilux2", "Zilux2.lnk");

    private static void CreateShortcuts(string targetDir)
    {
        var exe = Path.Combine(targetDir, ExeName);
        // 快捷方式失败不应中断安装：应用本体已经装好，缺快捷方式可以手动再建
        try
        {
            CreateShortcut(exe, DesktopShortcutPath, targetDir);
        }
        catch (Exception error)
        {
            Debug.WriteLine("desktop shortcut failed: " + error.Message);
        }

        try
        {
            CreateShortcut(exe, StartMenuShortcutPath, targetDir);
        }
        catch (Exception error)
        {
            Debug.WriteLine("start menu shortcut failed: " + error.Message);
        }
    }

    private static void RemoveShortcuts()
    {
        try
        {
            if (File.Exists(DesktopShortcutPath)) File.Delete(DesktopShortcutPath);
            if (File.Exists(StartMenuShortcutPath)) File.Delete(StartMenuShortcutPath);
            var menuDir = Path.GetDirectoryName(StartMenuShortcutPath)!;
            if (Directory.Exists(menuDir)) Directory.Delete(menuDir, true);
        }
        catch
        {
            // ignore
        }
    }

    private static void CreateShortcut(string exePath, string shortcutPath, string workingDir)
    {
        var directory = Path.GetDirectoryName(shortcutPath);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var shellType = Type.GetTypeFromProgID("WScript.Shell")
                        ?? throw new InvalidOperationException("WScript.Shell 不可用");
        dynamic shell = Activator.CreateInstance(shellType)!;
        dynamic shortcut = shell.CreateShortcut(shortcutPath);
        shortcut.TargetPath = exePath;
        shortcut.WorkingDirectory = workingDir;
        shortcut.IconLocation = exePath + ",0";
        shortcut.Description = DisplayName;
        shortcut.Save();
    }

    private static void WriteUninstaller(string targetDir)
    {
        var self = Process.GetCurrentProcess().MainModule?.FileName;
        if (string.IsNullOrWhiteSpace(self)) return;
        var dest = Path.Combine(targetDir, "Uninstall.exe");
        if (string.Equals(Path.GetFullPath(self), Path.GetFullPath(dest), StringComparison.OrdinalIgnoreCase)) return;
        File.Copy(self, dest, true);
    }

    private static void WriteUninstallRegistry(string targetDir)
    {
        var exe = Path.Combine(targetDir, ExeName);
        using var key = Registry.CurrentUser.CreateSubKey(UninstallKey, true);
        key.SetValue("DisplayName", DisplayName);
        key.SetValue("DisplayVersion", Version);
        key.SetValue("Publisher", "Zilux2");
        key.SetValue("InstallLocation", targetDir);
        key.SetValue("DisplayIcon", exe + ",0");
        key.SetValue("UninstallString", $"\"{Path.Combine(targetDir, "Uninstall.exe")}\" --uninstall");
        key.SetValue("QuietUninstallString", $"\"{Path.Combine(targetDir, "Uninstall.exe")}\" --uninstall --silent");
        key.SetValue("NoModify", 1, RegistryValueKind.DWord);
        key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        key.SetValue("EstimatedSize", (int)(new DirectoryInfo(targetDir).EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length) / 1024), RegistryValueKind.DWord);
    }

    public static void Launch(string targetDir)
    {
        try
        {
            Process.Start(new ProcessStartInfo(Path.Combine(targetDir, ExeName)) { WorkingDirectory = targetDir, UseShellExecute = true });
        }
        catch
        {
            // ignore
        }
    }
}
