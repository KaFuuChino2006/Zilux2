/**
 * 歌词分享海报（1080×1440 PNG）。
 *
 * 纯参数驱动，不 import player / lyrics / settings：Lead 从 `playerState().track` 与
 * 当前歌词行取值后传入即可，保持解耦。
 *
 * 封面图以 `crossOrigin = 'anonymous'` 加载；加载失败 / 无 CORS 时退化为
 * 双色渐变 + ♪ 占位，保证 `canvas.toBlob` 永远不会因画布污染失败。
 */
import { h, icon, toast } from './dom';

export const LYRIC_POSTER_WIDTH = 1080;
export const LYRIC_POSTER_HEIGHT = 1440;

const ACCENT = '#d9c08d';
const FONT_FAMILY = '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
const DEFAULT_SIGNATURE = '沉浸式音乐空间';
const COVER_TIMEOUT_MS = 8000;

export interface LyricPosterOptions {
  title: string;
  artist: string;
  album?: string;
  /** 封面绝对 URL（宿主代理地址或 https 地址）；空值 / 失败时用渐变占位。 */
  coverUrl?: string;
  /** 当前歌词行文本。 */
  lyricLine?: string;
  /** 当前歌词行翻译。 */
  translation?: string;
  /** 来源标签，如「网易云音乐」「本地音乐」。 */
  sourceLabel?: string;
  /** 署名副标题，默认「沉浸式音乐空间」。 */
  signature?: string;
}

function font(weight: number, size: number): string {
  return `${weight} ${size}px ${FONT_FAMILY}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ------------------------------------------------------------------ */
/* 工具：圆角矩形 / 渐变 / 文本                                        */
/* ------------------------------------------------------------------ */

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 由歌名 / 歌手派生一对封面占位渐变色。 */
function hashColors(seed: string): [string, string] {
  const hash = hashString(seed || 'Zilux2');
  const hueA = hash % 360;
  const hueB = (hueA + 42 + (hash % 110)) % 360;
  return [`hsla(${hueA}, 46%, 30%, 0.95)`, `hsla(${hueB}, 52%, 16%, 0.95)`];
}

const CJK_PATTERN = /[\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let buffer = '';
  for (const char of Array.from(text)) {
    if (CJK_PATTERN.test(char)) {
      if (buffer !== '') {
        tokens.push(buffer);
        buffer = '';
      }
      tokens.push(char);
    } else if (/\s/.test(char)) {
      if (buffer !== '') {
        tokens.push(buffer);
        buffer = '';
      }
      tokens.push(' ');
    } else {
      buffer += char;
    }
  }
  if (buffer !== '') tokens.push(buffer);
  return tokens;
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let result = '';
  for (const char of Array.from(text)) {
    if (ctx.measureText(`${result}${char}…`).width > maxWidth) break;
    result += char;
  }
  return result === '' ? '…' : `${result}…`;
}

/** 按当前 ctx.font 折行（CJK 逐字、拉丁按词），超出行数用省略号。 */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed === '' || maxLines <= 0) return [];
  const lines: string[] = [];
  let current = '';
  let overflowed = false;
  for (const token of tokenize(trimmed)) {
    const candidate = current + token;
    if (current !== '' && ctx.measureText(candidate.trimEnd()).width > maxWidth) {
      lines.push(current.trimEnd());
      current = token === ' ' ? '' : token;
      if (lines.length >= maxLines) {
        overflowed = true;
        break;
      }
    } else {
      current = candidate;
    }
  }
  if (!overflowed && lines.length < maxLines && current.trim() !== '') {
    lines.push(current.trimEnd());
  }
  if (lines.length === 0) return [];
  if (overflowed) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = ellipsize(ctx, `${last}…`, maxWidth);
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/* 封面加载                                                            */
/* ------------------------------------------------------------------ */

function loadCover(url: string | undefined, timeoutMs: number = COVER_TIMEOUT_MS): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (!url) {
      resolve(null);
      return;
    }
    const image = new Image();
    image.crossOrigin = 'anonymous';
    let settled = false;
    const finish = (value: HTMLImageElement | null): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    image.onload = () => finish(image);
    image.onerror = () => finish(null);
    image.src = url;
  });
}

function drawCoverCrop(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  if (sourceWidth <= 0 || sourceHeight <= 0) return;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  ctx.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
}

/* ------------------------------------------------------------------ */
/* 绘制                                                                */
/* ------------------------------------------------------------------ */

/** 在给定 2D 上下文上绘制海报（不含封面加载）。 */
export function drawLyricPoster(
  ctx: CanvasRenderingContext2D,
  options: LyricPosterOptions,
  cover: HTMLImageElement | null,
): void {
  const width = LYRIC_POSTER_WIDTH;
  const height = LYRIC_POSTER_HEIGHT;
  const [colorA, colorB] = hashColors(`${options.title}|${options.artist}`);

  // 背景
  const background = ctx.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, '#15161d');
  background.addColorStop(0.55, '#0a0b0f');
  background.addColorStop(1, '#07080b');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  // 顶部光晕
  const glow = ctx.createRadialGradient(width * 0.22, height * 0.1, 0, width * 0.22, height * 0.1, width * 0.95);
  glow.addColorStop(0, colorA);
  glow.addColorStop(0.5, colorB);
  glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();

  // 卡片
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
  ctx.shadowBlur = 60;
  ctx.shadowOffsetY = 24;
  roundRect(ctx, 44, 44, width - 88, height - 88, 52);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.035)';
  ctx.fill();
  ctx.restore();
  roundRect(ctx, 44.5, 44.5, width - 89, height - 89, 52);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.09)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // 封面
  const coverSize = 560;
  const coverX = (width - coverSize) / 2;
  const coverY = 150;
  const coverRadius = 32;
  ctx.save();
  roundRect(ctx, coverX, coverY, coverSize, coverSize, coverRadius);
  ctx.clip();
  if (cover) {
    drawCoverCrop(ctx, cover, coverX, coverY, coverSize, coverSize);
    const shade = ctx.createLinearGradient(0, coverY + coverSize * 0.55, 0, coverY + coverSize);
    shade.addColorStop(0, 'rgba(0, 0, 0, 0)');
    shade.addColorStop(1, 'rgba(0, 0, 0, 0.42)');
    ctx.fillStyle = shade;
    ctx.fillRect(coverX, coverY, coverSize, coverSize);
  } else {
    const fallback = ctx.createLinearGradient(coverX, coverY, coverX + coverSize, coverY + coverSize);
    fallback.addColorStop(0, colorA);
    fallback.addColorStop(1, '#101116');
    ctx.fillStyle = fallback;
    ctx.fillRect(coverX, coverY, coverSize, coverSize);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.font = font(400, 220);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('♪', coverX + coverSize / 2, coverY + coverSize / 2 + 12);
  }
  ctx.restore();
  roundRect(ctx, coverX, coverY, coverSize, coverSize, coverRadius);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  let cursorY = coverY + coverSize + 58;

  const sourceLabel = (options.sourceLabel ?? '').trim();
  if (sourceLabel !== '') {
    ctx.font = font(500, 24);
    ctx.fillStyle = 'rgba(217, 192, 141, 0.86)';
    ctx.fillText(ellipsize(ctx, sourceLabel.toUpperCase(), 720), width / 2, cursorY);
    cursorY += 48;
  }

  // 歌名
  const title = (options.title ?? '').trim() || '未命名曲目';
  ctx.font = font(700, 56);
  ctx.fillStyle = '#f2f3f6';
  for (const line of wrapText(ctx, title, 860, 2)) {
    cursorY += 8;
    ctx.fillText(line, width / 2, cursorY);
    cursorY += 64;
  }

  // 歌手
  ctx.font = font(400, 34);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.64)';
  cursorY += 12;
  const artist = (options.artist ?? '').trim() || '未知歌手';
  ctx.fillText(ellipsize(ctx, artist, 760), width / 2, cursorY);
  cursorY += 54;

  // 分隔金线
  ctx.save();
  ctx.strokeStyle = 'rgba(217, 192, 141, 0.55)';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(width / 2 - 52, cursorY);
  ctx.lineTo(width / 2 + 52, cursorY);
  ctx.stroke();
  ctx.restore();
  cursorY += 64;

  // 歌词
  const lyricLine = (options.lyricLine ?? '').trim();
  if (lyricLine !== '') {
    ctx.font = font(600, 46);
    ctx.fillStyle = '#f2f3f6';
    for (const line of wrapText(ctx, lyricLine, 820, 2)) {
      ctx.fillText(line, width / 2, cursorY);
      cursorY += 62;
    }
    const translation = (options.translation ?? '').trim();
    if (translation !== '') {
      ctx.font = font(400, 30);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      cursorY += 4;
      ctx.fillText(ellipsize(ctx, translation, 780), width / 2, cursorY);
      cursorY += 44;
    }
  } else {
    ctx.font = font(500, 40);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.fillText('分享一首正在循环的歌', width / 2, cursorY);
    cursorY += 58;
  }

  // 底部署名
  const baseline = height - 128;
  ctx.textAlign = 'left';
  ctx.fillStyle = ACCENT;
  roundRect(ctx, 110, baseline - 34, 6, 44, 3);
  ctx.fill();
  ctx.font = font(700, 40);
  ctx.fillStyle = ACCENT;
  ctx.fillText('Zilux2', 138, baseline);
  ctx.font = font(400, 24);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.42)';
  ctx.fillText(options.signature ?? DEFAULT_SIGNATURE, 138, baseline + 36);

  const album = (options.album ?? '').trim();
  if (album !== '') {
    ctx.textAlign = 'right';
    ctx.font = font(400, 26);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.fillText(ellipsize(ctx, album, 380), width - 110, baseline);
  }
  void cursorY;
}

/** 同步绘制并返回 canvas（封面已提前加载）。 */
export function renderLyricPosterCanvas(
  options: LyricPosterOptions,
  cover: HTMLImageElement | null = null,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = LYRIC_POSTER_WIDTH;
  canvas.height = LYRIC_POSTER_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 canvas 2D 上下文');
  drawLyricPoster(ctx, options, cover);
  return canvas;
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), 'image/png');
    } catch (err) {
      console.warn('[lyricPoster] toBlob 失败', err);
      resolve(null);
    }
  });
}

/** 生成 1080×1440 歌词海报 PNG。 */
export async function renderLyricPoster(options: LyricPosterOptions): Promise<Blob> {
  const cover = await loadCover(options.coverUrl);
  let blob = await canvasToPngBlob(renderLyricPosterCanvas(options, cover));
  if (!blob && cover) {
    // 覆盖兜底：万一画布被污染（宿主代理未回 CORS 头），去掉封面重绘。
    blob = await canvasToPngBlob(renderLyricPosterCanvas(options, null));
  }
  if (!blob) throw new Error('海报生成失败：无法导出 PNG');
  return blob;
}

/* ------------------------------------------------------------------ */
/* 下载 / 预览                                                         */
/* ------------------------------------------------------------------ */

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function sanitizeFilename(value: string): string {
  return value
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** 下载文件名：`歌名-歌手-20261025-1307.png`。 */
export function lyricPosterFilename(options: LyricPosterOptions, date: Date = new Date()): string {
  const base = sanitizeFilename(`${options.title}-${options.artist}`) || 'zilux2-lyric-poster';
  const stamp = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(
    date.getHours(),
  )}${pad2(date.getMinutes())}`;
  return `${base}-${stamp}.png`;
}

function triggerFileDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 生成并触发下载，返回实际文件名。 */
export async function downloadLyricPoster(options: LyricPosterOptions, filename?: string): Promise<string> {
  const blob = await renderLyricPoster(options);
  const name = filename ?? lyricPosterFilename(options);
  triggerFileDownload(blob, name);
  return name;
}

/**
 * 打开居中的海报预览弹窗（生成 → 预览 → 下载）。Promise 在弹窗关闭时 resolve。
 * 建议 Lead 挂在当前曲目卡片 / 歌词页的「分享海报」按钮上。
 */
export function openLyricPosterSheet(options: LyricPosterOptions): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let previewUrl: string | null = null;
    let renderedBlob: Blob | null = null;

    const status = h('div', { class: 'lyp-status', text: '正在生成海报…' });
    const preview = h('img', { class: 'lyp-preview', alt: '歌词海报预览' });
    preview.hidden = true;

    const downloadBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm is-primary lyp-download',
        'data-qa': 'lyric-poster-download',
        disabled: true,
      },
      icon('download', 14),
      h('span', { text: '下载海报' }),
    );

    const close = (): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener('keydown', onKeyDown, true);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      overlay.remove();
      resolve();
    };

    const closeBtn = h(
      'button',
      { type: 'button', class: 'icon-btn lyp-close', 'data-qa': 'lyric-poster-close', 'aria-label': '关闭' },
      icon('close', 18),
    );
    closeBtn.addEventListener('click', close);

    const panel = h(
      'div',
      { class: 'lyp-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': '歌词海报预览' },
      h(
        'div',
        { class: 'lyp-head' },
        h('div', { class: 'lyp-title', text: '歌词海报' }),
        closeBtn,
      ),
      h('div', { class: 'lyp-body' }, status, preview),
      h('div', { class: 'lyp-actions' }, downloadBtn),
    );

    const overlay = h('div', { class: 'lyp-sheet', 'data-qa': 'lyric-poster-sheet' }, panel);

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });

    downloadBtn.addEventListener('click', () => {
      if (!renderedBlob) return;
      triggerFileDownload(renderedBlob, lyricPosterFilename(options));
      toast('歌词海报已保存');
    });

    document.body.append(overlay);

    void (async () => {
      try {
        const blob = await renderLyricPoster(options);
        if (settled) return;
        renderedBlob = blob;
        previewUrl = URL.createObjectURL(blob);
        preview.src = previewUrl;
        preview.hidden = false;
        status.hidden = true;
        downloadBtn.disabled = false;
      } catch (err) {
        if (settled) return;
        status.textContent = `海报生成失败：${errorText(err)}`;
        status.classList.add('is-error');
      }
    })();
  });
}
