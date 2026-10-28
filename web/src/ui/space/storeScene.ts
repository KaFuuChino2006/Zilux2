/**
 * Zilux2 · 「唱片店」空间模式 —— R3 两区结构
 *
 * R3 交互：
 * - 后墙「菜单货架」：6 个分类牌（今日推荐 / 我喜欢的音乐 / 最近播放 / 我的歌单 / 私人雷达 …），点击进入；
 * - 右墙「大唱片架」：6 列 × 4 行 = 24 张/页，滚轮翻页，点击唱片聚焦；
 * - 相机在两个机位之间飞行，Esc 逐级返回（卡片 → 大架 → 菜单 → 退出）；
 * - 降级：无 WebGL2 时渲染成扁平货架列表，功能不中断。
 */

import * as THREE from 'three';
import {
  makeCardboardTexture,
  makeCoverArtTexture,
  makeNeonTexture,
  makeNightWindowTexture,
  makePosterArtTexture,
  makeRugTexture,
  makeLeafTexture,
  makeMenuBoardTexture,
  makeShelfHeaderTexture,
  makeShaftTexture,
  makeVinylDiscTexture,
  makeWallPlasterTexture,
  makeWalnutTexture,
  makeWoodFloorTexture,
} from './storeTextures';

const STYLE_ID = 'zl-store-style';

/** 货架网格：R1 固定 6 列 × 2 排，R2 再按区域扩展。 */
const COLS = 6;
const ROWS = 2;
const COVER_SIZE = 0.5;
const COVER_GAP_X = 0.12;
const ROW_Y = [1.04, 1.72];
/** 相机基准目标点（货架中部）。 */
const BASE_TARGET = new THREE.Vector3(0.1, 1.32, 0);
const BASE_YAW = 0.34;
const BASE_PITCH = 0.11;
const BASE_DISTANCE = 6.9;
const FOCUS_DISTANCE = 1.22;

/** R3：后墙菜单货架（3 列 × 2 行分类牌）。 */
const MENU_COLUMNS = 3;
const MENU_ROWS = 2;
const MENU_BOARD_W = 1.12;
const MENU_BOARD_H = 0.74;
const MENU_BOARD_GAP = 0.18;
const MENU_BOARD_Y = [1.98, 1.18];

/** R3：右墙大唱片架（6 列 × 4 行 = 24 张/页）。 */
const LIB_COLS = 6;
const LIB_ROWS = 4;
const LIB_COVER = 0.52;
const LIB_GAP = 0.16;
const LIB_ROW_Y = [0.88, 1.47, 2.09, 2.71];
const LIB_SHELF_Y = [0.6, 1.19, 1.81, 2.43, 3.02];
const LIB_PANEL_X = 5.32;
const LIB_SHELF_Z = 0.5;

export type StoreZoneName = 'menu' | 'library';

export interface StoreZoneState {
  zone: StoreZoneName;
  title: string;
  count: number;
  page: number;
  pages: number;
}

interface CameraPose {
  target: THREE.Vector3;
  yaw: number;
  pitch: number;
  distance: number;
  yawRange: number;
  pitchMin: number;
  pitchMax: number;
}

const MENU_POSE: CameraPose = {
  target: new THREE.Vector3(0.1, 1.45, 0),
  yaw: BASE_YAW,
  pitch: 0.12,
  distance: 6.6,
  yawRange: 0.9,
  pitchMin: -0.14,
  pitchMax: 0.34,
};

const LIB_POSE: CameraPose = {
  target: new THREE.Vector3(5.05, 1.72, LIB_SHELF_Z),
  yaw: -1.34,
  pitch: 0.0,
  distance: 4.8,
  yawRange: 0.36,
  pitchMin: -0.1,
  pitchMax: 0.26,
};

type QualityName = 'high' | 'medium' | 'low';

const QUALITY_PRESETS: Record<QualityName, { dpr: number; dust: number }> = {
  high: { dpr: 1.5, dust: 220 },
  medium: { dpr: 1.25, dust: 140 },
  low: { dpr: 1, dust: 80 },
};

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
  /** 区域切换（菜单 / 歌单大架），供外层更新面包屑。 */
  onZone?: (state: StoreZoneState) => void;
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
  setCamera(next: { yaw?: number; pitch?: number; distance?: number; targetY?: number }): void;
  resetView(): void;
  focusIndex(index: number): void;
  readonly focusedIndex: number;
  readonly zone: StoreZoneName;
  backToMenu(): void;
  /** 打开指定分类（调试/预览用；界面上走点击分类牌）。 */
  openCollection(index: number): void;
  /** 翻到大架的第 page 页（调试/预览用；界面上走滚轮）。 */
  setPage(page: number): void;
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
  /** 唱片所在墙面的外法线（世界坐标），聚焦时相机沿法线前移。 */
  normal: THREE.Vector3;
}

interface MenuBoardSlot {
  index: number;
  group: THREE.Group;
  plate: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  frame: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  texture: THREE.CanvasTexture | null;
  title: string;
  count: number;
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

/** 把颜色向白 / 黑混合，amount > 0 提亮，< 0 压暗。 */
/** 木地板贴图：底色 + 板缝 + 细微噪点（程序生成，避免额外资源）。 */
/** 墙面贴图：深色灰泥 + 噪点。 */
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
  private readonly menuBoards: MenuBoardSlot[] = [];
  private readonly menuBoardMeshes: THREE.Mesh[] = [];
  private zoneName: StoreZoneName = 'menu';
  private collections: StoreSceneCollection[] = [];
  private activeCollectionIndex = 0;
  private page = 0;
  private libraryHeader: { mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>; texture: THREE.Texture | null } | null = null;
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

  /** 相机围绕的注视点（预览/调试可改）。 */
  private readonly camTarget = BASE_TARGET.clone();
  private readonly camTargetDesired = BASE_TARGET.clone();
  private yawBase = BASE_YAW;
  private yawRange = MENU_POSE.yawRange;
  private pitchMin = MENU_POSE.pitchMin;
  private pitchMax = MENU_POSE.pitchMax;

  private focused = -1;
  private hovered = -1;
  private hoveredKind: 'menu' | 'cover' | '' = '';
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
    const hint = el('div', 'zls-hint', '点击分类牌进入 · 拖拽环视 · 滚轮推进 · Esc 退出');
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
    this.applyEnvironment();
    this.buildRoom();
    this.buildShelf();
    this.buildLibraryShelf();
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
    this.renderer.toneMappingExposure = 0.98;
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

  /** 用程序化环境贴图给黄铜 / 木面一点反射层次。 */
  private applyEnvironment(): void {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 128;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const grad = ctx.createLinearGradient(0, 0, 0, 128);
      grad.addColorStop(0, '#1a120c');
      grad.addColorStop(0.45, '#4a3423');
      grad.addColorStop(0.62, '#8a6236');
      grad.addColorStop(1, '#120c08');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 256, 128);
      // 顶部三团暖光，模拟轨道灯在环境里的高光
      for (const x of [58, 128, 198]) {
        const glow = ctx.createRadialGradient(x, 34, 2, x, 34, 46);
        glow.addColorStop(0, 'rgba(255, 214, 160, 0.9)');
        glow.addColorStop(1, 'rgba(255, 214, 160, 0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, 34, 46, 0, Math.PI * 2);
        ctx.fill();
      }
      const texture = new THREE.CanvasTexture(canvas);
      texture.mapping = THREE.EquirectangularReflectionMapping;
      texture.colorSpace = THREE.SRGBColorSpace;
      const pmrem = new THREE.PMREMGenerator(this.renderer as THREE.WebGLRenderer);
      const envMap = pmrem.fromEquirectangular(texture).texture;
      this.scene.environment = envMap;
      this.scene.environmentIntensity = 0.55;
      this.textures.push(texture, envMap);
      pmrem.dispose();
    } catch {
      // 环境贴图只是加分项，失败不影响场景。
    }
  }

  private buildRoom(): void {
    const renderer = this.renderer;
    if (!renderer) return;

    const floorTexture = makeWoodFloorTexture();
    this.textures.push(floorTexture);
    const floorMat = new THREE.MeshStandardMaterial({ map: floorTexture, color: 0x7a6248, roughness: 0.82, metalness: 0.08 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(36, 36), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, 1.2);
    this.scene.add(floor);
    this.disposables.push(floor.geometry, floorMat);

    const wallTexture = makeWallPlasterTexture();
    this.textures.push(wallTexture);
    const wallMat = new THREE.MeshStandardMaterial({ map: wallTexture, color: 0x8f7a62, roughness: 0.96, metalness: 0.02 });
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

    this.scene.add(new THREE.HemisphereLight(0xffe4bd, 0x120c08, 0.58));

    const keyLight = new THREE.DirectionalLight(0xffd8a4, 0.5);
    keyLight.position.set(3.2, 4.1, 3.4);
    this.scene.add(keyLight);

    const fillLight = new THREE.PointLight(0xffcf9a, 5, 9, 1.7);
    fillLight.position.set(-1.2, 1.7, 4.2);
    this.scene.add(fillLight);

    for (const side of [-1, 1] as const) {
      const wallGlow = new THREE.PointLight(0xffb877, 8, 11, 1.8);
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
      const spot = new THREE.SpotLight(0xffc98c, 9, 9.5, 0.62, 0.85, 1.85);
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

    // 两侧矮唱片箱（替代原先的高架）：箱体贴牛皮纸，里面插彩色唱片脊，让左右边界有细节。
    const cardboard = makeCardboardTexture();
    this.textures.push(cardboard);
    const binBoxMat = new THREE.MeshStandardMaterial({ map: cardboard, color: 0xb08d62, roughness: 0.85, metalness: 0.02 });
    const spineColors = [0x5a2f28, 0x2f4448, 0x5a462e, 0x40364f, 0x4a5638, 0x5a4048, 0x6a5a44];
    for (const side of [-1, 1] as const) {
      const bin = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.62, 0.5), binBoxMat);
      bin.position.set(side * 3.02, 0.31, -0.02);
      bin.rotation.y = side * 0.08;
      this.scene.add(bin);
      this.disposables.push(bin.geometry, binBoxMat);
      for (let i = 0; i < 9; i += 1) {
        const spineMat = new THREE.MeshStandardMaterial({ color: spineColors[(i + (side > 0 ? 3 : 0)) % spineColors.length], roughness: 0.8, metalness: 0.02 });
        const spine = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.44 + (i % 3) * 0.018, 0.4), spineMat);
        spine.position.set(side * 3.02 - 0.5 + i * 0.115, 0.62, -0.02);
        spine.rotation.y = side * 0.08;
        spine.rotation.z = (i % 2 === 0 ? 1 : -1) * 0.012;
        this.scene.add(spine);
        this.disposables.push(spine.geometry, spineMat);
      }
      // 箱上：小立牌与铜灯
      const lampMat = new THREE.MeshStandardMaterial({ color: 0xc4a06a, roughness: 0.3, metalness: 0.9 });
      const lampPole = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.4, 10), lampMat);
      lampPole.position.set(side * 3.35, 0.82, 0.12);
      const lampShade = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.12, 16, 1, true), new THREE.MeshStandardMaterial({ color: 0x2a2019, roughness: 0.5, metalness: 0.6, side: THREE.DoubleSide }));
      lampShade.position.set(side * 3.35, 1.02, 0.12);
      lampShade.rotation.x = Math.PI;
      const lampBulb = new THREE.Mesh(new THREE.SphereGeometry(0.028, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd9a0 }));
      lampBulb.position.set(side * 3.35, 0.98, 0.12);
      const lampLight = new THREE.PointLight(0xffc080, 2.4, 2.2, 2);
      lampLight.position.set(side * 3.35, 0.95, 0.12);
      this.scene.add(lampPole, lampShade, lampBulb, lampLight);
      this.disposables.push(lampPole.geometry, lampShade.geometry, lampShade.material as THREE.Material, lampBulb.geometry, lampBulb.material as THREE.Material, lampMat);
    }

    // 货架后方暖雾光层：让灯光有体积感
    const hazeTexture = makeGlowTexture();
    this.textures.push(hazeTexture);
    const hazeMat = new THREE.MeshBasicMaterial({ map: hazeTexture, color: 0xffb877, transparent: true, opacity: 0.1, depthWrite: false, blending: THREE.AdditiveBlending });
    const haze = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 3.4), hazeMat);
    haze.position.set(0, 1.75, -1.0);
    this.scene.add(haze);
    this.disposables.push(haze.geometry, hazeMat);

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
    let posterVariant = 0;
    for (const [title, color, x] of posterData) {
      const texture = makePosterArtTexture({ title, subtitle: posterVariant % 2 === 0 ? 'MONO SERIES' : 'NIGHT EDITION', accent: color, variant: posterVariant });
      this.textures.push(texture);
      const mat = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.85, metalness: 0.02 });
      const poster = new THREE.Mesh(new THREE.PlaneGeometry(0.96, 0.96), mat);
      poster.position.set(x, 1.95, -0.905);
      this.scene.add(poster);
      this.disposables.push(poster.geometry, mat);
      posterVariant += 1;
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

    this.buildRug();
    this.buildCeilingDetail();
    this.buildWallDetail();
    this.buildListeningDetail();
    this.buildShelfDetail();
    this.buildAtmosphereDetail();
  }

  private buildShelf(): void {
    const step = MENU_BOARD_W + MENU_BOARD_GAP;
    const shelfWidth = (MENU_COLUMNS - 1) * step + MENU_BOARD_W + 0.24;
    const walnut = makeWalnutTexture();
    this.textures.push(walnut);
    const woodMat = new THREE.MeshStandardMaterial({ map: walnut, color: 0x8a6a46, roughness: 0.6, metalness: 0.08 });
    const brassMat = new THREE.MeshStandardMaterial({ color: 0xb08a54, roughness: 0.3, metalness: 0.9 });
    const backMat = new THREE.MeshStandardMaterial({ color: 0x211a13, roughness: 0.92, metalness: 0.04 });

    const backPanel = new THREE.Mesh(new THREE.BoxGeometry(shelfWidth + 0.3, 2.72, 0.06), backMat);
    backPanel.position.set(0, 1.66, -0.32);
    this.scene.add(backPanel);
    this.disposables.push(backPanel.geometry, backMat);

    for (const side of [-1, 1]) {
      const board = new THREE.Mesh(new THREE.BoxGeometry(0.07, 2.72, 0.52), woodMat);
      board.position.set(side * (shelfWidth / 2 + 0.04), 1.66, -0.02);
      this.scene.add(board);
      this.disposables.push(board.geometry);
    }
    const top = new THREE.Mesh(new THREE.BoxGeometry(shelfWidth + 0.36, 0.08, 0.56), woodMat);
    top.position.set(0, 3.0, -0.02);
    this.scene.add(top);
    this.disposables.push(top.geometry);
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(shelfWidth + 0.3, 0.16, 0.5), woodMat);
    plinth.position.set(0, 0.44, -0.04);
    this.scene.add(plinth);
    this.disposables.push(plinth.geometry);

    for (let row = 0; row < MENU_ROWS; row += 1) {
      const plankY = MENU_BOARD_Y[row] - MENU_BOARD_H / 2 - 0.07;
      const plank = new THREE.Mesh(new THREE.BoxGeometry(shelfWidth + 0.2, 0.045, 0.5), woodMat);
      plank.position.set(0, plankY, -0.01);
      this.scene.add(plank);
      this.disposables.push(plank.geometry);
      const brass = new THREE.Mesh(new THREE.BoxGeometry(shelfWidth + 0.2, 0.012, 0.014), brassMat);
      brass.position.set(0, plankY - 0.028, 0.24);
      this.scene.add(brass);
      this.disposables.push(brass.geometry);
    }
    this.disposables.push(woodMat, brassMat);

    // 后墙菜单：6 块「分类牌」，点击进入右侧大唱片架。
    const boardGeo = new THREE.PlaneGeometry(MENU_BOARD_W, MENU_BOARD_H);
    const frameGeo = new THREE.PlaneGeometry(MENU_BOARD_W + 0.05, MENU_BOARD_H + 0.05);
    this.disposables.push(boardGeo, frameGeo);
    let index = 0;
    for (let row = 0; row < MENU_ROWS; row += 1) {
      for (let col = 0; col < MENU_COLUMNS; col += 1) {
        const x = (col - (MENU_COLUMNS - 1) / 2) * step;
        const group = new THREE.Group();
        group.position.set(x, MENU_BOARD_Y[row], 0.3);
        const frameMat = new THREE.MeshStandardMaterial({ color: 0x140f0b, roughness: 0.55, metalness: 0.4, emissive: 0x000000 });
        const frame = new THREE.Mesh(frameGeo, frameMat);
        frame.position.z = -0.012;
        const plateMat = new THREE.MeshStandardMaterial({ color: 0x1a1410, roughness: 0.66, metalness: 0.05, emissive: 0x000000, map: null });
        const plate = new THREE.Mesh(boardGeo, plateMat);
        plate.position.z = 0;
        group.add(frame, plate);
        this.scene.add(group);
        this.menuBoards.push({ index, group, plate, frame, texture: null, title: '', count: 0, hovered: false });
        this.menuBoardMeshes.push(plate);
        this.disposables.push(frameMat, plateMat);
        index += 1;
      }
    }
  }

  /** R3：右墙整面大唱片架（6×4 = 24 张/页，墙面朝 -X 方向）。 */
  private buildLibraryShelf(): void {
    const step = LIB_COVER + LIB_GAP;
    const width = (LIB_COLS - 1) * step + LIB_COVER + 0.36;
    const group = new THREE.Group();
    group.position.set(LIB_PANEL_X, 0, LIB_SHELF_Z);
    group.rotation.y = -Math.PI / 2;
    this.scene.add(group);

    const walnut = makeWalnutTexture();
    this.textures.push(walnut);
    const woodMat = new THREE.MeshStandardMaterial({ map: walnut, color: 0x7a5a3a, roughness: 0.62, metalness: 0.08 });
    const brassMat = new THREE.MeshStandardMaterial({ color: 0xb08a54, roughness: 0.3, metalness: 0.9 });
    const backMat = new THREE.MeshStandardMaterial({ color: 0x1b1510, roughness: 0.94, metalness: 0.03 });

    const back = new THREE.Mesh(new THREE.BoxGeometry(width + 0.2, 2.72, 0.05), backMat);
    back.position.set(0, 1.8, -0.06);
    group.add(back);

    for (const side of [-1, 1]) {
      const board = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.72, 0.52), woodMat);
      board.position.set(side * (width / 2 + 0.02), 1.8, 0.0);
      group.add(board);
    }
    const top = new THREE.Mesh(new THREE.BoxGeometry(width + 0.2, 0.08, 0.56), woodMat);
    top.position.set(0, 3.06, 0.0);
    group.add(top);
    const bottom = new THREE.Mesh(new THREE.BoxGeometry(width + 0.2, 0.14, 0.54), woodMat);
    bottom.position.set(0, 0.52, 0.0);
    group.add(bottom);

    for (const y of LIB_SHELF_Y) {
      const plank = new THREE.Mesh(new THREE.BoxGeometry(width + 0.2, 0.045, 0.5), woodMat);
      plank.position.set(0, y, 0.0);
      group.add(plank);
      const brass = new THREE.Mesh(new THREE.BoxGeometry(width + 0.2, 0.012, 0.014), brassMat);
      brass.position.set(0, y - 0.028, 0.26);
      group.add(brass);
    }
    this.disposables.push(woodMat, brassMat, backMat);

    // 封面：24 个席位。
    const frameGeo = new THREE.PlaneGeometry(LIB_COVER + 0.05, LIB_COVER + 0.05);
    const coverGeo = new THREE.PlaneGeometry(LIB_COVER, LIB_COVER);
    this.disposables.push(frameGeo, coverGeo);
    let index = 0;
    for (let row = 0; row < LIB_ROWS; row += 1) {
      for (let col = 0; col < LIB_COLS; col += 1) {
        const x = (col - (LIB_COLS - 1) / 2) * step;
        const slotGroup = new THREE.Group();
        slotGroup.position.set(x, LIB_ROW_Y[row], 0.3);
        const frameMat = new THREE.MeshStandardMaterial({ color: 0x120d09, roughness: 0.55, metalness: 0.35, emissive: 0x000000 });
        const frame = new THREE.Mesh(frameGeo, frameMat);
        frame.position.z = -0.004;
        const coverMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.72, metalness: 0.04 });
        const cover = new THREE.Mesh(coverGeo, coverMat);
        cover.position.z = 0.006;
        slotGroup.add(frame, cover);
        group.add(slotGroup);
        this.coverMeshes.push(cover);
        this.covers.push({
          index,
          group: slotGroup,
          cover,
          frame,
          texture: null,
          song: null,
          neutralScale: 1,
          hovered: false,
          normal: new THREE.Vector3(-1, 0, 0),
        });
        this.disposables.push(frameMat, coverMat);
        index += 1;
      }
    }

    // 大架标题牌。
    const headerMat = new THREE.MeshStandardMaterial({ color: 0x1a1310, roughness: 0.6, metalness: 0.1, emissive: 0x000000, map: null });
    const header = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.34), headerMat);
    header.position.set(0, 3.22, 0.12);
    group.add(header);
    this.disposables.push(header.geometry, headerMat);
    this.libraryHeader = { mesh: header, texture: null };
  }

  // ---------- R2 细节 ----------

  /** 地毯 */
  private buildRug(): void {
    const texture = makeRugTexture();
    this.textures.push(texture);
    const mat = new THREE.MeshStandardMaterial({ map: texture, color: 0x9a8272, roughness: 0.96, metalness: 0.02 });
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(4.9, 3.5), mat);
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(0, 0.018, 1.95);
    this.scene.add(rug);
    this.disposables.push(rug.geometry, mat);
  }

  /** 天花板：木梁 + 灯轨 + 视听桌上方的吊灯 */
  private buildCeilingDetail(): void {
    const walnut = makeWalnutTexture();
    this.textures.push(walnut);
    const beamMat = new THREE.MeshStandardMaterial({ map: walnut, color: 0x6a4a30, roughness: 0.82, metalness: 0.03 });
    for (const z of [-0.3, 1.3, 2.9]) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(10.6, 0.15, 0.17), beamMat);
      beam.position.set(0, 3.2, z);
      this.scene.add(beam);
      this.disposables.push(beam.geometry);
    }
    const railMat = new THREE.MeshStandardMaterial({ color: 0x2b2620, roughness: 0.4, metalness: 0.9 });
    const rail = new THREE.Mesh(new THREE.BoxGeometry(5.8, 0.05, 0.07), railMat);
    rail.position.set(0, 3.12, 1.28);
    this.scene.add(rail);
    this.disposables.push(rail.geometry, railMat, beamMat);

    // 吊灯
    const cordMat = new THREE.MeshStandardMaterial({ color: 0x14100d, roughness: 0.8, metalness: 0.1 });
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 1.1, 8), cordMat);
    cord.position.set(2.6, 2.75, 2.35);
    this.scene.add(cord);
    const shadeMat = new THREE.MeshStandardMaterial({ color: 0x1c1916, roughness: 0.45, metalness: 0.72, side: THREE.DoubleSide });
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.2, 26, 1, true), shadeMat);
    shade.position.set(2.6, 2.14, 2.35);
    shade.rotation.x = Math.PI;
    this.scene.add(shade);
    const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffdca6 });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.042, 16, 12), bulbMat);
    bulb.position.set(2.6, 2.05, 2.35);
    this.scene.add(bulb);
    const pendant = new THREE.PointLight(0xffc47e, 7, 5, 1.9);
    pendant.position.set(2.6, 1.92, 2.35);
    this.scene.add(pendant);
    this.disposables.push(cord.geometry, cordMat, shade.geometry, shadeMat, bulb.geometry, bulbMat);
  }

  /** 墙纸细节：护墙板、夜景窗、后门、霓虹、画框、壁灯 */
  private buildWallDetail(): void {
    const walnut = makeWalnutTexture();
    this.textures.push(walnut);
    const trimMat = new THREE.MeshStandardMaterial({ map: walnut, color: 0x8a6a46, roughness: 0.62, metalness: 0.08 });

    // 后墙护墙板与踢脚线
    const wainscot = new THREE.Mesh(new THREE.BoxGeometry(9.2, 0.36, 0.05), trimMat);
    wainscot.position.set(0, 0.21, -1.02);
    this.scene.add(wainscot);
    const baseTrim = new THREE.Mesh(new THREE.BoxGeometry(9.2, 0.1, 0.08), trimMat);
    baseTrim.position.set(0, 0.05, -1.0);
    this.scene.add(baseTrim);

    // 左墙夜景窗
    const windowTexture = makeNightWindowTexture();
    this.textures.push(windowTexture);
    const glassMat = new THREE.MeshBasicMaterial({ map: windowTexture });
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(2.35, 1.45), glassMat);
    glass.position.set(-5.33, 1.92, 1.85);
    glass.rotation.y = Math.PI / 2;
    const glassSheen = new THREE.Mesh(
      new THREE.PlaneGeometry(2.3, 1.4),
      new THREE.MeshBasicMaterial({ color: 0xaec8ff, transparent: true, opacity: 0.05, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    glassSheen.position.set(-5.31, 1.92, 1.85);
    glassSheen.rotation.y = Math.PI / 2;
    this.scene.add(glass, glassSheen);
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x231b14, roughness: 0.6, metalness: 0.18 });
    const frameParts: Array<[number, number, number, number, number]> = [
      [-5.32, 2.66, 1.85, 2.5, 0.07],
      [-5.32, 1.18, 1.85, 2.5, 0.07],
      [-5.32, 1.92, 0.64, 0.06, 1.5],
      [-5.32, 1.92, 3.06, 0.06, 1.5],
    ];
    for (const [x, y, z, w, h] of frameParts) {
      const piece = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.05), frameMat);
      piece.position.set(x, y, z);
      piece.rotation.y = Math.PI / 2;
      this.scene.add(piece);
      this.disposables.push(piece.geometry);
    }
    for (const dz of [-0.78, 0.78]) {
      const mullion = new THREE.Mesh(new THREE.BoxGeometry(0.045, 1.5, 0.04), frameMat);
      mullion.position.set(-5.31, 1.92, 1.85 + dz);
      mullion.rotation.y = Math.PI / 2;
      this.scene.add(mullion);
      this.disposables.push(mullion.geometry);
    }
    const sill = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.07, 2.6), trimMat);
    sill.position.set(-5.22, 1.14, 1.85);
    this.scene.add(sill);
    // 窗光落在地面
    const glow = this.textures[1];
    if (glow) {
      const lightPool = new THREE.Mesh(
        new THREE.PlaneGeometry(2.6, 1.9),
        new THREE.MeshBasicMaterial({ map: glow, color: 0x7f9dc8, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      lightPool.rotation.x = -Math.PI / 2;
      lightPool.position.set(-4.2, 0.02, 1.9);
      this.scene.add(lightPool);
      this.disposables.push(lightPool.geometry, lightPool.material);
    }
    this.disposables.push(glass.geometry, glassMat, glassSheen.geometry, glassSheen.material as THREE.Material, frameMat);
    const moonLight = new THREE.PointLight(0x7f9fd0, 4.2, 5.5, 2);
    moonLight.position.set(-4.6, 1.9, 1.85);
    this.scene.add(moonLight);

    // 后墙 OPEN 霓虹（右上方墙面，避开大货架）
    const openTexture = makeNeonTexture('OPEN', '#ff9a6a', 384, 144);
    this.textures.push(openTexture);
    const openMat = new THREE.MeshBasicMaterial({ map: openTexture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const openSign = new THREE.Mesh(new THREE.PlaneGeometry(0.66, 0.25), openMat);
    openSign.position.set(3.55, 2.92, -1.0);
    this.scene.add(openSign);
    const openLight = new THREE.PointLight(0xff8a5a, 2.2, 2.4, 2);
    openLight.position.set(3.55, 2.55, -0.8);
    this.scene.add(openLight);
    this.disposables.push(openSign.geometry, openMat);

    // 画框：给两张海报加木框与玻璃反光
    for (const x of [-3.55, 3.55]) {
      const frame = new THREE.Mesh(new THREE.BoxGeometry(1.12, 1.12, 0.05), trimMat);
      frame.position.set(x, 1.95, -0.94);
      this.scene.add(frame);
      const sheen = new THREE.Mesh(
        new THREE.PlaneGeometry(1.06, 1.06),
        new THREE.MeshBasicMaterial({ color: 0xffe8c8, transparent: true, opacity: 0.05, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      sheen.position.set(x, 1.95, -0.9);
      this.scene.add(sheen);
      this.disposables.push(frame.geometry, sheen.geometry, sheen.material as THREE.Material);
    }
    this.disposables.push(trimMat);

    // 后墙壁灯（画框外侧，铜杆朝下挂球泡）
    for (const side of [-1, 1] as const) {
      const x = side * 3.55;
      const backPlate = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.03, 16), frameMat);
      backPlate.rotation.x = Math.PI / 2;
      backPlate.position.set(x, 2.42, -1.0);
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.24, 10), frameMat);
      arm.position.set(x, 2.3, -0.9);
      arm.rotation.x = -0.9;
      const shade = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.1, 18, 1, true), new THREE.MeshStandardMaterial({ color: 0x2a241d, roughness: 0.5, metalness: 0.6, side: THREE.DoubleSide }));
      shade.position.set(x, 2.18, -0.83);
      shade.rotation.x = Math.PI;
      const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffd09a });
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.032, 14, 10), bulbMat);
      bulb.position.set(x, 2.13, -0.83);
      const light = new THREE.PointLight(0xffb877, 3.6, 3.2, 2);
      light.position.set(x, 2.05, -0.7);
      this.scene.add(backPlate, arm, shade, bulb, light);
      this.disposables.push(backPlate.geometry, arm.geometry, shade.geometry, shade.material as THREE.Material, bulb.geometry, bulbMat);
    }
  }

  /** 视听角：现有唱机上加细节 + 音箱 / 功放 / 耳机 / 植物 / 凳子 / 杯子 */
  private buildListeningDetail(): void {
    const woodTexture = makeWalnutTexture();
    this.textures.push(woodTexture);
    const woodMat = new THREE.MeshStandardMaterial({ map: woodTexture, color: 0xb08a5c, roughness: 0.55, metalness: 0.06 });
    const metalMat = new THREE.MeshStandardMaterial({ color: 0x8f8a84, roughness: 0.3, metalness: 0.95 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x15120f, roughness: 0.5, metalness: 0.35 });

    // 桌面板 / 唱机底座换成木纹
    const tableTop = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.06, 0.72), woodMat);
    tableTop.position.set(2.6, 0.735, 2.35);
    this.scene.add(tableTop);
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.1, 0.48), woodMat);
    plinth.position.set(2.6, 0.81, 2.35);
    this.scene.add(plinth);
    this.disposables.push(tableTop.geometry, plinth.geometry, woodMat);

    // 唱盘上的黑胶 + 毛毡垫
    const felt = new THREE.Mesh(new THREE.CylinderGeometry(0.255, 0.255, 0.008, 48), new THREE.MeshStandardMaterial({ color: 0x1a1512, roughness: 1, metalness: 0 }));
    felt.position.set(2.54, 0.886, 2.35);
    const vinylTexture = makeVinylDiscTexture();
    this.textures.push(vinylTexture);
    const vinyl = new THREE.Mesh(new THREE.CylinderGeometry(0.244, 0.244, 0.007, 64), new THREE.MeshStandardMaterial({ map: vinylTexture, color: 0xffffff, roughness: 0.42, metalness: 0.2 }));
    vinyl.position.set(2.54, 0.893, 2.35);
    this.scene.add(felt, vinyl);
    this.disposables.push(felt.geometry, felt.material as THREE.Material, vinyl.geometry, vinyl.material as THREE.Material);

    // 唱臂小部件
    const pivot = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.034, 0.05, 20), metalMat);
    pivot.position.set(2.88, 0.92, 2.52);
    const counter = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.07, 16), metalMat);
    counter.rotation.z = Math.PI / 2;
    counter.position.set(2.94, 0.93, 2.55);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.014, 0.038), darkMat);
    head.position.set(2.6, 0.925, 2.4);
    head.rotation.y = -0.7;
    this.scene.add(pivot, counter, head);
    this.disposables.push(pivot.geometry, counter.geometry, head.geometry);

    // 功放 + 旋钮 + 指示灯
    const amp = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.11, 0.3), darkMat);
    amp.position.set(3.02, 0.845, 2.16);
    const face = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.09, 0.012), metalMat);
    face.position.set(3.02, 0.845, 2.0);
    this.scene.add(amp, face);
    for (let i = 0; i < 3; i += 1) {
      const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.014, 18), metalMat);
      knob.rotation.x = Math.PI / 2;
      knob.position.set(2.88 + i * 0.075, 0.85, 1.99);
      this.scene.add(knob);
      this.disposables.push(knob.geometry);
    }
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.007, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffb066 }));
    led.position.set(3.16, 0.85, 1.99);
    this.scene.add(led);
    this.disposables.push(amp.geometry, face.geometry, led.geometry, led.material as THREE.Material, darkMat, metalMat);

    // 两侧音箱
    for (const x of [2.02, 3.28]) {
      const cab = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.52, 0.32), woodMat);
      cab.position.set(x, 0.26, 2.72);
      const woofer = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.02, 40), darkMat);
      woofer.rotation.x = Math.PI / 2;
      woofer.position.set(x, 0.22, 2.555);
      const tweeter = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.016, 24), metalMat);
      tweeter.rotation.x = Math.PI / 2;
      tweeter.position.set(x, 0.41, 2.56);
      this.scene.add(cab, woofer, tweeter);
      this.disposables.push(cab.geometry, woofer.geometry, tweeter.geometry);
    }

    // 耳机架：小立杆 + 竖直半环 + 耳罩
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.045, 0.26, 14), darkMat);
    stand.position.set(2.72, 0.9, 2.56);
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.058, 0.009, 8, 20, Math.PI), metalMat);
    band.rotation.x = Math.PI / 2;
    band.rotation.z = Math.PI;
    band.position.set(2.72, 1.03, 2.56);
    for (const side of [-1, 1] as const) {
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.022, 18), darkMat);
      cup.rotation.x = Math.PI / 2;
      cup.position.set(2.72 + side * 0.058, 0.99, 2.56);
      this.scene.add(cup);
      this.disposables.push(cup.geometry);
    }
    this.scene.add(stand, band);
    this.disposables.push(stand.geometry, band.geometry);

    // 凳子
    const stoolMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1d, roughness: 0.8, metalness: 0.06 });
    const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.06, 28), stoolMat);
    seat.position.set(2.6, 0.5, 1.55);
    this.scene.add(seat);
    this.disposables.push(seat.geometry, stoolMat);
    for (let i = 0; i < 3; i += 1) {
      const angle = (i / 3) * Math.PI * 2;
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.018, 0.5, 10), darkMat);
      leg.position.set(2.6 + Math.cos(angle) * 0.17, 0.25, 1.55 + Math.sin(angle) * 0.17);
      leg.rotation.set(Math.sin(angle) * 0.12, 0, -Math.cos(angle) * 0.12);
      this.scene.add(leg);
      this.disposables.push(leg.geometry);
    }

    // 绿植
    const potMat = new THREE.MeshStandardMaterial({ color: 0x6a4a34, roughness: 0.8, metalness: 0.05 });
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.11, 0.26, 20), potMat);
    pot.position.set(-1.2, 0.13, 2.9);
    this.scene.add(pot);
    const leafTexture = makeLeafTexture();
    this.textures.push(leafTexture);
    const leafMat = new THREE.MeshStandardMaterial({ map: leafTexture, transparent: true, alphaTest: 0.5, roughness: 0.8, metalness: 0.02, side: THREE.DoubleSide });
    const leafGeo = new THREE.PlaneGeometry(0.16, 0.5);
    for (let i = 0; i < 16; i += 1) {
      const angle = (i / 16) * Math.PI * 2 + (i % 3) * 0.2;
      const spread = 0.09 + (i % 4) * 0.03;
      const leaf = new THREE.Mesh(leafGeo, leafMat);
      leaf.position.set(-1.2 + Math.cos(angle) * spread, 0.46 + (i % 5) * 0.055, 2.9 + Math.sin(angle) * spread);
      leaf.rotation.set(-0.35 + (i % 3) * 0.25, angle, (i % 2 === 0 ? 1 : -1) * (0.25 + (i % 4) * 0.1));
      this.scene.add(leaf);
    }
    const stemGeo = new THREE.CylinderGeometry(0.006, 0.01, 0.42, 6);
    const stemMat = new THREE.MeshStandardMaterial({ color: 0x3a4a32, roughness: 0.8, metalness: 0.02 });
    for (let i = 0; i < 5; i += 1) {
      const angle = (i / 5) * Math.PI * 2;
      const stem = new THREE.Mesh(stemGeo, stemMat);
      stem.position.set(-1.2 + Math.cos(angle) * 0.03, 0.42, 2.9 + Math.sin(angle) * 0.03);
      stem.rotation.set(Math.cos(angle) * 0.25, 0, Math.sin(angle) * 0.25);
      this.scene.add(stem);
    }
    this.disposables.push(pot.geometry, potMat, leafMat, leafGeo, stemGeo, stemMat);

    // 桌上杯子
    const mugMat = new THREE.MeshStandardMaterial({ color: 0xc9b39a, roughness: 0.7, metalness: 0.05 });
    const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.03, 0.08, 18), mugMat);
    mug.position.set(2.86, 0.79, 2.62);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.026, 0.008, 8, 16), mugMat);
    handle.position.set(2.9, 0.79, 2.62);
    handle.rotation.y = Math.PI / 2;
    this.scene.add(mug, handle);
    this.disposables.push(mug.geometry, handle.geometry, mugMat);
  }

  /** 货架细节：木纹背板、压条、灯带、铜角、价签 */
  private buildShelfDetail(): void {
    const shelfWidth = COLS * (COVER_SIZE + COVER_GAP_X) + 0.1;
    const walnut = makeWalnutTexture();
    this.textures.push(walnut);
    const insetMat = new THREE.MeshStandardMaterial({ map: walnut, color: 0x553d28, roughness: 0.9, metalness: 0.02 });
    const inset = new THREE.Mesh(new THREE.PlaneGeometry(shelfWidth + 0.2, 2.28), insetMat);
    inset.position.set(0, 1.28, -0.286);
    this.scene.add(inset);

    const lipMat = new THREE.MeshStandardMaterial({ map: walnut, color: 0x8a6a46, roughness: 0.55, metalness: 0.12 });
    const brassMat = new THREE.MeshStandardMaterial({ color: 0xb08a54, roughness: 0.3, metalness: 0.9 });
    const ledMat = new THREE.MeshBasicMaterial({ color: 0xffd8a2 });
    for (let row = 0; row < ROWS; row += 1) {
      const y = ROW_Y[row] - COVER_SIZE / 2 - 0.078;
      const lip = new THREE.Mesh(new THREE.BoxGeometry(shelfWidth + 0.3, 0.048, 0.032), lipMat);
      lip.position.set(0, y + 0.012, 0.283);
      const led = new THREE.Mesh(new THREE.BoxGeometry(shelfWidth - 0.2, 0.012, 0.014), ledMat);
      led.position.set(0, y - 0.045, 0.236);
      this.scene.add(lip, led);
      this.disposables.push(lip.geometry, led.geometry);
    }
    this.disposables.push(inset.geometry, insetMat, lipMat, brassMat, ledMat);

    // 货架顶左侧：平放的一摞黑胶（三张）
    const stackColors = [0x2a2018, 0x1d1712, 0x241c15];
    for (let i = 0; i < 3; i += 1) {
      const sleeve = new THREE.Mesh(
        new THREE.BoxGeometry(0.42, 0.012, 0.42),
        new THREE.MeshStandardMaterial({ color: stackColors[i], roughness: 0.8, metalness: 0.03 }),
      );
      sleeve.position.set(-1.5 + i * 0.012, 2.47 + i * 0.014, -0.05 + i * 0.01);
      sleeve.rotation.y = (i - 1) * 0.06;
      this.scene.add(sleeve);
      this.disposables.push(sleeve.geometry, sleeve.material as THREE.Material);
    }
    const standTexture = makePosterArtTexture({ title: 'STAFF PICKS', subtitle: '店员私藏 · 每周更新', accent: '#6a4a30', variant: 1 });
    this.textures.push(standTexture);
    const standMat = new THREE.MeshStandardMaterial({ map: standTexture, color: 0xe8dcc8, roughness: 0.85, metalness: 0.02, side: THREE.DoubleSide });
    const stand = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.44), standMat);
    stand.position.set(1.4, 2.64, -0.08);
    stand.rotation.x = -0.1;
    this.scene.add(stand);
    this.disposables.push(stand.geometry, standMat);

    // 铜角铁
    for (const side of [-1, 1] as const) {
      for (const y of [0.12, 2.38]) {
        const corner = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.06), brassMat);
        corner.position.set(side * (shelfWidth / 2 + 0.06), y, 0.24);
        this.scene.add(corner);
        this.disposables.push(corner.geometry);
      }
    }

    // 价签：几张小纸片挂在封面下方
    const tagTexture = makeCardboardTexture();
    this.textures.push(tagTexture);
    const tagMat = new THREE.MeshStandardMaterial({ map: tagTexture, color: 0xd9c4a2, roughness: 0.9, metalness: 0.02, side: THREE.DoubleSide });
    for (const [x, y] of [
      [-1.42, 0.74],
      [0.86, 1.42],
      [1.9, 0.74],
    ] as const) {
      const tag = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 0.085), tagMat);
      tag.position.set(x, y, 0.3);
      tag.rotation.x = -0.1;
      this.scene.add(tag);
      this.disposables.push(tag.geometry);
    }
    this.disposables.push(tagMat);
  }


  /** 体积光柱 + 墙面装裱唱片 + 角落纸箱 */
  private buildAtmosphereDetail(): void {
    // 三束柔光柱（对应三盏轨道射灯）
    const shaftTexture = makeShaftTexture();
    this.textures.push(shaftTexture);
    const spots: Array<[number, number]> = [
      [-2.05, 1.1],
      [0, 1.35],
      [2.05, 1.1],
    ];
    for (const [x, z] of spots) {
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.62, 2.9, 24, 1, true),
        new THREE.MeshBasicMaterial({
          map: shaftTexture,
          color: 0xffc98c,
          transparent: true,
          opacity: 0.07,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        }),
      );
      shaft.position.set(x, 1.56, z);
      this.scene.add(shaft);
      this.disposables.push(shaft.geometry, shaft.material as THREE.Material);
    }

    // 装裱唱片（后墙货架两侧）
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.55, metalness: 0.15 });
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x120d09, roughness: 0.92, metalness: 0.03 });
    const vinylTexture = makeVinylDiscTexture();
    this.textures.push(vinylTexture);
    const vinylMat = new THREE.MeshStandardMaterial({ map: vinylTexture, color: 0xffffff, roughness: 0.55, metalness: 0.08 });
    for (const side of [-1, 1] as const) {
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.62, 0.045), frameMat);
      frame.position.set(side * 2.45, 2.12, -0.98);
      const back = new THREE.Mesh(new THREE.PlaneGeometry(0.54, 0.54), wallMat);
      back.position.set(side * 2.45, 2.12, -0.955);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.225, 48), vinylMat);
      disc.position.set(side * 2.45, 2.12, -0.95);
      this.scene.add(frame, back, disc);
      this.disposables.push(frame.geometry, frameMat, back.geometry, wallMat, disc.geometry);
    }
    this.disposables.push(vinylMat);

    // 角落纸箱堆
    const cardboard = makeCardboardTexture();
    this.textures.push(cardboard);
    const boxMat = new THREE.MeshStandardMaterial({ map: cardboard, color: 0xb08a5e, roughness: 0.9, metalness: 0.02 });
    const boxes: Array<[number, number, number, number, number, number, number]> = [
      [-3.55, 0.19, 0.55, 0.52, 0.38, 0.46, 0.12],
      [-3.42, 0.55, 0.5, 0.42, 0.32, 0.38, -0.18],
      [-3.72, 0.13, 0.9, 0.34, 0.26, 0.3, 0.42],
    ];
    for (const [x, y, z, w, h, d, rot] of boxes) {
      const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), boxMat);
      box.position.set(x, y, z);
      box.rotation.y = rot;
      this.scene.add(box);
      this.disposables.push(box.geometry);
    }
    this.disposables.push(boxMat);

    // 斜靠墙边的木牌「新品上架」
    const boardTex = makePosterArtTexture({ title: '新品上架', subtitle: 'NEW ARRIVALS · WEEKLY', accent: '#7a5a38', variant: 2 });
    this.textures.push(boardTex);
    const boardMat = new THREE.MeshStandardMaterial({ map: boardTex, color: 0xd8c8ae, roughness: 0.85, metalness: 0.02, side: THREE.DoubleSide });
    const board = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.7), boardMat);
    board.position.set(-4.05, 0.36, 0.05);
    board.rotation.y = 0.42;
    board.rotation.x = -0.12;
    this.scene.add(board);
    this.disposables.push(board.geometry, boardMat);
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
    this.collections = collections;
    if (this.root.classList.contains('is-fallback')) {
      this.fillFallback(collections);
      return;
    }
    if (this.activeCollectionIndex >= collections.length) this.activeCollectionIndex = 0;
    this.page = 0;
    this.renderMenu();
    if (this.zoneName === 'library') this.renderLibrary();
    this.emitZone();
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

  // ---------- R3：两区状态 / 菜单 / 大架 ----------

  get zone(): StoreZoneName {
    return this.zoneName;
  }

  openCollection(index: number): void {
    this.enterLibrary(index);
  }

  setPage(page: number): void {
    if (this.zoneName !== 'library') return;
    this.page = page;
    this.renderLibrary();
    this.emitZone();
  }

  backToMenu(): void {
    this.zoneName = 'menu';
    this.focused = -1;
    this.card.classList.remove('is-open');
    this.options.onFocus?.(null);
    this.applyPose(MENU_POSE);
    this.emitZone();
  }

  private enterLibrary(index: number): void {
    const collection = this.collections[index];
    if (!collection) return;
    this.activeCollectionIndex = index;
    this.page = 0;
    this.zoneName = 'library';
    this.focused = -1;
    this.card.classList.remove('is-open');
    this.options.onFocus?.(null);
    this.applyPose(LIB_POSE);
    this.renderLibrary();
    this.emitZone();
  }

  private applyPose(pose: CameraPose): void {
    this.camTargetDesired.copy(pose.target);
    this.yawBase = pose.yaw;
    this.yawRange = pose.yawRange;
    this.pitchMin = pose.pitchMin;
    this.pitchMax = pose.pitchMax;
    this.yawTarget = pose.yaw;
    this.pitchTarget = pose.pitch;
    this.distanceTarget = pose.distance;
  }

  private setHint(text: string): void {
    this.hint.textContent = text;
    this.hint.classList.remove('is-hidden');
    window.clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => this.hint.classList.add('is-hidden'), 6500);
  }

  private emitZone(): void {
    const collection = this.collections[this.activeCollectionIndex] ?? null;
    const count = collection?.songs.length ?? 0;
    const pages = Math.max(1, Math.ceil(count / (LIB_COLS * LIB_ROWS)));
    this.options.onZone?.({
      zone: this.zoneName,
      title: this.zoneName === 'menu' ? '菜单' : collection?.title ?? '歌单',
      count,
      page: this.page,
      pages,
    });
    if (this.zoneName === 'menu') {
      this.setHint('点击分类牌进入 · 拖拽环视 · 滚轮推进 · Esc 退出');
    } else if (pages > 1) {
      this.setHint(`滚轮翻页（${this.page + 1}/${pages}）· 点击唱片聚焦 · Esc 返回菜单`);
    } else {
      this.setHint('点击唱片聚焦 · Esc 返回菜单');
    }
  }

  private renderMenu(): void {
    for (const board of this.menuBoards) {
      const collection = this.collections[board.index];
      const material = board.plate.material;
      material.map?.dispose();
      if (board.texture) {
        const position = this.textures.indexOf(board.texture);
        if (position >= 0) this.textures.splice(position, 1);
        board.texture.dispose();
        board.texture = null;
      }
      if (!collection) {
        const decor = makeMenuBoardTexture({
          title: 'ZILUX2 RECORDS',
          subtitle: '黑胶 · 唱片 · 聆听室',
          count: 0,
          index: board.index,
          decorative: true,
        });
        board.texture = decor;
        this.textures.push(decor);
        material.map = decor;
        material.color.set(0xffffff);
        material.needsUpdate = true;
        board.title = '';
        board.count = 0;
        continue;
      }
      const texture = makeMenuBoardTexture({
        title: collection.title,
        subtitle: collection.subtitle ?? '',
        count: collection.songs.length,
        index: board.index,
      });
      board.texture = texture;
      this.textures.push(texture);
      material.map = texture;
      material.color.set(0xffffff);
      material.needsUpdate = true;
      board.title = collection.title;
      board.count = collection.songs.length;
    }
  }

  private renderLibrary(): void {
    const collection = this.collections[this.activeCollectionIndex] ?? null;
    const perPage = LIB_COLS * LIB_ROWS;
    const songs = collection?.songs ?? [];
    const pages = Math.max(1, Math.ceil(songs.length / perPage));
    this.page = clamp(this.page, 0, pages - 1);
    const start = this.page * perPage;
    for (const slot of this.covers) {
      const song = songs[start + slot.index] ?? null;
      slot.song = song;
      const material = slot.cover.material;
      material.map?.dispose();
      if (slot.texture) {
        const position = this.textures.indexOf(slot.texture);
        if (position >= 0) this.textures.splice(position, 1);
        slot.texture.dispose();
        slot.texture = null;
      }
      // 空位直接隐藏整格（连同画框/阴影），避免翻到最后一页时出现空框
      slot.group.visible = song !== null;
      if (!song) {
        material.map = null;
        material.needsUpdate = true;
        continue;
      }
      const texture = makeCoverArtTexture(song, slot.index);
      texture.anisotropy = this.renderer?.capabilities.getMaxAnisotropy() ?? 8;
      slot.texture = texture;
      this.textures.push(texture);
      material.map = texture;
      material.color.set(song ? 0xffffff : 0x2a241d);
      material.needsUpdate = true;
    }
    if (this.libraryHeader) {
      if (this.libraryHeader.texture) {
        const position = this.textures.indexOf(this.libraryHeader.texture);
        if (position >= 0) this.textures.splice(position, 1);
        this.libraryHeader.texture.dispose();
      }
      const texture = makeShelfHeaderTexture(collection?.title ?? '唱片架', songs.length, this.page, pages);
      texture.anisotropy = this.renderer?.capabilities.getMaxAnisotropy() ?? 8;
      this.libraryHeader.texture = texture;
      this.textures.push(texture);
      this.libraryHeader.mesh.material.map = texture;
      this.libraryHeader.mesh.material.needsUpdate = true;
    }
    this.syncActiveHighlight();
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
      this.yawTarget = clamp(this.yawTarget - dx * 0.0042, this.yawBase - this.yawRange, this.yawBase + this.yawRange);
      this.pitchTarget = clamp(this.pitchTarget + dy * 0.0028, this.pitchMin, this.pitchMax);
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
    if (hit?.kind === 'menu') {
      this.enterLibrary(hit.index);
    } else if (hit?.kind === 'cover') {
      this.focusIndex(hit.index);
    } else if (this.focused >= 0) {
      this.resetView();
    }
  };

  private handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    if (this.zoneName === 'library' && this.focused < 0) {
      const collection = this.collections[this.activeCollectionIndex];
      const pages = Math.max(1, Math.ceil((collection?.songs.length ?? 0) / (LIB_COLS * LIB_ROWS)));
      if (pages > 1) {
        const next = clamp(this.page + (event.deltaY > 0 ? 1 : -1), 0, pages - 1);
        if (next !== this.page) {
          this.page = next;
          this.renderLibrary();
          this.emitZone();
        }
        return;
      }
    }
    this.distanceTarget = clamp(this.distanceTarget + event.deltaY * 0.0017, 2.15, 7.4);
    if (this.focused >= 0) this.resetView();
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      if (this.focused >= 0) {
        this.resetView();
        return;
      }
      if (this.zoneName === 'library') this.backToMenu();
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

  setCamera(next: { yaw?: number; pitch?: number; distance?: number; targetY?: number }): void {
    if (typeof next.yaw === 'number') {
      this.yaw = next.yaw;
      this.yawTarget = next.yaw;
      this.yawBase = next.yaw;
    }
    if (typeof next.pitch === 'number') {
      this.pitch = next.pitch;
      this.pitchTarget = next.pitch;
    }
    if (typeof next.distance === 'number') {
      this.distance = next.distance;
      this.distanceTarget = next.distance;
    }
    if (typeof next.targetY === 'number') this.camTarget.setY(next.targetY);
  }

  resetView(): void {
    this.focused = -1;
    this.card.classList.remove('is-open');
    this.options.onFocus?.(null);
  }

  focusIndex(index: number): void {
    const slot = this.covers[index];
    if (!slot) return;
    this.focused = index;
    const world = slot.group.getWorldPosition(new THREE.Vector3());
    this.focusCamPos.copy(world).addScaledVector(slot.normal, FOCUS_DISTANCE);
    this.focusCamPos.y += 0.02;
    this.focusLook.copy(world);
    this.options.onFocus?.(slot.song);
    this.cardArt.style.background = `linear-gradient(140deg, ${slot.song?.color ?? '#c9a068'}, #2b2118)`;
    this.cardArt.textContent = slot.song ? Array.from(slot.song.title)[0] ?? '' : '·';
    this.cardTitle.textContent = slot.song?.title ?? '未载入唱片';
    this.cardArtist.textContent = slot.song ? `${slot.song.artist}` : '——';
    this.cardMeta.textContent = slot.song?.album ? `专辑 · ${slot.song.album}` : 'Zilux2 唱片店 · 原型';
    this.card.classList.add('is-open');
    this.setHint('Enter 播放 · 点击空白或 Esc 关闭卡片');
  }

  get focusedIndex(): number {
    return this.focused;
  }

  private updateHover(): void {
    if (this.focused >= 0) return;
    const hit = this.pick();
    const kind = hit?.kind ?? '';
    const index = hit?.index ?? -1;
    if (kind === this.hoveredKind && index === this.hovered) return;

    if (this.hoveredKind === 'menu' && this.menuBoards[this.hovered]) this.menuBoards[this.hovered].hovered = false;
    if (this.hoveredKind === 'cover' && this.covers[this.hovered]) this.covers[this.hovered].hovered = false;

    this.hoveredKind = kind;
    this.hovered = index;
    if (kind === 'menu' && this.menuBoards[index]) this.menuBoards[index].hovered = true;
    if (kind === 'cover' && this.covers[index]) this.covers[index].hovered = true;
    this.root.classList.toggle('is-hovering', Boolean(kind));
  }

  private pick(): { kind: 'menu' | 'cover'; index: number } | null {
    if (!this.renderer) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    if (this.zoneName === 'menu') {
      const hits = this.raycaster.intersectObjects(this.menuBoardMeshes, false);
      const first = hits[0];
      if (!first) return null;
      const board = this.menuBoards.find((item) => item.plate === first.object);
      return board ? { kind: 'menu', index: board.index } : null;
    }
    const hits = this.raycaster.intersectObjects(this.coverMeshes, false);
    const first = hits[0];
    if (!first) return null;
    const slot = this.covers.find((item) => item.cover === first.object);
    if (!slot || !slot.song || !slot.group.visible) return null;
    return { kind: 'cover', index: slot.index };
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
      this.camTarget.lerp(this.camTargetDesired, 1 - Math.exp(-3.4 * dt));
      this.yaw = damp(this.yaw, this.yawTarget, 5.4, dt);
      this.pitch = damp(this.pitch, this.pitchTarget, 5.4, dt);
      this.distance = damp(this.distance, this.distanceTarget, 5.0, dt);
      const cosPitch = Math.cos(this.pitch);
      const desired = new THREE.Vector3(
        this.camTarget.x + Math.sin(this.yaw) * cosPitch * this.distance,
        this.camTarget.y + Math.sin(this.pitch) * this.distance,
        this.camTarget.z + Math.cos(this.yaw) * cosPitch * this.distance,
      );
      this.camera.position.lerp(desired, 1 - Math.exp(-7 * dt));
      this.currentLook.lerp(this.camTarget, 1 - Math.exp(-7 * dt));
    }
    this.camera.lookAt(this.currentLook);

    for (const slot of this.covers) {
      const wanted = slot.hovered ? 1.045 : 1;
      slot.group.scale.setScalar(damp(slot.group.scale.x, wanted, 9, dt));
      const hoverIdle = time * 0.0022;
      slot.cover.position.z = 0.006 + Math.sin(hoverIdle + slot.index) * 0.0006;
    }

    for (const board of this.menuBoards) {
      const wanted = board.hovered ? 1.035 : 1;
      board.group.scale.setScalar(damp(board.group.scale.x, wanted, 9, dt));
      board.frame.material.emissive.setHex(board.hovered ? 0x5a431d : 0x000000);
      board.frame.material.emissiveIntensity = board.hovered ? 0.55 : 0;
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
