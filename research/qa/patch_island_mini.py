# -*- coding: utf-8 -*-
"""播放条：未悬停时收起为小药丸（已播时间 + 进度条 + 剩余时间），悬停展开完整播放器。"""
import io
import os
import sys

ROOT = r'E:\Zilux2开发\web\src'


def edit(rel, pairs):
    path = os.path.join(ROOT, rel)
    with io.open(path, 'r', encoding='utf-8') as fh:
        text = fh.read()
    for old, new in pairs:
        if old not in text:
            print('MISS %s: %r' % (rel, old[:90]))
            sys.exit(1)
        if text.count(old) != 1:
            print('DUP %s: %r' % (rel, old[:90]))
            sys.exit(1)
        text = text.replace(old, new)
    with io.open(path, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(text)
    print('OK %s' % rel)


old_dom = """  root.innerHTML = `
    <div class="island-pill island-time">
      <button class="island-btn island-play" data-playpause type="button" aria-label="播放/暂停">${ICON_PLAY}</button>
      <div class="island-timebody">
        <div class="island-title" data-island-title>未播放</div>
        <div class="island-progress" data-island-progress>
          <div class="island-progress-fill" data-island-fill></div>
        </div>
      </div>
      <button class="island-btn island-like" data-island-like type="button" aria-label="加入我喜欢" title="加入我喜欢">${ICON_HEART}</button>
      <span class="island-clock" data-island-clock>0:00 / 0:00</span>
    </div>
    <div class="island-pill island-skip">
      <button class="island-btn" data-island-prev type="button" aria-label="上一首">${ICON_PREV}</button>
      <button class="island-btn" data-island-next type="button" aria-label="下一首">${ICON_NEXT}</button>
    </div>
    <div class="island-pill island-mode">
      <button class="island-btn island-modebtn" data-island-mode type="button" aria-label="播放模式">${ICON_ORDER}<span data-island-modelabel>顺序</span></button>
    </div>
  `;
"""

new_dom = """  // 收起态只露一个小药丸：已播时间 + 进度条 + 剩余时间；悬停再展开完整播放器
  root.innerHTML = `
    <div class="island-pill island-mini" data-island-mini>
      <span class="island-mini-time" data-mini-elapsed>0:00</span>
      <div class="island-mini-track"><div class="island-mini-fill" data-mini-fill></div></div>
      <span class="island-mini-time" data-mini-remaining>-0:00</span>
    </div>
    <div class="island-expanded">
      <div class="island-pill island-time">
        <button class="island-btn island-play" data-playpause type="button" aria-label="播放/暂停">${ICON_PLAY}</button>
        <div class="island-timebody">
          <div class="island-title" data-island-title>未播放</div>
          <div class="island-progress" data-island-progress>
            <div class="island-progress-fill" data-island-fill></div>
          </div>
        </div>
        <button class="island-btn island-like" data-island-like type="button" aria-label="加入我喜欢" title="加入我喜欢">${ICON_HEART}</button>
        <span class="island-clock" data-island-clock>0:00 / 0:00</span>
      </div>
      <div class="island-pill island-skip">
        <button class="island-btn" data-island-prev type="button" aria-label="上一首">${ICON_PREV}</button>
        <button class="island-btn" data-island-next type="button" aria-label="下一首">${ICON_NEXT}</button>
      </div>
      <div class="island-pill island-mode">
        <button class="island-btn island-modebtn" data-island-mode type="button" aria-label="播放模式">${ICON_ORDER}<span data-island-modelabel>顺序</span></button>
      </div>
    </div>
  `;
"""

edit('ui/islandPlayer.ts', [
    (old_dom, new_dom),
    (
        "  const clockEl = root.querySelector<HTMLElement>('[data-island-clock]')!;\n",
        "  const clockEl = root.querySelector<HTMLElement>('[data-island-clock]')!;\n"
        "  const miniElapsedEl = root.querySelector<HTMLElement>('[data-mini-elapsed]')!;\n"
        "  const miniRemainingEl = root.querySelector<HTMLElement>('[data-mini-remaining]')!;\n"
        "  const miniFillEl = root.querySelector<HTMLElement>('[data-mini-fill]')!;\n",
    ),
    (
        """    clockEl.textContent = `${formatClock(position)} / ${formatClock(duration)}`;
    if (!scrubbing) {
      const ratio = duration > 0 ? Math.min(1, position / duration) : 0;
      fillEl.style.width = `${(ratio * 100).toFixed(2)}%`;
    }
""",
        """    clockEl.textContent = `${formatClock(position)} / ${formatClock(duration)}`;
    // 收起态小药丸：左已播、右剩余，中间进度
    miniElapsedEl.textContent = formatClock(position);
    miniRemainingEl.textContent = `-${formatClock(Math.max(0, duration - position))}`;
    const ratio = duration > 0 ? Math.min(1, position / duration) : 0;
    miniFillEl.style.width = `${(ratio * 100).toFixed(2)}%`;
    if (!scrubbing) {
      fillEl.style.width = `${(ratio * 100).toFixed(2)}%`;
    }
""",
    ),
])

css_append = """
/* ---------- 底部播放条：未悬停时收成小药丸（参考顶部「发现」的展开动画） ---------- */
.island-mini {
  height: 42px;
  min-width: 240px;
  max-width: 240px;
  padding: 0 14px;
  gap: 10px;
  overflow: hidden;
  transition: max-width 0.46s cubic-bezier(0.22, 0.61, 0.36, 1), opacity 0.3s ease,
    padding 0.46s cubic-bezier(0.22, 0.61, 0.36, 1), border-color 0.3s ease;
}
.island-mini-time {
  flex: none;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: #6a7180;
  white-space: nowrap;
}
.island-mini-track {
  position: relative;
  flex: 1 1 auto;
  min-width: 40px;
  height: 4px;
  border-radius: 999px;
  background: rgba(23, 26, 33, 0.14);
  overflow: hidden;
}
.island-mini-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 0%;
  border-radius: 999px;
  background: linear-gradient(90deg, #6a5cff, #3bb6f5 60%, #2fa8e8);
  transition: width 0.12s linear;
}
.island-expanded {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 0;
  opacity: 0;
  overflow: hidden;
  pointer-events: none;
  transition: max-width 0.46s cubic-bezier(0.22, 0.61, 0.36, 1), opacity 0.3s ease;
}
.island-dock:hover .island-mini {
  max-width: 0;
  opacity: 0;
  padding-left: 0;
  padding-right: 0;
  border-color: transparent;
}
.island-dock:hover .island-expanded {
  max-width: 900px;
  opacity: 1;
  pointer-events: auto;
}
.space-shell.theme-gold .island-mini-track {
  background: rgba(255, 255, 255, 0.16) !important;
}
.space-shell.theme-gold .island-mini-time {
  color: #cfc4a6 !important;
}
"""

css_path = os.path.join(ROOT, 'styles/space.css')
with io.open(css_path, 'r', encoding='utf-8') as fh:
    css = fh.read()
if '.island-mini {' not in css:
    css = css.rstrip('\n') + '\n' + css_append
    with io.open(css_path, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(css)
    print('OK styles/space.css')
else:
    print('SKIP styles/space.css')
