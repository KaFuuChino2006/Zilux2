import { createFlowScene } from './flowScene';
import { currentWenflashSettings, wenflashBackdropColor, wenflashBackdropMode, wenflashLayout, WENFLASH_SPLIT_EVENT } from './wenflashSettings';
import {
  OVERLAP_SETTINGS_EVENT,
  overlapBackdropColor,
  overlapSettings,
  overlapStyleOf,
  setOverlapFx,
  type OverlapSettings,
} from './overlapSettings';
import type { Theme } from './lumiere-folia/types';

export function createWenflashScene(onPainted: () => void, onError: (error: unknown) => void) {
  return createOverlapScene(onPainted, onError, false, true);
}

export function createOverlapScene(onPainted: () => void, onError: (error: unknown) => void, _recordUsage = false, glyphsOnly = false) {
  setOverlapFx(overlapSettings());
  const styleOf = (value: OverlapSettings) => {
    if (!glyphsOnly) return overlapStyleOf(value);
    const layout = wenflashLayout();
    const win = currentWenflashSettings();
    return {
      ...overlapStyleOf({...value, splitLyrics: layout !== 'whole'}),
      wenflashLayout: layout,
      postProcessLensDistortion: win.lensDistortion,
      postProcessRgbShift: win.rgbShift,
      postProcessGrain: win.grain,
      postProcessContrast: win.contrast,
      postProcessVignette: win.vignette,
    };
  };
  const type = createFlowScene(onPainted, onError, false, styleOf(overlapSettings()), glyphsOnly);
  // 整屏底色单独一档：重合默认透明（露封面底）；文闪用自己的封面 / 自定义 / 纯黑 / 纯白。
  const paintBackdrop = () => {
    if (!glyphsOnly) {
      type.root.style.backgroundColor = overlapBackdropColor(overlapSettings().backdrop);
      return;
    }
    const mode = wenflashBackdropMode();
    type.root.style.backgroundColor = mode === 'custom'
      ? wenflashBackdropColor()
      : mode === 'black'
        ? '#000000'
        : mode === 'white'
          ? '#ffffff'
          : 'transparent';
  };
  const refreshSplit = () => {
    paintBackdrop();
    type.setStyle(styleOf(overlapSettings()));
  };
  if (glyphsOnly) window.addEventListener(WENFLASH_SPLIT_EVENT, refreshSplit);
  paintBackdrop();
  // Saving the panel re-seeds the stage: the palette and the type come through the style, while
  // the seeded choices (turn chance, scatter, specks) are re-read when the program recompiles.
  const refresh = (event: Event) => {
    const saved = (event as CustomEvent<OverlapSettings>).detail ?? overlapSettings();
    setOverlapFx(saved);
    paintBackdrop();
    type.setStyle(styleOf(saved));
    // 落位方式、铺法方向这些不进 FlowSettings，样式类名相同也要重排一次。
    type.refresh();
  };
  window.addEventListener(OVERLAP_SETTINGS_EVENT, refresh);
  return {
    ...type,
    setUsageRecording() {},
    setTheme(theme: Theme) {
      type.setTheme({ ...theme, backgroundColor: '#000000' });
      // setTheme 会把根节点刷成主题底色，这里再按「背景」那一档盖回来。
      paintBackdrop();
    },
    dispose() {
      if (glyphsOnly) window.removeEventListener(WENFLASH_SPLIT_EVENT, refreshSplit);
      window.removeEventListener(OVERLAP_SETTINGS_EVENT, refresh);
      type.dispose();
    },
  };
}
