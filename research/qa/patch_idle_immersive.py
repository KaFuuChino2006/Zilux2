# -*- coding: utf-8 -*-
"""鼠标闲置 3 秒自动隐藏四周界面与 logo（沉浸模式），任意鼠标移动/按键恢复。"""
import io


def patch(path, pairs, label):
    s = io.open(path, 'r', encoding='utf-8', newline='').read()
    for name, old, new in pairs:
        assert s.count(old) == 1, f"anchor miss [{label}:{name}]: {old[:90]!r}"
        s = s.replace(old, new, 1)
    io.open(path, 'w', encoding='utf-8', newline='').write(s)
    print(f'patched {label}')


ss = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
css = r"E:\Zilux2开发\web\src\styles\space.css"

patch(ss, [
    (
        'enter start idle timer',
        """    likedViewOpen = true;
    setStatus('拖动旋转视角 · 滚轮滚动歌曲');
    void loadLikedTiles();""",
        """    likedViewOpen = true;
    setStatus('拖动旋转视角 · 滚轮滚动歌曲');
    void loadLikedTiles();
    wakeShellUi();""",
    ),
    (
        'leave reset idle',
        """  function leaveSpace(): void {
    if (!entered) return;
    likedViewOpen = false;""",
        """  function leaveSpace(): void {
    if (!entered) return;
    window.clearTimeout(idleTimer);
    root.classList.remove('is-idle');
    likedViewOpen = false;""",
    ),
    (
        'idle block',
        "  /* ------------------------------ 3D 歌词 ------------------------------ */",
        """  /* ------------------------------ 鼠标闲置自动隐藏界面 ------------------------------ */
  // 进入空间后鼠标闲置 3 秒：隐藏左右上下的界面、窗口按钮与 logo，获得沉浸体验；
  // 任意移动/点击/按键/滚轮即恢复。打开面板、搜索、模式菜单期间不隐藏。
  let idleTimer = 0;
  const IDLE_HIDE_MS = 3000;
  function idleUiShouldStay(): boolean {
    if (!entered) return true;
    const sheets = [customSheet, settingsSheet, librarySheet, accountSheet];
    for (const sheet of sheets) {
      if (sheet && !sheet.hidden && sheet.classList.contains('is-open')) return true;
    }
    if (searchBar.classList.contains('is-open')) return true;
    if (!lyricModePop.hidden) return true;
    return false;
  }
  function wakeShellUi(): void {
    root.classList.remove('is-idle');
    window.clearTimeout(idleTimer);
    if (!entered || disposed) return;
    idleTimer = window.setTimeout(() => {
      if (disposed || idleUiShouldStay()) return;
      root.classList.add('is-idle');
    }, IDLE_HIDE_MS);
  }
  const idleWake = (): void => {
    wakeShellUi();
  };
  document.addEventListener('pointermove', idleWake, { passive: true });
  document.addEventListener('pointerdown', idleWake, { capture: true });
  document.addEventListener('keydown', idleWake);
  document.addEventListener('wheel', idleWake, { passive: true });
  // 闲置状态下第一次点击只负责唤醒，不穿透到后面的磁贴/卡片
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!root.classList.contains('is-idle')) return;
      event.preventDefault();
      event.stopPropagation();
      wakeShellUi();
    },
    { capture: true },
  );

  /* ------------------------------ 3D 歌词 ------------------------------ */""",
    ),
    (
        'idletest qa',
        "  // QA：?pvtest=1 直接打开 PV 文字歌词（方便截图验收样式）",
        """  // QA：?idletest=1 直接进空间，验证闲置 3 秒后界面自动隐藏
  if (params.get('idletest') === '1') {
    window.setTimeout(() => {
      if (disposed) return;
      void enterSpace(true);
    }, 800);
  }

  // QA：?pvtest=1 直接打开 PV 文字歌词（方便截图验收样式）""",
    ),
], 'spaceShell')

s = io.open(css, 'r', encoding='utf-8', newline='').read()
s += """
/* 沉浸模式：鼠标闲置 3 秒隐藏四周界面与 logo */
.space-shell .space-brand,
.space-shell .space-rail,
.space-shell .space-searchbar,
.space-shell .space-discover,
.space-shell .space-back,
.space-shell .space-wctrl,
.space-shell .space-side,
.space-shell .space-page,
.space-shell .space-foot,
.space-shell .island-dock {
  transition: opacity 0.42s ease;
}
.space-shell.is-idle .space-brand,
.space-shell.is-idle .space-rail,
.space-shell.is-idle .space-searchbar,
.space-shell.is-idle .space-discover,
.space-shell.is-idle .space-back,
.space-shell.is-idle .space-wctrl,
.space-shell.is-idle .space-side,
.space-shell.is-idle .space-page,
.space-shell.is-idle .space-foot,
.space-shell.is-idle .island-dock {
  opacity: 0 !important;
  pointer-events: none !important;
}
.space-shell.is-idle {
  cursor: none;
}
"""
io.open(css, 'w', encoding='utf-8', newline='').write(s)
print('css idle immerse')
