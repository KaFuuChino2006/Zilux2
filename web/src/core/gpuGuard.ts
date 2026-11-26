/**
 * GPU 饥饿降级（主屏全屏游戏 → 副屏窗口掉帧）。
 *
 * 现象：主屏独占全屏跑游戏时，WDDM 把 GPU 队列优先给游戏，副屏窗口的 Present 被饿死；
 * 页面里的 rAF 帧间隔会从 16.7ms 涨到 30–200ms。此时最贵的样式是 backdrop-filter：
 * 每一帧都要重新采样并模糊它背后的整块内容，正好是合成队列排队时被放大得最厉害的一项。
 *
 * 这里只看 rAF 的真实间隔（不看 CPU、不看瞬时 FPS 计数）：
 *   - 连续 2 个采样窗口掉帧 → 给 <html> 挂 is-gpu-starved，样式层关掉毛玻璃；
 *   - 连续 5 个窗口恢复正常 → 摘掉。
 * 中间的灰区两个 streak 都清零，避免在阈值边缘来回切。
 *
 * 降级只关模糊、保留元素自身的半透明底色，不做位移/尺寸变化，所以不会造成版面跳动。
 */

import { host } from './bridge';

const SAMPLE_WINDOW_MS = 1200;const STARVED_MEDIAN_MS = 24; // ≈ 42fps 以下
const STARVED_P95_MS = 55;
const HEALTHY_MEDIAN_MS = 18; // ≈ 55fps 以上
const HEALTHY_P95_MS = 42;
const STARVED_STREAK = 2;
const HEALTHY_STREAK = 5;

export interface GpuStarvationDetail {
  starved: boolean;
  median: number;
  p95: number;
}

const percentile = (sorted: number[], ratio: number): number => {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[index] ?? 0;
};

/** 安装并返回卸载函数（测试/热重载用；正常启动不需要卸载）。 */
export function installGpuStarvationGuard(): () => void {
  const root = document.documentElement;
  let frames: number[] = [];
  let windowStart = performance.now();
  let badStreak = 0;
  let goodStreak = 0;
  let handle = 0;
  let stopped = false;

  const resetWindow = (now: number): void => {
    frames = [];
    windowStart = now;
  };

  // 写进宿主日志：用户报「副屏还是卡」时，先看这行有没有出现、median 掉到多少，
  // 就能区分是「GPU 被游戏抢走」（该出现）还是「页面自己慢」（不该出现）。
  const report = (detail: GpuStarvationDetail): void => {
    try {
      host.log('info', `[gpu] starved=${detail.starved} median=${detail.median.toFixed(1)} p95=${detail.p95.toFixed(1)}`);
    } catch {
      // 壁纸/歌词这类独立场景没有完整 bridge；观测失败不能影响降级本身。
    }
  };

  const evaluate = (now: number): void => {
    const gaps: number[] = [];
    for (let i = 1; i < frames.length; i += 1) {
      const previous = frames[i - 1];
      const current = frames[i];
      if (previous !== undefined && current !== undefined) gaps.push(current - previous);
    }
    resetWindow(now);
    // 一个窗口里只有 1 帧（窗口被系统冻结）时不判定：没有信息，也不该据此改 UI。
    if (gaps.length < 2) return;

    gaps.sort((a, b) => a - b);
    const median = percentile(gaps, 0.5);
    const p95 = percentile(gaps, 0.95);
    const starved = median >= STARVED_MEDIAN_MS || p95 >= STARVED_P95_MS;
    const healthy = median <= HEALTHY_MEDIAN_MS && p95 <= HEALTHY_P95_MS;

    if (starved) {
      badStreak += 1;
      goodStreak = 0;
    } else if (healthy) {
      goodStreak += 1;
      badStreak = 0;
    } else {
      badStreak = 0;
      goodStreak = 0;
    }

    const detail: GpuStarvationDetail = { starved, median, p95 };
    if (badStreak >= STARVED_STREAK && !root.classList.contains('is-gpu-starved')) {
      root.classList.add('is-gpu-starved');
      report(detail);
      window.dispatchEvent(new CustomEvent<GpuStarvationDetail>('zilux2:gpu-starved', { detail }));
    } else if (goodStreak >= HEALTHY_STREAK && root.classList.contains('is-gpu-starved')) {
      root.classList.remove('is-gpu-starved');
      const recovered: GpuStarvationDetail = { ...detail, starved: false };
      report(recovered);
      window.dispatchEvent(new CustomEvent<GpuStarvationDetail>('zilux2:gpu-starved', { detail: recovered }));
    }
  };

  const tick = (now: number): void => {
    if (stopped) return;
    handle = window.requestAnimationFrame(tick);

    // 页面不可见 / 收进托盘停放时 rAF 本来就会被暂停或降频，不能算成「掉帧」去改 UI。
    if (document.hidden || root.classList.contains('is-host-parked')) {
      badStreak = 0;
      goodStreak = 0;
      resetWindow(now);
      return;
    }

    frames.push(now);
    if (now - windowStart >= SAMPLE_WINDOW_MS) evaluate(now);
  };

  handle = window.requestAnimationFrame(tick);

  return () => {
    stopped = true;
    window.cancelAnimationFrame(handle);
    root.classList.remove('is-gpu-starved');
  };
}
