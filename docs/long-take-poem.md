# 长镜流诗

入口：快捷设置 → 播放效果 → 长镜流诗。设置沿用 `zilux2.lumiere`，新模式值为 `poem`，软件歌词页和桌面背景歌词共用。

歌词沿轻弧线连续交接，画面中心的文字放大、逐字点亮，两侧歌词随距离和屏幕边缘淡出。普通 LRC 使用句内估算进度；有逐字时间戳时按原始时间显示。翻译放在对应歌词下方，长句自动换行。相同时间戳的多行合并显示，避免镜头在同一时刻跳动。

绸光背景使用低分辨率画布绘制连续曲线，再合成到高清文字画布。封面色用 2.4 秒渐变融入原背景；换句、切歌不重新开始背景运动。暂停后背景时间停止，拖动进度条直接按新时间重新定位歌词。设置了减少动态效果时，停止背景流动和横向视差。

主要文件：

- `web/src/ui/poem.ts`：播放时钟、场景生命周期、启停及错误回退。
- `web/src/ui/poemScene.ts`：背景、歌词布局和绘制、封面色融合。
- `web/src/ui/poemMotion.ts`：确定性的换句轨迹，转场区间随相邻歌词间隔缩短。
- `web/poem-preview.html`：开发环境预览，未包含在正式打包入口内。

验证命令：

```powershell
node web/node_modules/typescript/bin/tsc --noEmit -p web/tsconfig.json
node --test web/tests/poem-motion.test.cjs web/tests/flow-motion.test.cjs web/tests/flow-preload.test.cjs
```

本次验证：15 项测试通过。使用生产绘制代码和原生 Canvas 离屏检查了宽屏、窄屏、长句、英文翻译和快速换句画面。浏览器启动被执行策略拒绝，尚未完成 WebView2 内的视觉和帧率验收；离屏绘制结果不代表软件内帧率。
