# -*- coding: utf-8 -*-
"""PV 歌词模式 step2：状态/加载/进入退出/长按菜单/QA。"""
import io


def patch(path, pairs, label):
    s = io.open(path, 'r', encoding='utf-8', newline='').read()
    for old, new, name in pairs:
        assert s.count(old) == 1, f"anchor miss [{label}:{name}]: {old[:100]!r}"
        s = s.replace(old, new, 1)
    io.open(path, 'w', encoding='utf-8', newline='').write(s)
    print('patched', label)


UI = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"

patch(
    UI,
    [
        # 1) custom 增加 lyricMode
        (
            """    wordsWrite: false,
  };""",
            """    wordsWrite: false,
    lyricMode: 'stage' as 'stage' | 'pv',
  };""",
            "default lyricMode",
        ),
        (
            """        wordsWrite?: unknown;
      };""",
            """        wordsWrite?: unknown;
        lyricMode?: unknown;
      };""",
            "parse type",
        ),
        # 2) loadCustom 返回 lyricMode
        (
            """        wordsWrite: parsed.wordsWrite === true || parsed.wordsWrite === 'on',""",
            """        wordsWrite: parsed.wordsWrite === true || parsed.wordsWrite === 'on',
        lyricMode: parsed.lyricMode === 'pv' ? 'pv' : 'stage',""",
            "load lyricMode",
        ),
        # 3) 歌词加载：同时喂 PV 层（PV 使用行开始时间）
        (
            """      space?.setLyrics(lines);
      if (lines.length === 0) showToast('这首歌暂时没有歌词', 'info');""",
            """      space?.setLyrics(lines);
      pvLyrics.setLines(
        lines.map((line, index) => ({
          text: line.text,
          translation: line.translation,
          start: line.startTime,
          end: lines[index + 1]?.startTime ?? line.startTime + 4,
        })),
      );
      if (lines.length === 0) showToast('这首歌暂时没有歌词', 'info');""",
            "pv feed",
        ),
        # 4) 时钟：PV 模式驱动 PV 层
        (
            """  function stepLyricsClock(): void {
    if (!lyricsOpen) return;
    space?.setLyricsTime(island.currentTime());
    lyricsTimer = window.requestAnimationFrame(stepLyricsClock);
  }""",
            """  function stepLyricsClock(): void {
    if (!lyricsOpen) return;
    if (lyricMode === 'pv') {
      pvLyrics.setTime(island.currentTime());
    } else {
      space?.setLyricsTime(island.currentTime());
    }
    lyricsTimer = window.requestAnimationFrame(stepLyricsClock);
  }""",
            "pv clock",
        ),
        # 5) 进入歌词：按模式分支
        (
            """  async function enterLyricsView(): Promise<void> {
    const track = island.currentTrack();
    if (!track) {
      showToast('先放一首歌，再看歌词', 'info');
      return;
    }
    lyricsOpen = true;
    lyricsBtn.classList.add('is-on');
    lyricsBtn.title = '退出歌词';
    lyricsBtn.setAttribute('aria-label', '退出歌词');
    lyricsDim.classList.add('is-on');
    space?.unfocusTile();
    space?.setLyricsView(true);
    space?.setLyricsTime(island.currentTime());
    space?.setTilesScattered(true);
    void loadLyrics3d(track);
    window.cancelAnimationFrame(lyricsTimer);
    stepLyricsClock();
    setStatus('歌词模式 · 点「返回」或按 Esc 回到封面墙');
  }""",
            """  async function enterLyricsView(): Promise<void> {
    const track = island.currentTrack();
    if (!track) {
      showToast('先放一首歌，再看歌词', 'info');
      return;
    }
    lyricsOpen = true;
    lyricsBtn.classList.add('is-on');
    lyricsBtn.title = '退出歌词';
    lyricsBtn.setAttribute('aria-label', '退出歌词');
    space?.unfocusTile();
    await loadLyrics3d(track);
    if (lyricMode === 'pv') {
      // PV 模式：隐藏磁贴封面，只留柔和文字 PV（回退时磁贴再回来）
      space?.setLyricsView(false);
      space?.setTilesVisible(false);
      pvLyrics.show();
      setStatus('PV 歌词模式 · 点「返回」或按 Esc 回到封面墙');
    } else {
      lyricsDim.classList.add('is-on');
      space?.setLyricsView(true);
      space?.setLyricsTime(island.currentTime());
      space?.setTilesScattered(true);
      setStatus('歌词模式 · 点「返回」或按 Esc 回到封面墙');
    }
    window.cancelAnimationFrame(lyricsTimer);
    stepLyricsClock();
  }""",
            "enter branch",
        ),
        # 6) 退出：PV 恢复磁贴
        (
            """    space?.setLyricsView(false);
    space?.setTilesScattered(false);
    lyricsBtn.classList.remove('is-on');""",
            """    space?.setLyricsView(false);
    space?.setTilesScattered(false);
    pvLyrics.hide();
    space?.setTilesVisible(true);
    lyricsBtn.classList.remove('is-on');""",
            "exit pv",
        ),
        # 7) 长按歌词按钮选择模式（短按=切换歌词）
        (
            """  lyricsBtn.addEventListener('click', () => {
    if (lyricsOpen) exitLyricsView();
    else void enterLyricsView();
  });""",
            """  let lyricsLongPressTimer = 0;
  let lyricsLongPressed = false;
  lyricsBtn.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    lyricsLongPressed = false;
    window.clearTimeout(lyricsLongPressTimer);
    lyricsLongPressTimer = window.setTimeout(() => {
      lyricsLongPressed = true;
      openLyricModePop();
    }, 560);
  });
  const cancelLyricLongPress = (): void => {
    window.clearTimeout(lyricsLongPressTimer);
    lyricsLongPressTimer = 0;
  };
  lyricsBtn.addEventListener('pointerup', cancelLyricLongPress);
  lyricsBtn.addEventListener('pointerleave', cancelLyricLongPress);
  lyricsBtn.addEventListener('pointercancel', cancelLyricLongPress);
  lyricsBtn.addEventListener('click', () => {
    if (lyricsLongPressed) {
      lyricsLongPressed = false;
      return;
    }
    if (lyricsOpen) exitLyricsView();
    else void enterLyricsView();
  });""",
            "long press",
        ),
        # 8) QA：?lyricmode=pv 强制模式
        (
            """  syncCustomUi();

  /* 把两个平台「我创建的」歌单放到 6 片小玻璃里（上排网易云、下排 QQ） */""",
            """  if (params.get('lyricmode') === 'pv') {
    lyricMode = 'pv';
    custom.lyricMode = 'pv';
  } else if (params.get('lyricmode') === 'stage') {
    lyricMode = 'stage';
    custom.lyricMode = 'stage';
  }
  syncCustomUi();

  /* 把两个平台「我创建的」歌单放到 6 片小玻璃里（上排网易云、下排 QQ） */""",
            "qa lyricmode",
        ),
    ],
    'spaceShell step2',
)
print('step2 done')
