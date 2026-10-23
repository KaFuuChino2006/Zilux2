# -*- coding: utf-8 -*-
"""追加主题语义令牌 + 组件层（ui.*）+ 首页样式到 app.css。"""
import io

CSS = r"E:\Zilux2开发\web\src\styles\app.css"

BLOCK = r"""
/* ==========================================================================
   主题语义令牌（换肤接口；theme.ts 会把这些写到 :root 覆盖）
   ========================================================================== */
:root {
  --surface: rgba(18, 19, 24, 0.72);
  --surface-strong: rgba(25, 27, 33, 0.94);
  --surface-hover: rgba(34, 36, 45, 0.92);
  --line-strong: rgba(255, 255, 255, 0.14);
  --accent-contrast: #111218;
  --scrim: rgba(4, 5, 8, 0.62);
  --shadow-1: 0 10px 28px rgba(0, 0, 0, 0.34);
  --shadow-2: 0 24px 64px rgba(0, 0, 0, 0.5);
  --dur-fast: 160ms;
  --dur-mid: 260ms;
  --dur-slow: 420ms;
}

.is-hidden {
  display: none !important;
}

/* ==========================================================================
   组件层：ui.*（页面只组合这些类，颜色全部引用语义令牌）
   ========================================================================== */
.ui-page {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 20px 30px calc(var(--player-h) + 40px) 10px;
  scroll-behavior: smooth;
}

.home-host {
  position: absolute;
  inset: 0;
}

.ui-heading {
  margin: 0;
  color: var(--text);
  font-size: clamp(30px, 3.4vw, 46px);
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.06;
}

.ui-sub {
  margin-top: 10px;
  color: var(--muted);
  font-size: 13.5px;
  letter-spacing: 0.01em;
}

.ui-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 9px 16px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--text);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  backdrop-filter: blur(12px);
  transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease),
    transform var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease);
}

.ui-btn:hover {
  background: var(--surface-hover);
  border-color: var(--line-strong);
  transform: translateY(-1px);
}

.ui-btn:active {
  transform: translateY(0);
}

.ui-btn--primary {
  background: var(--accent);
  border-color: transparent;
  color: var(--accent-contrast);
  font-weight: 600;
}

.ui-btn--primary:hover {
  background: var(--accent);
  filter: brightness(1.06);
  box-shadow: var(--shadow-1);
}

.ui-btn--lg {
  padding: 12px 20px;
  font-size: 14px;
}

.ui-btn--sm {
  padding: 6px 12px;
  font-size: 12px;
}

.ui-btn--icon {
  width: 38px;
  height: 38px;
  padding: 0;
  justify-content: center;
}

.ui-chip {
  display: inline-flex;
  align-items: center;
  padding: 6px 13px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--line);
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease);
}

.ui-chip:hover {
  color: var(--text);
  border-color: var(--line-strong);
}

.ui-chip.is-active {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: transparent;
}

.ui-card {
  border-radius: var(--radius-m);
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--text);
}

.ui-card.is-flat {
  background: transparent;
}

.ui-card.is-interactive {
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease),
    transform var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease);
}

.ui-card.is-interactive:hover {
  background: var(--surface-hover);
  border-color: var(--line-strong);
  transform: translateY(-2px);
  box-shadow: var(--shadow-1);
}

.ui-entry {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 14px 16px;
  text-align: left;
  border-radius: var(--radius-m);
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--text);
  font-family: inherit;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease),
    transform var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease);
}

.ui-entry:hover {
  background: var(--surface-hover);
  border-color: var(--line-strong);
  transform: translateY(-2px);
  box-shadow: var(--shadow-1);
}

.ui-entry-icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border-radius: 13px;
  background: var(--accent-soft);
  color: var(--accent);
}

.ui-entry-body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.ui-entry-title {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.ui-entry-sub {
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ui-section {
  margin-top: 34px;
}

.ui-section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.ui-section-title {
  margin: 0;
  color: var(--text);
  font-size: 18px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.ui-section-more {
  padding: 4px 2px;
  border: 0;
  background: none;
  color: var(--muted);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: color var(--dur-fast) var(--ease);
}

.ui-section-more:hover {
  color: var(--accent);
}

.ui-scroller {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 146px;
  gap: 14px;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 2px 2px 10px;
  scroll-snap-type: x proximity;
}

.ui-scroller::-webkit-scrollbar {
  height: 6px;
}

.ui-scroller::-webkit-scrollbar-thumb {
  background: var(--line-strong);
  border-radius: 999px;
}

.ui-scroller::-webkit-scrollbar-track {
  background: transparent;
}

.ui-tile {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: none;
  color: var(--text);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  scroll-snap-align: start;
}

.ui-tile-cover {
  display: block;
  aspect-ratio: 1;
  border-radius: var(--radius-m);
  overflow: hidden;
  background: var(--bg-soft);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-1);
  transition: transform var(--dur-mid) var(--ease), box-shadow var(--dur-mid) var(--ease);
}

.ui-tile-cover img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.ui-tile:hover .ui-tile-cover {
  transform: scale(1.045);
  box-shadow: var(--shadow-2);
}

.ui-tile-name {
  font-size: 13px;
  font-weight: 560;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ui-tile-meta {
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ui-empty {
  padding: 22px 4px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.7;
}

/* ==========================================================================
   首页（基础播放页）
   ========================================================================== */
.home {
  display: flex;
  flex-direction: column;
}

.home-hero {
  padding: 22px 0 28px;
}

.home-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 22px;
}

.home-search {
  justify-content: flex-start;
  min-width: min(380px, 100%);
  color: var(--muted);
}

.home-search:hover {
  color: var(--text);
}

.home-entries {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fill, minmax(222px, 1fr));
}

@media (max-width: 980px) {
  .home-entries {
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  }
}

/* 浅色主题下把旧组件的写死深色兜一下（后续逐个迁移到令牌） */
:root[data-theme='light'] body {
  background: var(--bg);
  color: var(--text);
}
"""

with io.open(CSS, "r", encoding="utf-8", newline="") as fh:
    text = fh.read()
E = "\r\n" if "\r\n" in text else "\n"
if ".ui-entry" in text:
    print("already patched")
else:
    text = text.rstrip("\r\n") + E * 2 + BLOCK.replace("\n", E).lstrip("\r\n")
    with io.open(CSS, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)
    print("app.css appended")
