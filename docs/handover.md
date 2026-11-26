# Zilux2 交接上下文（当前状态）

最后更新：2026-11-26 19:20（1.2.12 已发布；装机版运行中，PID 34636）

> 细节主题各自有专文，这里只写「接手第一小时需要知道的事」。
> 重合歌词模式见 [`overlap-handover.md`](overlap-handover.md)；界面铁律见 [`zilux2-ui-templates.md`](zilux2-ui-templates.md)。

## 1. 现在是什么版本、发到哪了

| 项 | 值 |
| --- | --- |
| 版本 | **1.2.12**（`Directory.Build.props` 的 `<Version>` 是唯一来源） |
| 提交 | `b57bfac` `feat(release): 1.2.12 — 重合歌词子系统、切歌性能、粉色调默认` |
| tag | `v1.2.12` → 已推送 `origin/main`（`ssh://git@ssh.github.com:443/KaFuuChino2006/Zilux2.git`） |
| CI | Release `45806402517` **success** |
| 产物 | `Zilux2-Setup-1.2.12.exe`（22,575,297 B）、`Zilux2-Portable-1.2.12.zip`（22,854,601 B）、`.sha256`、`htdemucs-dft-fp16-transparent.onnx` |
| 装机 | `%LOCALAPPDATA%\Programs\Zilux2`；本次部署备份 `web.bak-20261126-185831` / `Zilux2.exe.bak-20261126-185831` |
| 构建尺寸 | web payload 11,118,302 B；exe 52,753,211 B |

发布链路：`tools/publish.ps1`（tsc + vite + 打包 exe）→ `tools/deploy-installed.ps1`（装机目录 + 自动备份）→ 重启。
正式发版走 `tools/release.ps1`（publish → make-installer，可选 `-Tag` / `-Push` 触发 CI）。

## 2. 今天（2026-11-26）改了什么

1. **重合歌词子系统**（全新）：独立 Lumiere 模式 `overlap`，八件套舞台 + 九组设置面板。落位两档（随机散点 / 阶梯格）、背景三档（跟随主题 / 纯黑 / 纯白）、书写弧随机补笔与换句补 1~2 根、四边箭头放大、闪烁退场固定 50ms/步收尾两次、入场弹簧封顶 0.62s、「准备中」角标按当前模式显示。详见 `overlap-handover.md`。
2. **切歌性能**：主题签名去重、setStyle/setPalette 合并到下一帧、tuning 缓存、`flow.ts` 舞台池化复用、段落建场改生成器分帧、歌词预匹配写回缓存 + DOM 重绘 90ms 去抖。切歌长任务 **265ms → 0~55ms**（预建）/ 100~280ms（未预建，维护者已接受）。
3. **混音**：让位曲线收尾回 0dB；交叉淡化改墙钟排程；**新装/重置后「混音过渡」默认「自动」**（`seedMixTransitionModeDefault()`，只补没有这个键的情况，手动选过就不再覆盖）。
4. **默认外观**：主题色改粉（DARK `#d98aa4` / LIGHT `#cf7590`）、启动副标题 `Welcome`、播放/暂停渐变与人声保留淡出默认开启。
5. **音频/系统**：默认输出设备改只读端点 ID 查询（去掉 2.5s 轮询枚举）；OSD 与启动遮罩修正。
6. **性能与壁纸**：壁纸宿主 `Dispose` 修正、托盘停放暂停解码、关 EcoQoS + 指定独显；封面 7 天磁盘二级缓存；标题入场动画后撤合成层；后台歌词看门狗降频；新增 `gpuGuard`。

## 3. 仓库状态（重要）

- 已按维护者要求清理：根 `.scratch`(385M)、`nv-uefi-unlocker`(4.2G)、`research/zve1`(6.2G)、`promo`、`deliver`、`djuced_re`、`_tools`、`video_understanding`、`zzz_tv_stack`、`_research`、`models`、`driver`、`df-fix`、`results`、帧目录 `300`~`5000`、`probe_*.cjs`、`*_shape.npy`、`_tmp-*.json` 等。
- **外迁目录都在 `E:\Zilux2-仓库外存档\2026-11-26\`**（同盘 rename，双向可移回）。
- ⚠️ `research/` 是**已跟踪**目录，不要整目录移走/删除（会变成大批删除）；它里面剩余 5.3G 未跟踪产物（`research/tmp`、`research/shots`）仍留在工作树里，**不要 `git add -A research`**（曾误加 10 万行）。
- `web/.scratch/` 是自测脚本目录，未跟踪、不进仓库；`web/.scratch` 里的大 json / png 已清空。
- 提交纪律：不 `git add -A`；只加与本次发布相关的文件；不提交 `research/`、`web/.scratch/`。

## 4. 验证手段

```powershell
cd E:\Zilux2开发\web
npx tsc --noEmit                 # 必须 0 错误
node --test tests/               # 当前 656/656 通过
```

界面自测（Electron 的 WebView2 调试端口）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "web\.scratch\launch-cdp.ps1"   # 9333
node web/.scratch/eval.mjs "JSON.stringify({views:document.querySelectorAll('.lyrics-view').length})"
```

- 歌词按钮监听 `pointerdown`，`el.click()` 无效，要用真实输入（CDP `Input.dispatchMouseEvent`）。
- `general.backgroundLyrics` 为 true 时，第一次点歌词按钮只弹 toast，**2.5 秒内再点一次**才打开；判断开没开只看 `.lyrics-view` 数量。
- 性能探针：`localStorage.zilux2.perf='1'` → `window.__zilux2Perf = {marks, longtasks, gaps}`，mark 形状 `{n, ms, t, d?}`。

## 5. 关键文件地图（前端）

| 位置 | 职责 |
| --- | --- |
| `web/src/ui/lyrics.ts` | 歌词页总控：模式切换、六个舞台的创建/激活、主题推送、文档加载与 DOM 重绘 |
| `web/src/ui/flow.ts` | flow/overlap 共用舞台容器：current / standby / outgoing / spare 四个槽位与交接 |
| `web/src/ui/flowScene.ts` | 单个 Pixi 场景包装：compile → swapSong，失效合并到 rAF |
| `web/src/ui/overlapScene.ts` | 重合皮肤：背景三档、设置事件转发 |
| `web/src/ui/overlapSettings.ts` / `overlapSettingsPanel.ts` | 重合全部参数与面板（九组 + 独立预览） |
| `web/src/ui/perfProbe.ts` | 性能埋点（默认关闭） |
| `web/src/ui/lumiere-folia/components/visualizer/tempera/` | 全部画面实现（运行时限 1300 行，其余按职责拆分） |
| `web/src/core/mixTransitionMode.ts` | 混音过渡档位；`seedMixTransitionModeDefault()` 负责默认「自动」 |
| `web/src/ui/theme.ts` | 主题色与预设（默认粉） |

## 6. 已知问题 / 下一步候选

1. **未预建切歌的一次顿挫**：100~280ms（新歌首段同步建场）。维护者已明确「立刻切但偶尔顿一下可以」；要彻底消除只能延迟出画，暂不做。
2. **重合落位**：只剩「随机散点 / 阶梯格」两档；第三档「单一方向」已按维护者要求删除。相机 `followGain` 会把当前句拉回中心 —— 任何「绝对槽位」方案都会在屏幕上被抵消，这是当初删档的根本原因。
3. **同一句拆句的退场**：拆句后每个 chunk 各自按「后两句」退场；若维护者要整句一起退，需要在 `flowScene.ts` 重新聚合 `lineEnds`。
4. **`web/.scratch` 的 CDP 小工具**在清理时被删掉了大半（只剩 `launch-cdp.ps1`、`eval.mjs` 与几个 `.py` 探针），要做自动化测量得重写 `perf-cut.mjs` / `ov-burst.mjs`（逻辑见 `overlap-handover.md` §8.1）。
5. **ambient 遮挡**：自由线稿与文字同变换，只靠「跳过文字包围盒」让位，没有真正的纸下层。

## 7. 维护者的工作方式（照做即可）

- 原话：「以后让你修改东西直接查原因，找位置找到后直接修改，修改完直接重启给我，无需其他步骤」。
- 每一轮：查原因（读代码 / 抓运行时，不猜）→ 定位文件与行 → 改 → `npx tsc --noEmit` → publish → deploy → 重启装机版 → 一句话说「改了什么 + 现在能看什么」。
- 不做长篇方案论证，不交半成品，不让维护者自己部署。
- 动画三件套（入场 / 出场 / 打断）是硬要求，见 `zilux2-ui-templates.md` 铁律第 6 条与第 10 条（nav dock 的 `homeView` 状态机）。
