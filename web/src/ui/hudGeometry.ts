/**
 * 浮层位置夹取（纯函数，方便单测）。
 *
 * 规则与拖动时一致：至少留 120×60 在视口内，用户总能抓到标题栏。
 * 单独抽出来是因为 `mixHud.ts` 在模块层就绑 DOM，node 里 import 不进来。
 */
export const HUD_KEEP_X = 120;
export const HUD_KEEP_Y = 60;

export function clampHudPosition(
  x: number,
  y: number,
  viewportW: number,
  viewportH: number,
): { x: number; y: number } {
  const maxX = Math.max(0, viewportW - HUD_KEEP_X);
  const maxY = Math.max(0, viewportH - HUD_KEEP_Y);
  return {
    x: Math.max(0, Math.min(maxX, Math.round(Number.isFinite(x) ? x : 0))),
    y: Math.max(0, Math.min(maxY, Math.round(Number.isFinite(y) ? y : 0))),
  };
}
