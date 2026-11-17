/**
 * 外观联动（第 84 轮 A）：主题在 light / dark 之间切换时，自动应用名字里
 * 带「暗 / dark」或「亮 / light」的 appearance 预设。
 *
 * 只认 kind === 'appearance' 的预设 —— manual 预设是用户手动切场景用的，
 * 被主题切换悄悄改掉会很突然。
 */
import { fetchOptions, fetchPresets, patchOptions, type WallpaperOptions, type WallpaperPreset } from '../wallpaper/client';
import { currentTheme } from './theme';

const DARK_HINTS = ['暗', '夜间', '夜晚', 'dark', 'night'];
const LIGHT_HINTS = ['亮', '白天', '日间', 'light', 'day'];

function pickPreset(presets: WallpaperPreset[], dark: boolean): number | null {
  const hints = dark ? DARK_HINTS : LIGHT_HINTS;
  const match = presets.find((preset) => {
    if (preset.kind !== 'appearance') return false;
    const name = (preset.name || '').toLowerCase();
    return hints.some((hint) => name.includes(hint.toLowerCase()));
  });
  return match ? match.id : null;
}

let started = false;
let lastTheme = '';
let busy = false;

async function applyForTheme(theme: string): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const state = await fetchOptions();
    const options = state.options as WallpaperOptions;
    if (options.appearanceLink !== true) return;

    const { items } = await fetchPresets();
    const presets = items;
    const presetId = pickPreset(presets, theme === 'dark');
    if (!presetId) return;

    const preset = presets.find((item) => item.id === presetId);
    if (!preset) return;

    // 只把 payload 里出现过的键打回去，避免把整份 options 覆盖掉。
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(preset.payload || {})) {
      patch[key] = value;
    }
    if (Object.keys(patch).length === 0) return;
    await patchOptions(patch);
  } catch {
    /* 联动失败不影响主流程 */
  } finally {
    busy = false;
  }
}

/** 幂等：main() 里调一次即可。 */
export function startAppearanceLink(): void {
  if (started) return;
  started = true;
  lastTheme = currentTheme();

  new MutationObserver(() => {
    const theme = currentTheme();
    if (theme === lastTheme) return;
    lastTheme = theme;
    void applyForTheme(theme);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}
