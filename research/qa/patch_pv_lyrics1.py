# -*- coding: utf-8 -*-
"""自定义外观面板改为非模态贴按钮弹层 + PV 歌词模式 + 长按选择歌词模式。"""
import io


def patch(path, pairs, label):
    s = io.open(path, 'r', encoding='utf-8', newline='').read()
    for old, new, name in pairs:
        assert s.count(old) == 1, f"anchor miss [{label}:{name}]: {old[:90]!r}"
        s = s.replace(old, new, 1)
    io.open(path, 'w', encoding='utf-8', newline='').write(s)
    print('patched', label)


UI = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
CSS = r"E:\Zilux2开发\web\src\styles\space.css"

# ---------------------------------------------------------------- spaceShell
patch(
    UI,
    [
        # 1) 引入 PV 歌词模块
        (
            """import { createIslandPlayer, formatClock } from './islandPlayer';""",
            """import { createIslandPlayer, formatClock } from './islandPlayer';
import { createPvLyrics, type PvLyricsHandle } from './pvLyrics';""",
            "pv import",
        ),
        # 2) 自定义面板卡片引用
        (
            """  const customOpenBtn = root.querySelector<HTMLButtonElement>('[data-custom]')!;""",
            """  const customOpenBtn = root.querySelector<HTMLButtonElement>('[data-custom]')!;
  const customCardEl = customSheet.querySelector<HTMLElement>('.custom-sheet-card');""",
            "custom card ref",
        ),
        # 3) 非模态：定位到右侧铅笔按钮旁，并支持点外部/滚轮外关闭
        (
            """  const openCustomSheet = (): void => {
    if (customSheet.classList.contains('is-open')) return;
    customSheet.hidden = false;
    customSheet.classList.remove('is-open');
    syncCustomUi();""",
            """  const positionCustomSheet = (): void => {
    if (!customCardEl) return;
    const anchor = customOpenBtn.getBoundingClientRect();
    const width = customCardEl.offsetWidth || 520;
    const height = Math.min(customCardEl.offsetHeight || 560, window.innerHeight - 36);
    let left = anchor.left - width - 14;
    if (left < 12) left = Math.min(window.innerWidth - width - 12, anchor.right + 14);
    let top = anchor.top + anchor.height / 2 - height / 2;
    top = Math.max(12, Math.min(window.innerHeight - height - 12, top));
    customSheet.style.left = `${Math.round(left)}px`;
    customSheet.style.top = `${Math.round(top)}px`;
  };
  const openCustomSheet = (): void => {
    if (customSheet.classList.contains('is-open')) return;
    customSheet.hidden = false;
    customSheet.classList.remove('is-open');
    syncCustomUi();
    positionCustomSheet();""",
            "custom position",
        ),
        # 4) 关闭时清掉定位；外面的 pointerdown 关闭（非模态）
        (
            """  customOpenBtn.addEventListener('click', openCustomSheet);""",
            """  customOpenBtn.addEventListener('click', openCustomSheet);
  document.addEventListener('pointerdown', (event) => {
    if (customSheet.hidden || !customSheet.classList.contains('is-open')) return;
    const target = event.target as Node | null;
    if (!target) return;
    if (customSheet.contains(target) || customOpenBtn.contains(target)) return;
    closeCustomSheet();
  });
  window.addEventListener('resize', () => {
    if (!customSheet.hidden && customSheet.classList.contains('is-open')) positionCustomSheet();
  });""",
            "custom outside close",
        ),
        # 5) PV 层与模式状态
        (
            """  root.appendChild(island.element);
  island.setVolume(getSettings().playback.volume);""",
            """  root.appendChild(island.element);
  island.setVolume(getSettings().playback.volume);

  /* PV 文字歌词层（柔和日式文字 PV；不显示磁贴封面） */
  const pvLyrics: PvLyricsHandle = createPvLyrics();
  root.appendChild(pvLyrics.element);
  let lyricMode: 'stage' | 'pv' = custom.lyricMode === 'pv' ? 'pv' : 'stage';

  const lyricModePop = document.createElement('div');
  lyricModePop.className = 'lyric-mode-pop';
  lyricModePop.hidden = true;
  lyricModePop.innerHTML = `
    <p class="lyric-mode-title">歌词模式</p>
    <button class="lyric-mode-item" data-lyric-mode="stage" type="button">
      <b>3D 歌词舞台</b><span>歌词在磁贴之间飘着，可拖动视角</span>
    </button>
    <button class="lyric-mode-item" data-lyric-mode="pv" type="button">
      <b>PV 文字歌词</b><span>柔和文字 PV，隐藏磁贴封面</span>
    </button>
  `;
  root.appendChild(lyricModePop);
  const positionLyricModePop = (): void => {
    const anchor = lyricsBtn.getBoundingClientRect();
    const width = 236;
    let left = anchor.left - width - 12;
    if (left < 12) left = Math.min(window.innerWidth - width - 12, anchor.right + 12);
    let top = anchor.top + anchor.height / 2 - 70;
    top = Math.max(12, Math.min(window.innerHeight - 170, top));
    lyricModePop.style.left = `${Math.round(left)}px`;
    lyricModePop.style.top = `${Math.round(top)}px`;
  };
  const closeLyricModePop = (): void => {
    lyricModePop.hidden = true;
  };
  const openLyricModePop = (): void => {
    lyricModePop.hidden = false;
    positionLyricModePop();
    lyricModePop.querySelectorAll<HTMLButtonElement>('[data-lyric-mode]').forEach((button) => {
      button.classList.toggle('is-on', button.dataset.lyricMode === lyricMode);
    });
  };
  document.addEventListener('pointerdown', (event) => {
    if (lyricModePop.hidden) return;
    const target = event.target as Node | null;
    if (!target) return;
    if (lyricModePop.contains(target) || lyricsBtn.contains(target)) return;
    closeLyricModePop();
  });
  lyricModePop.querySelectorAll<HTMLButtonElement>('[data-lyric-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      const next = button.dataset.lyricMode === 'pv' ? 'pv' : 'stage';
      const changed = next !== lyricMode;
      lyricMode = next;
      custom.lyricMode = next;
      persistCustom();
      closeLyricModePop();
      showToast(next === 'pv' ? '已切换：PV 文字歌词' : '已切换：3D 歌词舞台', 'ok');
      if (changed && lyricsOpen) {
        exitLyricsView();
        window.setTimeout(() => {
          if (!disposed) void enterLyricsView();
        }, 240);
      }
    });
  });""",
            "pv layer + mode pop",
        ),
    ],
    'spaceShell step1',
)
print('step1 done')
