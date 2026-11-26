# Zilux2 性能基线与测量口径

## 口径（必须照这个测，否则数字会偏大一倍以上）
- 只统计 Zilux2 自己的进程树：`Zilux2.exe` + 它唯一的 `msedgewebview2.exe` 子进程 + 该子进程的 6 个孙进程，共 8 个。
- **不要**按进程名汇总 `msedgewebview2`——机器上还有 DeepSeek/Edge 的 WebView，会把别人算进来。
- 采样 15–20 秒，取每个进程 `TotalProcessorTime` 前后差之和 ÷ 时长；24 核机器上 100% = 1 核。

## 2026-11-25 基线（安装版 1.2.11，3440×1440 主屏 + 200Hz 刷新）
| 场景 | 进程树 CPU |
| --- | --- |
| 可见、首页空闲 | 34.1% |
| 收进托盘（离屏停放） | 4.8% |
| 修改前（第 9 轮之前，可见） | 158.6% |

## 已落地的优化（按收益排序）
1. `.daily-card::before/::after`（网点/印花）改 `animation-play-state: paused`，仅 hover/focus 时跑 —— 158.6% → 22.0%。
2. 逐字标题入场结束后把 `is-char-in` 换成 `is-char-settled`，撤掉 79 个常驻合成层。
3. 收进托盘时 `setHostParked(true)`：暂停 `document.getAnimations()` 全部动画 + 暂停壁纸 `<video>`，并给 `<html>` 加 `is-host-parked`。
4. `stagePulse` 的 rAF 自循环在 `is-host-parked` / `document.hidden` 时休眠（500ms 轮询唤醒）—— 停放态 41% → 4.8%。
5. 音频设备轮询改「轻量 ID 优先」，`corner-print` 改 `translate` 走合成层。

## 已知仍偏高
- 可见态 34% 主要是壁纸 `<video>`（1920×1080，整窗）+ 首页若干 hover 动画；要再降需要给软件内壁纸做服务端下采样（1280/960 长边）。
