"""播放条：词按钮进出歌词、音量图标优化（含静音态）、滚轮调音量。"""
import io

APP = r'E:\Zilux2开发\web\src\ui\app.ts'
DOM = r'E:\Zilux2开发\web\src\ui\dom.ts'
CSS = r'E:\Zilux2开发\web\src\styles\app.css'


def patch(path, steps):
    text = io.open(path, 'r', encoding='utf-8', newline='').read()
    eol = '\r\n' if '\r\n' in text else '\n'
    for label, old, new in steps:
        old = old.replace('\n', eol)
        new = new.replace('\n', eol)
        count = text.count(old)
        assert count == 1, f'{path} / {label}: found {count}'
        text = text.replace(old, new)
        print(f'ok {label}')
    io.open(path, 'w', encoding='utf-8', newline='').write(text)


# 1) 图标：静音态
patch(DOM, [
    (
        'muted icon',
        "  volume:\n",
        "  volumeMuted:\n"
        "    '<path d=\"M4 9.5h3.2L12 6v12l-4.8-3.5H4z\" fill=\"currentColor\" stroke=\"none\"/><path d=\"M15.2 9.6l4.2 4.8M19.4 9.6l-4.2 4.8\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\"/>',\n"
        "  volume:\n",
    ),
])

# 2) app.ts
patch(APP, [
    (
        'volume icon field',
        '  private volumeInput!: HTMLInputElement;\n',
        '  private volumeInput!: HTMLInputElement;\n  private volumeIcon!: HTMLSpanElement;\n',
    ),
    (
        'lyrics toggle',
        """    lyricsBtn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openLyrics();
    });
""",
        """    lyricsBtn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      // 「词」按钮和封面一样：已经打开歌词就退出
      if (this.lyrics) this.closeLyrics();
      else this.openLyrics();
    });
""",
    ),
    (
        'volume ui',
        """    this.volumeInput = h('input', { class: 'slider', type: 'range', min: '0', max: '100', step: '1', value: String(Math.round(getSettings().playback.volume * 100)) });
    this.volumeInput.style.width = '78px';
    this.volumeInput.addEventListener('input', () => {
      const value = Number(this.volumeInput.value) / 100;
      setVolume(value);
      patchSettings({ playback: { volume: value } });
    });
""",
        """    this.volumeInput = h('input', { class: 'slider', type: 'range', min: '0', max: '100', step: '1', value: String(Math.round(getSettings().playback.volume * 100)) });
    this.volumeInput.style.width = '78px';
    this.volumeInput.addEventListener('input', () => {
      this.applyVolumeValue(Number(this.volumeInput.value));
    });
    this.volumeIcon = h('span', { class: 'volume-icon' }, icon('volume', 16));
    const volumeWrap = h('div', { class: 'volume-wrap', title: '滚轮调节音量' }, this.volumeIcon, this.volumeInput);
    // 在音量条区域直接滚滚轮调音量（上下 4%）
    volumeWrap.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const step = event.deltaY < 0 ? 4 : -4;
        this.applyVolumeValue(Number(this.volumeInput.value) + step);
      },
      { passive: false },
    );
""",
    ),
    (
        'volume wrap usage',
        "        h('div', { class: 'volume-wrap' }, icon('volume', 16), this.volumeInput),",
        '        volumeWrap,',
    ),
    (
        'applyVolumeValue method',
        """  private paintModeBtn(mode: PlayerState['mode']): void {""",
        """  /** 统一设置音量：滑条 / 滚轮 / 快捷面板都走这里。 */
  private applyVolumeValue(raw: number): void {
    const percent = Math.min(100, Math.max(0, Math.round(raw)));
    this.volumeInput.value = String(percent);
    const value = percent / 100;
    setVolume(value);
    patchSettings({ playback: { volume: value } });
    this.paintVolumeIcon(percent);
  }

  private paintVolumeIcon(percent: number): void {
    if (!this.volumeIcon) return;
    const muted = percent <= 0;
    this.volumeIcon.textContent = '';
    this.volumeIcon.append(icon(muted ? 'volumeMuted' : 'volume', 16));
    this.volumeIcon.classList.toggle('is-muted', muted);
    const wrap = this.volumeIcon.parentElement;
    if (wrap) wrap.title = muted ? '已静音 · 滚轮调节音量' : `音量 ${percent}% · 滚轮调节`;
  }

  private paintModeBtn(mode: PlayerState['mode']): void {""",
    ),
    (
        'sync volume icon',
        "    this.volumeInput.value = String(Math.round(settings.playback.volume * 100));",
        "    this.volumeInput.value = String(Math.round(settings.playback.volume * 100));\n    this.paintVolumeIcon(Math.round(settings.playback.volume * 100));",
    ),
])

# 3) CSS
css = io.open(CSS, 'r', encoding='utf-8', newline='').read()
ceol = '\r\n' if '\r\n' in css else '\n'
block = """
/* 播放条音量：图标状态 + 滚轮提示 */
.playerbar .volume-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  transition: color 0.2s var(--ease);
}
.playerbar .volume-icon.is-muted {
  color: var(--danger);
}
.playerbar .volume-wrap {
  cursor: ns-resize;
}
.playerbar .volume-wrap:hover .volume-icon {
  color: var(--text);
}
"""
css += block.replace('\n', ceol)
io.open(CSS, 'w', encoding='utf-8', newline='').write(css)
print('ok css')
