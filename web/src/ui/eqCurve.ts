/**
 * 均衡器曲线可视化：10 段频响曲线 + 可拖拽节点。
 * 设置页与快捷设置共用；拖动节点即调整对应频段增益。
 */
import { EQ_BAND_FREQS, EQ_GAIN_MAX, EQ_GAIN_MIN } from '../core/settings';

export interface EqCurveOptions {
  /** 画布显示高度（CSS 像素），默认 150。 */
  height?: number;
  /** 是否允许拖拽节点，默认 true。 */
  interactive?: boolean;
  /** 拖动过程中触发（用于同步滑块/预设高亮，不要每次都写设置）。 */
  onChange?: (gains: number[]) => void;
  /** 拖动结束时触发（用于持久化）。 */
  onCommit?: (gains: number[]) => void;
}

export interface EqCurve {
  canvas: HTMLCanvasElement;
  setGains(gains: ReadonlyArray<number>): void;
  setEnabled(enabled: boolean): void;
  destroy(): void;
}

const MIN_FREQ = 20;
const MAX_FREQ = 20000;
const PADDING_Y = 14;

const clampGain = (value: number): number =>
  Math.max(EQ_GAIN_MIN, Math.min(EQ_GAIN_MAX, Math.round(Number.isFinite(value) ? value : 0)));

export function createEqCurve(options: EqCurveOptions = {}): EqCurve {
  const canvas = document.createElement('canvas');
  canvas.className = 'eq-curve';
  canvas.style.height = `${options.height ?? 150}px`;

  const gains: number[] = new Array(EQ_BAND_FREQS.length).fill(0);
  let enabled = true;
  let activeIndex = -1;
  let dragging = false;
  let observer: ResizeObserver | null = null;

  const cssVar = (name: string, fallback: string): string => {
    const value = getComputedStyle(canvas).getPropertyValue(name).trim();
    return value || fallback;
  };

  const xForFreq = (freq: number, width: number): number =>
    ((Math.log10(freq) - Math.log10(MIN_FREQ)) / (Math.log10(MAX_FREQ) - Math.log10(MIN_FREQ))) * width;

  // 注意：这里不能复用 clampGain（它会取整），否则平滑曲线会被量化成台阶。
  const yForGain = (gain: number, height: number): number => {
    const raw = Number.isFinite(gain) ? gain : 0;
    const value = Math.max(EQ_GAIN_MIN, Math.min(EQ_GAIN_MAX, raw));
    const ratio = (value - EQ_GAIN_MIN) / (EQ_GAIN_MAX - EQ_GAIN_MIN);
    return height - PADDING_Y - ratio * (height - PADDING_Y * 2);
  };

  const gainForY = (y: number, height: number): number => {
    const ratio = (height - PADDING_Y - y) / (height - PADDING_Y * 2);
    return clampGain(EQ_GAIN_MIN + ratio * (EQ_GAIN_MAX - EQ_GAIN_MIN));
  };

  /**
   * 在对数频率轴上做单调三次插值（Fritsch–Carlson / PCHIP），得到穿过各节点、
   * 且不会在节点之间产生过冲的平滑频响曲线。
   */
  const logFreqs = EQ_BAND_FREQS.map((freq) => Math.log10(freq));
  const slopes: number[] = new Array(EQ_BAND_FREQS.length).fill(0);

  const computeSlopes = (): void => {
    const n = EQ_BAND_FREQS.length;
    if (n < 2) return;
    const delta: number[] = new Array(n - 1);
    for (let i = 0; i < n - 1; i += 1) {
      const dx = (logFreqs[i + 1] ?? 0) - (logFreqs[i] ?? 0) || 1;
      delta[i] = ((gains[i + 1] ?? 0) - (gains[i] ?? 0)) / dx;
    }
    slopes[0] = delta[0] ?? 0;
    slopes[n - 1] = delta[n - 2] ?? 0;
    for (let i = 1; i < n - 1; i += 1) {
      const prev = delta[i - 1] ?? 0;
      const next = delta[i] ?? 0;
      if (prev * next <= 0) {
        slopes[i] = 0;
      } else {
        const average = (prev + next) / 2;
        const limit = 3 * Math.min(Math.abs(prev), Math.abs(next));
        slopes[i] = Math.max(-limit, Math.min(limit, average));
      }
    }
    const clampEndpoint = (i: number, dIndex: number): void => {
      const m = slopes[i] ?? 0;
      const d = delta[dIndex] ?? 0;
      if (m * d <= 0) slopes[i] = 0;
      else if (Math.abs(m) > 3 * Math.abs(d)) slopes[i] = 3 * d;
    };
    clampEndpoint(0, 0);
    clampEndpoint(n - 1, n - 2);
  };

  /** 任意频点的增益（dB），平滑插值穿过 10 个节点。 */
  const gainAtFreq = (freq: number): number => {
    const n: number = EQ_BAND_FREQS.length;
    if (n === 0) return 0;
    const first = EQ_BAND_FREQS[0] ?? 31;
    const last = EQ_BAND_FREQS[n - 1] ?? 16000;
    if (freq <= first) return gains[0] ?? 0;
    if (freq >= last) return gains[n - 1] ?? 0;
    const x = Math.log10(freq);
    for (let i = 0; i < n - 1; i += 1) {
      const x0 = logFreqs[i] ?? 0;
      const x1 = logFreqs[i + 1] ?? x0;
      if (x < x0 || x > x1) continue;
      const h = x1 - x0 || 1;
      const t = (x - x0) / h;
      const t2 = t * t;
      const t3 = t2 * t;
      const y0 = gains[i] ?? 0;
      const y1 = gains[i + 1] ?? 0;
      const m0 = slopes[i] ?? 0;
      const m1 = slopes[i + 1] ?? 0;
      return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * m0
        + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * m1;
    }
    return gains[n - 1] ?? 0;
  };

  const draw = (): void => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width <= 0 || height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const accent = cssVar('--accent', '#d9c08d');
    const accentSoft = cssVar('--accent-soft', 'rgba(217,192,141,0.18)');
    const line = cssVar('--line', 'rgba(255,255,255,0.08)');
    const panel = cssVar('--panel-solid', '#121318');

    // 横向参考线（-12 / -6 / 0 / 6 / 12 dB）
    ctx.lineWidth = 1;
    for (const db of [-12, -6, 0, 6, 12]) {
      const y = yForGain(db, height);
      ctx.strokeStyle = db === 0 ? accentSoft : line;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // 纵向频段刻度线
    ctx.strokeStyle = line;
    for (const freq of EQ_BAND_FREQS) {
      const x = xForFreq(freq, width);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    // 曲线采样（对数频率轴，单调三次插值，穿过各节点）
    computeSlopes();
    const samples = Math.max(120, Math.floor(width / 2));
    const points: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= samples; i += 1) {
      const t = i / samples;
      const x = t * width;
      const freq = MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, t);
      points.push({ x, y: yForGain(gainAtFreq(freq), height) });
    }

    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, accentSoft);
    gradient.addColorStop(1, 'rgba(217,192,141,0)');
    ctx.beginPath();
    ctx.moveTo(0, height);
    for (const point of points) ctx.lineTo(point.x, point.y);
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    // 节点
    EQ_BAND_FREQS.forEach((freq, index) => {
      const x = xForFreq(freq, width);
      const y = yForGain(gains[index] ?? 0, height);
      const radius = index === activeIndex ? 5.5 : 3.6;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = index === activeIndex ? accent : panel;
      ctx.fill();
      ctx.strokeStyle = accent;
      ctx.lineWidth = index === activeIndex ? 2 : 1.6;
      ctx.stroke();
    });

    // 关闭时压暗，提示曲线不生效
    if (!enabled) {
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fillRect(0, 0, width, height);
    }
  };

  const indexAt = (event: PointerEvent): number => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0) return -1;
    const x = event.clientX - rect.left;
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    EQ_BAND_FREQS.forEach((freq, index) => {
      const distance = Math.abs(xForFreq(freq, rect.width) - x);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return best;
  };

  const applyFromEvent = (event: PointerEvent, commit: boolean): void => {
    if (!options.interactive || !enabled || dragging === false) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.height <= 0) return;
    if (activeIndex < 0) return;
    const next = gainForY(event.clientY - rect.top, rect.height);
    if ((gains[activeIndex] ?? 0) !== next) {
      gains[activeIndex] = next;
      draw();
      options.onChange?.([...gains]);
    }
    if (commit) options.onCommit?.([...gains]);
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (!options.interactive || !enabled) return;
    const index = indexAt(event);
    if (index < 0) return;
    event.preventDefault();
    dragging = true;
    activeIndex = index;
    try {
      canvas.setPointerCapture?.(event.pointerId);
    } catch {
      /* 合成事件没有真实 pointer 捕获，忽略即可 */
    }
    const rect = canvas.getBoundingClientRect();
    if (rect.height > 0) {
      const next = gainForY(event.clientY - rect.top, rect.height);
      if ((gains[index] ?? 0) !== next) {
        gains[index] = next;
        options.onChange?.([...gains]);
      }
    }
    draw();
  };

  const onPointerMove = (event: PointerEvent): void => applyFromEvent(event, false);

  const finishDrag = (event: PointerEvent): void => {
    if (!dragging) return;
    applyFromEvent(event, true);
    dragging = false;
    activeIndex = -1;
    draw();
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', finishDrag);
  canvas.addEventListener('pointercancel', finishDrag);

  observer = new ResizeObserver(() => {
    if (!canvas.isConnected) {
      observer?.disconnect();
      observer = null;
      return;
    }
    draw();
  });
  observer.observe(canvas);

  window.requestAnimationFrame(draw);

  return {
    canvas,
    setGains(next: ReadonlyArray<number>): void {
      for (let i = 0; i < gains.length; i += 1) gains[i] = clampGain(next[i] ?? 0);
      draw();
    },
    setEnabled(next: boolean): void {
      enabled = next;
      canvas.classList.toggle('is-disabled', !next);
      draw();
    },
    destroy(): void {
      observer?.disconnect();
      observer = null;
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', finishDrag);
      canvas.removeEventListener('pointercancel', finishDrag);
    },
  };
}
