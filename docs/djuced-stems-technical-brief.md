# DJUCED 6.8.1 分轨分离（STEMS 2.0）技术要点

> 结论先行：**本地小模型 + 流式重叠相加 + 内存缓存 + 四路开关**。
> 模型是 **PyTorch 2.3.1 导出的 ONNX**（编码器-解码器 CNN，含 BatchNorm / LeakyReLU / 跳跃连接，
> 图内自带 DFT），**权重内嵌在 `DJUCED.exe` 的 `.data` 里**，用随附的 **ONNX Runtime** 跑；
> 另有一条纯 C++ 的 `fdeep` 后端作为便携实现。分离全程在设备上，不联网、不落盘。

## 1. 运行形态

| 项 | 实测 |
|---|---|
| 分轨数 | 4（drums / bass / other / vocals），UI 显示为 鼓乐 / 低音 / 旋律 / 人声 |
| 计算位置 | 本机 CPU，进程内（`DJUCED.exe` 直接加载 `NNPredictionDispatcher_*.dll`） |
| CPU 占用 | 播放 + 分离同时进行时 ≈ **0.81 核**，68 线程 |
| 内存 | 工作集 ≈ **2.8 GB**（含 Qt/QML 与曲库） |
| 磁盘缓存 | **无**（`Documents\DJUCED\cache` 在分离期间无新增；分离结果只在内存） |
| 单声道 | 直接拒绝：`STEMS can't be computed with mono songs.` |
| 触发 | `instant_stems`（载入即算）/ `analyze_stems_on_load` / 打垫开关 |
| 线程 | `stems_intraop_threads`（本机配置值 2） |
| 交互 | 四个垫是 **kill/restore**（把某一路从混音里摘掉/放回），不是 solo |

## 2. 模型：内嵌的 ONNX（PyTorch 2.3.1 导出）

在 `DJUCED.exe` 的 `.data` 段里能直接读到 ONNX protobuf 的字符串表：

```
0x1b7c5c4  "pytorch"  "2.3.1:"  "input"  "/Transpose_output_0"
           "bn0.weight" "bn0.bias" "bn0.running_mean" "bn0.running_var"
0x1b0bcd3  zplane::NNPredictionDispatcher 的 fdeep RTTI
0x1b0c1a2  "NNPredictionDispatcher_fd.dll"
0x1b0c652  "NNPredictionDispatcher_on.dll"
```

图结构（按节点名统计，18 MB 窗口内）：

```
Conv 753   LeakyRelu 568   Add 330   BatchNormalization 300
AveragePool 53   Concat 30   Resize 24   MatMul 8   DFT 2   Sigmoid 2
节点名样例：encoder…/decoder_block1/conv_block2/conv1/Conv_output_0
            decoder_block1/bn1/BatchNormalization_output_0
参数张量：bn0.*、conv_block7a/7b/7c/7d.*、after_conv2.*、after_conv_block1.* …
```

判读：

- **编码器-解码器 CNN（U-Net 型）**：`conv_block1..7a/7b/7c/7d` + `decoder_block1..`，`Add` 330 次即跳跃连接，`AveragePool`/`Resize` 做下采样与上采样。
- **BN + LeakyReLU** 是主干非线性（568 个 LeakyReLU），末端 `Sigmoid` 2 个（掩码/门控输出）。
- **图内 DFT 2 个**：频谱变换在模型图里完成，不是外挂 STFT；也就是说模型吃的是**复数谱/幅度谱**类张量（与 htdemucs 的波形域路线不同）。
- 权重是 protobuf 里的 raw_data，随 exe 一起分发（`ONNXModel(char const*, size_t)` 就是"从内存字节建模型"的构造）。

## 3. 推理后端：两套 dispatcher

| DLL | 大小 | 内容 |
|---|---|---|
| `NNPredictionDispatcher_on.dll` | 15,727,104 B | **ONNX Runtime 1.19 静态链接**（conan 包 `onnxr191ae88325774`），`zplane::NNPredictionDispatcher::ONNXImpl` / `ONNXModel`，带 OpenVINO / Eigen 线程池等 EP 代码 |
| `NNPredictionDispatcher_fd.dll` | 1,664,000 B | **fdeep**（header-only C++ 推理库）+ `nlohmann::json` + Eigen：`zplane::NNPredictionDispatcher::FdeepImpl` / `FdeepModel`，模型以 **JSON** 形式给出 |

`_on` 是主力（ONNX 图 + ORT），`_fd` 是纯 C++ 便携路径（不依赖 ORT，模型用 JSON 描述），
两者接口一致（`predict(zplTensorArray in, zplTensorArray& out)`），由宿主按可用性选择。

## 4. 宿主侧 DSP（`StemsProAlgorithm.cpp`，zplane Stems Pro 1.1.8）

二进制里保留的源码路径：

```
C:\janeway\workspace\tems-Pro_Stems-Pro-Windows_1.1.8@3\src\StemsProAlgorithm.cpp
...\extern\Algorithms\include\Algorithms/OverlapAddStep.h
...\extern\Algorithms\include\Algorithms/Hopping.h
...\Resample\src\Algorithms\Resampler.cpp
...\Fft.cpp
```

即：**分块（Hopping）→ 频谱（Fft）→ 网络推理 → 逆变换 → 重叠相加（OverlapAddStep）→ 重采样（Resampler）**，
是一条标准的流式分轨流水线；窗口长度/hop 具体数值未在字符串里暴露（推断 hop = 窗口的 1/4 量级，
与工业实现一致）。

## 5. 与 Zilux2 现有方案（htdemucs）的差别

| 维度 | DJUCED（zplane Stems Pro） | Zilux2（htdemucs-dft-fp16） |
|---|---|---|
| 模型域 | 图内 DFT，谱域掩码 | 波形域（dft 变体带频域分支） |
| 模型体积 | 内嵌于 exe（weights 数百 MB 内的 .data 一部分） | 单独 onnx ≈ 90 MB |
| 窗口 | 短窗流式（Hopping + OLA） | 30 s 窗、25% 重叠、7.8 s 段 |
| 实时性 | 播放中持续推理，≈0.8 核 | 离线算窗，0.30× 实时（30 s 用 9 s） |
| 缓存 | 仅内存 | 磁盘 LRU 512 MB / 2 GB 可调 |
| 输出 | 4 轨（drums/bass/other/vocals） | 4 轨（已支持 `stems=4`） |
| 质量（自测） | 未测 | MUSDB18 test 三曲均值 SDR **9.27 dB**（drums 10.26 / bass 9.59 / other 6.05 / vocals 11.19） |

## 6. 值得抄的 5 条（对 Zilux2 的落点）

1. **短窗流式 + OLA，而不是整段离线**：把 `StemSeparationService` 的 30 s 窗降到 2–4 s、hop 1 s，
   首包时延从 7 s 级降到 1 s 级（我们已实测 2 s 窗质量只掉 1 dB 量级，见 acceptance §5d/E12）。
2. **结果只放内存**：按 deck 缓存"当前窗口 ±1"，滑动丢弃；磁盘缓存只做冷启动兜底。
   我们现在的 5.29 MB/窗落盘 + LRU 在实时场景是负担。
3. **四路增益开关而不是复杂交叉**：DJUCED 的四垫就是 kill/restore + 5 ms 斜坡。
   我们的进阶过渡可以保留自己的编排，但**单轨切换的默认实现应当是 5–20 ms 斜坡**（已实现）。
4. **"mix − stem" 播放策略**：切掉某一路时，剩下三路用 `mix − 该路` 还原，避免四路分离误差叠加
   （这正是它听起来"不像降噪"的原因，见 acceptance §25 的听感分析）。
5. **单声道直接挡掉 + 边界重采样**：省掉一整类边界 bug（我们已有 `stems=4` 的 409/400 语义，
   但还没有"单声道拒绝"这条显式契约）。

## 7. 不建议照抄

- **图内 DFT**：与 ORT 的 DFT 算子绑定，换框架就废；我们 waveform 域已经跑通。
- **双后端（fdeep/onnx）**：维护两套推理路径的收益只在"没有 ORT 的环境"，我们是自带发布，不需要。
- **权重塞进主程序**：exe 已经 441 MB，其中 `.data` ≈ 411 MB；我们分开 onnx 反而好做热更新与校验
  （`modelSha256` 已经进 meta）。

## 8. 复现方式（本文所有数字）

```powershell
# 模型字符串与图结构
python - <<'PY'   # 见 .scratch 下同名脚本思路：mmap 扫 'pytorch' / 'conv_block' / 'BatchNormalization'
PY
# 运行时占用
Get-Process DJUCED | Select-Object CPU,Threads,WorkingSet64
# 分轨质量（我们自己的基准）
python .scratch/musdb/musdb_sdr.py .scratch/musdb/bks .scratch/musdb/bks/out d30_0
```
