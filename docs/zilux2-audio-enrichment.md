# 异步分析增强（分轨活动度 + SSM 结构）

状态：已落地（宿主 `Analysis/Enrichment/*`、前端 `online/analysisFeatures.ts`）。
基线：`beat-analysis` 契约（`docs/zilux2-beat-analysis-contract.md`）不动；增强是**追加**。

## 为什么是异步

基础分析（拍/拍号/调性/段落/activity 代理）耗时 ~0.4 s，`/api/analysis` 同步返回，
前端与 73 首缓存都依赖它。四个开源模型里只有 htdemucs 已经在包里（124 MB），
一首 4 分钟歌要 10 个 30 s 窗口、CPU 约 70 s；塞进同步接口会撞上
`TrackAnalysisService.AnalyzeTimeout=60 s` 与 `app.ts` 的 25 s 超时。

所以：

- `/api/analysis` 照旧同步；只有带 `enrich=1` 时才把任务入队。
- 结果写独立缓存、独立版本，**不改 `BeatAnalyzer.AnalyzerVersion`**（否则全库 JSON 失效）。
- 前端拿到基础结果先渲染，再后台轮询 `/api/analysis/features`，合并进同一个
  `BeatAnalysis` 对象；消费方（`v2Quality` / `vocalAnchor` / `phraseMix` /
  `introBridge` / `automixPlan` / `genreProfile`）读到的字段名不变。

## 两个 stage

| stage | 实现 | 版本 | 输入 | 输出 |
| --- | --- | --- | --- | --- |
| `structure` | `Analysis/Enrichment/StructureSsm.cs`，纯 DSP（小节 chroma → 余弦 SSM → checkerboard 核 → 峰值） | `structure/ssm-v1` | 基础分析里的 `barChromaMs/barChroma`、`momentaryLufs`、`activity` | `source/method/boundariesMs/sections[{startMs,endMs,label,confidence}]/barCount` |
| `stems` | `Analysis/Enrichment/StemActivityAnalyzer.cs`，复用 `StemSeparationService.ReadAudioWindow` + `HtdemucsSession` | `stems/v1` | 原始音频文件 | `hopMs=250/vocal[]/drum[]/bass[]/other[]/source=htdemucs/modelSha256/durationMs/normalized` |

- 结构不足 8 小节或没有峰值时回退基础 `sections`，`source="dsp"`（前端仍可显示，但不标 SSM）。
- 分轨曲线逐轨 95 分位归一，长度 `ceil(durationMs/250)`；`other` 含残差，不做 `mix−vocals`。
- 线程：结构在分析线程池；分轨 `clamp(ProcessorCount/4, 2, 4)`，单 worker 串行，避免与播放抢核。
- `BeatFusion` / `Embedding` 是预留槽位，当前恒 `null`。

## 契约

`GET /api/analysis/features?source=&rel=&id=&stages=stems,structure&token=`

```json
{
  "v": 1,
  "ok": true,
  "trackKey": "local:...",
  "features": {
    "v": 1,
    "version": "enrich-v1",
    "stems": { "hopMs": 250, "vocal": [], "drum": [], "bass": [], "other": [],
               "source": "htdemucs", "modelSha256": "...", "durationMs": 118073, "normalized": true },
    "structure": { "source": "ssm", "method": "ssm-checkerboard", "boundariesMs": [],
                   "sections": [{ "startMs": 0, "endMs": 30487.8, "label": "verse", "confidence": 0.4 }],
                   "barCount": 66 },
    "beatFusion": null,
    "embedding": null
  },
  "pending": ["stems"],
  "status": { "stems": "running", "structure": "ready" }
}
```

- `features` 可为 `null`（还没算）；`pending` 是未完成的 stage；`status` 是
  `ready | running | pending | failed | unavailable`。
- `/api/analysis?enrich=1` 会在返回体里带同一个 `features`（已就绪的部分）。
- 参数校验沿用基础接口：`source=local` 必须给 `rel`；在线源必须给合法 `id` 与已注册 provider。

## 缓存

`%LOCALAPPDATA%\Zilux2\analysis\features\<sha1(inputKey) 前 16 位 hex>\<stage>.json`

```json
{ "stage": "stems", "stageVersion": "stems/v1", "inputKey": "local:<rel>:<len>:<mtime>",
  "modelSha256": "...", "createdAtMs": 0, "payload": { } }
```

- `inputKey` 与基础分析一致（本地 `local:rel:len:mtime`，在线 `source:id`），所以换文件/换曲目自动失效。
- 升级只改对应 `stageVersion`，不用清全库；模型换 sha256 也视为新 stage。
- 写入走临时文件 + 原子替换、无 BOM；分轨临时音频目录在 `features/tmp/<hash>`，任务结束即删。

## 前端合并规则

`mergeEnhancedFeatures(analysis, features)` 只在形状合法时覆盖：

- `stems`：三条曲线等长、`hopMs` 在 80–1000 → 替换 `analysis.activity`，写
  `activitySource="stems"`、`activityModel`。
- `structure`：≥2 段且每段 `endMs>startMs` → 替换 `analysis.sections`，写
  `sectionsSource`（`dsp`/`ssm`）、`boundariesMs`；仅在原 `cueInMs/cueOutMs` 为 0 时按
  首个 `drop|chorus`、最后一个 `outro` 补。
- 合并后 `featuresVersion` 更新，`onAnalysisEnhanced` 通知 UI 重绘来源标记。
- `ensureEnhancedAnalysis(track, budgetMs)` 供过渡规划前短等（默认 1200 ms，
  调用方给 2500 ms）；超时就用现有曲线，绝不阻塞切歌。

## 已知边界

- 分轨只在 CPU 跑；一首 2 分钟曲约 30 s 出结果，期间播放不受影响（线程数受限）。
- 结构依赖基础分析的 `barChroma`；若某曲没有小节 chroma，结构 stage 直接回退 DSP。
- 分轨曲线是「文件时间轴」，不加 `cueInMs`；消费方按各自窗口换算。
- 4 个 coverLyrics 测试失败是仓库既有（`git status` 未改相关文件），与增强无关。

## 后续 stage（工具已就位，权重未随包）

- `tools/model-export/`：通用 ONNX 导出（mel 前端一起导出）、`parity.py` 复跑对齐、
  `adapters/all_in_one.py` 与 `adapters/beat_this.py` 两个适配器、`models/manifest.example.json`。
- 门：20 段 crop 的 `max|onnx−torch| < 1e-4`、cosine ≥ 0.9999；不达标脚本删除导出文件。
- 接入时只换 `structure` stage 的实现与 `stageVersion`（`structure/allinone-v1+<sha8>`），
  SSM 保留为回退；模型缺失/加载失败继续走 SSM。
- `BeatFusion` 与 `Embedding` 仍是预留槽位；在权重与 parity 通过前恒为 `null`。

## 验证

```powershell
# 1) 宿主：固定 token 便于脚本验证（32 位 hex）
$env:ZILUX2_ONLINE_TOKEN = '0123456789abcdef0123456789abcdef'
Start-Process "$env:LOCALAPPDATA\Programs\Zilux2\Zilux2.exe"
# 端口看日志：[online] listening on 127.0.0.1:<port>

# 2) 基础分析 + 入队
node .scratch/feature-backup/verify-features.mjs
# 期望：analysis 200；3 s 内 structure ready（source=ssm）；stems 30 s 左右 ready；
#       最终 {ok:true,pending:[],status:{stems:'ready',structure:'ready'}}
```

实测（`DJ阿罗 - 晴天(DJ版).mp3`，118073 ms）：structure 3 s ready、bars 66、4 段；
stems 474 帧 × 250 ms，缓存 13 KB；第二次请求命中缓存 <50 ms。
