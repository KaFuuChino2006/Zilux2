# -*- coding: utf-8 -*-
"""设置面板：把 settings store（宿主持久化）接到 3D 空间 UI。"""
import io

p = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
s = io.open(p, "r", encoding="utf-8", newline="").read()

# 1) import settings store
old = "import { fetchLibraryOverview, fetchPlaylist, libraryReady, type MusicSource } from '../library';"
new = old + "\nimport {\n  getSettings,\n  onSettingsChange,\n  patchSettings,\n  resetSettings,\n  type Settings,\n} from '../settings';"
assert s.count(old) == 1, "import"
s = s.replace(old, new, 1)

# 2) template: settings sheet before custom sheet
markup = '''    <div class="settings-sheet" data-settings-sheet hidden>
      <div class="settings-sheet-backdrop" data-settings-close></div>
      <div class="settings-sheet-card" role="dialog" aria-modal="true" aria-label="设置">
        <header class="settings-sheet-head">
          <div>
            <h2>设置</h2>
            <p>修改自动保存到本机，下次启动继续生效</p>
          </div>
          <button class="settings-sheet-close" data-settings-close type="button" aria-label="关闭">${WIN_CLOSE}</button>
        </header>
        <div class="settings-body">
          <section class="settings-section">
            <header><span class="settings-kicker">通用</span></header>
            <div class="settings-row">
              <div class="settings-row-text"><strong>启动动画</strong><span>打开软件时先播放粒子启动画面</span></div>
              <button class="settings-switch" data-setting-toggle="general.splash" type="button" role="switch" aria-checked="true"><i></i></button>
            </div>
            <div class="settings-row">
              <div class="settings-row-text"><strong>启动时最大化</strong><span>下次启动窗口直接铺满屏幕</span></div>
              <button class="settings-switch" data-setting-toggle="general.startMaximized" type="button" role="switch" aria-checked="false"><i></i></button>
            </div>
          </section>
          <section class="settings-section">
            <header><span class="settings-kicker">外观</span></header>
            <div class="settings-row">
              <div class="settings-row-text"><strong>减少动态效果</strong><span>收敛磁贴漂浮与过渡动画</span></div>
              <button class="settings-switch" data-setting-toggle="appearance.reduceMotion" type="button" role="switch" aria-checked="false"><i></i></button>
            </div>
            <div class="settings-row">
              <div class="settings-row-text"><strong>空间光晕</strong><span>背景与标题栏的彩色氛围光</span></div>
              <button class="settings-switch" data-setting-toggle="appearance.glow" type="button" role="switch" aria-checked="true"><i></i></button>
            </div>
            <div class="settings-row">
              <div class="settings-row-text"><strong>3D 歌词字号</strong><span>歌词界面里的文字大小</span></div>
              <div class="settings-seg" data-setting-seg="appearance.lyricsSize">
                <button data-seg-value="small" type="button">小</button>
                <button data-seg-value="medium" type="button">中</button>
                <button data-seg-value="large" type="button">大</button>
              </div>
            </div>
          </section>
          <section class="settings-section">
            <header><span class="settings-kicker">播放</span></header>
            <div class="settings-row">
              <div class="settings-row-text"><strong>默认音源</strong><span>搜索默认使用的平台</span></div>
              <div class="settings-seg" data-setting-seg="playback.defaultSource">
                <button data-seg-value="netease" type="button">网易云</button>
                <button data-seg-value="qq" type="button">QQ 音乐</button>
              </div>
            </div>
            <div class="settings-row">
              <div class="settings-row-text"><strong>搜索结果条数</strong><span>每次搜索返回的歌曲数量</span></div>
              <div class="settings-seg" data-setting-seg="playback.searchLimit">
                <button data-seg-value="10" type="button">10</button>
                <button data-seg-value="20" type="button">20</button>
                <button data-seg-value="30" type="button">30</button>
              </div>
            </div>
            <div class="settings-row">
              <div class="settings-row-text"><strong>播放音量</strong><span>播放器初始音量</span></div>
              <input class="settings-range" data-setting-range="playback.volume" type="range" min="0" max="100" step="1" value="72" aria-label="播放音量" />
            </div>
          </section>
        </div>
        <footer class="settings-foot">
          <button class="settings-reset" data-settings-reset type="button">恢复默认</button>
          <span>修改自动保存到本机</span>
        </footer>
      </div>
    </div>
'''
anchor = '    <div class="custom-sheet" data-custom-sheet hidden>'
assert s.count(anchor) == 1, "template"
s = s.replace(anchor, markup + anchor, 1)

# 3) refs + logic block after customOpenBtn ref
old = "  const customOpenBtn = root.querySelector<HTMLButtonElement>('[data-custom]')!;"
new = old + r'''
  const settingsSheet = root.querySelector<HTMLElement>('[data-settings-sheet]')!;
  const settingToggles = Array.from(
    root.querySelectorAll<HTMLButtonElement>('[data-setting-toggle]'),
  );
  const settingSegs = Array.from(root.querySelectorAll<HTMLElement>('[data-setting-seg]'));
  const settingVolume = root.querySelector<HTMLInputElement>('[data-setting-range="playback.volume"]')!;
  const settingsResetBtn = root.querySelector<HTMLButtonElement>('[data-settings-reset]')!;

  const readSetting = (path: string): unknown => {
    const [group, key] = path.split('.') as [keyof Settings, string];
    const bag = getSettings()[group] as unknown as Record<string, unknown>;
    return bag?.[key];
  };
  const sceneLyricsScale = (size: string): number =>
    size === 'small' ? 0.88 : size === 'large' ? 1.16 : 1;

  const applySettingsToScene = (next: Settings): void => {
    space?.setReducedMotion(next.appearance.reduceMotion);
    space?.setLyricsScale(sceneLyricsScale(next.appearance.lyricsSize));
    island.setVolume(next.playback.volume);
  };

  const syncSettingsUi = (): void => {
    const current = getSettings();
    settingToggles.forEach((button) => {
      const path = button.dataset.settingToggle ?? '';
      const on = readSetting(path) === true;
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    settingSegs.forEach((seg) => {
      const path = seg.dataset.settingSeg ?? '';
      const value = String(readSetting(path) ?? '');
      seg.querySelectorAll<HTMLButtonElement>('[data-seg-value]').forEach((button) => {
        button.classList.toggle('is-on', button.dataset.segValue === value);
      });
    });
    settingVolume.value = String(Math.round(current.playback.volume * 100));
  };

  const openSettingsSheet = (): void => {
    settingsSheet.hidden = false;
    syncSettingsUi();
    window.requestAnimationFrame(() => settingsSheet.classList.add('is-open'));
    host.requestSettings();
  };
  const closeSettingsSheet = (): void => {
    settingsSheet.classList.remove('is-open');
    window.setTimeout(() => {
      if (!settingsSheet.classList.contains('is-open')) settingsSheet.hidden = true;
    }, 180);
  };

  settingToggles.forEach((button) => {
    button.addEventListener('click', () => {
      const path = button.dataset.settingToggle ?? '';
      const [group, key] = path.split('.') as [keyof Settings, string];
      const next = !(readSetting(path) === true);
      patchSettings({ [group]: { [key]: next } } as never);
      applySettingsToScene(getSettings());
      syncSettingsUi();
    });
  });
  settingSegs.forEach((seg) => {
    seg.querySelectorAll<HTMLButtonElement>('[data-seg-value]').forEach((button) => {
      button.addEventListener('click', () => {
        const path = seg.dataset.settingSeg ?? '';
        const [group, key] = path.split('.') as [keyof Settings, string];
        const raw = button.dataset.segValue ?? '';
        const value: unknown = path === 'playback.searchLimit' ? Number.parseInt(raw, 10) : raw;
        patchSettings({ [group]: { [key]: value } } as never);
        applySettingsToScene(getSettings());
        syncSettingsUi();
      });
    });
  });
  settingVolume.addEventListener('input', () => {
    const value = Math.min(1, Math.max(0, Number.parseInt(settingVolume.value, 10) / 100));
    island.setVolume(value);
  });
  settingVolume.addEventListener('change', () => {
    const value = Math.min(1, Math.max(0, Number.parseInt(settingVolume.value, 10) / 100));
    patchSettings({ playback: { volume: value } });
  });
  settingsResetBtn.addEventListener('click', () => {
    resetSettings();
    applySettingsToScene(getSettings());
    syncSettingsUi();
    showToast('设置已恢复默认', 'ok');
  });
  settingsSheet.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('[data-settings-close]')) closeSettingsSheet();
  });
  onSettingsChange((next) => {
    applySettingsToScene(next);
    syncSettingsUi();
    if (!searchSourceTouched && next.playback.defaultSource !== searchSource) {
      searchSource = next.playback.defaultSource;
      searchSrcBtns.forEach((btn) => {
        btn.classList.toggle('is-on', btn.dataset.searchSource === searchSource);
      });
    }
  });
'''
assert s.count(old) == 1, "refs+logic"
s = s.replace(old, new, 1)

# 4) rail settings click
old = """      const label = feature === 'library' ? '歌单' : '设置';
      setStatus(`${label}功能即将开放`);"""
new = """      if (feature === 'settings') {
        openSettingsSheet();
        return;
      }
      setStatus('歌单功能即将开放');"""
assert s.count(old) == 1, "rail"
s = s.replace(old, new, 1)

# 5) search limit
old = "      const result = await searchOnline(searchSource, keyword, 30);"
new = "      const result = await searchOnline(searchSource, keyword, getSettings().playback.searchLimit);"
assert s.count(old) == 1, "searchlimit"
s = s.replace(old, new, 1)

# 6) default source touches
old = """  searchSrcBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const source = btn.dataset.searchSource === 'qq' ? 'qq' : 'netease';"""
new = """  let searchSourceTouched = false;
  searchSrcBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      searchSourceTouched = true;
      const source = btn.dataset.searchSource === 'qq' ? 'qq' : 'netease';"""
assert s.count(old) == 1, "touched"
s = s.replace(old, new, 1)

# 7) Escape priority for settings
old = """    if (event.key === 'Escape' && !customSheet.hidden) {"""
new = """    if (event.key === 'Escape' && !settingsSheet.hidden) {
      event.preventDefault();
      closeSettingsSheet();
      return;
    }
    if (event.key === 'Escape' && !customSheet.hidden) {"""
assert s.count(old) == 1, "escape"
s = s.replace(old, new, 1)

# 8) QA ?panel=settings
old = """  // QA：?panel=custom 直接打开自定义外观面板"""
new = """  // QA：?panel=settings 直接打开设置面板
  if (params.get('panel') === 'settings') {
    window.setTimeout(() => {
      if (!disposed) openSettingsSheet();
    }, 600);
  }

  // QA：?panel=custom 直接打开自定义外观面板"""
assert s.count(old) == 1, "qa"
s = s.replace(old, new, 1)

# 9) initial island volume
old = """  root.appendChild(island.element);"""
new = """  root.appendChild(island.element);
  island.setVolume(getSettings().playback.volume);"""
assert s.count(old) == 1, "island volume"
s = s.replace(old, new, 1)

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("settings UI patched")
