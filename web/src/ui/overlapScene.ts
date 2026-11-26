import { createFlowScene } from './flowScene';
import {
  OVERLAP_SETTINGS_EVENT,
  overlapBackdropColor,
  overlapSettings,
  overlapStyleOf,
  setOverlapFx,
  type OverlapSettings,
} from './overlapSettings';
import type { Theme } from './lumiere-folia/types';

export function createOverlapScene(onPainted: () => void, onError: (error: unknown) => void, _recordUsage = false) {
  setOverlapFx(overlapSettings());
  const type = createFlowScene(onPainted, onError, false, overlapStyleOf(overlapSettings()));
  // 整屏底色单独一档：默认透明（露封面底），也可以在重合设置里压成纯黑 / 纯白。
  const paintBackdrop = (value: OverlapSettings['backdrop']) => {
    type.root.style.backgroundColor = overlapBackdropColor(value);
  };
  paintBackdrop(overlapSettings().backdrop);
  // Saving the panel re-seeds the stage: the palette and the type come through the style, while
  // the seeded choices (turn chance, scatter, specks) are re-read when the program recompiles.
  const refresh = (event: Event) => {
    const saved = (event as CustomEvent<OverlapSettings>).detail ?? overlapSettings();
    setOverlapFx(saved);
    paintBackdrop(saved.backdrop);
    type.setStyle(overlapStyleOf(saved));
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
      paintBackdrop(overlapSettings().backdrop);
    },
    dispose() {
      window.removeEventListener(OVERLAP_SETTINGS_EVENT, refresh);
      type.dispose();
    },
  };
}
