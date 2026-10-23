# -*- coding: utf-8 -*-
"""一次性补丁：歌词字号移入自定义面板 + 右下角待播歌曲 + 顶部搜索尖角 + 自定义面板排版。"""
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
            print('MISS %s: %r' % (rel, old[:80]))
            sys.exit(1)
        count = text.count(old)
        if count != 1:
            print('DUP %s (%d): %r' % (rel, count, old[:80]))
            sys.exit(1)
        text = text.replace(old, new)
    with io.open(path, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(text)
    print('OK %s' % rel)


# ---------------- 1) settingsBoard: 删掉歌词字号这一行与 appearance 分组 ----------------
board_rows = """  {
    kind: 'segment',
    group: 'appearance',
    key: 'lyricsSize',
    label: '3D 歌词字号',
    desc: '歌词界面里的文字大小',
    options: [
      { value: 'small', label: '小' },
      { value: 'medium', label: '中' },
      { value: 'large', label: '大' },
    ],
  },
"""

edit('three/settingsBoard.ts', [
    ("  appearance: { lyricsSize: 'small' | 'medium' | 'large' };\n", ''),
    ("type GroupId = 'general' | 'appearance' | 'playback';", "type GroupId = 'general' | 'playback';"),
    (board_rows, ''),
    ("  { id: 'appearance', title: '外观' },\n", ''),
    ("    appearance: { lyricsSize: 'medium' },\n", ''),
    ("        appearance: { ...state.appearance },\n", ''),
    ("        appearance: { ...next.appearance },\n", ''),
])

# ---------------- 2) islandPlayer: 暴露下一首 ----------------
edit('ui/islandPlayer.ts', [
    (
        "  isTrackLive(): boolean;\n",
        "  isTrackLive(): boolean;\n  /** 按当前播放模式预计的下一首（没有下一首时为 null） */\n  peekNext(): OnlineTrack | null;\n",
    ),
    (
        """  function currentTrack(): OnlineTrack | null {
    if (index < 0 || index >= queue.length) return null;
    return queue[index] ?? null;
  }
""",
        """  function currentTrack(): OnlineTrack | null {
    if (index < 0 || index >= queue.length) return null;
    return queue[index] ?? null;
  }

  /** 按当前播放模式预计的下一首：顺序播到队尾之后就没有下一首了 */
  function peekNextTrack(): OnlineTrack | null {
    if (index < 0 || queue.length === 0) return null;
    if (mode === 'repeat') return queue[index] ?? null;
    if (mode === 'shuffle') {
      if (queue.length === 1) return queue[0] ?? null;
      let target = index;
      for (let i = 0; i < 8 && target === index; i += 1) target = Math.floor(Math.random() * queue.length);
      return queue[target] ?? null;
    }
    return queue[index + 1] ?? null;
  }
""",
    ),
    (
        """    currentTrack() {
      return currentTrack();
    },
""",
        """    currentTrack() {
      return currentTrack();
    },
    peekNext() {
      return peekNextTrack();
    },
""",
    ),
])

# ---------------- 3) spaceShell: 自定义面板插歌词字号 + 移除板内外观段 + 待播卡片 ----------------
lyrics_size_html = """            <div class="custom-collapse-body" data-lyrics-anim-body>
              <div class="custom-field">
                <div class="custom-label"><span>3D 歌词字号</span><b data-lyrics-size-current>中</b></div>
                <div class="custom-seg" data-lyrics-size-seg>
                  <button class="custom-seg-btn" data-lyrics-size="small" type="button">小</button>
                  <button class="custom-seg-btn is-on" data-lyrics-size="medium" type="button">中</button>
                  <button class="custom-seg-btn" data-lyrics-size="large" type="button">大</button>
                </div>
                <p class="custom-tip">3D 空间里歌词的字号，改完立即生效并保存</p>
              </div>
"""

upnext_js = """  root.appendChild(island.element);

  // 右下角「待播歌曲」：跟着灵动岛的播放队列，显示下一首
  const upNextDock = document.createElement('div');
  upNextDock.className = 'upnext-dock';
  upNextDock.hidden = true;
  upNextDock.innerHTML =
    '<span class="upnext-kicker">待播</span>' +
    '<img class="upnext-cover" data-upnext-cover alt="" />' +
    '<span class="upnext-meta"><strong data-upnext-title>—</strong><span data-upnext-artist></span></span>';
  root.appendChild(upNextDock);
  const upNextCover = upNextDock.querySelector<HTMLImageElement>('[data-upnext-cover]')!;
  const upNextTitle = upNextDock.querySelector<HTMLElement>('[data-upnext-title]')!;
  const upNextArtist = upNextDock.querySelector<HTMLElement>('[data-upnext-artist]')!;
  const refreshUpNext = (): void => {
    const current = island.currentTrack();
    const next = island.peekNext();
    if (!current || !next) {
      upNextDock.hidden = true;
      return;
    }
    upNextDock.hidden = false;
    upNextTitle.textContent = next.title;
    upNextArtist.textContent = next.artist;
    if (next.cover) {
      upNextCover.src = next.cover;
      upNextCover.hidden = false;
    } else {
      upNextCover.removeAttribute('src');
      upNextCover.hidden = true;
    }
  };
  // 播放模式/上一首/下一首按钮会改变“下一首是谁”，点完顺手刷一下
  island.element.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('[data-island-mode],[data-island-next],[data-island-prev]')) {
      window.setTimeout(refreshUpNext, 80);
    }
  });
  refreshUpNext();
"""

edit('ui/spaceShell.ts', [
    # 3.1 自定义面板 HTML：歌词动画 body 最前面放字号
    ('            <div class="custom-collapse-body" data-lyrics-anim-body>\n', lyrics_size_html),
    # 3.2 查询
    (
        "  const lyricColorCurrent = root.querySelector<HTMLElement>('[data-lyric-color-current]')!;\n",
        "  const lyricColorCurrent = root.querySelector<HTMLElement>('[data-lyric-color-current]')!;\n"
        "  const lyricsSizeBtns = root.querySelectorAll<HTMLButtonElement>('[data-lyrics-size]');\n"
        "  const lyricsSizeCurrent = root.querySelector<HTMLElement>('[data-lyrics-size-current]')!;\n",
    ),
    # 3.3 syncBoardSettings 去掉 appearance
    (
        """      appearance: {
        lyricsSize: settings.appearance.lyricsSize,
      },
""",
        '',
    ),
])

# 3.4 syncCustomUi 末尾同步歌词字号
edit('ui/spaceShell.ts', [
    (
        """    } else {
      customPreview.classList.remove('has-image');
      customPreview.style.backgroundImage = '';
      customPreview.innerHTML = '<span>未选择图片</span>';
    }
  };
""",
        """    } else {
      customPreview.classList.remove('has-image');
      customPreview.style.backgroundImage = '';
      customPreview.innerHTML = '<span>未选择图片</span>';
    }
    const lyricsSize = getSettings().appearance.lyricsSize;
    lyricsSizeBtns.forEach((button) => {
      button.classList.toggle('is-on', button.dataset.lyricsSize === lyricsSize);
    });
    lyricsSizeCurrent.textContent = lyricsSize === 'small' ? '小' : lyricsSize === 'large' ? '大' : '中';
  };
""",
    ),
    # 3.5 点击绑定（放在 lyricColorBtns 之后）
    (
        """  lyricColorBtns.forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.dataset.lyricColor;
      if (value === 'flow' || value === 'cover' || value === 'rhythm' || value === 'rainbow') custom.lyricColor = value;
      else custom.lyricColor = 'white';
      syncCustomUi();
      applyLyricColorSetting();
      persistCustom();
    });
  });
""",
        """  lyricColorBtns.forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.dataset.lyricColor;
      if (value === 'flow' || value === 'cover' || value === 'rhythm' || value === 'rainbow') custom.lyricColor = value;
      else custom.lyricColor = 'white';
      syncCustomUi();
      applyLyricColorSetting();
      persistCustom();
    });
  });
  lyricsSizeBtns.forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.dataset.lyricsSize;
      const size = value === 'small' || value === 'large' ? value : 'medium';
      patchSettings({ appearance: { lyricsSize: size } } as never);
      applySettingsToScene(getSettings());
      syncCustomUi();
      syncSettingsUi();
    });
  });
""",
    ),
    # 3.6 待播歌曲卡片（island 创建后）
    ("  root.appendChild(island.element);\n", upnext_js),
    # 3.7 onTrack / onStateChange 后刷新待播
    (
        """      lyricsTrackKey = '';
      if (lyricsOpen && track) void loadLyrics3d(track);
    },
""",
        """      lyricsTrackKey = '';
      if (lyricsOpen && track) void loadLyrics3d(track);
      refreshUpNext();
    },
""",
    ),
    (
        """      if (lyricsOpen) {
        const track = island.currentTrack();
        if (track) void loadLyrics3d(track);
      }
    },
  });
  root.appendChild(island.element);
""",
        """      if (lyricsOpen) {
        const track = island.currentTrack();
        if (track) void loadLyrics3d(track);
      }
      refreshUpNext();
    },
  });
  root.appendChild(island.element);
""",
    ),
])

# ---------------- 4) CSS：搜索尖角 + 自定义面板排版 + 待播卡片 ----------------
css_append = """
/* ---------- 顶部搜索/发现：内层轨道跟随外层胶囊圆角，修掉「两个尖角」 ---------- */
.space-searchbar,
.space-searchbar.is-open,
.space-discover,
.space-discover:hover,
.space-discover.is-open {
  border-radius: 999px;
  overflow: hidden;
}
.space-search-src,
.space-discover-src {
  border-radius: 999px;
  overflow: hidden;
}
.space-src-btn,
.space-src-btn.is-on,
.space-discover-item {
  border-radius: 999px;
}
.space-discover:hover .space-discover-body,
.space-discover.is-open .space-discover-body {
  max-width: 460px;
}

/* ---------- 自定义面板：统一节奏，别让选项挤成一坨 ---------- */
.custom-sheet .custom-body {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.custom-sheet .custom-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-bottom: 16px;
  border-bottom: 1px solid rgba(127, 127, 127, 0.16);
}
.custom-sheet .custom-section:last-of-type {
  border-bottom: 0;
  padding-bottom: 4px;
}
.custom-sheet .custom-section-head {
  margin-bottom: 2px;
}
.custom-sheet .custom-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.custom-sheet .custom-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.custom-sheet .custom-label {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.custom-sheet .custom-seg {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.custom-sheet .custom-seg-btn,
.custom-sheet .custom-btn {
  white-space: nowrap;
}
.custom-sheet .custom-slider {
  width: 100%;
}
.custom-sheet .custom-grid-pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.custom-sheet .custom-collapse-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* ---------- 右下角：待播歌曲 ---------- */
.upnext-dock {
  position: absolute;
  right: 26px;
  bottom: 26px;
  z-index: 7;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 300px;
  padding: 8px 14px 8px 10px;
  border-radius: 18px;
  border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.7));
  background: var(--glass, rgba(255, 255, 255, 0.62));
  backdrop-filter: blur(18px) saturate(150%);
  color: var(--ink, #171a21);
  box-shadow: 0 10px 28px rgba(23, 26, 33, 0.12);
  pointer-events: none;
}
.upnext-dock[hidden] {
  display: none;
}
.upnext-kicker {
  font-size: 11px;
  letter-spacing: 0.12em;
  opacity: 0.55;
  flex: none;
}
.upnext-cover {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  object-fit: cover;
  background: rgba(0, 0, 0, 0.12);
  flex: none;
}
.upnext-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.upnext-meta strong {
  font-size: 12.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.upnext-meta span {
  font-size: 11px;
  opacity: 0.6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
"""

css_path = os.path.join(ROOT, 'styles/space.css')
with io.open(css_path, 'r', encoding='utf-8') as fh:
    css = fh.read()
if '.upnext-dock {' not in css:
    css = css.rstrip('\n') + '\n' + css_append
    with io.open(css_path, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(css)
    print('OK styles/space.css')
else:
    print('SKIP styles/space.css (already patched)')
