# 第三方代码说明（Third-Party Notices）

本仓库整体按根目录 [`LICENSE`](LICENSE) 的 MIT 许可发布，但以下目录/文件包含第三方作品，需同时遵守其原始许可。

## web/src/ui/lumiere-folia/

该目录下的文件改编自 **Folia**（https://github.com/chthollyphile/folia-major），版权归其原作者所有，遵循 **GNU Affero General Public License v3.0（AGPL-3.0）** 发布。

- 该目录及其衍生作品的使用、修改与分发需遵守 AGPL-3.0；
- 本仓库其余部分（除该目录外）按 MIT 许可发布；
- 后续版本已推进「纯字」播放效果的自研渲染替换，历史版本与包含该目录代码的构建仍按 AGPL-3.0 约束使用。

## 参考项目（未复制其界面资源或源代码）

- Rhine Music Windows（MIT）—— 架构与工程方法参考
- Mineradio（GPL-3.0）—— 设计思路参考

### 拼合 / Tempera（2026-11-06 移植）

`web/src/ui/lumiere-folia/components/visualizer/tempera/` 及所需的 `sonnet/`、Pixi 公共辅助模块来自本地 Folia v0.7.21 源码快照（上游：https://github.com/chthollyphile/folia-major）。原作者保留版权，许可全文保存在 `web/src/ui/lumiere-folia/LICENSE`。本地快照没有可验证的 commit 元数据。

本次复用原版分镜编译、构图、逐字布局、镜头、转场和后处理，并保留默认参数。移植修改限于 MotionValue 导入适配、删除未使用声明以通过本项目 TypeScript 检查，以及不传入针对 AI 代理的指令性注释。`web/src/ui/flowScene.ts` 负责连接 Zilux 歌词、播放时钟和生命周期；未移植 Folia 的 React 设置面板与用户图片库管理界面。默认使用 Folia 午夜主题；主题、字体、歌词时间轴和随机种子均会影响具体画面。
