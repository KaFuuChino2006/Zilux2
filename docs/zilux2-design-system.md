# Zilux2 设计规范 v2 · 白色磨砂（Frost）

> 状态：v2（2026-10-18）· 全应用视觉基线，替换 v1 深色方案
> 适用范围：首页、播放条、搜索/歌词/设置/账号弹层、播放页骨架、3D 场景外观、启动页

## 1. 总原则

1. **白色磨砂**：大面积浅色背景 + 半透明白玻璃层，靠 `backdrop-filter` 模糊出层次，不靠深色对比。
2. **低饱和、轻质感**：极光/光斑只做 6–12% 透明度的氛围，不铺高饱和渐变；禁止纯黑大块、禁止霓虹描边。
3. **内容优先**：文字、封面、按钮清晰度优先；玻璃只做承载，不抢内容。
4. **一致的光源**：所有玻璃面统一「上方冷白、下方淡紫」的极轻渐变，阴影统一向下投影。
5. 布局、栅格、z-index、交互方式保持不变，只替换视觉层（token + 组件样式 + 3D 配色）。

## 2. 颜色 Token（`web/src/styles/base.css` 单一来源）

```css
:root {
  /* 背景层 */
  --bg: #f6f7fb;
  --bg-deep: #eef1f7;
  --bg-tint: #f9f7ff;
  /* 玻璃面 */
  --glass: rgba(255, 255, 255, 0.62);
  --glass-strong: rgba(255, 255, 255, 0.82);
  --glass-soft: rgba(255, 255, 255, 0.38);
  --glass-border: rgba(255, 255, 255, 0.78);
  --glass-line: rgba(22, 26, 38, 0.08);
  /* 文本 */
  --text: #171a21;
  --text-dim: #5d6470;
  --text-mute: #9aa1ad;
  /* 强调色（比深色版更沉，保证白底对比度 ≥ 4.5:1） */
  --accent: #6a5cff;
  --accent-cyan: #2fa8e8;
  --accent-pink: #e263a1;
  --accent-soft: rgba(106, 92, 255, 0.10);
  /* 阴影 */
  --shadow-sm: 0 1px 2px rgba(20, 24, 40, 0.05), 0 4px 14px rgba(20, 24, 40, 0.06);
  --shadow-md: 0 10px 30px rgba(20, 24, 40, 0.10), 0 2px 6px rgba(20, 24, 40, 0.05);
  --shadow-lg: 0 24px 60px rgba(20, 24, 40, 0.16), 0 6px 18px rgba(20, 24, 40, 0.06);
  /* 圆角 */
  --r-sm: 10px; --r-md: 14px; --r-lg: 18px; --r-xl: 24px; --r-pill: 999px;
}
```

- 玻璃规则：`background: var(--glass); backdrop-filter: blur(22px) saturate(150%); border: 1px solid var(--glass-border); box-shadow: var(--shadow-sm);`
- 浮层（弹层/播放条/顶栏）：`--glass-strong` + `blur(28px)` + `--shadow-md`；设置/账号大弹层用 `--shadow-lg`。
- 分割线统一 `1px solid var(--glass-line)`（或 `rgba(22,26,38,.06)`）。
- 强调按钮：`linear-gradient(135deg, #6a5cff 0%, #3bb6f5 100%)`，文字纯白；次按钮：白 70% 玻璃 + `--text`。
- 发光/光晕只允许 `rgba(106,92,255,.16)` 级别，且必须落在浅色背景上。

## 3. 背景与氛围

- `body` 底色：`linear-gradient(180deg, #f7f8fc 0%, #eef1f7 55%, #f6f2fa 100%)`。
- 极光：3 个 `radial-gradient` 光斑（紫 #b9a8ff 18% / 青 #a8e1ff 16% / 粉 #ffc3dd 14%），`filter: blur(120px)`，整体透明度 ≤ 0.5，缓慢漂移（reduced-motion 下静止）。
- 噪点：白噪点 ≤ 0.025 透明度，只做质感不抢眼。

## 4. 组件指引

- **标题栏**：白磨砂 `--glass-strong`，底部 `--glass-line` 细线，不再用深色横条；窗口按钮 36×28 圆角，hover 浅灰。
- **左侧 rail**：宽 84px，白色 55% 玻璃；图标 `--text-dim`，激活项底色 `--accent-soft` + 图标/文字 `--accent`；底部仅保留设置（彩色球已删除）。
- **顶栏**：搜索框白玻璃胶囊（`--r-pill`，内阴影 `inset 0 1px 0 #fff`），右侧铃铛/设置为主 32px 圆形白玻璃。
- **Hero**：浅色舞台——背景 `linear-gradient(160deg,#fbfaff,#eef3ff 60%,#fdf2f8)`，卡片阴影 `--shadow-md`，倒影用浅灰地面渐变；文案 `--text`，标签 `--text-mute`。
- **卡片**：封面圆角 16，白 60% 玻璃承载；hover `translateY(-2px)` + `--shadow-md`；卡片标题 `--text` 14px 600，副行 `--text-mute` 12px。
- **播放条**：`--glass-strong` + 顶部细线 + `--shadow-md`；进度条底 `rgba(22,26,38,.08)`、已播放 `--accent` 渐变；播放键 44px 圆，白玻璃 + 强调渐变描边。
- **搜索弹层**：120px backdrop `rgba(246,247,251,.55)` + blur；面板白 82% + `--shadow-lg`；结果行 hover `rgba(106,92,255,.06)`；VIP 徽标用 `--accent-pink` 10% 底。
- **歌词面板**：白 78% 玻璃；非当前行 `--text-mute`，当前行 `--text` + 左侧 2px 强调条（或强调底色）。
- **设置/账号弹层**：白 84% 玻璃；左侧导航选中项 `--accent-soft` + 强调文字；开关开=强调渐变，关=`rgba(22,26,38,.12)`；分段控件白玻璃。
- **启动页**：改为浅色磨砂——底 `#f6f5fb`，柔和彩色光斑（紫/青/粉各 12%），品牌字标 `--text`（保持现有排版/进度/跳过），粒子改为柔和光点（白色/淡彩、透明度低、无强发光）。
- **3D 封面环**：背景透明或浅色渐变；卡片 tone 不变（封面本身彩色），阴影变浅、倒影用 `rgba(23,26,33,.10)`；禁止在浅色上用深色光晕。
- **过渡**：入场 240–360ms `cubic-bezier(.22,.61,.36,1)`；`html.reduce-motion` 全部 0ms 并停 3D 自转。

## 5. 设置项调整

- 外观 → 界面主题：改为只显示「白色磨砂（当前）」（暂不提供深色/极夜）；`Settings.appearance.theme` 归一化规则改为 `'frost'` 默认，旧数据 `dark/midnight` 一律回落 `frost`（后端契约同步改注释即可，不破坏解析）。
- 外观 → 氛围光晕：改控制浅色极光光斑的显隐。
- 其余设置项不变。

## 6. 验收

- 首页、搜索、歌词、设置、账号、启动页全部为白色磨砂，无残留深色块/黑色背景/霓虹描边；
- 文字对比度：正文 ≥ 4.5:1，按钮文字清晰；封面/二维码等彩色内容不被玻璃底冲淡；
- 滚动、弹层、切换主题后无闪烁、无黑色闪屏；reduce-motion 下无动画。
