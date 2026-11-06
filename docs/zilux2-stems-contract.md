# Zilux2 离线人声分离契约（/api/stems）

> 状态：**实施中**（宿主侧 `StemSeparationService` + 前端 `stemsDeck`）
> 依据：`research/folia-stems-plan.md` §5（窗口、缓存、回退），模型来自 MIT 许可的
> `itamiArika/htdemucs-int8-memory`（`htdemucs-dft-fp16-transparent.onnx`，sha256
> `10d0d51c78f5ed1bc8e2c7b47f816169e810d78e4ebd510369c4a6a2b362221e`）。

## 1. 目标

用真实 2 轨分离（vocals / instrumental）替换现有的 EQ 近似（220 Hz / 4200 Hz 搁架），
用于无缝过渡的「人声先出、伴奏渐入」和后续的「人声消除」开关。EQ 路径保留为
等待期 / 失败回退，**任何时候都不能出现无声**。

## 2. 窗口模型

- 采样率 44.1 kHz、立体声、段长 343,980 样本（7.8 s，模型写死）；窗口 **30 s**
  （1,323,000 帧），25% 重叠 + 三角窗 OLA 在宿主内部完成。
- 窗口号 `w = floor(positionMs / 30000)`；`windowSec` 默认 30，允许 10–30（仅供调试）。
- 最后一个窗口按实际长度返回（不足 30 s），客户端按 `frames` 调度。

## 3. 接口

### 3.1 计算一个窗口

```
GET /api/stems?source=local|netease|qq&id=&rel=&window=0&windowSec=30
```

| 字段 | 说明 |
|---|---|
| `source` | `local` 时用 `rel`；在线平台用 `id` |
| `window` | 窗口号，从 0 开始 |
| `windowSec` | 可选，默认 30 |

响应 200 JSON：

```json
{ "state": "ready", "window": 0, "windowSec": 30, "frames": 1323000, "cached": true, "ms": 6 }
{ "state": "computing", "window": 0, "retryAfterMs": 800 }
{ "state": "busy", "window": 0, "retryAfterMs": 500 }
{ "state": "model-missing", "downloadUrl": "https://hf-mirror.com/.../htdemucs-dft-fp16-transparent.onnx", "sha256": "..." }
{ "state": "error", "message": "..." }
```

- 同一 `(trackKey, window)` 单飞；全局同时只跑 1 个分离任务（`SemaphoreSlim(1)`）。
- 首次调用会同步算完再返回 `ready`（约 7 s/窗口）。期间客户端用 EQ 兜底。
- `model-missing` 映射 501，`busy` 映射 503，`error` 映射 500（body 仍是上面的 JSON）。

### 3.2 取分离音轨

```
GET /api/stems/audio?source=&id=&rel=&window=0&stem=vocals|instrumental
→ 200 audio/wav（44.1 kHz / 16-bit / 立体声；两轨统一 headroom，峰值 ≤ 1.0）
→ 404 该窗口未就绪 → 409 busy → 501 model-missing
```

一次性返回整窗，**不需要 Range**；前端 `fetch` + `decodeAudioData`。

### 3.3 缓存

```
%LOCALAPPDATA%\Zilux2\stems\<sha1(trackKey)>\
    meta.json                 { trackKey, source, title, durationMs, segmentMs, modelSha256, createdUtc }
    w000.vocals.wav  w000.inst.wav
```

- 上限默认 512 MB，超出按最旧 `LastWriteTimeUtc` 淘汰（不影响正在播放的窗口）。
- `meta.json` 的 `modelSha256` 不匹配即视为未命中。

## 4. 模型

- 优先 `ZILUX2_STEMS_MODEL` 环境变量；否则
  `%LOCALAPPDATA%\Zilux2\models\htdemucs-dft-fp16-transparent.onnx`。
- 缺失时返回 `model-missing`；宿主不自动下载（安装器或手动放置）。
- ORT 会话：`EnableCpuMemArena=true`、`EnableMemoryPattern=false`、
  `IntraOpNumThreads=clamp(ProcessorCount/2,4,12)`；空闲 60 s 后释放会话。

## 5. 前端调度（`web/src/core/stemsDeck.ts`）

- 分离激活时：`mixGain → 0`（300 ms 等功率），`stemGain → 1`；两个 `AudioBufferSourceNode`
  （vocals / instrumental）挂在 `AudioContext` 时钟上，按 `ctx.currentTime` 排程。
- 提前请求 `w+1`；相邻窗口 250 ms 等功率交叠；seek/切歌 `stop()` + 丢弃旧结果。
- 人声/伴奏配比通过 `vocalsGain` / `instGain` 两条增益调整（零成本）。
- 任一窗口失败连续 2 次 → 本曲回退 EQ；模型缺失 → 永久回退并置灰开关。
