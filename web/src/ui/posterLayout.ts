/**
 * 封面显示方式偏好：网格卡片 / 横条列表。
 *
 * 墙面（收藏/最近/歌单/本地）与首页热门歌单共用这一份设置，
 * 存 localStorage，重启后保持。
 */

export type PosterLayout = 'grid' | 'list';

const KEY = 'zilux2.posterLayout';

export function readPosterLayout(): PosterLayout {
  try {
    return localStorage.getItem(KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

export function writePosterLayout(layout: PosterLayout): void {
  try {
    localStorage.setItem(KEY, layout);
  } catch {
    /* 隐私模式下写不进去就算了 */
  }
}
