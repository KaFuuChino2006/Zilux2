/**
 * 封面兜底：在线封面代理偶尔会失败，浏览器会显示「图片未找到」图标。
 * 这里全局监听图片加载失败，先按当前端口重新绑定地址重试，再按退避间隔重试原地址（最多 2 次），
 * 仍失败才换成本地生成的渐变封面（不依赖网络），保证每张卡片都有图。
 */

import { rebindCoverUrl } from '../online/artwork';

/** 失败后重试的次数与间隔（毫秒）。 */
const RETRY_DELAYS = [420, 1100];

/** 由种子字符串生成稳定的双色渐变 SVG 封面（data URL）。 */
export function gradientCover(seed: string): string {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const hue = hash % 360;
  const hue2 = (hue + 38 + (hash % 40)) % 360;
  const light1 = 58 + (hash % 12);
  const light2 = 38 + ((hash >> 5) % 14);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue} 58% ${light1}%)"/>` +
    `<stop offset="1" stop-color="hsl(${hue2} 52% ${light2}%)"/>` +
    `</linearGradient></defs>` +
    `<rect width="256" height="256" fill="url(#g)"/>` +
    `<circle cx="${64 + (hash % 96)}" cy="${72 + ((hash >> 7) % 96)}" r="${40 + (hash % 46)}" fill="rgba(255,255,255,0.14)"/>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** 去掉重试参数后的原始地址。 */
function baseSource(src: string): string {
  return src
    .replace(/([?&])zretry=\d+&?/g, '$1')
    .replace(/[?&]$/, '')
    .replace(/\?&/, '?');
}

/** 安装全局兜底（图片 error 事件不冒泡，用捕获阶段监听）。 */
export function installCoverFallback(): void {
  // 加载成功后清掉重试标记，后续换图不受影响
  document.addEventListener(
    'load',
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLImageElement)) return;
      delete target.dataset.coverRetrying;
      delete target.dataset.coverRebased;
      delete target.dataset.coverSrc;
    },
    true,
  );

  document.addEventListener(
    'error',
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLImageElement)) return;
      if (target.dataset.coverFallback === '1') return;

      const current = target.getAttribute('src') ?? '';
      if (!current || current.startsWith('data:')) return;

      // 新地址（切歌/换页）时重置重试计数
      const retryParam = /[?&]zretry=(\d+)/.exec(current);
      const attempt = retryParam ? Number(retryParam[1]) : 0;
      const base = baseSource(current);

      // 宿主每次启动都换端口与 token：启动早期渲染的封面可能还绑着上次的端口，
      // 先按当前端口/token 重新绑定一次再试，避免一路掉到渐变兜底图。
      if (target.dataset.coverRebased !== '1') {
        const rebased = rebindCoverUrl(base);
        if (rebased && rebased !== base) {
          target.dataset.coverRebased = '1';
          target.src = rebased;
          return;
        }
      }

      if (attempt < RETRY_DELAYS.length) {
        // 已经排队过重试就不再排，避免同一张图反复换 src 造成闪烁
        if (target.dataset.coverRetrying === '1') return;
        target.dataset.coverRetrying = '1';
        window.setTimeout(() => {
          delete target.dataset.coverRetrying;
          if (target.dataset.coverFallback === '1') return;
          const separator = base.includes('?') ? '&' : '?';
          target.src = `${base}${separator}zretry=${attempt + 1}`;
        }, RETRY_DELAYS[attempt]);
        return;
      }

      target.dataset.coverFallback = '1';
      // 记下原始地址：宿主端口/token 到达后可重新绑定重试（见 online/artwork.ts）
      target.dataset.coverSrc = base;
      target.src = gradientCover(base || target.alt || 'zilux');
    },
    true,
  );
}
