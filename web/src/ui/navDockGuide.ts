import { h } from './dom';

/**
 * 悬浮导航条的一次性引导。
 *
 * 以前导航条是左侧常驻的竖排 rail，现在是浮在上方、会自己收起的胶囊：
 * 老用户第一次看到时既不知道它会自动隐藏，也不知道能拖、能右键召唤、能改大小，
 * 所以首次使用（或本版更新后第一次启动）弹一次说明，看过就记住。
 *
 * 三条规矩：
 *  1) 只弹一次：看过写入 localStorage，键里带版本号，将来改文案递增版本即可再弹。
 *  2) 引导期间把导航条按住（`is-guide-hold`）：它此刻可能刚好回到闲置态被收起，
 *     引导正指着那一块，收走就变成指空气。
 *  3) 出入场按全站规矩：入场 + 同轨迹反向出场 + 打断先收尾（正在出场时直接落地旧的）。
 */

export const NAV_DOCK_GUIDE_KEY = 'zilux2.navDockGuide';
/**
 * 引导文案版本：以后改说明再 +1，老用户会重新看到一次。
 *
 * v2：v1.2.0 正式发布前跑过一版临时构建（同一条引导、文案还没定稿），
 * 那批机器上已经写了 `1`；正式版把版本提到 2，装过临时构建的人（包括维护者自己）
 * 更新后才看得到这次定稿的说明。
 */
export const NAV_DOCK_GUIDE_VERSION = 2;

const CLOSE_MS = 220;

/** 这次启动要不要弹引导（没看过 / 看过的是旧版本）。 */
export function navDockGuidePending(): boolean {
  try {
    const seen = Number(localStorage.getItem(NAV_DOCK_GUIDE_KEY) ?? 0);
    return !Number.isFinite(seen) || seen < NAV_DOCK_GUIDE_VERSION;
  } catch {
    // 存储不可用时按已看过处理，别每次启动都弹。
    return false;
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(NAV_DOCK_GUIDE_KEY, String(NAV_DOCK_GUIDE_VERSION));
  } catch {
    /* 存不了就只在本次会话里算了 */
  }
}

interface GuideItem {
  key: string;
  text: string;
}

const ITEMS: GuideItem[] = [
  { key: '悬停', text: '首页一直停在顶部居中；其它页面鼠标靠近才出来，停 5 秒自动收起。' },
  { key: '右键', text: '在任意空白处点右键，它会跟着光标过来，点别处或按 Esc 再收回去。' },
  { key: '拖动', text: '按住条身可以搬走，拖右下角的小柄改大小，双击空白处复位。' },
  { key: '让位', text: '打开搜索时它会自动让开，不会挡住搜索面板。' },
];

/**
 * 弹出引导。`host` 是 `.app`（挂载点），`dock` 是导航条本体（定位与按住的对象）。
 * 返回的 Promise 在引导关闭后 resolve，方便调用方恢复状态。
 */
export function showNavDockGuide(host: HTMLElement, dock: HTMLElement): Promise<void> {
  // 打断：上一段出场还在跑就直接落地（它的收尾定时器到点也只是移除已脱离的元素）。
  const existing = host.querySelector<HTMLElement>('.nav-guide');
  if (existing) {
    if (!existing.classList.contains('is-out')) return Promise.resolve();
    existing.remove();
  }

  const list = h('ul', { class: 'nav-guide-list' });
  for (const item of ITEMS) {
    list.append(
      h(
        'li',
        { class: 'nav-guide-item' },
        h('span', { class: 'nav-guide-num', text: item.key }),
        h('span', { class: 'nav-guide-text', text: item.text }),
      ),
    );
  }

  const ok = h('button', { class: 'btn nav-guide-ok', type: 'button', text: '知道了' });
  const card = h(
    'div',
    { class: 'nav-guide', role: 'dialog', 'aria-modal': 'false', 'aria-label': '导航栏用法' },
    h('span', { class: 'nav-guide-arrow', 'aria-hidden': 'true' }),
    h('h3', { class: 'nav-guide-title', text: '导航栏换了新样子' }),
    h('p', { class: 'nav-guide-sub', text: '以前固定在左侧，现在浮在上方、会自己让开。' }),
    list,
    h('div', { class: 'nav-guide-actions' }, ok),
  );
  host.append(card);

  /** 贴着导航条摆：默认在它下方，空间不够就翻到上方，水平居中于条身。 */
  const place = (): void => {
    const box = dock.getBoundingClientRect();
    const width = card.offsetWidth || 320;
    const height = card.offsetHeight || 240;
    const gap = 16;
    let above = false;
    let top = box.bottom + gap;
    if (top + height > window.innerHeight - 12) {
      above = true;
      top = box.top - height - gap;
    }
    const left = Math.min(
      Math.max(12, box.left + box.width / 2 - width / 2),
      Math.max(12, window.innerWidth - width - 12),
    );
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(Math.max(12, top))}px`;
    card.classList.toggle('is-above', above);
    const arrow = card.querySelector<HTMLElement>('.nav-guide-arrow');
    if (arrow) {
      const center = box.left + box.width / 2 - left;
      arrow.style.left = `${Math.round(Math.min(Math.max(18, center), width - 18))}px`;
    }
  };

  let closing = false;
  let done: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    done = resolve;
  });

  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    close();
  };
  // 刚出现的一小会儿不响应外部点击：启动那两秒用户常在点界面或滚轮，
  // 引导一冒头就被点掉，看起来就跟「根本没弹」一样。
  const bornAt = performance.now();
  const onOutside = (event: PointerEvent): void => {
    if (performance.now() - bornAt < 1200) return;
    const target = event.target as HTMLElement | null;
    // 点引导本身不关；点导航条也不关（用户可能想先试着按一下）。
    if (target?.closest('.nav-guide')) return;
    if (target?.closest('.rail.nav-dock')) return;
    close();
  };

  const follow = window.setInterval(place, 400);

  function close(): void {
    if (closing) return;
    closing = true;
    markSeen();
    dock.classList.remove('is-guide-hold');
    window.clearInterval(follow);
    window.removeEventListener('resize', place);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('pointerdown', onOutside, true);
    card.classList.add('is-out');
    window.setTimeout(() => {
      card.remove();
      done();
    }, CLOSE_MS);
  }

  ok.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
  // 捕获阶段：页面里大量 stopPropagation，冒泡收不到。
  window.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('resize', place);

  // 先量一次再定位：offsetWidth 需要元素已经在文档里。
  place();
  ok.focus({ preventScroll: true });
  return closed;
}
