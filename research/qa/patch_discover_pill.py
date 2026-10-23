# -*- coding: utf-8 -*-
"""顶部「发现」胶囊：网易云 / QQ 音乐的最近播放、每日推荐按钮（先做 UI 与动效，功能后续）。"""
import io

p = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
s = io.open(p, "r", encoding="utf-8", newline="").read()

# 1) 模板：在搜索下拉后插入发现胶囊
anchor = """      <div class="space-search-drop" data-search-drop hidden>
        <div class="space-search-results" data-search-results></div>
      </div>
"""
assert s.count(anchor) == 1, "anchor"
markup = """      <div class="space-discover" data-discover>
        <button class="space-discover-pill" data-discover-toggle type="button" aria-label="最近播放与每日推荐">
          ${icon('sparkles', 16)}<span>发现</span>
        </button>
        <div class="space-discover-body">
          <div class="space-discover-src">
            <button class="space-src-btn is-on" data-discover-source="netease" type="button">网易</button>
            <button class="space-src-btn" data-discover-source="qq" type="button">QQ</button>
          </div>
          <button class="space-discover-item" data-discover-item="recent" type="button">${icon('playlist', 13)}<span>最近播放</span></button>
          <button class="space-discover-item" data-discover-item="daily" type="button">${icon('sparkles', 13)}<span>每日推荐</span></button>
        </div>
      </div>
"""
s = s.replace(anchor, anchor + markup, 1)

# 2) 逻辑：在搜索栏绑定之后插入
anchor2 = "  const discover = root.querySelector<HTMLElement>('[data-discover]')!;\n"
assert s.count(anchor2) == 0
anchor3 = "  const topSearchBtn = root.querySelector<HTMLButtonElement>('[data-topsearch]')!;"
assert s.count(anchor3) == 1, "topSearchBtn"
logic = anchor3 + r"""

  /* 顶部「发现」胶囊：最近播放 / 每日推荐（先出按钮与动效，功能后续接入） */
  const discoverEl = root.querySelector<HTMLElement>('[data-discover]')!;
  const discoverToggle = root.querySelector<HTMLButtonElement>('[data-discover-toggle]')!;
  const discoverSrcBtns = Array.from(
    root.querySelectorAll<HTMLButtonElement>('[data-discover-source]'),
  );
  let discoverSource: MusicSource = 'netease';
  const discoverSourceLabel = (): string => (discoverSource === 'qq' ? 'QQ 音乐' : '网易云音乐');
  discoverToggle.addEventListener('click', () => {
    discoverEl.classList.toggle('is-open');
  });
  discoverSrcBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      discoverSource = btn.dataset.discoverSource === 'qq' ? 'qq' : 'netease';
      discoverSrcBtns.forEach((item) => {
        item.classList.toggle('is-on', item === btn);
      });
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-discover-item]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const label = btn.dataset.discoverItem === 'daily' ? '每日推荐' : '最近播放';
      setStatus(`${discoverSourceLabel()} · ${label} 功能即将开放`);
      showToast(`${discoverSourceLabel()} · ${label} 即将开放`, 'info');
    });
  });
  document.addEventListener('pointerdown', (event) => {
    if (!discoverEl.contains(event.target as Node)) discoverEl.classList.remove('is-open');
  });"""
s = s.replace(anchor3, logic, 1)

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("discover pill patched")
