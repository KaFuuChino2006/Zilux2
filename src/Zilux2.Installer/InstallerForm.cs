using System.Drawing.Drawing2D;

namespace Zilux2.Installer;

internal sealed class InstallerForm : Form
{
    private readonly TextBox _pathBox;
    private readonly Button _installButton;
    private readonly Button _cancelButton;
    private readonly ProgressBar _progress;
    private readonly Label _status;
    private readonly CheckBox _launchCheck;
    private bool _installing;

    public InstallerForm()
    {
        Text = "Zilux2 安装程序";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        MinimizeBox = true;
        ClientSize = new Size(620, 430);
        BackColor = Color.FromArgb(246, 247, 251);
        Font = new Font("Microsoft YaHei UI", 9.5f);
        try
        {
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        }
        catch
        {
            // ignore
        }
        DoubleBuffered = true;

        var header = new Panel { Dock = DockStyle.Top, Height = 150, BackColor = Color.White };
        header.Paint += (_, e) =>
        {
            using var brush = new LinearGradientBrush(header.ClientRectangle,
                Color.FromArgb(244, 240, 255), Color.FromArgb(232, 247, 255), 20f);
            e.Graphics.FillRectangle(brush, header.ClientRectangle);
            using var accent = new SolidBrush(Color.FromArgb(106, 92, 255));
            e.Graphics.FillRectangle(accent, 0, header.Height - 3, header.Width, 3);
        };
        var title = new Label
        {
            Text = "Zilux2",
            Font = new Font("Microsoft YaHei UI", 26f, FontStyle.Bold),
            ForeColor = Color.FromArgb(22, 24, 35),
            AutoSize = true,
            Location = new Point(28, 26),
            BackColor = Color.Transparent,
        };
        var subtitle = new Label
        {
            Text = "沉浸式音乐空间 · 3D 歌词 · 磁贴歌单",
            Font = new Font("Microsoft YaHei UI", 10f),
            ForeColor = Color.FromArgb(96, 104, 122),
            AutoSize = true,
            Location = new Point(31, 78),
            BackColor = Color.Transparent,
        };
        var version = new Label
        {
            Text = $"版本 {InstallerCore.Version}",
            Font = new Font("Microsoft YaHei UI", 9f),
            ForeColor = Color.FromArgb(120, 128, 146),
            AutoSize = true,
            Location = new Point(32, 104),
            BackColor = Color.Transparent,
        };
        header.Controls.AddRange(new Control[] { title, subtitle, version });
        Controls.Add(header);

        var pathLabel = new Label
        {
            Text = "安装位置",
            Location = new Point(30, 170),
            AutoSize = true,
            ForeColor = Color.FromArgb(60, 66, 82),
        };
        _pathBox = new TextBox
        {
            Location = new Point(30, 194),
            Width = 440,
            Text = InstallerCore.DefaultInstallDir,
            BorderStyle = BorderStyle.FixedSingle,
        };
        var browse = new Button
        {
            Text = "浏览…",
            Location = new Point(478, 192),
            Size = new Size(110, 30),
            FlatStyle = FlatStyle.System,
        };
        browse.Click += (_, _) =>
        {
            using var dialog = new FolderBrowserDialog { SelectedPath = _pathBox.Text };
            if (dialog.ShowDialog(this) == DialogResult.OK) _pathBox.Text = dialog.SelectedPath;
        };

        string left = Path.Combine(InstallerCore.DefaultInstallDir, "Uninstall.exe");
        var hint = new Label
        {
            Text = "安装到当前用户目录，无需管理员权限；桌面和开始菜单会创建快捷方式。",
            Location = new Point(30, 232),
            Width = 558,
            ForeColor = Color.FromArgb(120, 128, 146),
        };
        _ = left;

        _progress = new ProgressBar
        {
            Location = new Point(30, 268),
            Size = new Size(558, 14),
            Style = ProgressBarStyle.Continuous,
        };
        _status = new Label
        {
            Text = "准备就绪",
            Location = new Point(30, 290),
            Width = 558,
            ForeColor = Color.FromArgb(90, 98, 116),
        };
        _launchCheck = new CheckBox
        {
            Text = "安装完成后立即启动 Zilux2",
            Location = new Point(30, 336),
            AutoSize = true,
            Checked = true,
        };
        _installButton = new Button
        {
            Text = "安装",
            Location = new Point(390, 368),
            Size = new Size(96, 34),
            BackColor = Color.FromArgb(106, 92, 255),
            ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat,
        };
        _installButton.FlatAppearance.BorderSize = 0;
        _installButton.Click += async (_, _) => await RunInstallAsync();
        _cancelButton = new Button
        {
            Text = "退出",
            Location = new Point(494, 368),
            Size = new Size(96, 34),
            FlatStyle = FlatStyle.System,
        };
        _cancelButton.Click += (_, _) => Close();

        Controls.AddRange(new Control[] { pathLabel, _pathBox, browse, hint, _progress, _status, _launchCheck, _installButton, _cancelButton });
    }

    private async Task RunInstallAsync()
    {
        if (_installing) return;
        var dir = _pathBox.Text.Trim();
        if (string.IsNullOrWhiteSpace(dir))
        {
            MessageBox.Show(this, "请填写安装位置", "Zilux2 安装程序", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        _installing = true;
        _installButton.Enabled = false;
        _cancelButton.Enabled = false;
        _pathBox.Enabled = false;
        var progress = new Progress<(int Percent, string Message)>(p =>
        {
            _progress.Value = Math.Clamp(p.Percent, 0, 100);
            _status.Text = p.Message;
        });
        try
        {
            _status.Text = "正在关闭已运行的 Zilux2…";
            InstallerCore.KillRunning();
            await Task.Run(() => InstallerCore.Install(dir, progress));
            _progress.Value = 100;
            _status.Text = "安装完成";
            if (_launchCheck.Checked) InstallerCore.Launch(dir);
            MessageBox.Show(this, "Zilux2 安装完成！\n\n桌面和开始菜单里都能找到它。", "Zilux2 安装程序",
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            Close();
        }
        catch (Exception error)
        {
            _status.Text = "安装失败";
            _progress.Value = 0;
            MessageBox.Show(this, "安装失败：\n" + error.Message, "Zilux2 安装程序", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            _installing = false;
            _installButton.Enabled = true;
            _cancelButton.Enabled = true;
            _pathBox.Enabled = true;
        }
    }
}
