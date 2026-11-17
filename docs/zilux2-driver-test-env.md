# Zilux2 驱动测试环境

开发测试签名驱动需要 **Secure Boot 关闭**。这台开发机当前 `Secure Boot = True`，
`bcdedit /set testsigning on` 会被安全引导策略拒绝，因此不能直接在主机加载测试驱动。

推荐使用 Hyper-V 虚拟机；快照可以随时回滚，不会影响日常系统。

## 方案 A：Hyper-V 虚拟机（推荐）

1. 管理员 PowerShell 启用 Hyper-V：
   ```powershell
   Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All
   ```
   重启。
2. 创建“外部/默认”虚拟交换机，确保能联网。
3. 用 Windows 10/11 ISO 创建 Gen 2 虚拟机：
   - 关闭 Secure Boot（Hyper-V 设置 → 安全 → 取消“启用安全启动”）
   - 4 GB 内存、2 vCPU、60 GB 动态磁盘
   - 装好 Windows 后打快照 `clean`
4. 虚拟机内管理员 PowerShell：
   ```powershell
   bcdedit /set testsigning on
   shutdown /r /t 0
   ```
5. 重启后桌面右下角出现“测试模式”。
6. 把 `driver\src\control\package` 整个目录复制进虚拟机。
7. 安装测试证书：
   ```powershell
   Import-Certificate -FilePath zilux2-test-driver.cer -CertStoreLocation Cert:\LocalMachine\Root
   Import-Certificate -FilePath zilux2-test-driver.cer -CertStoreLocation Cert:\LocalMachine\TrustedPublisher
   ```
8. 安装控制驱动：
   ```powershell
   pnputil /add-driver .\Zilux2AudioControl.inf /install
   ```
   或用 WDK 的 **x64** `devcon.exe`：
   ```powershell
   devcon install Zilux2AudioControl.inf ZILUX\VirtualAudioControl
   ```
9. 验证：
   ```powershell
   driverquery /v | findstr Zilux2AudioControl
   ```
   并运行 `driver\tools\Zilux2AudioBridge`，应该能打开
   `\\.\Zilux2VirtualAudio` 并读到 ABI 版本。

## 方案 B：主机 BIOS 关闭 Secure Boot

1. 重启进入 UEFI/BIOS。
2. 关闭 Secure Boot（不同主板在 Security / Boot 菜单）。
3. 保存重启，管理员执行：
   ```powershell
   bcdedit /set testsigning on
   shutdown /r /t 0
   ```
4. 右下角出现“测试模式”后安装驱动。

> 这会降低主机启动安全性；测试完成后可用
> `bcdedit /set testsigning off` 并重新打开 Secure Boot。

## 当前主机检查结果

```text
Secure Boot: True
Hyper-V:     Disabled
WDK:         10.0.26100.6584 installed
MSVC:        14.44.35207 installed
Test cert:   imported to LocalMachine Root / TrustedPublisher
```

## 安装驱动时常见错误

- `0x800B0109`：测试证书没有进 Trusted Root/TrustedPublisher，或没有开 testsigning。
- `0x80070490`：INF 硬件 ID 与 `devcon` 参数不一致。
- 设备黄色感叹号、Code 52：Secure Boot 仍开着 / 测试签名未生效。
- `devcon.exe` 无法运行：选错架构；x64 系统要用
  `C:\Program Files (x86)\Windows Kits\10\Tools\10.0.26100.0\x64\devcon.exe`。
