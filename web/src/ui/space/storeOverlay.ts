/**
 * Zilux2 · 「唱片店」空间预览覆盖层（R3 两区版）
 *
 * 设置 →「空间界面」入口调用 `openStoreSpacePreview()`，在应用内全屏打开 3D 场景。
 * R6 会替换为正式的界面切换：侧栏入口 + 真实数据 + 动态 import。
 *
 * 操作（R3）：
 * - 菜单：点击分类牌进入右侧大唱片架，拖拽环视、滚轮推进；
 * - 大架：滚轮翻页、点击唱片聚焦；
 * - Esc 逐级返回：卡片 → 大架 → 菜单 → 退出。
 */

import { toast } from '../dom';
import { mockCollections } from './mockCollections';
import { loadStoreCollections } from './storeCollections';
import type { StoreScene, StoreZoneState } from './storeScene';

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

  const crumb = document.createElement('div');
  crumb.className = 'space-overlay-crumb';
  crumb.textContent = '唱片店 · 载入中…';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'space-overlay-close';
  closeBtn.title = '返回（Esc）';
  closeBtn.textContent = '返回';

  stage.append(crumb);
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

  const onZone = (state: StoreZoneState): void => {
    if (state.zone === 'menu') {
      crumb.textContent = '唱片店 · 菜单';
      return;
    }
    crumb.textContent =
      state.pages > 1
        ? `唱片店 · ${state.title} · ${state.count} 张 · 第 ${state.page + 1}/${state.pages} 页`
        : `唱片店 · ${state.title} · ${state.count} 张`;
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (scene && scene.focusedIndex >= 0) {
      scene.resetView();
      return;
    }
    if (scene && scene.zone === 'library') {
      scene.backToMenu();
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
        onZone,
        onPlay: (song) => {
          toast(`即将播放《${song.title}》— ${song.artist}（播放接入下一步）`);
        },
        onFallback: () => {
          toast('当前环境不支持 WebGL2，已回退为扁平货架');
        },
      });
      // 先放入演示数据占位，真实数据到达后整体替换（封面按 URL 懒加载）。
      scene.setCollections(mockCollections());
      void loadStoreCollections()
        .then((collections) => {
          if (disposed || !scene) return;
          if (collections.length > 0) {
            scene.setCollections(collections);
            crumb.textContent = '唱片店 · 菜单';
          } else {
            toast('未能读取在线歌单，先使用演示数据');
          }
        })
        .catch((error: unknown) => {
          console.warn('[space] 在线歌单载入失败', error);
          if (!disposed) toast('在线歌单载入失败，先使用演示数据');
        });
    })
    .catch((error: unknown) => {
      console.error('[space] 唱片店预览加载失败', error);
      toast('唱片店预览加载失败，请查看日志');
      close();
    });
}
