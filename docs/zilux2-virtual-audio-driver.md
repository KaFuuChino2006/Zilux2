# Zilux2 自研虚拟音频驱动：架构与实施计划

> 状态：设计稿，尚未开始编码。目标不是复刻 VB-CABLE，而是做一个可随 Zilux2 分发、
> 后续能承载更多音频功能的虚拟音频设备平台。

## 1. 目标

### 1.1 第一阶段（MVP）

- 提供一个系统录音设备 **Zilux2 Microphone**，Discord / 游戏语音 / OBS 可直接选择。
- Zilux2 把「音乐 + 物理麦克风」混音后的 PCM 写入该设备。
- 本机扬声器/耳机继续正常播放 Zilux2，不依赖 VB-CABLE。
- 支持 48 kHz / 16-bit / 双声道，端到端延迟目标 ≤ 50 ms。
- 安装包随 Zilux2 分发；支持安装、升级、卸载。

### 1.2 后续能力（驱动平台化）

| 能力 | 实现层 | 说明 |
| --- | --- | --- |
| 音乐 + 麦克风混音 | 用户态 DSP | 当前功能迁移到自研设备 |
| 虚拟扬声器 `Zilux2 Speaker` | 驱动 render endpoint | 其它应用输出到 Zilux2，可录制/转发/混音 |
| 多虚拟麦克风 | 驱动多实例 | 不同语音软件选择不同混音 |
| 每应用路由 | 用户态 WASAPI / 进程回环 | 驱动只提供端点，不解析进程 |
| 麦克风降噪 / EQ / 压缩 | 用户态 DSP | 可独立更新，不进内核 |
| 说话时音乐自动 duck | 用户态 sidechain | 检测麦克风能量 |
| 录制 / 直播混音 | 用户态 | 多路总线 |
| 低延迟监听 | 驱动 + 用户态 | 可配置缓冲 |
| 设备预设 / 场景 | 用户态配置 | 游戏、语音、直播 |

原则：**驱动保持薄、稳定、少逻辑；DSP 和路由放用户态**。这样功能可以快速迭代，驱动不需要频繁重新签名。

## 2. 为什么必须用内核驱动

Windows 没有用户态 API 可以创建新的录音端点：

- WASAPI 只能采集/播放已有端点；
- APO 只能处理已有端点，不能新建麦克风；
- DirectShow / MediaFoundation 虚拟摄像头式方案不能出现在系统麦克风列表；
- 只有内核音频驱动（PortCls / AVStream / ACX）能注册 `KSCATEGORY_AUDIO` 端点。

## 3. 驱动模型选择

### 推荐：PortCls + WaveRT

- 成熟、文档和示例最多，虚拟声卡常用。
- Capture-only 设备可以先实现一个 WaveRT capture pin + topology。
- 后续再加 render pin 做虚拟扬声器。
- 相比 ACX，PortCls 的调试资料更充分，适合第一版。

### 不推荐第一版用 ACX

ACX 是较新的音频驱动框架，概念更现代，但示例/社区资料少，学习与调试成本更高；
等 PortCls 版本稳定后再评估迁移。

### 不用 KMDF-only

KMDF 只能创建设备对象，不能自动变成系统音频端点；音频端点仍需要 PortCls/AVStream/ACX
的 KS 引脚与拓扑。

## 4. 总体架构

```text
┌────────────────────────────────────────────────────────────┐
│ Zilux2 页面 / 播放器（Web Audio）                          │
│  音乐 + 物理麦克风 → 混音 → PCM 48k/16bit/stereo           │
└───────────────────────────┬────────────────────────────────┘
                            │ 共享内存环形缓冲 + 事件
┌───────────────────────────▼────────────────────────────────┐
│ Zilux2AudioBridge（用户态，随 Zilux2 启动）                │
│  - 打开驱动控制设备                                        │
│  - 注册/映射共享环形缓冲                                   │
│  - 写入 PCM，处理欠载/溢出                                 │
│  - 设备状态、格式协商、错误上报                            │
└───────────────────────────┬────────────────────────────────┘
                            │ IOCTL / shared section
┌───────────────────────────▼────────────────────────────────┐
│ Zilux2 Virtual Audio Driver（内核）                        │
│  PortCls adapter                                           │
│   ├─ WaveRT capture miniport → Zilux2 Microphone           │
│   ├─ topology miniport（麦克风端点）                       │
│   └─ control device（IOCTL：注册 ring、查询状态）          │
└───────────────────────────┬────────────────────────────────┘
                            │ KS / WaveRT
┌───────────────────────────▼────────────────────────────────┐
│ Discord / 游戏 / OBS：选择 Zilux2 Microphone               │
└────────────────────────────────────────────────────────────┘
```

### 4.1 数据面

- 用户态 Bridge 创建共享内存 section（例如 4 × 10 ms 的 ring）。
- 驱动在 `StartStream` 时映射 section，记录读指针。
- WaveRT 音频引擎按周期拉取；驱动把 ring 中 PCM 复制到 WaveRT buffer。
- 欠载时填静音并计数；溢出时丢最旧数据。
- 位置寄存器按 WaveRT 规范推进；通知事件用于低延迟唤醒。

### 4.2 控制面 IOCTL（版本化）

```text
IOCTL_ZILUX_AUDIO_GET_VERSION
IOCTL_ZILUX_AUDIO_REGISTER_RING   // 传入 section handle / 大小 / 格式
IOCTL_ZILUX_AUDIO_START
IOCTL_ZILUX_AUDIO_STOP
IOCTL_ZILUX_AUDIO_GET_STATS       // underrun / overrun / latency
IOCTL_ZILUX_AUDIO_SET_FORMAT      // 后续：44.1/48/96k、位深、声道
```

所有 IOCTL 必须：

- 校验输入/输出长度、版本、对齐；
- 不信任用户指针，使用 `METHOD_BUFFERED` 或显式 MDL；
- 句柄生命周期与进程退出绑定；
- 不允许任意物理内存/端口访问。

## 5. 设备与端点命名

- 设备实例：`Zilux2 Virtual Audio`
- 录音端点：`Zilux2 Microphone`
- 后续播放端点：`Zilux2 Speaker`
- 设备接口 GUID：固定、版本化，例如
  `{6E7B1E2A-...-...}`（实现时生成并写入 INF 与用户态代码）
- 硬件 ID：`ZILUX\VirtualAudio`
- 兼容 ID：`ZILUX\VirtualAudio`

不要把设备名做成每次安装随机，否则语音软件的设备选择会丢失。

## 6. 安装、升级、卸载

### 安装包内容

```text
driver/
  Zilux2VirtualAudio.sys
  Zilux2VirtualAudio.inf
  Zilux2VirtualAudio.cat
  zilux2-audio-bridge.exe
```

### 安装流程

1. 管理员权限运行安装器。
2. `pnputil /add-driver ... /install` 或 `SetupCopyOEMInf`。
3. 创建设备节点（`devcon`/`DiInstallDevice` 或 INF `AddService`）。
4. 启动 `Zilux2AudioBridge`（Windows 服务或随应用启动）。
5. 应用检测端点是否出现，失败则回退到 CABLE / 普通麦克风。

### 升级

- 驱动版本号写入 INF `DriverVer`。
- 安装器先停止 Bridge，再替换驱动包；音频服务重启。
- 保留设备实例 ID，避免用户重新选择麦克风。
- 失败回滚到上一版驱动包。

### 卸载

- 停止并删除 Bridge 服务。
- `pnputil /delete-driver`，删除设备节点。
- 清理共享内存/配置；不删除用户设置。

## 7. 签名与分发（最大成本）

### 开发/测试

- Visual Studio 2022 + WDK + Windows SDK。
- 测试机/虚拟机：`bcdedit /set testsigning on`，关闭 Secure Boot。
- 用测试证书签名 `.sys`，仅用于内部验证。

### 正式分发

- **EV 代码签名证书**（DigiCert/Sectigo 等）。
- Microsoft Partner Center 注册，提交驱动做 **attestation signing**。
- 生成 `.cat`，随 INF/SYS 一起安装。
- Windows 10/11 x64 内核驱动默认强制签名；未签名驱动无法在普通用户机器安装。
- 建议跑 HLK/Driver Verifier，至少覆盖：
  - 安装/升级/卸载；
  - 睡眠/唤醒；
  - 采样率/位深切换；
  - 多应用同时打开；
  - 设备禁用/启用；
  - 长时间播放（数小时）；
  - 蓝屏/内存泄漏压力测试。

### 版本策略

- 驱动与 Bridge 协议版本独立：`driverVersion` / `protocolVersion`。
- 应用启动时握手；不兼容时提示升级，不直接崩溃。

## 8. 延迟与格式

### MVP

- 48 kHz、16-bit、stereo。
- 缓冲 3 × 10 ms，目标端到端 20–50 ms。
- WaveRT 位置寄存器 + 事件通知。

### 后续

- 44.1/48/96 kHz；16/24/32-bit float；mono/stereo/多声道。
- 格式由 KS 协商；驱动内部重采样或要求 Bridge 输出固定格式。
- 低延迟模式（2 × 5 ms）与稳定模式可切换。

## 9. 安全与稳定性

- 驱动只做端点、ring 映射、PCM 拷贝；不做网络/文件/注册表解析。
- 所有共享内存写入做边界检查；ring 使用原子读写指针。
- 用户进程退出/崩溃：驱动停止拉流、填静音，不蓝屏。
- 驱动卸载时等待所有流关闭。
- 开启 Driver Verifier、Special Pool、Pool Tracking。
- 代码签名 + 安装包签名，降低杀软误报。

## 10. 代码结构（规划）

```text
driver/
  Zilux2VirtualAudio.sln
  src/
    DriverEntry.c
    Adapter.c            // PortCls adapter 注册
    MiniportWaveRT.c     // capture/render WaveRT miniport
    MiniportTopology.c   // 麦克风拓扑
    RingBuffer.c         // 共享 ring 映射/拷贝
    ControlDevice.c      // IOCTL 控制设备
    Trace.h
  include/
    Zilux2AudioIoctl.h   // 用户态/内核共享 ABI
  package/
    Zilux2VirtualAudio.inf
    Zilux2VirtualAudio.cat
  bridge/
    Zilux2AudioBridge.cs // 用户态桥接（可先做控制台）
```

应用侧新增：

```text
src/Zilux2/Audio/VirtualMic/
  VirtualMicDevice.cs    // 枚举/握手/错误处理
  VirtualMicWriter.cs    // 共享内存写入
```

## 11. 分阶段计划

### Phase 0：环境与设计（1–2 周）

- 安装 VS 2022 + WDK + Windows SDK。
- 准备 Windows 11 测试虚拟机（快照、测试签名）。
- 固化 IOCTL ABI、设备 ID、ring 布局。
- 建立驱动项目骨架，能编译出空驱动并在 VM 安装。

### Phase 1：Capture-only 原型（4–8 周）

- PortCls adapter + WaveRT capture pin + topology。
- 设备管理器中显示 `Zilux2 Microphone`。
- 固定 48k/16-bit/stereo；Bridge 写入测试音。
- Audacity/OBS 能录到测试音。

### Phase 2：Zilux2 集成（4–6 周）

- 页面混音 PCM 通过宿主/Bridge 写入驱动。
- 设置页新增「使用 Zilux2 麦克风」选项，自动检测。
- 回退：未安装驱动时继续用 CABLE / 物理麦克风。
- 延迟、欠载、设备重启测试。

### Phase 3：稳定性与安装器（4–8 周）

- 安装/升级/卸载、服务、日志、错误恢复。
- Driver Verifier、长时间压力、多应用并发。
- 安装包集成；Beta 测试。

### Phase 4：签名与分发（4–8 周，取决于证书/审核）

- EV 证书、Partner Center、attestation。
- 正式签名包、版本策略、回滚。
- 发布。

### Phase 5：平台功能

- 虚拟扬声器、多实例、DSP、每应用路由、录音/直播混音。

> 从零写、可分发、带签名的生产驱动，通常按 **6–12 个月** 量级评估；上面的周数是
> 有经验驱动开发者的乐观估算，不含证书审核和兼容性返工。

## 12. 当前环境缺口

这台机器目前没有：

- Visual Studio / MSVC
- Windows Driver Kit（WDK）
- Windows SDK 的驱动工具
- 测试签名虚拟机

在开始 Phase 0 之前必须先补齐，否则只能写不可编译的代码。

## 13. 需要确认的决策

1. 只支持 Windows 10/11 x64，还是也要 ARM64？
2. 第一版只做 capture（麦克风），还是同时做 render（虚拟扬声器）？
3. 是否已有 EV 代码签名证书 / Partner Center 账号？
4. 是否接受 PortCls + WaveRT，而不是 ACX？
5. 安装器是否允许要求管理员权限并重启音频服务？
