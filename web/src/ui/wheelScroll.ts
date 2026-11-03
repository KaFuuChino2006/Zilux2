/**
 * 让横向滚动容器支持「竖向滚轮 → 横向平滑滚动」。
 *
 * 首页的每日推荐/热门歌单早就这么做了，发现页的分类条与横向歌单墙复用同一套手感：
 * 滚轮输入先累积到目标位置，再用 requestAnimationFrame 缓动逼近，避免一格一格地跳。
 */
export function enableWheelScroll(element: HTMLElement, speed = 1.35): void {
  let target = element.scrollLeft;
  let raf = 0;
  const maxScroll = (): number => Math.max(0, element.scrollWidth - element.clientWidth);
  const step = (): void => {
    const max = maxScroll();
    if (target > max) target = max;
    if (target < 0) target = 0;
    const distance = target - element.scrollLeft;
    if (Math.abs(distance) < 0.6) {
      element.scrollLeft = target;
      raf = 0;
      return;
    }

    element.scrollLeft += distance * 0.22;
    raf = window.requestAnimationFrame(step);
  };
  const kick = (): void => {
    if (raf === 0) raf = window.requestAnimationFrame(step);
  };

  element.addEventListener(
    'wheel',
    (event) => {
      // 已经是横向滚动（触控板左右滑）就交给浏览器，不再叠加。
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const max = maxScroll();
      if (max <= 0) return;
      const next = Math.max(0, Math.min(max, target + event.deltaY * speed));
      // 已经滚到尽头，把滚轮还给页面，避免整页被横滚条卡住。
      if ((next <= 0 && event.deltaY < 0) || (next >= max && event.deltaY > 0)) return;
      event.preventDefault();
      target = next;
      kick();
    },
    { passive: false },
  );

  element.addEventListener(
    'pointerdown',
    () => {
      target = element.scrollLeft;
      if (raf !== 0) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      }
    },
    { passive: true },
  );
}
