# -*- coding: utf-8 -*-
"""新增设置项：闲置自动进入 3D 歌词界面，鼠标一动回磁贴。"""
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


# ---------- settings.ts ----------
edit('settings.ts', [
    (
        "    lyricsAutoOpen: boolean;\n",
        "    lyricsAutoOpen: boolean;\n"
        "    /** 空间里闲置（约 3 秒没动鼠标）且正在播放时，自动切到 3D 歌词界面，鼠标一动回磁贴 */\n"
        "    idleLyrics: boolean;\n",
    ),
    (
        "    lyricsAutoOpen: true,\n",
        "    lyricsAutoOpen: true,\n    idleLyrics: true,\n",
    ),
    (
        "      lyricsAutoOpen: asBool(playback.lyricsAutoOpen, DEFAULT_SETTINGS.playback.lyricsAutoOpen),\n",
        "      lyricsAutoOpen: asBool(playback.lyricsAutoOpen, DEFAULT_SETTINGS.playback.lyricsAutoOpen),\n"
        "      idleLyrics: asBool(playback.idleLyrics, DEFAULT_SETTINGS.playback.idleLyrics),\n",
    ),
])

# ---------- settingsBoard.ts ----------
edit('three/settingsBoard.ts', [
    (
        "  playback: { defaultSource: 'netease' | 'qq'; searchLimit: number; volume: number };\n",
        "  playback: {\n"
        "    defaultSource: 'netease' | 'qq';\n"
        "    searchLimit: number;\n"
        "    volume: number;\n"
        "    idleLyrics: boolean;\n"
        "  };\n",
    ),
    (
        "  {\n    kind: 'segment',\n    group: 'playback',\n    key: 'defaultSource',\n",
        "  {\n"
        "    kind: 'toggle',\n"
        "    group: 'playback',\n"
        "    key: 'idleLyrics',\n"
        "    label: '闲置自动歌词',\n"
        "    desc: '闲置时正在播放就进入歌词，鼠标一动回磁贴',\n"
        "  },\n"
        "  {\n    kind: 'segment',\n    group: 'playback',\n    key: 'defaultSource',\n",
    ),
    (
        "    playback: { defaultSource: 'netease', searchLimit: 20, volume: 0.72 },\n",
        "    playback: { defaultSource: 'netease', searchLimit: 20, volume: 0.72, idleLyrics: true },\n",
    ),
])

# ---------- spaceShell.ts ----------
edit('ui/spaceShell.ts', [
    (
        "        searchLimit: settings.playback.searchLimit,\n        volume: settings.playback.volume,\n",
        "        searchLimit: settings.playback.searchLimit,\n"
        "        volume: settings.playback.volume,\n"
        "        idleLyrics: settings.playback.idleLyrics,\n",
    ),
    (
        """  function wakeShellUi(): void {
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
""",
        """  // 闲置时如果正在播放歌，就自动进 3D 歌词界面；鼠标一动立刻回磁贴
  let idleLyricsEntered = false;
  function maybeAutoLyrics(): void {
    if (!entered || disposed || lyricsOpen) return;
    if (!getSettings().playback.idleLyrics) return;
    if (!mediaPlaying || !island.currentTrack()) return;
    idleLyricsEntered = true;
    void enterLyricsView();
  }
  function wakeShellUi(): void {
    root.classList.remove('is-idle');
    window.clearTimeout(idleTimer);
    if (!entered || disposed) return;
    idleTimer = window.setTimeout(() => {
      if (disposed || idleUiShouldStay()) return;
      root.classList.add('is-idle');
      maybeAutoLyrics();
    }, IDLE_HIDE_MS);
  }
  const idleWake = (): void => {
    if (idleLyricsEntered) {
      idleLyricsEntered = false;
      if (lyricsOpen) exitLyricsView();
    }
    wakeShellUi();
  };
""",
    ),
])
