/**
 * Zilux2 · 「唱片店」空间模式 —— R1 原型场景
 *
 * 设计目标（R1）：
 * - 独立预览页可运行的 3D 唱片店底层：暗木地板 + 墙面 + 轨道灯 + 两排唱片货架；
 * - 相机：拖拽环视 / 滚轮推进 / 点击唱片聚焦（阻尼过渡），Esc 逐级返回；
 * - 点击聚焦后弹出白色磨砂信息卡（后续 R3 接真实数据与播放器）；
 * - 自带降级：无 WebGL2 时渲染成扁平货架列表，功能不中断。
 *
 * 本文件暂时保持「自包含」，等 R2/R3 再拆成 storeCamera / shelf / storeData 等模块。
 */

import * as THREE from 'three';

const STYLE_ID = 'zl-store-style';

/** 货架网格：R1 固定 6 列 × 2 排，R2 再按区域扩展。 */
const COLS = 6;
const ROWS = 2;
const COVER_SIZE = 0.5;
const COVER_GAP_X = 0.12;
const ROW_Y = [1.04, 1.72];
const PLANK_THICKNESS = 0.045;
/** 相机基准目标点（货架中部）。 */
const BASE_TARGET = new THREE.Vector3(0.12, 1.36, 0);
const BASE_YAW = 0.34;
const BASE_PITCH = 0.15;
const BASE_DISTANCE = 5.6;
const FOCUS_DISTANCE = 1.22;

type QualityName = 'high' | 'medium' | 'low';

const QUALITY_PRESETS: Record<QualityName, { dpr: number; dust: number }> = {
  high: { dpr: 1.5, dust: 220 },
  medium: { dpr: 1.25, dust: 140 },
  low: { dpr: 1, dust: 80 },
};

/** 原型期封面底色池（R3 会换成真实封面的主色/贴图）。 */
const COVER_PALETTE: ReadonlyArray<readonly [string, string]> = [
  ['#8c5a3c', '#3a2015'],
  ['#6f4430', '#2c1710'],
  ['#44655c', '#16251f'],
  ['#3d5068', '#161f2b'],
  ['#7d4b5c', '#2b1620'],
  ['#8a6a3e', '#352513'],
  ['#4f5f3f', '#1d2517'],
  ['#5f4a70', '#241a2e'],
  ['#8f5a3a', '#371d10'],
  ['#3f666b', '#142528'],
  ['#9a7345', '#3d2714'],
  ['#564a6b', '#211b2c'],
];

export interface StoreSceneSong {
  trackKey: string;
  title: string;
  artist: string;
  album?: string;
  /** R3 起用于真实封面；R1 缺省时用主色 + 歌名生成占位封面。 */
  coverUrl?: string;
  /** 封面主色（十六进制），没有封面图时用来生成渐变。 */
  color?: string;
}

export interface StoreSceneCollection {
  id: string;
  title: string;
  subtitle?: string;
  songs: StoreSceneSong[];
}

export interface StoreSceneOptions {
  quality?: QualityName;
  /** 聚焦到某张唱片 / 取消聚焦。 */
  onFocus?: (song: StoreSceneSong | null) => void;
  /** 信息卡上点「播放」。 */
  onPlay?: (song: StoreSceneSong) => void;
  onReady?: () => void;
  /** WebGL2 不可用，场景已切换为扁平列表。 */
  onFallback?: () => void;
}

export interface StoreSceneStats {
  fps: number;
  drawCalls: number;
  triangles: number;
  dpr: number;
  width: number;
  height: number;
}

export interface StoreScene {
  readonly root: HTMLElement;
  resize(): void;
  setCollections(collections: StoreSceneCollection[]): void;
  setActiveTrack(trackKey: string | null): void;
  resetView(): void;
  focusIndex(index: number): void;
  readonly focusedIndex: number;
  stats(): StoreSceneStats;
  dispose(): void;
}

interface CoverSlot {
  index: number;
  group: THREE.Group;
  cover: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  frame: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  texture: THREE.CanvasTexture | null;
  song: StoreSceneSong | null;
  neutralScale: number;
  hovered: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** 与房间场景一致的帧率无关阻尼。 */
function damp(current: number, target: number, smoothing: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-smoothing * dt));
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, html?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

function parseHex(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '');
  const value = Number.parseInt(normalized.length === 3 ? normalized.replace(/(.)/g, '$1$1') : normalized, 16);
  if (!Number.isFinite(value)) return [120, 100, 80];
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** 把颜色向白 / 黑混合，amount > 0 提亮，< 0 压暗。 */
function shade(hex: string, amount: number): string {
  const [r, g, b] = parseHex(hex);
  const mix = (channel: number): number => {
    const target = amount >= 0 ? 255 : 0;
    return Math.round(channel + (target - channel) * Math.min(1, Math.abs(amount)));
  };
  return `rgb(${mix(r)} ${mix(g)} ${mix(b)})`;
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

function wrapCoverText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  const words = text.split(/\s+/).filter(Boolean);
  const latin = words.length > 1;
  const tokens = latin ? words : Array.from(text);
  let current = '';
  const push = (): boolean => {
    if (!current) return false;
    lines.push(current);
    current = '';
    return lines.length >= maxLines;
  };
  for (const token of tokens) {
    const next = latin ? (current ? `${current} ${token}` : token) : current + token;
    if (ctx.measureText(next).width > maxWidth && current) {
      if (push()) return lines;
      current = latin ? token : token;
    } else {
      current = next;
    }
  }
  push();
  return lines.slice(0, maxLines);
}

function makeCoverTexture(song: StoreSceneSong | null, index: number): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const palette = COVER_PALETTE[index % COVER_PALETTE.length] ?? ['#c9a068', '#6b4a2f'];
  const base = song?.color ?? palette[0];
  const deep = palette[1];

  if (ctx) {
    const grad = ctx.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, shade(base, 0.28));
    grad.addColorStop(0.55, base);
    grad.addColorStop(1, shade(deep, -0.32));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    const sheen = ctx.createRadialGradient(size * 0.74, size * 0.2, size * 0.02, size * 0.74, size * 0.2, size * 0.82);
    sheen.addColorStop(0, 'rgba(255,244,222,0.24)');
    sheen.addColorStop(0.45, 'rgba(255,244,222,0.08)');
    sheen.addColorStop(1, 'rgba(255,244,222,0)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, size, size);

    if (song) {
      let seed = 0;
      for (const char of song.title) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
      const rng = (slot: number): number => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return ((seed >>> 8) + slot * 7919) % 1000 / 1000;
      };
      ctx.save();
      for (let i = 0; i < 60; i += 1) {
        const x = rng(i) * size;
        const y = rng(i + 97) * size;
        const r = 0.5 + rng(i + 193) * 2.2;
        ctx.fillStyle = rgba('#fff4dc', 0.04 + rng(i + 311) * 0.06);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    ctx.strokeStyle = 'rgba(255,240,214,0.22)';
    ctx.lineWidth = 10;
    ctx.strokeRect(18, 18, size - 36, size - 36);

    if (song) {
      const titleFont = song.title.length > 14 ? 44 : song.title.length > 9 ? 52 : 62;
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
      ctx.shadowBlur = 18;
      ctx.shadowOffsetY = 4;
      ctx.fillStyle = 'rgba(255,248,235,0.94)';
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.font = `600 ${titleFont}px 'Zilux2 Sans SC', 'Microsoft YaHei', sans-serif`;
      const lines = wrapCoverText(ctx, song.title, size - 128, 2);
      let lineY = size * 0.44;
      for (const line of lines) {
        ctx.fillText(line, 60, lineY);
        lineY += titleFont * 1.12;
      }
      ctx.restore();
      ctx.fillStyle = 'rgba(255,244,226,0.62)';
      ctx.font = `400 21px 'Zilux2 Sans SC', 'Microsoft YaHei', sans-serif`;
      ctx.fillText(song.artist.slice(0, 18), 60, size - 84);
      ctx.fillStyle = 'rgba(255,244,226,0.3)';
      ctx.font = `400 16px 'Zilux2 Sans SC', 'Microsoft YaHei', sans-serif`;
      ctx.textAlign = 'right';
      ctx.fillText('ZILUX2 RECORDS', size - 58, size - 44);
    } else {
      ctx.fillStyle = 'rgba(255,246,232,0.86)';
      ctx.font = `500 46px 'Zilux2 Sans SC', 'Microsoft YaHei', sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('待载入', size / 2, size * 0.56);
      ctx.fillStyle = 'rgba(255,246,232,0.4)';
      ctx.font = `400 20px 'Zilux2 Sans SC', 'Microsoft YaHei', sans-serif`;
      ctx.fillText('ZILUX2 RECORDS', size / 2, size * 0.68);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/** 木地板贴图：底色 + 板缝 + 细微噪点（程序生成，避免额外资源）。 */
function makeFloorTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#241b13';
    ctx.fillRect(0, 0, size, size);
    for (let row = 0; row < 8; row += 1) {
      const y = (row / 8) * size;
      const shadeBase = 0.03 + (row % 3) * 0.014;
      ctx.fillStyle = `rgba(255,214,168,${shadeBase})`;
      ctx.fillRect(0, y + 1, size, size / 8 - 2);
      ctx.fillStyle = 'rgba(8,5,3,0.55)';
      ctx.fillRect(0, y, size, 2);
      ctx.fillStyle = 'rgba(255,226,180,0.06)';
      ctx.fillRect(0, y + 3, size, 1);
    }
    for (let i = 0; i < 1400; i += 1) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      ctx.fillStyle = `rgba(255,220,180,${Math.random() * 0.05})`;
      ctx.fillRect(x, y, 1 + Math.random() * 2, 1);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(6, 6);
  return texture;
}

/** 墙面贴图：深色灰泥 + 噪点。 */
function makeWallTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#3a2d22';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 5200; i += 1) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      ctx.fillStyle = Math.random() > 0.5 ? `rgba(255,226,186,${Math.random() * 0.035})` : `rgba(0,0,0,${Math.random() * 0.05})`;
      ctx.fillRect(x, y, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 2);
  return texture;
}

/** 吊牌贴图：黑底 + 铜色字 + 细边框。 */
function makeSignTexture(): THREE.CanvasTexture {
  const width = 1024;
  const height = 216;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#120d0a';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(200, 162, 106, 0.55)';
    ctx.lineWidth = 6;
    ctx.strokeRect(10, 10, width - 20, height - 20);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#d8b071';
    ctx.font = `500 86px 'Zilux2 Sans SC', 'Microsoft YaHei', sans-serif`;
    ctx.fillText('ZILUX2 · 唱片店', width / 2, height / 2 - 6);
    ctx.fillStyle = 'rgba(216, 176, 113, 0.55)';
    ctx.font = `400 22px 'Zilux2 Sans SC', 'Microsoft YaHei', sans-serif`;
    ctx.fillText('RECORDS · VINYL · LISTENING ROOM', width / 2, height / 2 + 62);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** 墙上海报：深色底 + 抽象色块 + 标题。 */
function makePosterTexture(title: string, base: string): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#191310';
    ctx.fillRect(0, 0, size, size);
    const grad = ctx.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, shade(base, 0.1));
    grad.addColorStop(1, '#0e0b08');
    ctx.fillStyle = grad;
    ctx.fillRect(46, 46, size - 92, size - 92);
    ctx.strokeStyle = 'rgba(255, 226, 180, 0.28)';
    ctx.lineWidth = 4;
    ctx.strokeRect(46, 46, size - 92, size - 92);
    ctx.beginPath();
    ctx.arc(size / 2, size * 0.44, size * 0.2, 0, Math.PI * 2);
    ctx.fillStyle = rgba('#f2ddb8', 0.16);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(size / 2, size * 0.44, size * 0.06, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20, 14, 10, 0.85)';
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 238, 210, 0.88)';
    ctx.textAlign = 'center';
    ctx.font = `500 34px 'Zilux2 Sans SC', 'Microsoft YaHei', sans-serif`;
    ctx.fillText(title, size / 2, size - 78);
    ctx.fillStyle = 'rgba(255, 238, 210, 0.4)';
    ctx.font = `400 18px 'Zilux2 Sans SC', 'Microsoft YaHei', sans-serif`;
    ctx.fillText('ZILUX2 RECORDS', size / 2, size - 44);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** 径向光晕贴图：尘埃 / 灯头泛光共用。 */
function makeGlowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255,244,220,1)');
    grad.addColorStop(0.35, 'rgba(255,236,200,0.5)');
    grad.addColorStop(1, 'rgba(255,236,200,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

class StoreSceneImpl implements StoreScene {
  readonly root: HTMLElement;

  private readonly options: StoreSceneOptions;
  private readonly quality: { dpr: number; dust: number };

  private readonly canvas: HTMLCanvasElement;
  private readonly fade: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly card: HTMLElement;
  private readonly cardArt: HTMLElement;
  private readonly cardTitle: HTMLElement;
  private readonly cardArtist: HTMLElement;
  private readonly cardMeta: HTMLElement;
  private fallbackBox: HTMLElement | null = null;

  private renderer: THREE.WebGLRenderer | null = null;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2(-10, -10);

  private readonly covers: CoverSlot[] = [];
  private readonly coverMeshes: THREE.Mesh[] = [];
  private readonly textures: THREE.Texture[] = [];
  private readonly disposables: Array<{ dispose: () => void }> = [];

  private dust: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> | null = null;
  private dustOrigin: Float32Array | null = null;

  private readonly currentPos = new THREE.Vector3();
  private readonly currentLook = new THREE.Vector3();
  private readonly focusCamPos = new THREE.Vector3();
  private readonly focusLook = new THREE.Vector3();

  private yaw = BASE_YAW;
  private yawTarget = BASE_YAW;
  private pitch = BASE_PITCH;
  private pitchTarget = BASE_PITCH;
  private distance = BASE_DISTANCE;
  private distanceTarget = BASE_DISTANCE;

  private focused = -1;
  private hovered = -1;
  private activeTrackKey: string | null = null;

  private dragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragMoved = 0;
  private pointerDownAt = 0;

  private raf = 0;
  private disposed = false;
  private readonly clock = new THREE.Clock();
  private fpsFrames = 0;
  private fpsTime = 0;
  private fps = 0;
  private hintTimer = 0;
  private resizeObserver: ResizeObserver | null = null;
  private readonly startAt = performance.now();

  constructor(options: StoreSceneOptions = {}) {
    this.options = options;
    this.quality = QUALITY_PRESETS[options.quality ?? 'high'];

    this.root = el('div', 'zl-store-scene');
    this.canvas = el('canvas');
    this.canvas.className = 'zls-canvas';
    const fade = el('div', 'zls-fade');
    const hint = el('div', 'zls-hint', '拖拽环视 · 滚轮推进 · 点击唱片聚焦 · Esc 返回');
    const vignette = el('div', 'zls-vignette');

    const card = el('div', 'zls-card');
    const art = el('div', 'zls-card-art');
    const title = el('div', 'zls-card-title', '');
    const artist = el('div', 'zls-card-artist', '');
    const meta = el('div', 'zls-card-meta', '');
    const actions = el('div', 'zls-card-actions');
    const playBtn = el('button', 'zls-btn is-primary', '播放');
    const backBtn = el('button', 'zls-btn', '返回');
    actions.append(playBtn, backBtn);
    card.append(art, title, artist, meta, actions);

    this.fade = fade;
    this.hint = hint;
    this.card = card;
    this.cardArt = art;
    this.cardTitle = title;
    this.cardArtist = artist;
    this.cardMeta = meta;

    this.root.append(this.canvas, vignette, fade, hint, card);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x120d09, 0.075);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 60);
    this.currentPos.set(0, 1.7, BASE_DISTANCE);
    this.currentLook.copy(BASE_TARGET);
    this.camera.position.copy(this.currentPos);
    this.camera.lookAt(this.currentLook);

    playBtn.addEventListener('click', () => {
      const slot = this.covers[this.focused];
      if (slot?.song) this.options.onPlay?.(slot.song);
    });
    backBtn.addEventListener('click', () => this.resetView());

    if (!this.initWebGL()) return;
    this.buildRoom();
    this.buildShelf();
    this.buildDust();
    this.bindEvents();
    this.setCollections([]);
    this.startLoop();
  }

  // ---------- 初始化 ----------

  private initWebGL(): boolean {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2');
    if (!gl) {
      this.renderFallback();
      return false;
    }
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    } catch {
      this.renderFallback();
      return false;
    }
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.setClearColor(0x0b0806, 1);
    this.applySize();
    return true;
  }

  private renderFallback(): void {
    this.root.classList.add('is-fallback');
    this.fade.style.display = 'none';
    this.hint.style.display = 'none';
    this.fallbackBox = el('div', 'zls-fallback');
    this.fallbackBox.append(
      el('div', 'zls-fallback-title', '唱片店需要 WebGL2'),
      el('div', 'zls-fallback-hint', '当前环境不支持 3D 渲染，已回退为扁平货架列表；功能保持一致。'),
      el('div', 'zls-fallback-grid'),
    );
    this.root.append(this.fallbackBox);
    this.options.onFallback?.();
  }

  private buildRoom(): void {
    const renderer = this.renderer;
    if (!renderer) return;

    const floorTexture = makeFloorTexture();
    this.textures.push(floorTexture);
    const floorMat = new THREE.MeshStandardMaterial({ map: floorTexture, color: 0x9a7f60, roughness: 0.82, metalness: 0.08 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(36, 36), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, 1.2);
    this.scene.add(floor);
    this.disposables.push(floor.geometry, floorMat);

    const wallTexture = makeWallTexture();
    this.textures.push(wallTexture);
    const wallMat = new THREE.MeshStandardMaterial({ map: wallTexture, color: 0xb29a80, roughness: 0.96, metalness: 0.02 });
    const backWall = new THREE.Mesh(new THREE.PlaneGeometry(18, 6), wallMat);
    backWall.position.set(0, 2.6, -1.05);
    this.scene.add(backWall);
    this.disposables.push(backWall.geometry, wallMat);

    const sideMat = new THREE.MeshStandardMaterial({ color: 0x1c1510, roughness: 0.98, metalness: 0 });
    for (const side of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(14, 6), sideMat);
      wall.position.set(side * 5.4, 2.6, 2.6);
      wall.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      this.scene.add(wall);
      this.disposables.push(wall.geometry);
    }
    this.disposables.push(sideMat);

    const ceilingMat = new THREE.MeshStandardMaterial({ color: 0x120d0a, roughness: 1, metalness: 0 });
    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), ceilingMat);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(0, 3.3, 2);
    this.scene.add(ceiling);
    this.disposables.push(ceiling.geometry, ceilingMat);

    // 地面地毯：径向渐变，给货架前一块暖色区域。
    const rugTexture = makeGlowTexture();
    this.textures.push(rugTexture);
    const rugMat = new THREE.MeshBasicMaterial({ map: rugTexture, color: 0x6b4a2a, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending });
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 5.2), rugMat);
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(0, 0.012, 1.2);
    this.scene.add(rug);
    this.disposables.push(rug.geometry, rugMat);

    this.scene.add(new THREE.HemisphereLight(0xffe4bd, 0x120c08, 0.62));

    const keyLight = new THREE.DirectionalLight(0xffd8a4, 0.62);
    keyLight.position.set(3.2, 4.1, 3.4);
    this.scene.add(keyLight);

    const fillLight = new THREE.PointLight(0xffcf9a, 7, 9, 1.6);
    fillLight.position.set(-1.2, 1.7, 4.2);
    this.scene.add(fillLight);

    for (const side of [-1, 1] as const) {
      const wallGlow = new THREE.PointLight(0xffb877, 12, 11, 1.7);
      wallGlow.position.set(side * 3.1, 3.0, 2.2);
      this.scene.add(wallGlow);
    }

    // 轨道灯：三盏聚光 + 灯头 + 泛光片 + 地面光池，营造唱片店的暖光池。
    const glowTexture = makeGlowTexture();
    this.textures.push(glowTexture);
    const spotPositions: Array<[number, number]> = [
      [-2.05, 1.1],
      [0, 1.35],
      [2.05, 1.1],
    ];
    for (const [x, z] of spotPositions) {
      const spot = new THREE.SpotLight(0xffc98c, 12, 9, 0.6, 0.85, 1.8);
      spot.position.set(x, 3.05, z);
      spot.target.position.set(x * 0.42, 1.05, 0.1);
      this.scene.add(spot, spot.target);

      const fixtureMat = new THREE.MeshStandardMaterial({ color: 0x2a2521, roughness: 0.5, metalness: 0.85 });
      const fixture = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.058, 0.2, 18), fixtureMat);
      fixture.position.set(x, 3.12, z);
      this.scene.add(fixture);
      this.disposables.push(fixture.geometry, fixtureMat);

      const glowMat = new THREE.MeshBasicMaterial({ map: glowTexture, color: 0xffd6a0, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending });
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 0.85), glowMat);
      glow.position.set(x, 3.02, z);
      glow.rotation.x = -Math.PI / 2;
      this.scene.add(glow);
      this.disposables.push(glow.geometry, glowMat);

      // 地面上的暖色光池：让“店”有地面纵深，而不是漂浮的书柜。
      const poolMat = new THREE.MeshBasicMaterial({ map: glowTexture, color: 0xffb670, transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending });
      const pool = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 3.1), poolMat);
      pool.rotation.x = -Math.PI / 2;
      pool.position.set(x * 1.15, 0.02, z + 0.55);
      this.scene.add(pool);
      this.disposables.push(pool.geometry, poolMat);

      // 后墙洗墙光：让墙面有被灯照到的层次。
      const washMat = new THREE.MeshBasicMaterial({ map: glowTexture, color: 0xffc182, transparent: true, opacity: 0.1, depthWrite: false, blending: THREE.AdditiveBlending });
      const wash = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 2.5), washMat);
      wash.position.set(x, 2.05, -1.02);
      this.scene.add(wash);
      this.disposables.push(wash.geometry, washMat);
    }

    const railMat = new THREE.MeshStandardMaterial({ color: 0x3a322a, roughness: 0.42, metalness: 0.9 });
    const rail = new THREE.Mesh(new THREE.BoxGeometry(5.1, 0.045, 0.065), railMat);
    rail.position.set(0, 3.2, 1.2);
    this.scene.add(rail);
    this.disposables.push(rail.geometry, railMat);

    // 两侧的唱片箱，增加“店”的纵深。
    const crateMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1d, roughness: 0.85, metalness: 0.05 });
    const crateGeo = new THREE.BoxGeometry(0.62, 0.34, 0.42);
    for (const [x, z, rot] of [
      [-2.75, 1.35, 0.18],
      [2.75, 1.35, -0.18],
    ] as const) {
      const crate = new THREE.Mesh(crateGeo, crateMat);
      crate.position.set(x, 0.17, z);
      crate.rotation.y = rot;
      this.scene.add(crate);
    }
    this.disposables.push(crateGeo, crateMat);

    // 两侧高唱片架：只作为前景剪影，给画面左右边界一点“店”的重量。
    const rackMat = new THREE.MeshStandardMaterial({ color: 0x241a12, roughness: 0.88, metalness: 0.04 });
    for (const side of [-1, 1]) {
      const rack = new THREE.Mesh(new THREE.BoxGeometry(1.05, 1.68, 0.5), rackMat);
      rack.position.set(side * 2.62, 0.9, -0.15);
      rack.rotation.y = side * 0.1;
      this.scene.add(rack);
      this.disposables.push(rack.geometry);
      const recordMat = new THREE.MeshStandardMaterial({ color: 0x12100d, roughness: 0.7, metalness: 0.06 });
      for (let i = 0; i < 6; i += 1) {
        const disc = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.44 + (i % 3) * 0.012, 0.4), recordMat);
        disc.position.set(side * 2.62 - 0.42 + i * 0.14, 1.42, -0.42);
        disc.rotation.y = side * 0.1;
        this.scene.add(disc);
        this.disposables.push(disc.geometry);
      }
      this.disposables.push(recordMat);
    }
    this.disposables.push(rackMat);

    // 吊牌
    const signTexture = makeSignTexture();
    this.textures.push(signTexture);
    const signMat = new THREE.MeshBasicMaterial({ map: signTexture, transparent: true });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.7, 0.57), signMat);
    sign.position.set(0, 2.92, -0.96);
    this.scene.add(sign);
    this.disposables.push(sign.geometry, signMat);

    // 后墙海报
    const posterData: Array<[string, string, number]> = [
      ['午夜唱片', '#7d4b5c', -3.55],
      ['夜航星', '#3d5068', 3.55],
    ];
    for (const [title, color, x] of posterData) {
      const texture = makePosterTexture(title, color);
      this.textures.push(texture);
      const mat = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.85, metalness: 0.02 });
      const poster = new THREE.Mesh(new THREE.PlaneGeometry(0.96, 0.96), mat);
      poster.position.set(x, 1.95, -0.92);
      this.scene.add(poster);
      this.disposables.push(poster.geometry, mat);
    }

    // 视听桌 + 唱片机（右侧前景，让镜头有“店内”参照物）
    const tableMat = new THREE.MeshStandardMaterial({ color: 0x4a3625, roughness: 0.7, metalness: 0.08 });
    const tableTop = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.055, 0.72), tableMat);
    tableTop.position.set(2.6, 0.74, 2.35);
    this.scene.add(tableTop);
    this.disposables.push(tableTop.geometry, tableMat);
    const legGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.74, 10);
    for (const [lx, lz] of [
      [2.14, 2.06],
      [3.06, 2.06],
      [2.14, 2.64],
      [3.06, 2.64],
    ] as const) {
      const leg = new THREE.Mesh(legGeo, tableMat);
      leg.position.set(lx, 0.37, lz);
      this.scene.add(leg);
    }
    this.disposables.push(legGeo);

    const plinthMat = new THREE.MeshStandardMaterial({ color: 0x1b1613, roughness: 0.55, metalness: 0.35 });
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.1, 0.48), plinthMat);
    plinth.position.set(2.6, 0.81, 2.35);
    this.scene.add(plinth);
    this.disposables.push(plinth.geometry, plinthMat);

    const platterMat = new THREE.MeshStandardMaterial({ color: 0x141210, roughness: 0.36, metalness: 0.5 });
    const platter = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.022, 48), platterMat);
    platter.position.set(2.54, 0.874, 2.35);
    this.scene.add(platter);
    this.disposables.push(platter.geometry, platterMat);

    const labelMat = new THREE.MeshStandardMaterial({ color: 0xc99f66, roughness: 0.6, metalness: 0.2 });
    const label = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.024, 32), labelMat);
    label.position.set(2.54, 0.885, 2.35);
    this.scene.add(label);
    this.disposables.push(label.geometry, labelMat);

    const armMat = new THREE.MeshStandardMaterial({ color: 0xb08a54, roughness: 0.32, metalness: 0.9 });
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.012, 0.022), armMat);
    arm.position.set(2.75, 0.9, 2.26);
    arm.rotation.y = 0.55;
    this.scene.add(arm);
    this.disposables.push(arm.geometry, armMat);

    // 桌边的唱片堆
    const stackMat = new THREE.MeshStandardMaterial({ color: 0x2a2118, roughness: 0.75, metalness: 0.05 });
    const stackGeo = new THREE.BoxGeometry(0.31, 0.02, 0.31);
    for (let i = 0; i < 5; i += 1) {
      const record = new THREE.Mesh(stackGeo, stackMat);
      record.position.set(3.0, 0.782 + i * 0.021, 2.02);
      record.rotation.y = i * 0.09;
      this.scene.add(record);
    }
    this.disposables.push(stackGeo, stackMat);

    // 左侧听歌椅
    const chairMat = new THREE.MeshStandardMaterial({ color: 0x3f2e21, roughness: 0.8, metalness: 0.04 });
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.06, 0.52), chairMat);
    seat.position.set(-2.85, 0.44, 1.55);
    this.scene.add(seat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.5, 0.05), chairMat);
    back.position.set(-2.85, 0.72, 1.8);
    back.rotation.x = -0.12;
    this.scene.add(back);
    this.disposables.push(seat.geometry, back.geometry, chairMat);

    // 左侧前景：唱片箱 + 插着几张唱片
    const binMat = new THREE.MeshStandardMaterial({ color: 0x33251a, roughness: 0.85, metalness: 0.05 });
    const bin = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.52, 0.62), binMat);
    bin.position.set(-2.55, 0.26, 1.9);
    bin.rotation.y = 0.16;
    this.scene.add(bin);
    this.disposables.push(bin.geometry, binMat);
    const discMat = new THREE.MeshStandardMaterial({ color: 0x171310, roughness: 0.6, metalness: 0.1 });
    for (let i = 0; i < 4; i += 1) {
      const disc = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.42, 0.4), discMat);
      disc.position.set(-2.97 + i * 0.24, 0.62, 1.8);
      disc.rotation.y = 0.16;
      this.scene.add(disc);
      this.disposables.push(disc.geometry);
    }
    this.disposables.push(discMat);
  }

  private buildShelf(): void {
    const shelfWidth = COLS * (COVER_SIZE + COVER_GAP_X) + 0.1;
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x4a3625, roughness: 0.62, metalness: 0.12 });
    const brassMat = new THREE.MeshStandardMaterial({ color: 0xb08a54, roughness: 0.3, metalness: 0.9 });
    const backMat = new THREE.MeshStandardMaterial({ color: 0x211a13, roughness: 0.92, metalness: 0.04 });

    // 柜体背板
    const backPanel = new THREE.Mesh(new THREE.BoxGeometry(shelfWidth + 0.35, 2.35, 0.06), backMat);
    backPanel.position.set(0, 1.28, -0.32);
    this.scene.add(backPanel);
    this.disposables.push(backPanel.geometry, backMat);

    // 左右立板 + 顶板 + 每排搁板 + 铜条
    for (const side of [-1, 1]) {
      const board = new THREE.Mesh(new THREE.BoxGeometry(0.07, 2.35, 0.52), woodMat);
      board.position.set(side * (shelfWidth / 2 + 0.08), 1.28, -0.02);
      this.scene.add(board);
      this.disposables.push(board.geometry);
    }
    const top = new THREE.Mesh(new THREE.BoxGeometry(shelfWidth + 0.4, 0.08, 0.56), woodMat);
    top.position.set(0, 2.42, -0.02);
    this.scene.add(top);
    this.disposables.push(top.geometry);

    for (let row = 0; row < ROWS; row += 1) {
      const plank = new THREE.Mesh(new THREE.BoxGeometry(shelfWidth + 0.24, PLANK_THICKNESS, 0.54), woodMat);
      plank.position.set(0, ROW_Y[row] - COVER_SIZE / 2 - 0.1, -0.01);
      this.scene.add(plank);
      this.disposables.push(plank.geometry);

      const brass = new THREE.Mesh(new THREE.BoxGeometry(shelfWidth + 0.24, 0.012, 0.014), brassMat);
      brass.position.set(0, ROW_Y[row] - COVER_SIZE / 2 - 0.072, 0.27);
      this.scene.add(brass);
      this.disposables.push(brass.geometry);
    }
    this.disposables.push(woodMat, brassMat);

    // 唱片：黑胶托盘 + 封面，两者一起缩放/高亮。
    const frameGeo = new THREE.PlaneGeometry(COVER_SIZE + 0.065, COVER_SIZE + 0.065);
    const coverGeo = new THREE.PlaneGeometry(COVER_SIZE, COVER_SIZE);
    this.disposables.push(frameGeo, coverGeo);

    let index = 0;
    for (let row = 0; row < ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) {
        const x = (col - (COLS - 1) / 2) * (COVER_SIZE + COVER_GAP_X);
        const group = new THREE.Group();
        group.position.set(x, ROW_Y[row], 0.0);

        const frameMat = new THREE.MeshStandardMaterial({ color: 0x120d09, roughness: 0.55, metalness: 0.35, emissive: 0x000000 });
        const frame = new THREE.Mesh(frameGeo, frameMat);
        frame.position.z = -0.002;
        this.disposables.push(frameMat);

        const coverMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.72, metalness: 0.04 });
        const cover = new THREE.Mesh(coverGeo, coverMat);
        cover.position.z = 0.006;
        this.disposables.push(coverMat);
        this.coverMeshes.push(cover);

        group.add(frame, cover);
        this.scene.add(group);
        this.covers.push({ index, group, cover, frame, texture: null, song: null, neutralScale: 1, hovered: false });
        index += 1;
      }
    }
  }

  private buildDust(): void {
    const count = this.quality.dust;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = (Math.random() - 0.5) * 8;
      positions[i * 3 + 1] = 0.15 + Math.random() * 2.8;
      positions[i * 3 + 2] = -0.8 + Math.random() * 4.4;
    }
    this.dustOrigin = positions.slice();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const glow = makeGlowTexture();
    this.textures.push(glow);
    const material = new THREE.PointsMaterial({
      size: 0.028,
      map: glow,
      color: 0xffe2b8,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.dust = new THREE.Points(geometry, material);
    this.scene.add(this.dust);
    this.disposables.push(geometry, material);
  }

  // ---------- 数据 ----------

  setCollections(collections: StoreSceneCollection[]): void {
    if (this.root.classList.contains('is-fallback')) {
      this.fillFallback(collections);
      return;
    }
    const songs: Array<StoreSceneSong | null> = [];
    for (const collection of collections) {
      for (const song of collection.songs) {
        if (songs.length >= COLS * ROWS) break;
        songs.push(song);
      }
      if (songs.length >= COLS * ROWS) break;
    }
    for (const slot of this.covers) {
      const song = songs[slot.index] ?? null;
      slot.song = song;
      const material = slot.cover.material;
      material.map?.dispose();
      if (slot.texture) {
        const position = this.textures.indexOf(slot.texture);
        if (position >= 0) this.textures.splice(position, 1);
        slot.texture.dispose();
        slot.texture = null;
      }
      const texture = makeCoverTexture(song, slot.index);
      slot.texture = texture;
      this.textures.push(texture);
      material.map = texture;
      material.color.set(0xffffff);
      material.needsUpdate = true;
    }
    this.syncActiveHighlight();
  }

  setActiveTrack(trackKey: string | null): void {
    this.activeTrackKey = trackKey;
    this.syncActiveHighlight();
  }

  private syncActiveHighlight(): void {
    for (const slot of this.covers) {
      const isActive = Boolean(this.activeTrackKey && slot.song && slot.song.trackKey === this.activeTrackKey);
      slot.frame.material.emissive.setHex(isActive ? 0x6f9d8b : 0x000000);
      slot.frame.material.emissiveIntensity = isActive ? 0.35 : 0;
    }
  }

  private fillFallback(collections: StoreSceneCollection[]): void {
    const grid = this.fallbackBox?.querySelector('.zls-fallback-grid');
    if (!grid) return;
    grid.innerHTML = '';
    const songs = collections.flatMap((collection) => collection.songs).slice(0, COLS * ROWS);
    for (const song of songs) {
      const card = el('button', 'zls-fallback-card');
      const art = el('span', 'zls-fallback-art');
      art.style.background = `linear-gradient(140deg, ${song.color ?? '#c9a068'}, #2a2119)`;
      art.textContent = song.title.slice(0, 4);
      card.append(art, el('span', 'zls-fallback-name', song.title), el('span', 'zls-fallback-artist', song.artist));
      card.addEventListener('click', () => this.options.onPlay?.(song));
      grid.append(card);
    }
  }

  // ---------- 交互 ----------

  private bindEvents(): void {
    const canvas = this.canvas;
    canvas.addEventListener('pointerdown', this.handlePointerDown);
    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.handlePointerUp);
    canvas.addEventListener('wheel', this.handleWheel, { passive: false });
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('resize', this.handleResize);
    this.resizeObserver = new ResizeObserver(() => this.applySize());
    this.resizeObserver.observe(this.root);
    document.addEventListener('visibilitychange', this.handleVisibility);
    this.hintTimer = window.setTimeout(() => this.hint.classList.add('is-hidden'), 6500);
  }

  private handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    this.dragging = true;
    this.dragMoved = 0;
    this.pointerDownAt = performance.now();
    this.dragStartX = event.clientX;
    this.dragStartY = event.clientY;
    this.root.classList.add('is-dragging');
    this.canvas.setPointerCapture?.(event.pointerId);
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (this.dragging) {
      const dx = event.clientX - this.dragStartX;
      const dy = event.clientY - this.dragStartY;
      this.dragStartX = event.clientX;
      this.dragStartY = event.clientY;
      this.dragMoved += Math.abs(dx) + Math.abs(dy);
      if (this.focused >= 0) this.resetView();
      this.yawTarget = clamp(this.yawTarget + dx * 0.0042, BASE_YAW - 0.95, BASE_YAW + 0.95);
      this.pitchTarget = clamp(this.pitchTarget + dy * 0.0028, -0.16, 0.34);
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.updateHover();
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (!this.dragging) return;
    this.dragging = false;
    this.root.classList.remove('is-dragging');
    this.canvas.releasePointerCapture?.(event.pointerId);
    const quick = performance.now() - this.pointerDownAt < 420 && this.dragMoved < 8;
    if (!quick) return;
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    const hit = this.pick();
    if (hit >= 0) {
      this.focusIndex(hit);
    } else if (this.focused >= 0) {
      this.resetView();
    }
  };

  private handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.distanceTarget = clamp(this.distanceTarget + event.deltaY * 0.0017, 2.15, 7.4);
    if (this.focused >= 0) this.resetView();
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      if (this.focused >= 0) this.resetView();
      return;
    }
    if (this.focused >= 0 && (event.key === 'Enter' || event.key === ' ')) {
      const slot = this.covers[this.focused];
      if (slot?.song) this.options.onPlay?.(slot.song);
    }
  };

  resize(): void {
    this.applySize();
  }

  private handleResize = (): void => {
    this.applySize();
  };

  private handleVisibility = (): void => {
    if (document.hidden) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    } else if (!this.disposed && !this.raf) {
      this.clock.getDelta();
      this.startLoop();
    }
  };

  private applySize(): void {
    if (!this.renderer) return;
    const width = Math.max(1, this.root.clientWidth);
    const height = Math.max(1, this.root.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality.dpr));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  // ---------- 相机 / 聚焦 ----------

  resetView(): void {
    this.focused = -1;
    this.card.classList.remove('is-open');
    this.options.onFocus?.(null);
  }

  focusIndex(index: number): void {
    const slot = this.covers[index];
    if (!slot) return;
    this.focused = index;
    const position = slot.group.position;
    const world = new THREE.Vector3(position.x, position.y, position.z);
    // 相机站在封面正前方稍微偏下的位置，看向封面中心。
    this.focusCamPos.set(world.x * 0.94, world.y + 0.03, world.z + FOCUS_DISTANCE);
    this.focusLook.set(world.x * 0.96, world.y - 0.015, world.z);
    this.options.onFocus?.(slot.song);
    this.cardArt.style.background = `linear-gradient(140deg, ${slot.song?.color ?? '#c9a068'}, #2b2118)`;
    this.cardArt.textContent = slot.song ? Array.from(slot.song.title)[0] ?? '' : '·';
    this.cardTitle.textContent = slot.song?.title ?? '未载入唱片';
    this.cardArtist.textContent = slot.song ? `${slot.song.artist}` : '——';
    this.cardMeta.textContent = slot.song?.album ? `专辑 · ${slot.song.album}` : 'Zilux2 唱片店 · 原型';
    this.card.classList.add('is-open');
  }

  get focusedIndex(): number {
    return this.focused;
  }

  private updateHover(): void {
    const hit = this.pick();
    if (hit === this.hovered) return;
    this.hovered = hit;
    this.root.classList.toggle('is-hovering', hit >= 0);
  }

  private pick(): number {
    if (!this.renderer) return -1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.coverMeshes, false);
    const first = hits[0];
    if (!first) return -1;
    const found = this.covers.find((slot) => slot.cover === first.object);
    return found ? found.index : -1;
  }

  // ---------- 渲染循环 ----------

  private startLoop(): void {
    if (this.disposed || this.raf) return;
    this.clock.getDelta();
    const tick = (): void => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(tick);
      const dt = Math.min(this.clock.getDelta(), 0.05);
      this.update(dt);
      this.renderer?.render(this.scene, this.camera);
      this.countFps(dt);
    };
    this.raf = requestAnimationFrame(tick);
    this.root.classList.add('is-ready');
  }

  private update(dt: number): void {
    const time = (performance.now() - this.startAt) / 1000;

    if (this.focused >= 0) {
      this.camera.position.lerp(this.focusCamPos, 1 - Math.exp(-7.4 * dt));
      this.currentLook.lerp(this.focusLook, 1 - Math.exp(-7.4 * dt));
    } else {
      this.yaw = damp(this.yaw, this.yawTarget, 5.4, dt);
      this.pitch = damp(this.pitch, this.pitchTarget, 5.4, dt);
      this.distance = damp(this.distance, this.distanceTarget, 5.0, dt);
      const cosPitch = Math.cos(this.pitch);
      const desired = new THREE.Vector3(
        BASE_TARGET.x + Math.sin(this.yaw) * cosPitch * this.distance,
        BASE_TARGET.y + Math.sin(this.pitch) * this.distance,
        BASE_TARGET.z + Math.cos(this.yaw) * cosPitch * this.distance,
      );
      this.camera.position.lerp(desired, 1 - Math.exp(-7 * dt));
      this.currentLook.lerp(BASE_TARGET, 1 - Math.exp(-7 * dt));
    }
    this.camera.lookAt(this.currentLook);

    for (const slot of this.covers) {
      const wanted = slot.hovered ? 1.045 : 1;
      slot.group.scale.setScalar(damp(slot.group.scale.x, wanted, 9, dt));
      const hoverIdle = time * 0.0022;
      slot.cover.position.z = 0.006 + Math.sin(hoverIdle + slot.index) * 0.0006;
    }

    if (this.dust && this.dustOrigin) {
      const positionAttr = this.dust.geometry.getAttribute('position') as THREE.BufferAttribute;
      const array = positionAttr.array as Float32Array;
      for (let i = 0; i < array.length / 3; i += 1) {
        const baseY = this.dustOrigin[i * 3 + 1];
        const baseX = this.dustOrigin[i * 3];
        array[i * 3 + 1] = 0.15 + ((baseY - 0.15 + time * 0.018 + i * 0.013) % 2.85);
        array[i * 3] = baseX + Math.sin(time * 0.22 + i) * 0.055;
      }
      positionAttr.needsUpdate = true;
    }
  }

  private countFps(dt: number): void {
    this.fpsFrames += 1;
    this.fpsTime += dt;
    if (this.fpsTime >= 0.5) {
      this.fps = this.fpsFrames / this.fpsTime;
      this.fpsFrames = 0;
      this.fpsTime = 0;
    }
  }

  // ---------- 对外状态 ----------

  stats(): StoreSceneStats {
    const info = this.renderer?.info;
    return {
      fps: Math.round(this.fps || 60),
      drawCalls: info?.render.calls ?? 0,
      triangles: info?.render.triangles ?? 0,
      dpr: this.renderer?.getPixelRatio() ?? 1,
      width: this.renderer?.domElement.width ?? 0,
      height: this.renderer?.domElement.height ?? 0,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    window.clearTimeout(this.hintTimer);
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('resize', this.handleResize);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    document.removeEventListener('visibilitychange', this.handleVisibility);
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('wheel', this.handleWheel);
    for (const item of this.disposables) item.dispose();
    for (const texture of this.textures) texture.dispose();
    this.textures.length = 0;
    this.renderer?.dispose();
    this.renderer = null;
    this.root.remove();
  }
}

/** 创建「唱片店」空间场景并发到指定容器上。 */
export function createStoreScene(host: HTMLElement, options: StoreSceneOptions = {}): StoreScene {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_CSS;
    document.head.append(style);
  }
  const scene = new StoreSceneImpl(options);
  host.append(scene.root);
  requestAnimationFrame(() => scene.resize());
  scene.root.classList.add('is-entering');
  requestAnimationFrame(() => scene.root.classList.remove('is-entering'));
  window.setTimeout(() => options.onReady?.(), 60);
  return scene;
}

const STYLE_CSS = `
.zl-store-scene {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: #0b0806;
  color: #f5ead8;
  font-family: 'Zilux2 Sans SC', 'Microsoft YaHei', 'PingFang SC', sans-serif;
  user-select: none;
  -webkit-user-select: none;
  cursor: grab;
  opacity: 1;
  transition: opacity 0.6s ease;
}
.zl-store-scene.is-entering { opacity: 0; }
.zl-store-scene.is-dragging { cursor: grabbing; }
.zl-store-scene.is-hovering { cursor: pointer; }
.zl-store-scene .zls-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.zl-store-scene .zls-vignette {
  position: absolute; inset: 0; pointer-events: none;
  background:
    radial-gradient(ellipse at 50% 42%, rgba(0, 0, 0, 0) 44%, rgba(0, 0, 0, 0.46) 100%),
    linear-gradient(180deg, rgba(9, 6, 4, 0.55) 0%, rgba(9, 6, 4, 0) 24%, rgba(9, 6, 4, 0) 74%, rgba(7, 5, 3, 0.62) 100%);
}
.zl-store-scene .zls-fade {
  position: absolute; inset: 0; pointer-events: none; background: #0b0806;
  opacity: 1; transition: opacity 1.05s ease;
}
.zl-store-scene.is-ready .zls-fade { opacity: 0; }
.zl-store-scene .zls-hint {
  position: absolute; left: 50%; bottom: 26px; transform: translateX(-50%);
  padding: 7px 16px; border-radius: 999px;
  background: rgba(14, 10, 7, 0.45);
  border: 1px solid rgba(255, 226, 180, 0.14);
  color: rgba(255, 238, 214, 0.78);
  font-size: 12.5px; letter-spacing: 0.14em; white-space: nowrap;
  backdrop-filter: blur(8px);
  transition: opacity 0.8s ease;
}
.zl-store-scene .zls-hint.is-hidden { opacity: 0; }
.zl-store-scene .zls-card {
  position: absolute; right: 54px; top: 50%;
  width: 296px; padding: 18px 18px 16px;
  border-radius: 20px;
  background: rgba(247, 243, 236, 0.94);
  color: #24271f;
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(16px);
  opacity: 0; pointer-events: none;
  transform: translateY(-46%) translateX(18px);
  transition: opacity 0.34s ease, transform 0.4s cubic-bezier(0.22, 1, 0.36, 1);
}
.zl-store-scene .zls-card.is-open { opacity: 1; pointer-events: auto; transform: translateY(-46%) translateX(0); }
.zl-store-scene .zls-card-art {
  height: 92px; border-radius: 14px; margin-bottom: 13px;
  display: flex; align-items: center; justify-content: center;
  font-size: 34px; font-weight: 600; color: rgba(255, 248, 235, 0.86); letter-spacing: 0.04em;
  background: linear-gradient(140deg, #c9a068, #2b2118);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16);
}
.zl-store-scene .zls-card-title { font-size: 17.5px; font-weight: 600; letter-spacing: 0.01em; line-height: 1.35; }
.zl-store-scene .zls-card-artist { margin-top: 3px; font-size: 12.5px; color: #6d6a5f; }
.zl-store-scene .zls-card-meta { margin-top: 9px; font-size: 11px; letter-spacing: 0.04em; color: #8b877c; }
.zl-store-scene .zls-card-actions { display: flex; gap: 8px; margin-top: 15px; }
.zl-store-scene .zls-btn {
  flex: 1; height: 34px; border-radius: 10px; border: 1px solid rgba(36, 39, 31, 0.12);
  background: rgba(36, 39, 31, 0.06); color: #2c3028;
  font-family: inherit; font-size: 12.5px; letter-spacing: 0.06em; cursor: pointer;
  transition: background 0.18s ease, border-color 0.18s ease;
}
.zl-store-scene .zls-btn:hover { background: rgba(36, 39, 31, 0.12); }
.zl-store-scene .zls-btn.is-primary { background: #2a332b; border-color: transparent; color: #f6efe2; }
.zl-store-scene .zls-btn.is-primary:hover { background: #35402f; }
.zl-store-scene.is-fallback { display: flex; align-items: center; justify-content: center; cursor: default; background: #171310; }
.zl-store-scene .zls-fallback { width: min(860px, 82vw); text-align: center; }
.zl-store-scene .zls-fallback-title { font-size: 20px; font-weight: 600; letter-spacing: 0.04em; }
.zl-store-scene .zls-fallback-hint { margin-top: 8px; font-size: 12.5px; line-height: 1.8; color: rgba(245, 234, 216, 0.62); }
.zl-store-scene .zls-fallback-grid {
  margin-top: 26px; display: grid; grid-template-columns: repeat(6, 1fr); gap: 14px;
}
.zl-store-scene .zls-fallback-card {
  display: flex; flex-direction: column; gap: 7px; padding: 0; border: 0;
  background: transparent; color: rgba(245, 234, 216, 0.86); cursor: pointer;
  font-family: inherit; text-align: left;
}
.zl-store-scene .zls-fallback-art {
  aspect-ratio: 1 / 1; border-radius: 8px; display: flex; align-items: center; justify-content: center;
  font-size: 15px; color: rgba(255, 248, 235, 0.92);
  box-shadow: inset 0 0 0 1px rgba(255, 240, 214, 0.16);
  transition: transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}
.zl-store-scene .zls-fallback-card:hover .zls-fallback-art { transform: translateY(-3px); }
.zl-store-scene .zls-fallback-name { font-size: 12.5px; }
.zl-store-scene .zls-fallback-artist { font-size: 11px; color: rgba(245, 234, 216, 0.5); }
`;
