# -*- coding: utf-8 -*-
"""给空间外观面板加「键盘快捷键」设置：可改键、持久化、并驱动播放控制。"""
import io
import sys

ROOT = r"E:\Zilux2开发"
SHELL = ROOT + r"\web\src\ui\spaceShell.ts"
CSS = ROOT + r"\web\src\styles\space.css"


def read(path):
    with io.open(path, "r", encoding="utf-8") as f:
        return f.read()


def write(path, text):
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def rep(text, old, new, label):
    if text.count(old) != 1:
        print("FAIL [%s] count=%d" % (label, text.count(old)))
        sys.exit(1)
    print("OK [%s]" % label)
    return text.replace(old, new, 1)


src = read(SHELL)

# 1) 外观面板里插入「快捷键」一节（放在歌词动画节之前）
html_anchor = '          <section class="custom-section custom-collapse" data-lyrics-anim>'
html_new = '''          <section class="custom-section">
            <header class="custom-section-head">
              <span class="custom-kicker">快捷键</span>
              <div>
                <h3>键盘快捷键</h3>
                <p>点键位后直接按新键即可修改；系统媒体键（播放/上一首/下一首）始终可用</p>
              </div>
            </header>
            <div class="custom-hotkeys">
              <div class="custom-hotkey-row"><strong>播放 / 暂停</strong><button class="custom-hotkey-btn" data-hotkey="toggle" type="button">Space</button></div>
              <div class="custom-hotkey-row"><strong>下一首</strong><button class="custom-hotkey-btn" data-hotkey="next" type="button">Ctrl + \u2192</button></div>
              <div class="custom-hotkey-row"><strong>上一首</strong><button class="custom-hotkey-btn" data-hotkey="prev" type="button">Ctrl + \u2190</button></div>
              <div class="custom-hotkey-row"><strong>音量 +</strong><button class="custom-hotkey-btn" data-hotkey="volup" type="button">Ctrl + \u2191</button></div>
              <div class="custom-hotkey-row"><strong>音量 \u2212</strong><button class="custom-hotkey-btn" data-hotkey="voldown" type="button">Ctrl + \u2193</button></div>
              <div class="custom-hotkey-row"><strong>喜欢当前歌曲</strong><button class="custom-hotkey-btn" data-hotkey="like" type="button">L</button></div>
              <div class="custom-hotkey-row"><strong>歌词模式</strong><button class="custom-hotkey-btn" data-hotkey="lyrics" type="button">C</button></div>
              <div class="custom-hotkey-row"><strong>外观面板</strong><button class="custom-hotkey-btn" data-hotkey="settings" type="button">O</button></div>
            </div>
            <button class="custom-hotkey-reset" data-hotkeys-reset type="button">恢复默认快捷键</button>
          </section>
'''
src = rep(src, html_anchor, html_new + html_anchor, "html.section")

# 2) 查询 / 组合键工具 / 改键监听
q_anchor = "  const STAR_COLOR_LABEL: Record<string, string> = { purple: '\u7d2b', cover: '\u5c01\u9762\u8272', custom: '\u81ea\u5b9a\u4e49' };\n"
q_new = q_anchor + '''  const hotkeyBtns = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-hotkey]'));
  const hotkeysReset = root.querySelector<HTMLButtonElement>('[data-hotkeys-reset]');
  const HOTKEY_DEFAULT: Record<string, string> = {
    toggle: 'Space',
    next: 'Ctrl+ArrowRight',
    prev: 'Ctrl+ArrowLeft',
    volup: 'Ctrl+ArrowUp',
    voldown: 'Ctrl+ArrowDown',
    like: 'KeyL',
    lyrics: 'KeyC',
    settings: 'KeyO',
  };
  const HOTKEY_SYMBOL: Record<string, string> = {
    Space: 'Space',
    ArrowLeft: '\u2190',
    ArrowRight: '\u2192',
    ArrowUp: '\u2191',
    ArrowDown: '\u2193',
    Escape: 'Esc',
    Enter: 'Enter',
    Backspace: 'Backspace',
    Tab: 'Tab',
    Comma: ',',
    Period: '.',
    Slash: '/',
    Semicolon: ';',
    Quote: "'",
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\\\',
    Minus: '-',
    Equal: '=',
  };
  const isModifierKey = (event: KeyboardEvent): boolean =>
    event.key === 'Control' || event.key === 'Shift' || event.key === 'Alt' || event.key === 'Meta' || event.key === 'CapsLock';
  const comboOf = (event: KeyboardEvent): string => {
    const parts: string[] = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Meta');
    if (isModifierKey(event)) return parts.join('+');
    parts.push(event.code || event.key);
    return parts.join('+');
  };
  const formatHotkey = (combo: string): string => {
    if (!combo) return '\u672a\u8bbe\u7f6e';
    return combo
      .split('+')
      .map((part) => {
        if (HOTKEY_SYMBOL[part]) return HOTKEY_SYMBOL[part];
        if (/^Key[A-Z]$/.test(part)) return part.slice(3);
        if (/^Digit[0-9]$/.test(part)) return part.slice(5);
        if (/^Numpad[0-9]$/.test(part)) return `\u5c0f\u952e\u76d8 ${part.slice(6)}`;
        return part;
      })
      .join(' + ');
  };
  let hotkeyCapture: string | null = null;
  const syncHotkeysUi = (): void => {
    hotkeyBtns.forEach((btn) => {
      const action = btn.dataset.hotkey ?? '';
      const capturing = hotkeyCapture === action;
      btn.classList.toggle('is-capturing', capturing);
      btn.textContent = capturing ? '\u6309\u4e0b\u65b0\u6309\u952e\u2026' : formatHotkey(custom.hotkeys[action] ?? '');
    });
  };
  hotkeyBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.hotkey ?? '';
      hotkeyCapture = hotkeyCapture === action ? null : action;
      syncHotkeysUi();
    });
  });
  hotkeysReset?.addEventListener('click', () => {
    hotkeyCapture = null;
    custom.hotkeys = { ...HOTKEY_DEFAULT };
    persistCustom();
    syncHotkeysUi();
    setStatus('\u5df2\u6062\u590d\u9ed8\u8ba4\u5feb\u6377\u952e');
  });
'''
src = rep(src, q_anchor, q_new, "queries.hotkeys")

# 3) DEFAULT_CUSTOM 增加 hotkeys
def_anchor = "    lyricFont: '',\n  };\n  const loadCustom = (): typeof DEFAULT_CUSTOM => {"
def_new = '''    lyricFont: '',
    hotkeys: {
      toggle: 'Space',
      next: 'Ctrl+ArrowRight',
      prev: 'Ctrl+ArrowLeft',
      volup: 'Ctrl+ArrowUp',
      voldown: 'Ctrl+ArrowDown',
      like: 'KeyL',
      lyrics: 'KeyC',
      settings: 'KeyO',
    } as Record<string, string>,
  };
  const loadCustom = (): typeof DEFAULT_CUSTOM => {'''
src = rep(src, def_anchor, def_new, "defaults.hotkeys")

# 4) loadCustom 解析 hotkeys
lc_anchor = "        lyricFont: typeof parsed.lyricFont === 'string' ? parsed.lyricFont.slice(0, 80) : '',\n      };"
lc_new = '''        lyricFont: typeof parsed.lyricFont === 'string' ? parsed.lyricFont.slice(0, 80) : '',
        hotkeys: (() => {
          const out: Record<string, string> = { ...DEFAULT_CUSTOM.hotkeys };
          const raw = (parsed as { hotkeys?: unknown }).hotkeys;
          if (raw && typeof raw === 'object') {
            Object.entries(raw as Record<string, unknown>).forEach(([action, combo]) => {
              if (action in out && typeof combo === 'string' && combo.length <= 64) out[action] = combo;
            });
          }
          return out;
        })(),
      };'''
src = rep(src, lc_anchor, lc_new, "loadCustom.hotkeys")

# 5) syncCustomUi 里同步快捷键按钮
sc_anchor = "  const syncCustomUi = (): void => {\n"
sc_new = sc_anchor + "    syncHotkeysUi();\n"
src = rep(src, sc_anchor, sc_new, "syncCustomUi.hotkeys")

# 6) 快捷键动作 + 在 onKeyDown 顶部接入捕获与分发
kd_anchor = "  const onKeyDown = (event: KeyboardEvent): void => {\n"
kd_new = '''  const runHotkeyAction = (action: string): boolean => {
    switch (action) {
      case 'toggle':
        if (!island.currentTrack()) return false;
        island.toggle();
        return true;
      case 'next':
        island.next();
        return true;
      case 'prev':
        island.prev();
        return true;
      case 'volup':
      case 'voldown': {
        const current = getSettings().playback.volume;
        const next = Math.min(1, Math.max(0, current + (action === 'volup' ? 0.05 : -0.05)));
        island.setVolume(next);
        patchSettings({ playback: { volume: next } });
        setStatus(`\u97f3\u91cf ${Math.round(next * 100)}%`);
        return true;
      }
      case 'like':
        void likeCurrentTrack();
        return true;
      case 'lyrics':
        if (lyricsOpen) exitLyricsView();
        else void enterLyricsView();
        return true;
      case 'settings':
        if (!customSheet.hidden && customSheet.classList.contains('is-open')) closeCustomSheet();
        else openCustomSheet();
        return true;
      default:
        return false;
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const combo = comboOf(event);
    if (hotkeyCapture) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        hotkeyCapture = null;
        syncHotkeysUi();
        return;
      }
      if (isModifierKey(event) || !combo) return;
      const action = hotkeyCapture;
      hotkeyCapture = null;
      Object.keys(custom.hotkeys).forEach((key) => {
        if (key !== action && custom.hotkeys[key] === combo) custom.hotkeys[key] = '';
      });
      custom.hotkeys[action] = combo;
      persistCustom();
      syncHotkeysUi();
      setStatus(`\u5feb\u6377\u952e\u5df2\u8bbe\u4e3a ${formatHotkey(combo)}`);
      return;
    }
    if (!event.repeat) {
      const target = event.target as HTMLElement | null;
      const typing = !!target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      if (!typing) {
        const matched = Object.keys(custom.hotkeys).find((key) => custom.hotkeys[key] === combo);
        if (matched && runHotkeyAction(matched)) {
          event.preventDefault();
          return;
        }
      }
    }
'''
src = rep(src, kd_anchor, kd_new, "onKeyDown.hotkeys")

write(SHELL, src)

# 7) CSS 追加
css = read(CSS)
css_new = css.rstrip("\n") + '''

/* ------------------------- 外观面板：键盘快捷键 ------------------------- */
.custom-hotkeys {
  display: grid;
  gap: 6px;
}
.custom-hotkey-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 5px 9px;
  border-radius: 9px;
  background: rgba(20, 24, 33, 0.045);
}
.custom-hotkey-row strong {
  font-size: 12px;
  font-weight: 600;
  color: #2a2f3c;
}
.custom-hotkey-btn {
  min-width: 104px;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid rgba(42, 47, 60, 0.16);
  background: #ffffff;
  color: #2a2f3c;
  font: 600 11px/1.4 inherit;
  cursor: pointer;
  transition: border-color 0.18s ease, background 0.18s ease, color 0.18s ease;
}
.custom-hotkey-btn:hover {
  border-color: rgba(42, 47, 60, 0.34);
}
.custom-hotkey-btn.is-capturing {
  border-color: rgba(42, 47, 60, 0.5);
  background: #2a2f3c;
  color: #fff;
  animation: custom-hotkey-pulse 1.1s ease-in-out infinite;
}
@keyframes custom-hotkey-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(42, 47, 60, 0.25); }
  50% { box-shadow: 0 0 0 4px rgba(42, 47, 60, 0.12); }
}
.custom-hotkey-reset {
  margin-top: 8px;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px dashed rgba(42, 47, 60, 0.28);
  background: transparent;
  color: #4a5060;
  font: 600 11px/1.4 inherit;
  cursor: pointer;
}
.custom-hotkey-reset:hover {
  color: #2a2f3c;
  border-color: rgba(42, 47, 60, 0.5);
}
.space-shell.theme-gold .custom-hotkey-row {
  background: rgba(255, 255, 255, 0.035) !important;
}
.space-shell.theme-gold .custom-hotkey-row strong {
  color: #f0e3c2 !important;
}
.space-shell.theme-gold .custom-hotkey-btn {
  background: rgba(28, 24, 16, 0.9) !important;
  border-color: rgba(212, 175, 55, 0.28) !important;
  color: #f2e6c8 !important;
}
.space-shell.theme-gold .custom-hotkey-btn:hover {
  border-color: rgba(216, 182, 74, 0.6) !important;
}
.space-shell.theme-gold .custom-hotkey-btn.is-capturing {
  background: rgba(216, 182, 74, 0.92) !important;
  border-color: rgba(216, 182, 74, 0.92) !important;
  color: #1b1710 !important;
  animation: custom-hotkey-pulse-gold 1.1s ease-in-out infinite;
}
@keyframes custom-hotkey-pulse-gold {
  0%, 100% { box-shadow: 0 0 0 0 rgba(216, 182, 74, 0.3); }
  50% { box-shadow: 0 0 0 4px rgba(216, 182, 74, 0.16); }
}
.space-shell.theme-gold .custom-hotkey-reset {
  border-color: rgba(212, 175, 55, 0.3) !important;
  color: #d8cbb0 !important;
}
.space-shell.theme-gold .custom-hotkey-reset:hover {
  color: #f6ecd2 !important;
  border-color: rgba(216, 182, 74, 0.6) !important;
}
'''
write(CSS, css_new)
print("CSS appended")
print("DONE")
