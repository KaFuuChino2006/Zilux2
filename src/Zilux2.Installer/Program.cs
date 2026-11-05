namespace Zilux2.Installer;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        var silent = args.Contains("--silent", StringComparer.OrdinalIgnoreCase);
        var uninstall = args.Contains("--uninstall", StringComparer.OrdinalIgnoreCase);
        var dirArgIndex = Array.FindIndex(args, a => string.Equals(a, "--dir", StringComparison.OrdinalIgnoreCase));
        var targetDir = dirArgIndex >= 0 && dirArgIndex + 1 < args.Length
            ? args[dirArgIndex + 1]
            : InstallerCore.DefaultInstallDir;

        if (uninstall)
        {
            InstallerCore.Uninstall(Path.GetDirectoryName(Application.ExecutablePath.TrimEnd('\\')) ?? targetDir);
            return;
        }

        if (silent)
        {
            var noShortcuts = args.Contains("--no-shortcuts", StringComparer.OrdinalIgnoreCase);
            var launch = args.Contains("--launch", StringComparer.OrdinalIgnoreCase);
            var progress = new Progress<(int Percent, string Message)>(_ => { });
            InstallerCore.KillRunning();
            // D-25：--no-shortcuts 只跳过快捷方式；卸载注册表仍须刷新，
            // 否则自动更新后 DisplayVersion/InstallLocation 会停留在旧版本。
            InstallerCore.Install(targetDir, progress, createShortcuts: !noShortcuts, register: true);
            if (launch)
            {
                InstallerCore.Launch(targetDir);
            }
            return;
        }

        Application.Run(new InstallerForm());
    }
}
