/**
 * Zilux2 · 「唱片店」空间预览覆盖层（R1 原型）
 *
 * 设置 →「空间界面」里的入口调用 `openStoreSpacePreview()`，
 * 在应用内全屏打开 3D 场景（假数据、独立于主界面生命周期）。
 * R6 会替换为正式的界面切换：侧栏入口 + 真实数据 + 动态 import。
 *
 * 操作：拖拽环视、滚轮推进、点击唱片聚焦、Esc / 右上角按钮返回。
 */

import { toast } from '../dom';
import { mockCollections } from './mockCollections';
import type { StoreScene } from './storeScene';

interface PreviewHandle {
  close: () => void;
}

let active: PreviewHandle | null = null;

export function openStoreSpacePreview(): void {
  if (active) return;

  const root = document.createElement('div');
  root.className = 'space-overlay';

  const stage = document.createElement('div');
  stage.className = 'space-overlay-stage';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'space-overlay-close';
  closeBtn.title = '返回（Esc）';
  closeBtn.textContent = '返回';

  root.append(stage, closeBtn);
  document.body.append(root);

  let scene: StoreScene | null = null;
  let disposed = false;

  const close = (): void => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('keydown', onKey, true);
    try {
      scene?.dispose();
    } catch {
      // 忽略清理异常，保证覆盖层一定被移除
    }
    scene = null;
    root.remove();
    active = null;
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    // 逐级返回：先退出聚焦卡片，再退出空间。
    if (scene && scene.focusedIndex >= 0) {
      scene.resetView();
      return;
    }
    close();
  };

  window.addEventListener('keydown', onKey, true);
  closeBtn.addEventListener('click', close);

  active = { close };

  void import('./storeScene')
    .then(({ createStoreScene }) => {
      if (disposed) return;
      scene = createStoreScene(stage, {
        quality: 'high',
        onPlay: (song) => {
          toast(`R1 原型：将播放《${song.title}》（R3 接入真实播放器）`);
        },
        onFallback: () => {
          toast('当前环境不支持 WebGL2，已回退为扁平货架');
        },
      });
      scene.setCollections(mockCollections());
    })
    .catch((error: unknown) => {
      console.error('[space] 唱片店预览加载失败', error);
      toast('唱片店预览加载失败，请查看日志');
      close();
    });
}
