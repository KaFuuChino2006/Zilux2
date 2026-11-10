# 系统音频切换 OSD

> 1.1.102

切换系统默认播放设备时，屏幕右上角显示一张独立的 WPF 卡片：

```text
系统音频                              正在切换 / 已切换
当前播放 / 上一台         ->          切换到 / 正在使用
Realtek HD Audio 2nd output          扬声器
────────────── 进度 ──────────────
```

## 交互

- 主机快捷键 `F7`（可在 设置 → 快捷键 修改 `systemOutput`）循环系统输出设备。
- 设置 → 系统音频 → `立即切换一次` 也会触发。
- 页面选择设备（`setDefault`）由宿主转发，同样触发 OSD。
- 外部（Windows 音量合成器/系统设置）切换默认设备时，宿主每 2.5s 轮询一次并补发 OSD。
- OSD 是独立 Topmost 窗口，不抢焦点、鼠标穿透；主窗口最小化/隐藏时仍可显示。
- 显示 2.8s 后淡出；650ms 时从“正在切换”切到“已切换”，上一台降为次要色，目标设备转为橙色。
- OSD 已经显示时再次切换：不重放弹入/上移动画，卡片和箭头留在原位，只更新左右设备名并重新计时。

## 文件

- `src/Zilux2/SystemAudioOsdWindow.xaml`
- `src/Zilux2/SystemAudioOsdWindow.xaml.cs`
- `src/Zilux2/MainWindow.xaml.cs`：`ShowSystemAudioOsd`、`StartSystemAudioWatch`、`CycleSystemOutput`
- `src/Zilux2/WebViewHost.cs`：`SystemAudioOutputChanged` 事件、`HandleAudioOutputMessage` 的 `setDefault`
- `src/Zilux2/Audio/SystemAudioOutputService.cs`

## 视觉

- 470×116 DIP，右上角距工作区 24px；卡片本身约 450×96。
- 奶油白卡片、深墨色文字、蓝灰强调色；和软件浅色主题使用同一组颜色。
- 15px 圆角；窗口留 10px 透明边给阴影，圆角不会被窗口边缘切成方角。
- 设备名去掉尾部驱动商括号（如 `(Realtek(R) Audio)`），单行省略；完整名称仍显示在系统音频设置页。
- 箭头是一条细横线接实心箭头，没有中间的移动光点；入场时横线生长、箭头随后出现，目标设备在 650ms 后淡入。

## 验证

```text
dotnet build -c Release     0 warning / 0 error
node --test web/tests/*.test.cjs
60 pass / 0 fail
```

实机截帧：

- `docs/assets/system-audio-osd/entering.png`
- `docs/assets/system-audio-osd/switched.png`

## 已知限制

- 外部切换依赖 2.5s 轮询，最多有约 2.5s 延迟；通过应用内快捷键/设置切换是即时的。
- 设备名尾部括号会被 OSD 省略，完整名称在设置页查看。
