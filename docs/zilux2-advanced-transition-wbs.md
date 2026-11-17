# 进阶智能过渡：最终验收标准与任务分解（WBS）

> 目标不是「比 DJUCED 快」，是「比 DJUCED 更像真人、且可解释、可回退」。
> 本文是验收依据：每一项都要有可复现的证据，不接受「听起来还行」。

---

## 0. 验收总表（Definition of Done）

| # | 验收项 | 通过标准 | 证据形式 |
|---|---|---|---|
| A1 | 标准过渡未被影响 | `naturalGains` 调用点、输出值与改动前逐样本一致 | 单测回归 + diff |
| A2 | 进阶模式可一键关闭 | `planForMode('standard')` 恒为 `null`；关闭后无任何新节点接入 | 单测 |
| B1 | 4 轨分离可用 | API 返回 drums/bass/other/vocals 四路；旧 `stem=vocals\|instrumental` 仍工作 | 契约测试 + 手工请求 |
| B2 | 4 轨质量 | 四路求和与原始混音残差 < −60 dBFS | 数值脚本 |
| C1 | 换手点对齐 | 自动化时间戳与 `downbeats` 偏差 <5 ms | 调度器 dump + 断言 |
| C2 | 低频不叠 | 过渡全过程中 30–120 Hz 能量波动 <2 dB | 环回录音 + 频带分析 |
| C3 | 人声不打架 | 两轨 vocals 同时 >−30 dBFS 的时长 <1 拍 | 同上 |
| C4 | 拍点不漂 | 合成 click 跑 2 分钟，漂移 <5 ms | 同上 |
| C5 | 回声不糊 | delay 尾巴在下一小节线 −18 dB 以下，且不盖住 B 的 downbeat | 频谱 + 波形 |
| D1 | 决策可解释 | 每次过渡给出 `reason` 文案，且与实际动作一致 | UI 快照 |
| D2 | 时间线可编辑 | 拖动换手点后重放，动作随之改变 | UI 录屏 |
| E1 | 兜底不炸 | 断网 / 删缓存 / 中途 seek / 缺 stem 四种情况均不崩溃 | 4 个用例 |
| E2 | 盲听达标 | 与 DJUCED 各 20 次对比，选优 ≥50% | 人工记录表 |
| F1 | 全量测试 | `node --test web/tests/*.test.cjs` 全绿；`dotnet build` 0 error；`tsc --noEmit` 0 error | CI 输出 |

---

## 1. 任务分解

### T1 前端纯函数层（已完成 ✅）
- `web/src/core/transitionPlan.ts`：`Compat` / `planTransition` / `gainAt` / `actionWindows` / `planForMode`
- `web/src/core/djMoves.ts`：6 手法 + 3 模板 + `humanize` + `ECHO`
- `web/tests/transitionPlan.test.cjs`：11 用例

### T2 后端 4 轨 stems API（进行中）
- `src/Zilux2/Stems/HtdemucsSession.cs`：暴露 4 轨输出（`StemCount = 4`，drums/bass/other/vocals）
- `src/Zilux2/Stems/StemSeparationService.cs`：写 `wNNN.{drums,bass,other,vocals}.wav`，并保留 `inst` 兼容
- `src/Zilux2/Online/LocalMusicServer.cs`：`stems=2|4` 参数，stem 白名单扩展
- 兼容：旧客户端请求 `stem=vocals` 必须仍返回旧行为

### T3 前端音频层（本轮）
- `web/src/core/stemSwap.ts`：把 `TransitionPlan` 展开成 `ScheduledEvent[]`（纯函数，可测）
- `web/src/audio/stemGraph.ts`：每 deck 4 条支路 + delay 总线 + ducking，全部走 `AudioParam`
- `web/src/core/beatPll.ts`：PLL 锁相（纯函数 + 可测）

### T4 接入（标准路径零改动）
- `crossfadeDeck.ts` 增加分支：`mode==='advanced'` 才构建 `StemGraph`；否则原逻辑
- 失败自动回落：`try { advanced } catch { naturalGains }`

### T5 UI
- 设置项：过渡模式（标准 / 进阶）
- 过渡时间线可视化：动作条 + 可拖动换手点 + `reason` 文案

### T6 分析与决策增强
- BPM 置信度门控（`conf<0.45` 走候选拍族二次判定）
- 候选拍族：×2 / ÷2 / ×1.5 / ÷1.5 打分而非硬折叠
- DJUCED `key` 整数编码 → `Nd/Nm` 映射（用于对标，非必需）

### T7 实测验收
- 环回录音脚本 + 频带/重叠/漂移分析
- 4 个兜底用例
- 盲听记录表 + 验收报告

---

## 2. 顺序与依赖

```
T1 ✅ ──► T3 ──► T4 ──► T5 ──► T7
T2 ──────┘（T3 的 4 轨需要 T2 的 API，但可用假数据先做）
T6 独立，可与 T3 并行
```

## 3. 不可违反的约束

1. **标准过渡冻结**：`transitionMath.naturalGains()` 与 `crossfadeDeck.ts:957/972` 不改行为。
2. **一切可选**：进阶模式默认关闭；关掉后不得残留任何音频节点或定时器。
3. **不抖结构**：换手点必须落在小节线；只有 `jitterMs` 与曲线允许抖动。
4. **不碰用户未提交改动**：后端改动只做增量，不整文件覆盖（`git status` 里已有 20+ 个用户改动）。
5. **可回滚**：新文件删掉即恢复原状；内存补丁不落盘。
