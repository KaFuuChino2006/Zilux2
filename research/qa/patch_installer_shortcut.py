import io
from pathlib import Path

path = Path(r"E:\Zilux2开发\src\Zilux2.Installer\InstallerCore.cs")
with io.open(path, "r", encoding="utf-8", newline="") as handle:
    text = handle.read()
crlf = "\r\n" in text
normalized = text.replace("\r\n", "\n")

def rep(old, new):
    global normalized
    assert normalized.count(old) == 1, (old[:50], normalized.count(old))
    normalized = normalized.replace(old, new)

# 1) Version 用程序集版本（原来硬编码 2.0.0，安装界面与注册表都显示错的版本）
rep(
    '    public const string Version = "2.0.0";',
    '    public static string Version =>\n'
    '        typeof(InstallerCore).Assembly.GetName().Version?.ToString(3) ?? "2.0.0";',
)

# 2) 快捷方式：先建父目录（新安装时 Start Menu\\Programs\\Zilux2 不存在 → WScript Save 报「无法保存快捷方式」），
#    并且单个快捷方式失败不拖垮整个安装。
rep(
    """    private static void CreateShortcuts(string targetDir)
    {
        var exe = Path.Combine(targetDir, ExeName);
        CreateShortcut(exe, DesktopShortcutPath, targetDir);
        CreateShortcut(exe, StartMenuShortcutPath, targetDir);
    }""",
    """    private static void CreateShortcuts(string targetDir)
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
    }""",
)

# 3) CreateShortcut：保证目标目录存在
rep(
    """    private static void CreateShortcut(string exePath, string shortcutPath, string workingDir)
    {
        var shellType = Type.GetTypeFromProgID("WScript.Shell")""",
    """    private static void CreateShortcut(string exePath, string shortcutPath, string workingDir)
    {
        var directory = Path.GetDirectoryName(shortcutPath);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var shellType = Type.GetTypeFromProgID("WScript.Shell")""",
)

with io.open(path, "w", encoding="utf-8", newline="") as handle:
    handle.write(normalized.replace("\n", "\r\n") if crlf else normalized)
print("OK: installer-shortcut-fix")
