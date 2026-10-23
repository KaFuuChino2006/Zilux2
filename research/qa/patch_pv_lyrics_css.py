# -*- coding: utf-8 -*-
"""CSS：自定义面板非模态贴按钮 + PV 歌词层 + 长按歌词模式菜单。"""
import io

path = r"E:\Zilux2开发\web\src\styles\space.css"
s = io.open(path, 'r', encoding='utf-8', newline='').read()

# 去掉旧的自定义面板遮罩/居中定位（用 !important 覆盖历史规则）
appended = """

/* ===== 自定义外观面板：非模态贴按钮弹层（半透明、不模糊背景，方便边调边看） ===== */
.custom-sheet {
  position: fixed !important;
  inset: auto !important;
  left: 0;
  top: 0;
  display: block !important;
  place-items: unset;
  opacity: 1 !important;
  transition: none !important;
  pointer-events: none;
  z-index: 66;
}
.custom-sheet.is-open {
  opacity: 1 !important;
}
.custom-sheet-backdrop {
  display: none !important;
}
.custom-sheet-card {
  position: absolute !important;
  left: 0;
  top: 0;
  margin: 0;
  width: min(520px, 88vw) !important;
  max-height: min(820px, calc(100vh - 36px));
  overflow-y: auto;
  padding: 20px 20px 16px !important;
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.62) !important;
  border: 1px solid rgba(255, 255, 255, 0.78);
  -webkit-backdrop-filter: blur(10px) saturate(125%);
  backdrop-filter: blur(10px) saturate(125%);
  box-shadow: 0 24px 64px rgba(30, 42, 74, 0.16);
  opacity: 0 !important;
  transform: translateX(10px) scale(0.975);
  transition: opacity 0.2s ease, transform 0.24s cubic-bezier(0.22, 0.8, 0.28, 1) !important;
  pointer-events: auto;
}
.custom-sheet.is-open .custom-sheet-card {
  opacity: 1 !important;
  transform: translateX(0) scale(1);
}

/* ===== 歌词模式长按菜单 ===== */
.lyric-mode-pop {
  position: fixed;
  z-index: 78;
  width: 236px;
  padding: 10px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.92);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  backdrop-filter: blur(18px) saturate(140%);
  box-shadow: 0 18px 44px rgba(30, 42, 74, 0.18);
}
.lyric-mode-pop[hidden] {
  display: none;
}
.lyric-mode-title {
  margin: 2px 4px 8px;
  font-size: 11px;
  letter-spacing: 0.12em;
  color: var(--text-mute);
}
.lyric-mode-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 9px 10px;
  border-radius: 12px;
  border: 1px solid transparent;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.lyric-mode-item b {
  font-size: 13px;
  color: var(--text);
}
.lyric-mode-item span {
  font-size: 11px;
  color: var(--text-mute);
}
.lyric-mode-item:hover {
  background: rgba(106, 92, 255, 0.08);
}
.lyric-mode-item.is-on {
  border-color: rgba(106, 92, 255, 0.4);
  background: rgba(106, 92, 255, 0.1);
}

/* ===== PV 文字歌词层（柔和日式文字 PV） ===== */
.pv-layer {
  position: fixed;
  inset: 0;
  z-index: 7;
  display: grid;
  place-items: center;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.65s ease;
  background:
    radial-gradient(circle at 50% 42%, rgba(24, 30, 48, 0.42), rgba(6, 8, 14, 0.93) 62%),
    linear-gradient(180deg, #060810, #0a0d18 55%, #05060c);
}
.pv-layer.is-open {
  opacity: 1;
}
.pv-dust {
  position: absolute;
  inset: 0;
  opacity: 0.5;
  background-image:
    radial-gradient(circle at 18% 24%, rgba(200, 214, 255, 0.7) 0 1.1px, transparent 1.7px),
    radial-gradient(circle at 72% 38%, rgba(255, 255, 255, 0.5) 0 0.9px, transparent 1.5px),
    radial-gradient(circle at 44% 76%, rgba(186, 202, 255, 0.45) 0 1.2px, transparent 1.9px);
  background-size: 260px 220px, 340px 300px, 420px 380px;
  animation: pv-drift 26s linear infinite;
}
@keyframes pv-drift {
  from {
    background-position: 0 0, 0 0, 0 0;
  }
  to {
    background-position: 0 -220px, 0 -300px, 0 -380px;
  }
}
.pv-frame {
  position: absolute;
  inset: 7vh 7vw;
  opacity: 0.4;
}
.pv-frame-line {
  position: absolute;
  background: rgba(255, 255, 255, 0.5);
}
.pv-frame-top-left {
  left: 0;
  top: 0;
  width: 56px;
  height: 1px;
}
.pv-frame-top-right {
  right: 0;
  top: 0;
  width: 56px;
  height: 1px;
}
.pv-frame-bottom-left {
  left: 0;
  bottom: 0;
  width: 56px;
  height: 1px;
}
.pv-frame-bottom-right {
  right: 0;
  bottom: 0;
  width: 56px;
  height: 1px;
}
.pv-stage {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  max-width: 78vw;
  padding: 0 4vw;
  transform: translateY(14px);
  transition: transform 0.8s cubic-bezier(0.22, 0.8, 0.28, 1);
}
.pv-layer.is-open .pv-stage {
  transform: translateY(0);
}
.pv-line {
  margin: 0;
  font-family: 'Segoe UI', 'Microsoft YaHei UI', 'PingFang SC', sans-serif;
  font-size: clamp(22px, 2.6vw, 40px);
  letter-spacing: 0.16em;
  line-height: 1.5;
  text-align: center;
  color: rgba(255, 255, 255, 0.95);
  text-shadow: 0 0 28px rgba(186, 202, 255, 0.35), 0 2px 12px rgba(0, 0, 0, 0.4);
}
.pv-line.pv-ghost {
  font-size: clamp(13px, 1.3vw, 20px);
  letter-spacing: 0.1em;
  color: rgba(255, 255, 255, 0.26);
  text-shadow: none;
}
.pv-trans {
  margin: 0;
  font-size: clamp(12px, 1.3vw, 17px);
  letter-spacing: 0.08em;
  color: rgba(200, 214, 255, 0.6);
}
.pv-current.is-swap {
  animation: pv-in 0.7s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.pv-trans.is-swap {
  animation: pv-in 0.9s cubic-bezier(0.2, 0.8, 0.2, 1);
}
@keyframes pv-in {
  from {
    opacity: 0;
    transform: translateY(14px);
    filter: blur(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
    filter: blur(0);
  }
}
"""

s = s + appended
io.open(path, 'w', encoding='utf-8', newline='').write(s)
print('css appended')
