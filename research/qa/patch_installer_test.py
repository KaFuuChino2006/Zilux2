# -*- coding: utf-8 -*-
import io

p = r"E:\Zilux2开发\src\Zilux2.Installer\InstallerCore.cs"
s = io.open(p, 'r', encoding='utf-8', newline='').read()
s = s.replace(
    "public static void Install(string targetDir, IProgress<(int Percent, string Message)> progress, bool createShortcuts = true)",
    "public static void Install(string targetDir, IProgress<(int Percent, string Message)> progress, bool createShortcuts = true, bool register = true)")
s = s.replace(
    "        if (createShortcuts) CreateShortcuts(targetDir);\n        WriteUninstaller(targetDir);\n        WriteUninstallRegistry(targetDir);",
    "        if (createShortcuts) CreateShortcuts(targetDir);\n        if (register)\n        {\n            WriteUninstaller(targetDir);\n            WriteUninstallRegistry(targetDir);\n        }")
io.open(p, 'w', encoding='utf-8', newline='').write(s)

p2 = r"E:\Zilux2开发\src\Zilux2.Installer\Program.cs"
s2 = io.open(p2, 'r', encoding='utf-8', newline='').read()
old = """        if (silent)
        {
            var progress = new Progress<(int Percent, string Message)>(_ => { });
            InstallerCore.KillRunning();
            InstallerCore.Install(targetDir, progress);
            return;
        }"""
new = """        if (silent)
        {
            var noShortcuts = args.Contains("--no-shortcuts", StringComparer.OrdinalIgnoreCase);
            var progress = new Progress<(int Percent, string Message)>(_ => { });
            InstallerCore.KillRunning();
            InstallerCore.Install(targetDir, progress, createShortcuts: !noShortcuts, register: !noShortcuts);
            return;
        }"""
assert s2.count(old) == 1
s2 = s2.replace(old, new, 1)
io.open(p2, 'w', encoding='utf-8', newline='').write(s2)
print("test hooks added")
