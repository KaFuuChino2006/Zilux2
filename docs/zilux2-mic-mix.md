# 麦克风混音（音乐 + 本机麦克风）

## 这是什么

Zilux2 把**自己正在播放的音乐**和**物理麦克风**混成一路，送到虚拟音频线的播放端
（VB-Audio `CABLE Input`、VoiceMeeter `VoiceMeeter Input` 等）。在 Discord / 游戏语音里
把麦克风选成对应的录音端（通常是 `CABLE Output`），对方就能同时听到你说话和音乐；
本机扬声器仍然照常播放，物理麦克风也不会被系统独占。

## 为什么需要虚拟音频线

Windows 没有向「任意应用创建一个虚拟麦克风」的公开接口；软件不能直接把自己的 PCM
写进一条系统录音设备。必须有一条虚拟音频线驱动：

- **VB-Audio Virtual Cable**（免费，推荐）：
  - 播放端：`CABLE Input (VB-Audio Virtual Cable)`
  - 录音端：`CABLE Output (VB-Audio Virtual Cable)`
- VoiceMeeter / Virtual Audio Cable 同理：Zilux2 输出到它的 Input，语音软件选它的 Output。

安装后不需要在 Zilux2 里手填设备；设置页会自动识别标签里带 `CABLE Input` /
`VoiceMeeter Input` / `Virtual Audio Cable` 的播放设备。

## 使用

1. 安装 VB-Audio Virtual Cable（安装后可能需要重启音频服务/系统）。
2. Zilux2 → 设置 → **麦克风混音**。
3. 选择「物理麦克风」（例如 `麦克风 (Razer Seiren Mini)`）。
4. 「虚拟音频线输出」应自动选中 `CABLE Input (VB-Audio Virtual Cable)`。
5. 点 **开启混音**。
6. 在 Discord / 游戏语音里把输入设备改成 `CABLE Output (VB-Audio Virtual Cable)`。

之后：

- 你正常对着物理麦克风说话 → 对方能听到。
- Zilux2 播放音乐 → 对方能听到。
- 本机扬声器/耳机仍播放 Zilux2，音量由播放器控制；「音乐音量」只改送进麦克风的那一路。
- 如果 CABLE Output 电平偏小：先把 Windows 里 **CABLE Input 的输出音量拉满**，再提高
  Zilux2 面板里的 **总输出增益**（最高 600%）。内置限幅会防止增益过高时削波。
  Zilux2 开启混音时也会尝试把选中的虚拟音频线端点音量自动拉到 100%，避免系统把
  CABLE Input 压在 20–50%。
- 关闭混音或退出 Zilux2 后，把语音软件的输入设备切回物理麦克风即可。

## 常见问题：CABLE Output 麦克风测试一直是 0%

1. **Windows 设置 → 系统 → 声音 → CABLE Output → 属性**，把「允许应用和 Windows
   将此设备用于音频」改成 **允许**。如果这里是「不允许」，所有软件（包括 Windows
   麦克风测试和语音软件）都收不到 CABLE Output 的声音。
2. 打开 **输出设备 CABLE Input** 的属性，确认音量不是 0、没有被静音。
3. 回到 Zilux2 的「麦克风混音」，点「测试 CABLE 输出」发送 1 秒提示音，同时看
   Windows 麦克风测试的波形/音量。
4. 仍然为 0 时，确认 VB-Audio Virtual Cable 驱动正常（设备管理器里没有黄色感叹号），
   必要时重装驱动或重启 Windows Audio 服务。

> 「允许应用和 Windows 将此设备用于音频 = 不允许」是设备级开关，不是 Zilux2 能绕过的；
> 它关闭时 CABLE Output 不会向任何应用提供音频。

## 分发与许可

VB-Audio 官方允许把 **标准版 VB-CABLE 原样**随软件分发/嵌入安装器，前提是保留
donationware 说明和来源：

- 来源：<https://www.vb-cable.com>
- 说明：VB-CABLE 是 donationware，欢迎用户捐赠或购买 license
- 不要修改驱动文件；`VB-CABLE A+B` / `C+D` 不能随产品分发

企业/机构批量部署需要向 VB-Audio 购买对应数量的 license。设置页的「获取 VB-CABLE」
按钮只打开官方下载页，不静默安装；后续如果做 Hub 内置安装器，需要保留上述署名和捐赠入口。

## 边界

- 只采集 **Zilux2 自己**的音频（页面 Web Audio 图），不会把游戏、系统提示音、其他人的
  语音一起送进麦克风。
- 麦克风经过 Web Audio 混音会带来少量额外延迟；如果语音软件里听到自己声音明显滞后，
  可关闭语音软件的「监听自己」或使用耳机。
- 需要麦克风权限。WebView2 宿主已经授权 `https://zilux2.local`；首次开启时 Windows
  仍可能弹出隐私提示。
- 如果输出列表里没有 `CABLE Input`，说明虚拟音频线没安装或驱动未启动；此时「开启混音」
  会保持禁用并给出提示。
