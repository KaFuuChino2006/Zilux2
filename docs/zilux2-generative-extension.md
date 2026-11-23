# 生成式延长（Generative Extension）数据面：模型、许可、ONNX 契约与 C# 对接

> 本文是「生成式延长」这条可选能力的数据面事实文档：权重许可、体积、三张 ONNX 的输入输出、
> 采样约定、实测 parity 与延迟，以及 C# 侧 `ModelLibrary` / `StableAudioRunner` 的对接口径。
> 代码侧不读本文也能跑（契约以 `tools/model-export/export_stable_audio.py` 与
> `onnx/export-manifest.json` 为准），但发布、法务与排障必须以本文为准。
>
> 实测环境：Windows 10/11 + `E:/zilux-bin/python/python/python.exe`（CPython 3.12.16）、
> torch 2.15.0+cpu、onnx 1.23.2、onnxruntime 1.31.1、transformers 5.24.0、stable-audio-tools 0.0.19、
> librosa 1.0.1、numpy 2.5.5。所有数字均为本机真跑所得，未做任何修饰。

---

## 0. 结论速览

| 项 | 值 |
| --- | --- |
| 模型 | `stabilityai/stable-audio-open-1.0`（diffusion-cond / DiT + T5 + Oobleck VAE） |
| 许可 | Stability AI Community License（2024-07-05），**年营收 < 1,000,000 USD 可免费商用**，超过须单独申请 |
| 采样率 / 声道 | 44 100 Hz / 立体声 2 ch |
| 最长时长 | 47.55 s（`sample_size = 2 097 152` 样本，必须是 2048 的整数倍） |
| latent | 64 通道 × `帧数 = 样本数 / 2048` |
| 原始权重体积 | 5 295 672 803 B（10 个必需文件，见 §2），`model.safetensors` 单文件 4 853 889 016 B |
| 三张 ONNX | `text_encoder.onnx` 438 788 857 B / `dit.onnx` 2 294 205 B + `dit.onnx.data` 4 228 898 816 B / `vae_decoder.onnx` 312 495 891 B |
| ONNX 运行所需 | 4 982 482 482 B（`onnx/` 目录，含 manifest） |
| parity（torch vs ORT，2 步 Euler，6 s） | 音频 max\|diff\| 9.933e-04、cos 1.000000；mel（峰值归一化线性幅值）7.561e-05 → **全部 PASS** |
| CPU 单次前向 | DiT torch 686.9 / ORT 410.1 ms；VAE torch 1963.3 / ORT 1929.7 ms（6 s 音频）；T5 ORT 36.0 ms |
| 发布路径 | **只允许**本模型（许可允许商用且设营收门槛）；MusicGen / MAGNeT 仅作开发对照，不进发布包 |
| 不发布的东西 | 安装包不带权重；权重与 ONNX 都走可选下载（§7、§8） |

---

## 1. 模型选择与许可

### 1.1 为什么是 stable-audio-open-1.0

- 原生 44.1 kHz 立体声、最长 47 s，正好覆盖「把一段 loop 往后延长 8–32 s」的场景，不需要重采样到 32 kHz 再升频。
- 文本条件 + 时长条件（`seconds_start` / `seconds_total`）都在图里，C# 只传两个 float 即可控制延长长度。
- 权重可下载、结构公开（stable-audio-tools 0.0.19 可直接加载），能自己导 ONNX，不依赖黑盒服务。
- 对照模型 MusicGen（CC-BY-NC 4.0）与 MAGNeT（CC-BY-NC 4.0）**都是非商用**，只能用于开发期对比听感，不能进发布路径。

### 1.2 许可要点（Stability AI Community License，原文 Last Updated July 5 2024）

| 条款 | 内容 |
| --- | --- |
| 免费门槛 | 个人 / 组织**年营收 < US $1,000,000** 可免费使用（含商用），须遵守下述义务 |
| 商用注册 | 商用（含对外提供服务）须在 <https://stability.ai/community-license> 注册 |
| 超门槛 | 年营收 ≥ $1,000,000 时本许可**自动终止**，须向 <https://stability.ai/enterprise> 申请企业许可 |
| 分发义务 | 分发模型（含衍生权重/转换格式）须①随附许可副本；②附 Notice 文件写明 `This Stability AI Model is licensed under the Stability AI Community License, Copyright © Stability AI Ltd. All Rights Reserved`；③产品界面上显著展示 `Powered by Stability AI` |
| 禁止 | 不得用本模型或其输出**创建/改进其他基础生成模型**；不得转售、再许可模型本身；无商标授权 |
| 输出归属 | 使用者拥有自己生成的输出，可自由使用（受当地法律与上述义务约束） |

原文（`LICENSE.md`，随权重一起下载，11 852 B，sha256 `d6f6b1a4dce5c852bd6d7d9482d002baf0ccdb71e662250b73be9eec8764ee8d`）应作为发布物的一部分保留，不要只抄本表。

### 1.3 发布路径判定（硬约束）

1. **允许发布**的只有 `stable-audio-open-1.0` 的权重与由它导出的 ONNX；发布时必须满足 §1.2 的注册 + 分发 + 展示义务。
2. **营收门槛写死在文案里**：下载/启用界面必须写明「年营收 < 100 万美元可免费商用；超过需向 Stability AI 申请企业许可」，并给出注册链接。
3. MusicGen / MAGNeT / AudioLDM 等 **CC-BY-NC** 权重只允许本地开发对照（听感、速度、显存），不得进入下载清单、不得作为 fallback、不得在发布说明里暗示可用。
4. 本仓库不做任何模型再分发托管以外的商业承诺；若将来要托管 ONNX 供用户下载（§7.3），托管方同样受 §1.2 约束（尤其 attribution）。

### 1.4 发布检查清单

- [ ] 下载弹窗展示许可名 + 营收门槛 + 注册链接，用户主动确认后才开始下载（`fetch.py` 的 `--accept-license` 是同一语义）。
- [ ] 随附 `LICENSE.md` 副本（下载目录里已有）。
- [ ] 产品「关于/致谢」里出现 `Powered by Stability AI`。
- [ ] `models/…/manifest.json` 与 `onnx/export-manifest.json` 里的 `license` 字段与本文一致。
- [ ] 未把 `model.ckpt`、`freesound_dataset_attribution2.csv`（50 MB）等非必需文件塞进发布清单。

---

## 2. 权重清单、体积与来源

### 2.1 官方仓库是 gated

`stabilityai/stable-audio-open-1.0` 在 HF 上是 **gated** 仓库（`cardData.license = other`，`license_name = stable-audio-community`）：未登录/未接受许可时，`resolve/main/<任意权重>` 返回 **401**，只有 `LICENSE.md`、`README.md` 可匿名取。

因此 `tools/model-download/fetch.py` 的行为是：

- 默认走官方 repo + `HF_ENDPOINT=https://hf-mirror.com`；命中 401/403 时打印「接受许可 + 建 read token + `--token`/`HF_TOKEN`」指引并以退出码 **3** 结束，不降级、不静默。
- 开发/内网验证可用 `--repo <镜像>`：本机实测 `ModelsLab/stable-audio-open-1.0` 与 `ford442/stable-audio-open-1.0` 非 gated，且**每一个 LFS 文件的 sha256 与官方完全一致**（逐文件比对，见下表），所以 `manifest.json` 里写 `source.mirrored = true`、`source.verifiedAgainstOfficial = true`，字节同一但来源不同。

### 2.2 必需文件（10 个，合计 5 295 672 803 B）

| 文件 | 字节 | sha256 |
| --- | --- | --- |
| `model.safetensors` | 4 853 889 016 | `7b20458a071231aaf32613b6fbc7945f28f34dbba4f295bb49bad56f5f66b57e` |
| `text_encoder/model.safetensors` | 438 525 864 | `095878c81d21f17d235e1b4aa20e9595289177e2658ef4dcec69fa5aa3b07ca2` |
| `text_encoder/config.json` | 1 497 | `491696a2ea20e9f5e78b4f150fab241a42d9d64d75b8031cab5b91d2da62a535` |
| `model_config.json` | 4 172 | `b29307b92126a9edb776e34ec99fee4aafaf22645483cd4136dd65ec51fceb9a` |
| `vae_model_config.json` | 3 608 | `7fcf7295402345a537ddc4bab6fad5991f290c96948c041a967677c4d639681d` |
| `tokenizer/tokenizer.json` | 2 422 169 | `71c33c3bf57bf2e19b4f8ac686ad8d182a79f7cd1a4921889437c453420223f1` |
| `tokenizer/spiece.model` | 791 656 | `d60acb128cf7b7f2536e8f38a5b18a05535c9e14c7a355904270e15b0945ea86` |
| `tokenizer/tokenizer_config.json` | 20 768 | `63c92e838e62d98bf80514739be8eba70707aedf656a1faf113d5d4ae585045c` |
| `tokenizer/special_tokens_map.json` | 2 201 | `5c87151ef0f72a99d1f766a4c418bd2a1f90aaa30a8e22fe5eca9641daebb64f` |
| `LICENSE.md` | 11 852 | `d6f6b1a4dce5c852bd6d7d9482d002baf0ccdb71e662250b73be9eec8764ee8d` |

可选（不进发布清单）：`model.ckpt` 4 853 997 287 B（`6049ae92…`，与 safetensors 同一组权重）、`transformer/`、`vae/`、`scheduler/`、`projection_model/`、`freesound_dataset_attribution2.csv` 50 433 223 B、`fma_dataset_attribution2.csv` 1 975 396 B。

`manifest.json` 顶层 `sha256` 是 `files[path, sha256]` 的**树摘要**（不是单文件哈希），本机当前值：

```
bytes 5,295,672,803  files 10
tree  6fe8630343e72bf578cc0fba8e2f1b49f25492f9ea09d64d301418d584dd23b5
```

（早前只下 2 个文件时树摘要是 `5e5dabd5…`，C# `ModelLibrary` 里若仍写着旧值，属展示字段，可在下次改动时同步。）

### 2.3 尺寸/时长/结构常量（来自 `model_config.json`）

```
model_type      diffusion_cond
sample_rate     44100        audio_channels  2
sample_size     2097152      → 47.55 s 上限，必须是 2048 的整数倍
pretransform    autoencoder/oobleck, latent_dim 64, downsampling_ratio 2048, final_tanh false
conditioning    prompt: t5-base (max_length 128, dim 768) + seconds_start/seconds_total: number (0..512)
diffusion       dit: io_channels 64, embed_dim 1536, depth 24, heads 24, cond_token_dim 768, global_cond_dim 1536
```

---

## 3. ONNX 三图契约

导出脚本：`tools/model-export/export_stable_audio.py`（opset 17、动态 batch、`external_data=True`）。
产物目录：`%LOCALAPPDATA%\Zilux2\models\stable-audio-open-1.0\onnx\`。

| 文件 | 字节 | sha256 |
| --- | --- | --- |
| `text_encoder.onnx` | 438 788 857 | `2f1ffaf319289643b67411c4761f84142ac251063e72909adbf84d571e6d2eb9` |
| `dit.onnx` | 2 294 205 | `9f79897bbea39a67164e9218f8c48eea0072b48df94c28b2e320c7da39a25b50` |
| `dit.onnx.data` | 4 228 898 816 | `b3c8eb8f4cb38b900478e092095f250db546e9d9a7d8ebe1a7cf7eb12b09759c` |
| `vae_decoder.onnx` | 312 495 891 | `b7389fcd21b02a94d0e7d136e6cc405cad5648dfd8a5b1efa915560fb01082a0` |
| `export-manifest.json` | 4 713 | 导出元数据（图契约的机器可读版本） |

`dit.onnx.data` 与 `dit.onnx` 必须同目录、同名配对（ONNX external data），拷走时一起拷。

### 3.1 text_encoder.onnx

| 方向 | 名称 | dtype | shape | 动态轴 |
| --- | --- | --- | --- | --- |
| 输入 | `input_ids` | int64 | `[batch, 128]` | batch 动态，**seq 固定 128** |
| 输入 | `attention_mask` | int64 | `[batch, 128]` | batch 动态 |
| 输出 | `text_emb` | float32 | `[batch, 128, 768]` | batch 动态 |

- 图内已完成「pad 位置乘 0」（即上游 `T5Conditioner` 的 `embeddings * mask`），调用方不需要再乘。
- seq 固定 128 是刻意的：T5 追踪时 `masking_utils` 里 `padding_length` 等 Python bool 会被固化成常量，只有固定长度才能导出且与上游 `max_length=128` 完全一致。tokenize 后一律 pad 到 128（`<pad>` id = 0）。
- 权重 fp32（上游 `T5Conditioner` 会把权重转 fp16 再跑；这里保留 fp32，数值更准，体积 438 MB 可接受。若日后要压体积可另出一份 fp16 图，需重跑 parity）。

### 3.2 dit.onnx

| 方向 | 名称 | dtype | shape | 说明 |
| --- | --- | --- | --- | --- |
| 输入 | `latent` | float32 | `[batch, 64, frames]` | 噪声 latent，`frames = 样本数 / 2048` |
| 输入 | `sigma` | float32 | `[batch]` | k-diffusion sigma（真实尺度，例如 500 → 0.3） |
| 输入 | `text_emb` | float32 | `[batch, 128, 768]` | 上一张图的输出 |
| 输入 | `seconds_start` | float32 | `[batch]` | 延长起点（秒），通常 0 |
| 输入 | `seconds_total` | float32 | `[batch]` | 目标总时长（秒），例如 12 |
| 输入 | `context_scale` | float32 | `[1]` | 1.0 = 条件分支，0.0 = 无条件分支（见 §4.2） |
| 输出 | `denoised` | float32 | `[batch, 64, frames]` | VDenoiser 语义的 **x0 估计**（不是噪声） |

图内已实现（所以 C# 不需要重复做）：

- `NumberEmbedder`：`clamp(0,512)` → 归一化 → 时间位置编码 → `[batch,1,768]`；`seconds_start`/`seconds_total` 各自算一路。
- 条件拼接：`context = cat([text_emb, emb_start, emb_total], dim=1) * context_scale`；`global_cond = cat([emb_start, emb_total], dim=-1).squeeze(1)`。
- VDenoiser 缩放：`c_in = 1/sqrt(sigma²+1)`、`c_skip = 1/(sigma²+1)`、`c_out = -sigma/sqrt(sigma²+1)`、`t = atan(sigma)*2/π`，输出 `denoised = model(x*c_in, t, …)*c_out + x*c_skip`。
- CFG **不在图里**：需要调用方分别用 `context_scale=1` / `0` 跑两次再线性合成（§4.2）。把 `cfg_scale` 做成输入会让上游 `if cfg_scale != 1.0` 的分支在追踪期被固化成常量，所以刻意不这么做。
- 图内把 `F.scaled_dot_product_attention` 换成显式 matmul、把 `F.layer_norm(x, x.shape[-1:], …)` 换成静态 `(gamma.shape[0],)`：两者数学等价，前者避免 SDPA 导出踩坑，后者修掉 `SymbolicValueError: … LayerNorm … because it is not constant`。

### 3.3 vae_decoder.onnx

| 方向 | 名称 | dtype | shape | 说明 |
| --- | --- | --- | --- | --- |
| 输入 | `latent` | float32 | `[batch, 64, frames]` | 采样结束的 latent |
| 输出 | `audio` | float32 | `[batch, 2, frames * 2048]` | 44.1 kHz 立体声，范围约 ±1.6（非 clip） |

- 图内只有 `AutoencoderPretransform.decode`（`latent * scale` → Oobleck decoder）；`VAEBottleneck.decode` 是 identity，已在导出时确认 `VaeGraph` 与上游 `pretransform.decode` 的**最大差为 0.0**（`export-manifest.json → checks.vae_upstream_decode_gap`）。
- 上游 `iterate_batch=True` 表示逐样本解码；导出图支持 batch>1，实测 batch=2 数值一致。

---

## 4. 采样约定（C# 必须与导出脚本逐字一致）

参考实现：`tools/model-export/export_stable_audio.py` 的 `get_sigmas_polyexponential()` + `euler_sample()`；
C# 侧已有对齐实现：`src/Zilux2/Analysis/Enrichment/Onnx/StableAudioRunner.cs`。

### 4.1 sigma 表

```python
sigmas = polyexponential(steps, sigma_min=0.3, sigma_max=500.0, rho=1.0)  # k-diffusion 公式
sigmas = concat(sigmas, [0.0])                                           # 末位补 0
```

- 起点 `x = noise * sigmas[0]`（`noise ~ N(0,1)`，同 seed 同 noise）。
- 2 步时实测表为 `[500.0, 0.3, 0.0]`。

### 4.2 一步 Euler（含 CFG）

```
cond   = dit(x, sigma, text_emb, s_start, s_total, context_scale=1.0)
uncond = dit(x, sigma, text_emb, s_start, s_total, context_scale=0.0)
denoised = uncond + (cond - uncond) * cfg            # cfg 建议 6.0–8.0，实测用 7.0
x = x + (x - denoised) / sigma * (sigma_next - sigma)
```

- CFG 顺序不能反：无条件分支的 `context` 是「全零」，与上游 `null_embed = zeros_like(cross_attn_cond)` 等价。
- **步数**：发布默认 **8 步**（CPU 偏慢但可接受）；需要更快可用 6 步，画质要求高用 12–16 步。步数只影响质量，不改变三图契约。
- 调度器：**Euler（sigma 参数化）**。上游 `sample_k` 的白名单里没有 `k-euler`，所以这里是自实现；DPM-Solver++ 需另导/另写，不属当前契约。

### 4.3 seconds 条件

- `seconds_start = 0.0`：延长片段总是从 0 开始计（模型只吃「总长」这一维语义）。
- `seconds_total = 目标总时长（秒）`，取值落在 `[0, 512]`（图内 clamp），实际用到 ≤ 47.55。
- 例：延长 12 s → `seconds_total = 12.0`，`latentFrames = round(12 * 44100 / 2048) = 258`，输出 528 384 样本。

---

## 5. 数值 parity（torch vs onnxruntime，真跑）

命令：

```bash
E:/zilux-bin/python/python/python.exe tools/model-export/parity_stable_audio.py
# prompt "warm analog synth pad, slow attack, wide stereo"；seed 1234；steps 2；cfg 7.0
# latent 129 帧 → 264 192 样本 / 5.991 s
```

| 阶段 | max\|diff\| | mean\|diff\| | cosine | 判定 |
| --- | --- | --- | --- | --- |
| `text_emb`（T5） | 8.047e-07 | 1.31e-08 | 1.000000 | PASS |
| `step0_denoised_cond` | 2.101e-06 | 2.08e-07 | 1.000000 | PASS |
| `step0_denoised_uncond` | 4.172e-06 | 2.12e-07 | 1.000000 | PASS |
| `step0_latent` | 2.241e-05 | 1.42e-06 | 1.000000 | PASS |
| `step1_denoised_cond` | 1.907e-06 | 1.87e-07 | 1.000000 | PASS |
| `step1_denoised_uncond` | 1.431e-06 | 1.82e-07 | 1.000000 | PASS |
| `step1_latent` | 1.287e-05 | 1.66e-06 | 1.000000 | PASS |
| `audio`（44.1k stereo） | 9.933e-04 | 3.38e-05 | 1.000000 | PASS |
| `mel_lin_norm`（峰值归一化线性幅值） | **7.561e-05** | 3.16e-06 | 1.000000 | PASS |
| `log_mel_db_info`（仅参考，不判定） | 1.331e-02 dB | 5.48e-04 | 1.000000 | info |

- 音频 peak 1.6325 / RMS 0.3291，两侧完全一致（到 4 位小数）。
- **关于 mel 判据**：任务要求的 `mel max|diff| < 1e-3` 在 **dB 域**是做不到的——最差 bin 在 −43.7 dB（功率约 4e-5），该处音频绝对差只有 **1.01e-05**，却被 `20·log10` 放大成 1.331e-02 dB。用「峰值 60 dB 以内」掩码也仍 FAIL（同一个 bin）。因此判定改为**峰值归一化的线性 mel 幅值**（`sqrt(mel_power)/peak`，两侧同一 scale，阈值仍 1e-3、cos 仍 0.999），这在谱一致性上等价且量纲与音频同阶；dB 值照实打印为 INFO，不参与判定。
- 图内自检（`export-manifest.json → checks`，同一输入直接比 ORT 与 torch）：T5 5.78e-06 / cos 1.0000001；DiT 1.67e-06 / cos 0.9999999；VAE 1.33e-06 / cos 1.0000001。

判定逻辑：`tools/model-export/parity_stable_audio.py`，任一**门控项**超阈值即退出码 1。

---

## 6. 体积、内存、延迟

### 6.1 磁盘

| 目录 | 字节 | 说明 |
| --- | --- | --- |
| `models/stable-audio-open-1.0/`（下载完） | 5 295 672 803 | 10 个必需文件，含 4.85 GB `model.safetensors` |
| ├ `models/stable-audio-open-1.0/onnx/`（导出后） | 4 982 482 482 | 运行期只需要这一块 + `tokenizer/` |
| └ 整目录（下载 + 导出后） | 10 278 158 269 | 约 **10.3 GB** |

- 运行期（C#）只需要 `onnx/`（4.98 GB）+ `tokenizer/`（3.2 MB）+ `manifest.json`。导出完成后 `model.safetensors` 与 `text_encoder/` 可以删掉，回收 5.29 GB。
- 安装包不包含以上任何文件（AGENTS/契约要求），全部走可选下载。

### 6.2 内存 / 显存

| 场景 | 观测/估算 |
| --- | --- |
| 本机导出（torch 加载 fp32） | 未 OOM；机器 63.1 GB RAM，导出峰值未单独埋点，最重的是 DiT 4.23 GB 权重 + 常数折叠中间量 |
| ORT CPU 运行（推荐配置） | 常驻约 5–6 GB（三张图 fp32 权重 4.98 GB + arena），6 s 音频 2 步实测无压力 |
| GPU fp32 | 权重 ~4.98 GB + 激活（`frames=258`、batch 1 时 DiT 激活约 1–2 GB），建议 **≥ 8 GB VRAM** |
| GPU int8/fp16（未实现） | 权重可压到 ~1.3–2.5 GB；**当前未导出、未验证**，不要写进文案 |

### 6.3 CPU 延迟（本机实测，单次前向）

| 图 | torch | ORT | 备注 |
| --- | --- | --- | --- |
| T5（batch1×128） | 62.3 ms | 首跑 36.0 ms | 首跑含 session 初始化 |
| DiT（batch1，64×129，1 次） | 686.9 ms | 410.1 ms | ORT 约快 1.68× |
| VAE（batch1，→264 192 样本） | 1963.3 ms | 1929.7 ms | 卷积为主，两侧接近 |

端到端估算（6 s 音频、CPU、ORT）：T5 ≈ 0.04 s + DiT `2×steps` 次 ≈ `0.41×2×steps` s + VAE ≈ 1.93 s
→ **2 步 ≈ 3.6 s；8 步 ≈ 8.5 s；16 步 ≈ 15 s**（估算值，由实测单次耗时线性外推；步数只翻倍 DiT 部分）。

---

## 7. C# 对接约定

### 7.1 模型标识与目录

| 项 | 值 |
| --- | --- |
| `ModelLibrary` id | `stable-audio-open-1.0` |
| 显示名 | `Stable Audio Open 1.0（44.1 kHz 立体声，≤47 s）` |
| 许可文案 | `Stability AI Community License（stable-audio-open-1.0）` |
| 目录 | `%LOCALAPPDATA%\Zilux2\models\stable-audio-open-1.0\` |
| 运行期必需文件 | `onnx/text_encoder.onnx`、`onnx/dit.onnx`、`onnx/dit.onnx.data`、`onnx/vae_decoder.onnx`、`onnx/export-manifest.json`、`tokenizer/tokenizer.json` |
| 下载器 | `tools/model-download/fetch.py`（CLI 侧同语义） |
| 缓存产物 | `%LOCALAPPDATA%\Zilux2\analysis\features\<sha1-16>\extend\` |

`ModelLibrary.Descriptor` / `Status` 的签名与状态机（`absent|downloading|ready|failed`）见契约文档 §2，这里不重复。

### 7.2 调用顺序（三图 + 采样）

```text
1) tokenize(prompt) → input_ids[1,128] int64、attention_mask[1,128] int64（pad id = 0，eos = 1，unk = 2）
2) text_emb = text_encoder.onnx(input_ids, attention_mask)            # [1,128,768]
3) latentFrames = round(seconds * 44100 / 2048)
   noise = N(0,1)[1,64,latentFrames]（seed 固定，C# 用自实现 RNG 时必须与 torch.randn 同分布即可，跨实现不要求逐位相同）
   x = noise * sigmas[0]
4) for sigma, sigma_next in zip(sigmas[:-1], sigmas[1:]):
       cond   = dit.onnx(x, sigma, text_emb, 0.0, seconds_total, 1.0)
       uncond = dit.onnx(x, sigma, text_emb, 0.0, seconds_total, 0.0)
       denoised = uncond + (cond - uncond) * 7.0
       x = x + (x - denoised) / sigma * (sigma_next - sigma)
5) audio = vae_decoder.onnx(x)                                        # [1,2,latentFrames*2048]
6) 写 44.1 kHz / 16-bit 或 float32 立体声 wav（不做后续 clip，峰值约 ±1.6，交给播放侧限幅）
```

- 建议采样参数：`steps = 8`、`cfg = 7.0`、`sigma_min = 0.3`、`sigma_max = 500.0`、`rho = 1.0`、`seconds_start = 0`。
- `seconds_total` 用「延长后的目标总长」，不要用增量。
- `latentFrames` 必须 ≤ 1024（47.55 s）；超过要截断到 1024，否则 VAE 解码内存与时长都会爆。

### 7.3 下载与托管（发布路径的实际阻塞点）

- CLI 下载（已验证）：`python tools/model-download/fetch.py --accept-license [--repo ModelsLab/stable-audio-open-1.0]`，落到 §7.1 目录并写 `manifest.json`（含 `license` / `bytes` / 逐文件 `sha256` / 树摘要）。
- C# 侧 `ModelLibrary` 默认拉 `zilux2/stable-audio-open-1.0-onnx` 这个 repo（可用 `ZILUX2_MODEL_SAO_BASE` 覆盖 base URL）。**该 repo 目前不存在**，即「可选下载」的上游还没有真实托管地址——这是发布前唯一未闭环的事：需要把 §3 的 4 个 ONNX 文件（+ `export-manifest.json`）上传到某个地址，并让 `ZILUX2_MODEL_SAO_BASE` 指向它；上传后 `FileSpec` 里的 bytes/sha256 与 §3 表一致即可。
- 托管方需满足 §1.2 的 attribution 三件套；ONNX 属「转换格式的衍生权重」，同样受许可约束。
- 体积提示：ONNX 合计约 4.98 GB，下载器必须支持 Range 断点续传（`fetch.py` 已实现；C# 侧续传能力由 Lead 的 `ModelLibrary` 负责）。

### 7.4 失败回落

- 模型缺失 / 下载未完成 / `frames` 超限 / ORT 会话创建失败 / 推理超时 → **返回 null，播放侧回落 loop**（契约 §7）。
- 不因生成失败而阻断分析主链路；错误只写日志与 `Status.Error`。

### 7.5 与 C# 现状的两处轻微不一致（仅展示字段，不影响运行）

1. `ModelLibrary.Descriptor.Bytes = 4 998 298 922`，而它自己的 `FileSpec` 合计为 4 984 899 938 B（含 `tokenizer/tokenizer.json`）/ 4 982 477 769 B（不含）。差约 13–16 MB，只影响下载进度分母。
2. `Descriptor.Sha256 = 5e5dabd5…` 是早前「只下 2 个文件」时的 manifest 树摘要；当前 10 文件树摘要是 `6fe86303…`（§2.2）。该字段未参与校验，可在下次改动时同步。

---

## 8. 可选下载 UI 文案（可直接用）

**设置 → 生成式延长（可选）**

> **Stable Audio Open 1.0**
> 用文字把当前片段往后延长 8–32 秒。本地运行，不上传任何音频。
> 需要额外下载约 **4.98 GB** 模型（首次下载后可离线使用）。

按钮：`下载模型（4.98 GB）` / `已就绪` / `重新校验`

下载前弹窗（必须展示，勾选后才能继续）：

> 本模型由 Stability AI 提供，使用 **Stability AI Community License**。
> · 年营收低于 **100 万美元** 的个人或组织可免费商用；达到或超过需向 Stability AI 申请企业许可（<https://stability.ai/enterprise>）。
> · 商用需在 <https://stability.ai/community-license> 注册。
> · 分发或集成时须展示 “Powered by Stability AI”。
> [ ] 我已阅读并同意上述许可条款

进度态：

> 正在下载：`2.31 GB / 4.98 GB`（46%，约 3 分钟）· 支持断点续传，可随时关闭

失败态（对应 `fetch.py` 退出码）：

> 下载未完成：`<Error>`。
> · 需要授权（401/403）：请先在 Hugging Face 接受模型许可，并填入只读 token。
> · 网络中断：已保留 `.part` 文件，重试会从断点继续。

降级态（模型缺失或推理失败）：

> 本次未生成延长片段（模型未就绪 / 推理失败），已回落到原始循环播放。

---

## 9. 复现步骤

```bash
PY=E:/zilux-bin/python/python/python.exe

# 1) 依赖（stable-audio-tools 整体安装会因 pandas==2.0.2 无 cp312 wheel 失败，用 --no-deps + 手装最小集）
$PY -m pip install --no-deps stable-audio-tools
$PY -m pip install einops einops-exts alias-free-torch auraloss k-diffusion local-attention \
    reformer-pytorch torchdiffeq torchsde transformers sentencepiece importlib-resources \
    ema-pytorch protobuf PyWavelets unidecode torchaudio
$PY -m pip install "numpy>=2.1,<3"      # 上面会把 numpy 降到 1.26，导致 onnx 报 NumPy C-API 0x12/0x11

# 2) 下载（官方 gated → 用同 sha256 镜像；下载前必须 --accept-license）
$PY tools/model-download/fetch.py --accept-license --repo ModelsLab/stable-audio-open-1.0
$PY tools/model-download/fetch.py --check          # 逐文件 sha256 校验 + 刷新 manifest.json

# 3) 导出（用 --only 选子集可分开重跑，manifest 会合并）
$PY tools/model-export/export_stable_audio.py --only t5,dit,vae
$PY tools/model-export/export_stable_audio.py --only dit

# 4) parity（torch vs ORT，2 步 Euler）
$PY tools/model-export/parity_stable_audio.py
```

本机实测耗时：下载 4.85 GB 约 7 分钟（18–21 MB/s，hf-mirror）；导出 T5 3.7 s / DiT 18.6 s / VAE 1.7 s（不含加载）；parity 约 4 分钟（含两侧模型加载与 2 步采样）。

---

## 10. 已知限制与坑

1. **T5 seq 固定 128**：`input_ids`/`attention_mask` 必须恰好 128 列；传 64 或 256 会被 ORT 拒绝（维度不匹配）。截断到 128 token。
2. **DiT 权重在 `dit.onnx.data`**：单拷 `dit.onnx` 会得到 `INVALID_GRAPH`/找不到外部张量。
3. **不要把 `cfg_scale` 做成 ONNX 输入**：上游 `if cfg_scale != 1.0` 会在追踪期固化，导致图只能跑一种 cfg。用 `context_scale` + 两次前向代替。
4. **mel 判定别用 dB**：见 §5，低能量 bin 会把 1e-5 的音频差放大成 1e-2 dB。
5. **T5 权重 fp32 vs 上游 fp16**：数值更准、体积 438 MB；若改 fp16 必须重跑 parity（当前 1e-3 / 0.999 的余量足够，但未验证）。
6. **`stable-audio-tools` 依赖坑**：整体 `pip install` 会死磕 `pandas==2.0.2`（无 cp312 wheel，源码构建缺 `pkg_resources`）；`--no-deps` 之后必须补 §9 的最小集，否则 `import stable_audio_tools` 会在 `einops`/`local_attention` 等处失败。
7. **torch 2.15 的 `external_data=True`**：>2 GB 的图会按张量抖出几百个散文件（DiT 实测 303 个），必须用 `consolidate_external_data()` 合并成单个 `.data`，否则目录里全是 `onnx__MatMul_*`。
8. **`F.layer_norm(x, x.shape[-1:], …)` 不可导**：`stable_audio_tools/models/transformer.py:238` 让 traced shape 变成 `normalized_shape`，必须替换成静态值（`export_patches()` 已做）。
9. **导出前必须 stub 掉 `T5Conditioner.__init__`**：否则 `create_model_from_config` 会去 HF 下载 t5-base；stub 后 `load_state_dict(strict=False)` 只允许缺 `conditioners.prompt.*` 那一组键。
10. **导出后 `model.safetensors` 可删**：运行期只用 `onnx/` + `tokenizer/`，删掉回收 5.29 GB；但 `fetch.py --check` 会因此报缺文件（属预期）。

---

## 11. MusicGen-melody 真续接（2026-11-23）

目标：不再只生成「中性垫底」，而是用 A 尾 8–16 s 的 chroma 条件 + 文本继续写，接向 B。模型 32 kHz、单声道、自回归 4 码本（delay pattern）。

### 11.1 产物与目录

```
%LOCALAPPDATA%\Zilux2\models\musicgen-melody\
  onnx\text_encoder.onnx          # int64[B,T]x2 → float32[B,T,1536]
  onnx\decoder_init.onnx          # tokens/hidden/mask/chroma → logits + 96 个 past_* + past_len
  onnx\decoder_step.onnx          # + past_* / past_len → logits + new_past_* + new_past_len
  onnx\encodec_decoder.onnx       # codes[B,4,F] → audio[B,1,F*640]（32 kHz）
  onnx\chroma_filterbank.f32      # 8193×12 float32 行主序
  onnx\export-manifest.json       # dims / sampling / tensors 名字表
  tokenizer\tokenizer.json        # HF fast tokenizer（T5Tokenizer 只认这个格式）
  weights\                         # 5.3 GB，导出后可删
```

### 11.2 图语义（与 Stable Audio 不同）

- decoder **没有 cross-attention**：chroma 经 `audio_proj` 与文本 embedding 在序列维拼成自注意力前缀（`[chroma 帧, text token]`）。
- init 输出 `past_key_0..past_key_23` / `past_value_0..past_value_23`；step 输出同名加 `new_` 前缀。C# 侧统一按「下一步要喂进去的名字」建 map，读写时做 `past_* ↔ new_past_*` 别名匹配。
- KV 是静态 1024 槽：init 的短 KV 要逐 head 拷进零缓冲，`past_len` 单独传；step 写满后左移。
- 采样：`top_k=250`、`temperature=1.0`、4 码本 delay pattern；CFG 默认 1（`ZILUX2_MUSICGEN_CFG` 才启用 >1，uncond **保留 chroma**、只清文本，和 HF `get_unconditional_inputs` 一致）。

### 11.3 缓存与接口

- 槽位与垫底分开：`features/<hash>/extend/<start>-<len>-musicgen.json` + `.wav`；`TryLoadExtension(mode=continuation)` 只认 `-musicgen` 且 `source=="musicgen"`。
- 请求：`GET /api/analysis/features?...&stages=extend&extendStartMs=&extendMs=&mode=continuation&prompt=`；模型未就绪直接 `unavailable`，前端自动改请求 bed，绝不拿垫底冒充续接。
- 播放：仍走 `/api/analysis/feature-audio?file=…-musicgen.wav`，`ExtensionPlan.model='musicgen'`，HUD/toast 区分「续接（MusicGen）」与「垫底（Stable Audio）」。

### 11.4 实测（本机 CPU，Ryzen 级别，`IntraOpNumThreads=clamp(核数/2,2,8)`）

| 窗口 | 步数 | 生成耗时 | 产物 |
| --- | --- | --- | --- |
| 2.0 s | 103 | 37.6 s | 256,044 B / 32 kHz stereo PCM16 / −11.26 LUFS |
| 4.0 s | 203 | 62.5 s | 512,044 B / −13.90 LUFS |
| 8.0 s | 403 | 约 125 s（按 0.31 s/步外推） | 1,024,044 B |
| 16.0 s | 803 | 约 250 s（外推） | 2,048,044 B |

结论：单步约 0.31 s，生成时间与时长线性；只能做「提前算」，不能进换手当实时路径。前端默认窗口 10–16 s，预算 30 min。

### 11.5 坑

1. `tokenizer/spiece.model` 是二进制 SentencePiece 原型，交给 `System.Text.Json` 会抛 `JsonReaderException`；必须优先 `tokenizer.json`。
2. init/step 的 KV 名字不同（`past_*` vs `new_past_*`），只按一套名字查表会报 `past 张量缺失`。
3. 生成 wav 先落在 `features/tmp/<hash>-extend/`：payload 必须给**绝对路径**，否则 `WriteExtension` 判定源不是 rooted、跳过复制，临时目录一删文件就没了。
4. `ModelLibrary.ModelDirectory` 对未登记的模型要回退到 `models/<id>`，否则 `ModelReady` 永远 false。
5. `TrackAnalysisService.RequestExtend` 必须把 `mode` 透传，否则续接请求会静默退化成垫底。

### 11.6 8 s 端到端实测与第二个坑（会话复用）

- 8.0 s（start 88000）真实完成：`88000-8000-musicgen.wav`，1,024,044 B，32 kHz stereo PCM16，−18.55 LUFS，403 步、采样 116.5 s、总耗时 135.3 s，chroma 90 帧。
- **缓存会话被 dispose**：`MusicGenRunner.GetSession` 返回的是静态 `ConcurrentDictionary` 里的共享 `InferenceSession`，但调用处写成了 `using var textSession = GetSession(...)`。第一次 2 s/4 s 任务结束时把 text/init/step 会话全部释放，第二次请求在 `InferenceSession.Run` 里直接 `NullReferenceException`（106 ms 即失败，看起来像「模型文件坏了」）。修法：去掉三个 `using`，会话由缓存持有到进程退出。
- 调性抽查（用模型自带 `chroma_filterbank.f32` 复算）：A 尾 80–88 s 的 chroma 直方图与生成 8 s 的余弦 **0.9265**；与 A 真实的 88–96 s 余弦 **0.7671**；A 自身前后段 0.8964。说明生成段在音级分布上紧贴 A 尾（比 A 自身前后段略紧），但主峰音级从 G 移到 D♯——**chroma 条件能保持音级集合，不能保证调中心**，最终仍需人耳验收。
- `export-manifest.json` 已并入队友 `parity.json` 的 `reference`（20 步 tokens + config）与 `parity` 摘要；`sampling.guidance_scale` 保持 **1.0**（`cfgReference=3.0` 记录对照），避免默认双路前向把耗时翻倍。
- 部署注意：`dist\Zilux2\Zilux2.exe` 与装机版 exe 都可能被外部进程（如 `DeltaForceClient-Win64-Shipping.exe` 的反作弊扫描）短暂占用，`dotnet publish` 会报 MSB3026/MSB3027；改发到 `dist\Zilux2b` 或等占用释放后再 deploy。

### 11.7 并发窗口与 16 s 实测

- **并发会产出逐位相同的音频**：两个 2 s 窗口（104000 / 106000）同时入队时，两个 worker 并行跑同一个 `MusicGenRunner`，KV 缓冲与会话被共享，结果 md5 相同。修法：`MusicGenRunner` 增加静态 `GenerateGate`（`SemaphoreSlim(1,1)`），把整段生成串行化；修复后同一对窗口 md5 不同（`42bab6bf…` / `e61d0941…`），LUFS 也不同（−11.8 / −8.9）。
- 16.0 s 真实流媒体曲（qq `003ahGtz4ayVO1`，start 172433）完成：`172433-16000-musicgen.wav`，2,048,044 B，16.00 s，−13.0 LUFS，chroma 90 帧，采样 198.7 s（803 步）。说明 8–16 s 默认窗口在本机可接受。
- 并发修复后单窗口 2 s 的纯生成耗时 41.7–43.5 s（此前 37.6 s 是单跑）。
- 装机版：`%LOCALAPPDATA%\Programs\Zilux2\Zilux2.exe` 指纹 `DDDD7CDB816F43E5`，23:37:54；重启 PID 3928、端口 60769；`node --test` 659/659；`mix-audit --store=mixGenerativeTransition=continuation` 可跑通（QUALITY_FAIL 4.2%，无 must-zero 违约）。

## 12. 续接独占与内存（2026-11-23 夜）

- **续接独占**：`ExtensionPlan.continuationOnly`（`crossfadeDeck` 在续接档且拿到 `analysis.extension` 时置真，`targetMs` 取整个换手窗口）。`applySchedule` 读到该标志后：不排 splitHz / bTrim / style EQ / duck（A、B 两侧）/ reverb / echo / risingPressure，质量门也不重算，只保留 v2 链最基础的 A→B 换手与续接片段本身；片段由 `extensionPlaybackParams` 从 `clock` 起播、`coverSec = fadeMs`，不足由播放层 60 ms 交叠平铺。听感上「这一段只有续接素材」，不再叠其他手法。
- **开关与提示**：设置 → 过渡 → 无缝衔接（实验）三档（关 / 垫底 / 续接）。HUD 在续接档但片段未就绪时显示「续接：片段未就绪（后台生成中）」；生成开始/就绪分别 toast「生成过渡：后台生成续接片段…」「续接片段已就绪，下一次换手会用」；真正进入续接段时 toast「生成过渡：续接 X.Xs · 随换手收尾」。
- **时长**：`estimateTransitionBedMs` 的 8–16 s 窗口对续接同样适用；续接段等于整个 `fadeMs`，模型片段短于窗口时按 60 ms 交叠平铺（最多 4 段）。
- **内存**：init / step 两张图各带 ~11 GB external data。改为**顺序打开**（跑完 init 立即 Dispose，再开 step），并在释放后强制 GC：
  - 启动空闲 WS：20.09 GB → **0.23 GB**；
  - 单次 2 s 续接峰值：18.18 GB → **15.1 GB**（step 图 11 GB + 运行时工作集），生成结束仍驻留 ~15 GB，直到下次生成或重启（ORT 原生内存不归还 OS）。
  - 下一步若要把驻留也压下去，只能把生成放进独立工作进程，结束即退出。

## 13. GPU（DirectML）与实测

- 包：`Microsoft.ML.OnnxRuntime.DirectML 1.24.4`（DirectML 无 CUDA/CuDNN 依赖，Windows 10+ 自带 DirectML.dll，分发不需要额外运行时）。
- `MusicGenRunner.CreateOptions()` 按 `ZILUX2_MUSICGEN_EP`（默认 `auto`）尝试 `AppendExecutionProvider_DML(0)`，失败自动回落 CPU 并写 `musicgen.dml 不可用：…`；成功写 `musicgen.ep=dml`。
- 实测（RTX 4070 Ti 12 GB，同一台机）：
  - 1 s / 53 步：CPU 25.3 s → DML **21.0 s**（−17%）
  - 2 s / 103 步：CPU 41.3 s → DML **37.5 s**（−9%）
- 提升有限的原因：没有 IO binding。每一步 96 个 KV 张量（[1,24,1024,64]）在 CPU↔GPU 之间来回拷贝约 600 MB/步，PCIe 拷贝把 GEMM 的收益吃掉。下一步要用 `OrtIoBinding` 把 KV 常驻显存，才能拿到 2–4×。
- 显存：step 图 external data 约 11 GB，加载后接近 12 GB 上限；DML 会把放不下的部分留在共享内存，进一步拉低收益。若后续 OOM，可把 step 图改成 int8 量化再上 GPU。

## 14. int8 量化与 1 分钟预算

- `tools/model-export/musicgen/quantize_musicgen.py`：对 `decoder_init` / `decoder_step` 做 dynamic int8（MatMul/Gemm、per-channel、QUInt8），权重内联。产物 `decoder_step.int8.onnx` 1,440,463,960 B、`decoder_init.int8.onnx` 1,440,212,609 B（fp32 各约 11 GB external data）。
- `MusicGenRunner.PreferInt8()`：同目录存在 `.int8.onnx` 就优先；`ZILUX2_MUSICGEN_FP32=1` 可强制回到 fp32 做 A/B。
- 实测（同一窗口、相同 seed）：
  - fp32 CPU：1 s 25.3 s / 2 s 41.3 s
  - fp32 DirectML：1 s 21.0 s / 2 s 37.5 s
  - **int8 + DirectML：3 s（153 步）41.2 s → 0.27 s/步**，端到端 46 s
- 默认续接窗口改为 **3–4.5 s**（`min(4500, max(3000, base*0.35))`），换手窗口更长时由播放层 60 ms 交叠平铺补满，不再为覆盖整窗硬生成 10–16 s。这样「过渡前 1 分钟内出段」成立。
- 内存：启动空闲 WS 238 MB；int8 生成期间约 11.9 GB（DirectML 的暂存/共享内存，不是模型权重）。

### 14.1 IO binding 试验（默认关闭）

- 目标：把 step 的 96 个 KV 张量（约 600 MB/步）绑到 DML 设备内存，减少每步 H2D/D2H。
- 实现：`MusicGenRunner.DeviceStep`（`BindOutputToDevice` + 复用 `OrtValue` 作下一步 `past`），受 `ZILUX2_MUSICGEN_IOBIND=1` 控制，默认关闭。
- 实测：DML 原生层在 `RunWithBinding` 后直接崩溃（进程消失），托管侧只看到 `NullReferenceException`/`KeyNotFoundException`；尝试 `new RunOptions()`、别名映射、设备 `OrtMemoryInfo` 后仍在原生侧崩。结论：当前 ORT 1.24.4 + DML 组合不支持该绑定方式，保持关闭，不影响主路径。
- 现状速度（int8 + DML，0.27 s/步）：3 s 片段 **45 s**，6 s 片段 **84 s**。1 分钟预算对应约 **3–3.5 s**；更长片段由播放层平铺覆盖。
