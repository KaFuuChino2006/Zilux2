/**
 * 壁纸音频可视化（规格书 §5.9，第 77 轮 C：默认开，样式可选 频谱 / 波形 / 圆环 / 粒子）。
 *
 * 用一个与壁纸同层的 <canvas> 画，52 帧上限自适应（掉帧就降采样），
 * 数据源是 audioFrame()（宿主 30Hz 推 bins[64]/bands[8]/level/peak）。
 * 只有壁纸层可见时才跑动画循环，隐藏时立刻停，避免后台空转吃 CPU。
 */

import { audioFrame, type AudioFrame } from '../core/audio';
import { onBeat } from '../core/beatClock';

export type VisualizerStyle = 'spectrum' | 'wave' | 'ring' | 'particles';

/**
 * 可视化的可调项（歌词页「可视化细节」用；壁纸页没有 UI 入口，用默认值）。
 * - bars：频谱柱数
 * - heightRatio：条带高度占可用高度的比例
 * - opacity：整体不透明度系数
 * - bottomInset：底部让位（像素），给播放条留位置，条带不再压住它
 */
export interface VisualizerTuning {
  bars: number;
  heightRatio: number;
  opacity: number;
  bottomInset: number;
}

const DEFAULT_TUNING: VisualizerTuning = { bars: 64, heightRatio: 0.32, opacity: 1, bottomInset: 0 };

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  size: number;
}

const MAX_PARTICLES = 160;
/**
 * 目标帧率上限；掉帧时自动往下退，最低 24。
 * 20 → 30 是实测取舍：52fps 的 canvas 重绘要额外 3.9% CPU（4.8% → 8.7%），
 * 30fps 视觉上几乎无差，但把余量留给了壁纸本身。
 */
let targetFps = 30;
let lastFrameAt = 0;

export class WallpaperVisualizer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private style: VisualizerStyle = 'spectrum';
  private enabled = false;
  private running = false;
  private width = 0;
  private height = 0;
  private fullWidth = 0;
  private fullHeight = 0;
  private particles: Particle[] = [];
  private tuning: VisualizerTuning = { ...DEFAULT_TUNING };
  private beatFlash = 0;
  private frameCount = 0;
  private slowWindows = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'wp-visualizer';
    const ctx = this.canvas.getContext('2d', { alpha: true, desynchronized: true });
    if (!ctx) throw new Error('wallpaper visualizer: 2d context unavailable');
    this.ctx = ctx;

    onBeat((event) => {
      this.beatFlash = Math.min(1, Math.max(0.2, event.strength));
      if (this.style === 'particles') this.burst(event.strength);
    });
  }

  get element(): HTMLCanvasElement {
    return this.canvas;
  }

  configure(enabled: boolean, style: string): void {
    this.enabled = enabled;
    const next = (['spectrum', 'wave', 'ring', 'particles'] as const).includes(style as VisualizerStyle)
      ? (style as VisualizerStyle)
      : 'spectrum';
    const changed = next !== this.style;
    this.style = next;
    if (changed) {
      this.particles = [];
      if (this.fullWidth > 0) this.resize(this.fullWidth, this.fullHeight);
    }
    if (!enabled) this.stop();
  }

  /** 调参：只改绘制参数，不重建 canvas；尺寸相关的变化会立刻重算一次。 */
  setTuning(patch: Partial<VisualizerTuning>): void {
    const next: VisualizerTuning = { ...this.tuning };
    if (Number.isFinite(patch.bars)) next.bars = Math.max(8, Math.min(128, Math.round(patch.bars as number)));
    if (Number.isFinite(patch.heightRatio)) {
      next.heightRatio = Math.max(0.08, Math.min(0.6, patch.heightRatio as number));
    }
    if (Number.isFinite(patch.opacity)) next.opacity = Math.max(0.1, Math.min(1, patch.opacity as number));
    if (Number.isFinite(patch.bottomInset)) next.bottomInset = Math.max(0, Math.round(patch.bottomInset as number));
    const sizeChanged =
      next.heightRatio !== this.tuning.heightRatio || next.bottomInset !== this.tuning.bottomInset;
    this.tuning = next;
    if (sizeChanged && this.fullWidth > 0) this.resize(this.fullWidth, this.fullHeight);
  }

  /**
   * canvas 面积直接决定每帧 clearRect 的成本（全屏 1600×960 重绘实测要 +3.9% CPU）。
   * 频谱和波形只需要底部一条带子，只有圆环 / 粒子才铺满。
   * bottomInset 是底部需要让开的像素（播放条），条带贴在这之上，不再压住控制条。
   */
  resize(width: number, height: number): void {
    if (width < 2 || height < 2) return;
    this.fullWidth = width;
    this.fullHeight = height;
    const bandOnly = this.style === 'spectrum' || this.style === 'wave';
    const inset = Math.min(this.tuning.bottomInset, Math.max(0, height - 120));
    const usable = Math.max(80, height - inset);
    const drawHeight = bandOnly ? Math.max(96, Math.round(usable * this.tuning.heightRatio)) : usable;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    this.width = width;
    this.height = drawHeight;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(drawHeight * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${drawHeight}px`;
    // 条带模式贴在让位区之上；全屏模式从顶部开始。
    this.canvas.style.top = bandOnly ? `${height - inset - drawHeight}px` : '0px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  start(): void {
    if (this.running || !this.enabled) return;
    this.running = true;
    lastFrameAt = 0;
    requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    this.ctx.clearRect(0, 0, this.width, this.height);
  }

  private readonly frame = (now: number): void => {
    if (!this.running) return;
    requestAnimationFrame(this.frame);

    // 帧率上限（自适应）：间隔不够就跳过这一帧，只清空重画很便宜。
    const interval = 1000 / targetFps;
    if (lastFrameAt !== 0 && now - lastFrameAt < interval) return;
    const delta = lastFrameAt === 0 ? interval : now - lastFrameAt;
    lastFrameAt = now;

    // 掉帧检测：连续 30 帧都超出预算就退一档，最低 24fps。
    if (delta > interval * 1.6) {
      if (++this.slowWindows >= 30 && targetFps > 24) {
        targetFps = Math.max(24, targetFps - 8);
        this.slowWindows = 0;
      }
    } else if (this.slowWindows > 0) {
      this.slowWindows--;
    }

    this.frameCount++;
    const frame = audioFrame();
    this.draw(frame, now);
  };

  private draw(frame: AudioFrame, now: number): void {
    const { ctx, width, height } = this;
    if (width < 2 || height < 2) return;
    ctx.clearRect(0, 0, width, height);
    if (this.beatFlash > 0) this.beatFlash = Math.max(0, this.beatFlash - 0.02);

    const level = frame.level || 0;
    const bands = frame.bands.length >= 8 ? frame.bands : new Array(8).fill(0);
    const bins = frame.bins.length > 0 ? frame.bins : new Array(64).fill(0);
    ctx.save();
    ctx.globalAlpha = Math.min(1, (0.55 + level * 0.4) * this.tuning.opacity);

    if (this.style === 'spectrum') this.drawSpectrum(bins, level);
    else if (this.style === 'wave') this.drawWave(bins, now);
    else if (this.style === 'ring') this.drawRing(bands, level);
    else this.drawParticles(bands, level, now);

    ctx.restore();
  }

  /** 频谱条：底部若干根柱子（数量可调），左右对称留白，越高越亮。 */
  private drawSpectrum(bins: number[], level: number): void {
    const { ctx, width, height } = this;
    const count = Math.max(8, Math.round(this.tuning.bars));
    const gap = 2;
    const barWidth = Math.max(1.5, (width * 0.86) / count - gap);
    const totalWidth = count * (barWidth + gap);
    let x = (width - totalWidth) / 2;
    const baseY = height - 18;
    const maxHeight = height * 0.26;

    for (let i = 0; i < count; i += 1) {
      // 柱子数可调（24..128），bins 固定 64 段：按比例取样，避免超出部分永远为 0。
      const sample = bins[Math.min(bins.length - 1, Math.floor((i / count) * bins.length))] ?? 0;
      const value = Math.min(1, sample * (1 + level * 0.5));
      const h = Math.max(2, value * maxHeight);
      const alpha = 0.25 + value * 0.75;
      ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
      ctx.fillRect(x, baseY - h, barWidth, h);
      x += barWidth + gap;
    }
  }

  /** 波形：一条随 bins 起伏的折线，横向铺满。 */
  private drawWave(bins: number[], now: number): void {
    const { ctx, width, height } = this;
    const midY = height * 0.78;
    const amplitude = height * 0.1 * (1 + this.beatFlash * 0.5);
    ctx.beginPath();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.72)';
    const points = 96;
    for (let i = 0; i <= points; i += 1) {
      const t = i / points;
      const sample = bins[Math.floor(t * (bins.length - 1))] ?? 0;
      const wobble = Math.sin(t * Math.PI * 4 + now / 420) * 0.25;
      const y = midY - (sample + wobble * 0.15) * amplitude;
      const x = t * width;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  /** 圆环：8 个 band 决定半径抖动，中心随 level 呼吸。 */
  private drawRing(bands: number[], level: number): void {
    const { ctx, width, height } = this;
    const cx = width / 2;
    const cy = height * 0.5;
    const baseR = Math.min(width, height) * 0.16;
    const r = baseR * (1 + level * 0.18 + this.beatFlash * 0.08);

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.stroke();

    const count = 64;
    for (let i = 0; i < count; i += 1) {
      const band = bands[i % bands.length] ?? 0;
      const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
      const inner = r + 8;
      const outer = inner + Math.max(2, band * baseR * 0.9);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
      ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = `rgba(255,255,255,${(0.2 + band * 0.7).toFixed(3)})`;
      ctx.stroke();
    }
  }

  /** 粒子：低音越强喷得越远，生命期 1.2s。 */
  private drawParticles(bands: number[], level: number, now: number): void {
    const { ctx } = this;
    const bass = (bands[1] ?? 0) * 0.6 + (bands[2] ?? 0) * 0.4;
    // 持续少量补充，避免只有 beat 才有粒子。
    if (this.particles.length < MAX_PARTICLES && bass > 0.08 && Math.random() < 0.35) {
      this.spawn(1 + Math.round(bass * 3), bass);
    }

    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    const dt = 1 / 60;
    this.particles = this.particles.filter((p) => {
      p.life -= dt * 0.85;
      if (p.life <= 0) return false;
      p.x += p.vx * dt * 60;
      p.y += p.vy * dt * 60;
      p.vy += 0.06;
      ctx.globalAlpha = Math.max(0, p.life) * 0.7;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.6 + p.life * 0.6), 0, Math.PI * 2);
      ctx.fill();
      return true;
    });
    ctx.globalAlpha = 1;
    void now;
    void level;
  }

  private burst(strength: number): void {
    if (this.style !== 'particles') return;
    this.spawn(6 + Math.round(strength * 14), strength);
  }

  private spawn(count: number, energy: number): void {
    const { width, height } = this;
    if (width < 2 || height < 2) return;
    for (let i = 0; i < count; i += 1) {
      if (this.particles.length >= MAX_PARTICLES) break;
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
      const speed = 1.2 + Math.random() * 2.6 * (0.6 + energy);
      this.particles.push({
        x: this.fullWidth / 2 + (Math.random() - 0.5) * this.fullWidth * 0.12,
        y: height * 0.62,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.7 + Math.random() * 0.5,
        size: 1.2 + Math.random() * 2.2,
      });
    }
  }
}
