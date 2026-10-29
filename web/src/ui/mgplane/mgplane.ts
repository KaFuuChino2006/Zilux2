/**
 * MG 画布（首页平面世界）生产视图。
 *
 * 设计基准来自 research/mockups/mg-canvas 的静态原型，这里按应用真实数据重做：
 * - 一张 6000×3400 的「平面」：六个分类区 + 中心 NOW + 歌单区，全部画在同一层；
 * - 相机可自由拖动 / 滚轮锚定缩放 / Tab 六区飞行 / Home 回全景；
 * - 点封面原地展开播放台，点歌单块原地展开曲目环，长按弹径向菜单，可进入多选；
 * - grade 跟随封面主色；底部不画播放条（沿用应用 fixed 播放条）。
 *
 * 交互只通过 callbacks 交给 app.ts：本模块不直接跳页、不直接开播（Space 除外）。
 */

import { addLikedTrack, removeLikedTrack } from '../../online/client';
import { onlineArtwork } from '../../online/artwork';
import type { OnlineTrack } from '../../online/types';
import { fetchPlaylist } from '../../core/library';
import type { LibraryPlaylist } from '../../core/library';
import { coverColorsOf, fallbackColors } from '../coverColors';
import { h, icon } from '../dom';
import { onPlayer, playerState, toggle } from '../player';
import type { PlayerState } from '../player';
import {
  MG_EMPTY_DATA,
  MG_NOW,
  MG_PLAYLIST_ZONE,
  MG_SAFE,
  MG_WORLD_H,
  MG_WORLD_W,
  MG_ZONES,
  fromHomeData,
  mgDuration,
  mgIsLocal,
  mgTrackKey,
} from './model';
import type { MgListKind, MgPlaneCallbacks, MgPlaneData, MgPlaylistGroup, MgZoneSpec } from './model';
import './mgplane.css';

export { fromHomeData };
export type { MgListKind, MgPlaneCallbacks, MgPlaneData } from './model';

/** 每张封面的绑定信息（点开时用来开播 / 展开）。 */
interface MgCoverBinding {
  track: OnlineTrack;
  tracks: OnlineTrack[];
  index: number;
  scope: MgPlaneCallbacks['play'] extends (tracks: OnlineTrack[], index: number, scope: infer S) => void ? S : never;
  el: HTMLElement;
  size: number;
}

type MgScene = 'theater' | 'world';

interface MgCam {
  x: number;
  y: number;
  z: number;
}

interface MgCamAnim {
  raf: number;
  from: MgCam;
  to: MgCam;
  started: number;
  duration: number;
  resolve: () => void;
}

interface MgDragState {
  active: boolean;
  id: number;
  startX: number;
  startY: number;
  camX: number;
  camY: number;
  lastX: number;
  lastY: number;
  lastT: number;
  moved: boolean;
  pointerType: string;
}

const CAM_MIN_Z = 0.12;
const CAM_MAX_Z = 2.4;
const DRAG_THRESHOLD = 6;
const LONG_PRESS_MS = 350;
const FLY_MS = 640;
const MOTION_SPEED = 900;
/** 滚轮缩放：目标 clamp 区间（任务规格 0.3–2.4）。 */
const ZOOM_MIN = 0.3;
/** 滚轮灵敏度：向下滚（deltaY>0）= 缩小、向上滚 = 放大。 */
const ZOOM_WHEEL_K = 0.0016;
/** 缩放趋近的时间常数（ms），约 100ms；180–260ms 内稳定。 */
const ZOOM_TAU = 100;
/** 缩放到位的判定阈值。 */
const ZOOM_SETTLE = 0.0006;
/** 惯性：起步阈值 20px/s、停止阈值 10px/s、最大 2200px/s、边界 6px 微弹。 */
const INERTIA_START = 0.02;
const INERTIA_STOP = 0.01;
const INERTIA_MAX = 2.2;
const INERTIA_BOUNCE = 6;
/** 键盘平移：320px / 320ms ease-out。 */
const PAN_STEP = 320;
const PAN_MS = 320;
/** prefers-reduced-motion 下降级时长（线性/直接到位）。 */
const REDUCED_MS = 80;

/** 视图层可见封面数（不改 model.ts 的 MG_ZONE_LIMIT，只覆盖渲染数量）。 */
const ZONE_VIS: Record<MgListKind, number> = { daily: 12, recent: 8, liked: 12, radar: 8, local: 8 };

/** 线性 / ease-out / ease-in-out 缓动。 */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (2 - 2 * t) * (2 - 2 * t) * 0.5;
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** 封面 img：先请求宿主真实封面，失败时回退到程序化封面（不抛错）。 */
function coverImg(track: OnlineTrack, alt: string): HTMLImageElement {
  const img = document.createElement('img');
  img.alt = alt;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = onlineArtwork(track);
  img.addEventListener('error', () => {
    if (img.dataset.fallback === '1') return;
    img.dataset.fallback = '1';
    img.src = onlineArtwork({ ...track, cover: '' });
  });
  return img;
}

/** 歌单块封面：宿主代理封面优先，缺失时用标题生成稳定渐变（不额外请求）。 */
function playlistArt(item: LibraryPlaylist): HTMLElement {
  const box = h('div', { class: 'mg-pl-art' });
  if (item.cover) {
    const img = document.createElement('img');
    img.alt = item.title;
    img.loading = 'lazy';
    img.src = item.cover;
    img.addEventListener('error', () => {
      img.remove();
      box.dataset.seed = item.id;
      box.textContent = item.title.slice(0, 1);
    });
    box.append(img);
    return box;
  }
  box.dataset.seed = item.id;
  box.textContent = item.title.slice(0, 1);
  return box;
}

export class MgPlaneView {
  readonly root: HTMLDivElement;

  private readonly callbacks: MgPlaneCallbacks;
  private data: MgPlaneData = MG_EMPTY_DATA;

  // 结构层
  private readonly bg: HTMLDivElement;
  private readonly gradeEl: HTMLDivElement;
  private readonly viewportEl: HTMLDivElement;
  private readonly worldEl: HTMLDivElement;
  private readonly gridEl: HTMLDivElement;
  private readonly zoneLayer: HTMLDivElement;
  private readonly coversLayer: HTMLDivElement;
  private readonly nowLayer: HTMLDivElement;
  private readonly ghostEl: HTMLDivElement;
  private readonly theaterEl: HTMLDivElement;
  private readonly hudEl: HTMLDivElement;
  private readonly crumbEl: HTMLSpanElement;
  private readonly miniEl: HTMLDivElement;
  private readonly miniFrame: HTMLElement;
  private readonly readoutEl: HTMLDivElement;
  private readonly hoverEl: HTMLDivElement;
  private readonly expandEl: HTMLDivElement;
  private readonly ringEl: HTMLDivElement;
  private readonly selEl: HTMLDivElement;
  private readonly debugEl: HTMLElement;
  private readonly toastEl: HTMLDivElement;
  private readonly pickEl: HTMLDivElement;
  /** 世界画布上的歌词窗口（屏幕层，不随相机缩放）。 */
  private readonly nowLyricEl: HTMLDivElement;
  private lyricKey = '';
  private picked: MgCoverBinding | null = null;
  private pickedNow = false;
  private theaterTrackKey = '';
  private plGroupId = '';
  private openKind: MgListKind | null = null;
  private plOpen = false;
  private stripEl: HTMLDivElement | null = null;
  private stripView: HTMLDivElement | null = null;
  private stripInner: HTMLDivElement | null = null;
  private stripBar: HTMLDivElement | null = null;
  private stripScroll = 0;
  private stripTarget = 0;
  private stripRaf = 0;
  private stripContent = 0;
  private stripViewH = 0;
  private readonly loadedTracks = new Map<MgListKind, OnlineTrack[]>();
  private readonly moreState = new Map<MgListKind, { loading: boolean; done: boolean }>();

  // 相机
  private cam: MgCam = { x: MG_WORLD_W / 2, y: MG_WORLD_H / 2, z: 0.24 };
  private fitZ = 0.24;
  private camAnim: MgCamAnim | null = null;
  private readonly drag: MgDragState = {
    active: false,
    id: -1,
    startX: 0,
    startY: 0,
    camX: 0,
    camY: 0,
    lastX: 0,
    lastY: 0,
    lastT: 0,
    moved: false,
    pointerType: 'mouse',
  };
  private inertiaRaf = 0;
  /** 滚轮缩放的目标值（与缓动中的 cam.z 分离，便于连续滚轮累加）。 */
  private zoomTarget = 0;
  private zoomRaf = 0;
  private zoomAnchor: { wx: number; wy: number; px: number; py: number } | null = null;
  /** 系统「减弱动态效果」偏好；开启时所有相机动画降级为 80ms 线性/直接到位。 */
  private readonly motionQuery: MediaQueryList | null =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;

  // 页面状态（只保留世界态：播放不再跳转独立播放页）
  private scene: MgScene = 'world';
  /** 播放页已取消：保留字段给旧剧场代码兜底，始终为 false，避免任何入口再进入播放页。 */
  private autoTheater = false;
  /** 本次 pointerdown 是否用于揭幕（剧场态第一下：只揭幕，不吞其余操作）。 */
  private theaterPress = false;
  private readonly covers: MgCoverBinding[] = [];
  private expanded: { track: OnlineTrack; tracks: OnlineTrack[]; index: number; scope: MgCoverBinding['scope'] } | null = null;
  private ring: { item: LibraryPlaylist; tracks: OnlineTrack[] } | null = null;
  private readonly sel = new Set<string>();
  private selTracks = new Map<string, OnlineTrack>();
  private selScope: MgCoverBinding['scope'] = 'daily';
  private readonly liked = new Set<string>();
  private radialEl: HTMLDivElement | null = null;
  private pressTimer = 0;
  private pressCover: MgCoverBinding | null = null;
  private pressStart: { x: number; y: number } | null = null;
  private hoverTimer = 0;
  private toastTimer = 0;
  private gradeToken = 0;
  private autoTimer = 0;
  private readonly autoSteps: number[] = [];

  // 开关
  private debugOpen = false;
  private debugFolded = false;
  private inertiaOn = true;
  private parallaxOn = true;
  private motionOn = true;
  private gradeMode: 'follow' | 'a' | 'b' = 'follow';

  // 生命周期
  private readonly unsubPlayer: () => void;
  private readonly onKeyDownBound = (event: KeyboardEvent): void => this.onKeyDown(event);
  private readonly resizeObserver: ResizeObserver;
  private readonly onResizeBound: () => void;
  private readonly timers: number[] = [];
  private disposed = false;
  private lastPlayerKey = '';
  private lastGradeTrack: OnlineTrack | null = null;

  constructor(callbacks: MgPlaneCallbacks) {
    this.callbacks = callbacks;
    this.root = h('div', { class: 'mgplane', tabindex: '0', 'aria-label': 'MG 画布首页' });
    this.bg = h('div', { class: 'mg-bg', 'aria-hidden': 'true' });
    this.gradeEl = h('div', { class: 'mg-grade', 'aria-hidden': 'true' });
    this.viewportEl = h('div', { class: 'mg-viewport' });
    this.worldEl = h('div', { class: 'mg-world' });
    this.gridEl = h('div', { class: 'mg-grid', 'aria-hidden': 'true' });
    this.zoneLayer = h('div', { class: 'mg-zonelayer' });
    this.coversLayer = h('div', { class: 'mg-covers' });
    this.nowLayer = h('div', { class: 'mg-now' });
    this.ghostEl = h('div', { class: 'mg-ghosts', 'aria-hidden': 'true' });
    this.theaterEl = h('div', { class: 'mg-theater' });
    this.hudEl = h('div', { class: 'mg-hud' });
    this.crumbEl = h('span', { class: 'mg-crumb-text' });
    this.miniEl = h('div', { class: 'mg-mini', 'aria-hidden': 'true' });
    this.miniFrame = h('i', { class: 'mg-mini-frame' });
    this.readoutEl = h('div', { class: 'mg-readout', 'aria-hidden': 'true' });
    this.hoverEl = h('div', { class: 'mg-hover', 'aria-hidden': 'true' });
    this.expandEl = h('div', { class: 'mg-expand', hidden: 'hidden' } as Record<string, string>);
    this.ringEl = h('div', { class: 'mg-ring', hidden: 'hidden' } as Record<string, string>);
    this.selEl = h('div', { class: 'mg-selbar', hidden: 'hidden' } as Record<string, string>);
    this.debugEl = h('aside', { class: 'mg-debug' });
    this.toastEl = h('div', { class: 'mg-toast', role: 'status', 'aria-live': 'polite' });
    this.pickEl = h('div', { class: 'mg-pickbar', hidden: 'hidden' } as Record<string, string>);
    this.nowLyricEl = h('div', { class: 'mg-now-lyric', 'aria-hidden': 'true' },
      h('span', { class: 'mg-now-ly is-prev' }),
      h('span', { class: 'mg-now-ly is-now' }),
      h('span', { class: 'mg-now-ly is-next' }),
    );
    this.worldEl.append(this.gridEl, this.zoneLayer, this.coversLayer, this.nowLayer, this.ghostEl);
    this.viewportEl.append(this.worldEl);
    this.root.append(
      this.bg,
      this.gradeEl,
      this.viewportEl,
      this.hudEl,
      this.miniEl,
      this.readoutEl,
      this.hoverEl,
      this.theaterEl,
      this.expandEl,
      this.ringEl,
      this.selEl,
      this.pickEl,
      this.debugEl,
      this.toastEl,
    );

    this.buildHud();
    this.buildTheater();
    this.buildDebug();
    this.buildMini();
    this.buildSelection();
    this.buildPickBar();

    this.onResizeBound = () => this.onResize();
    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(this.root);
    this.bindPointer();
    this.bindKeyboard();
    window.addEventListener('resize', this.onResizeBound);

    this.unsubPlayer = onPlayer((state) => this.onPlayerState(state));
    this.renderTheaterState();
    this.renderZones();
  }

  /* ------------------------------------------------------------------ */
  /* 对外：数据更新                                                      */
  /* ------------------------------------------------------------------ */

  update(data: MgPlaneData): void {
    if (this.disposed) return;
    this.data = data;
    this.renderZones();
    this.renderNow();
    this.renderTheaterState();
    this.syncTheaterTrack();
    const current = playerState().track;
    if (current && (!this.lastGradeTrack || mgTrackKey(current) !== mgTrackKey(this.lastGradeTrack))) {
      this.applyGrade(current);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAuto();
    this.cancelCamAnim();
    this.stopZoomAnim();
    if (this.inertiaRaf) cancelAnimationFrame(this.inertiaRaf);
    this.inertiaRaf = 0;
    this.clearPress();
    this.timers.forEach((id) => window.clearTimeout(id));
    this.timers.length = 0;
    this.unsubPlayer();
    this.resizeObserver.disconnect();
    window.removeEventListener('resize', this.onResizeBound);
    window.removeEventListener('keydown', this.onKeyDownBound);
    this.root.remove();
  }

  /* ------------------------------------------------------------------ */
  /* 骨架                                                                */
  /* ------------------------------------------------------------------ */

  private buildHud(): void {
    /* HUD 右侧把原左侧栏 / 顶栏入口全部融入画布：搜索、发现、我的歌单、设置、账号、歌词，外加私人雷达。 */
    const hudBtn = (name: string, label: string, run: () => void): HTMLButtonElement => {
      const btn = h('button', { class: 'mg-hud-btn', type: 'button', title: label, 'aria-label': label }, icon(name, 16));
      btn.addEventListener('click', run);
      return btn;
    };
    const search = hudBtn('search', '搜索', () => this.callbacks.search());
    const discover = hudBtn('compass', '发现', () => this.callbacks.discover());
    const myPlaylists = hudBtn('list', '我的歌单', () => this.callbacks.myPlaylists());
    const settings = hudBtn('sliders', '设置', () => this.callbacks.settings());
    const account = hudBtn('user', '账号', () => this.callbacks.account());
    const lyrics = hudBtn('lyrics', '歌词', () => this.callbacks.lyrics());
    const radar = hudBtn('sparkle', '私人雷达', () => this.callbacks.openList('radar'));
    this.hudEl.append(
      h('div', { class: 'mg-hud-brand' },
        h('span', { class: 'mg-hud-word', text: 'ZILUX2' }),
        h('i', { class: 'mg-hud-sep' }),
        h('span', { class: 'mg-hud-page' }, this.crumbEl),
      ),
      h('div', { class: 'mg-hud-actions' }, search, discover, myPlaylists, settings, account, lyrics, radar),
    );
    this.crumbEl.textContent = '平面世界 · 拖动探索';
  }

  private buildPickBar(): void {
    this.pickEl.hidden = true;
    this.pickEl.classList.remove('is-on');
  }

  /** 单击封面：高亮选中（同一时刻只有一个），底部浮出细信息条；双击才播放。 */
  private pickCover(binding: MgCoverBinding): void {
    this.clearPick();
    this.picked = binding;
    binding.el.classList.add('is-picked');
    this.pickEl.innerHTML = '';
    this.pickEl.append(
      h('b', { class: 'mg-pick-title', text: binding.track.title }),
      h('span', { class: 'mg-pick-artist', text: `${binding.track.artist} · ${mgDuration(binding.track.durationMs)}` }),
      h('span', { class: 'mg-pick-hint', text: '双击播放 · Esc 取消' }),
    );
    this.pickEl.hidden = false;
    this.pickEl.classList.add('is-on');
    this.crumbEl.textContent = `${binding.track.title} · 已选中`;
    this.hideHover();
    // 选中即对焦：相机平滑飞到该封面上（至少放大到 0.9，保证可读）。
    // 用屏幕矩形反算世界坐标，兼容世界封面、叠放里的卡片与展开列表里的卡片。
    const rect = binding.el.getBoundingClientRect();
    const rootRect = this.root.getBoundingClientRect();
    if (rect.width > 0 && rootRect.width > 0) {
      const z = this.cam.z || 1;
      const screenX = rect.left + rect.width / 2 - rootRect.left;
      const screenY = rect.top + rect.height / 2 - rootRect.top;
      const worldX = (screenX - rootRect.width / 2) / z + this.cam.x;
      const worldY = (screenY - rootRect.height / 2) / z + this.cam.y;
      const targetZ = Math.min(1.6, Math.max(z, 0.9));
      void this.flyTo({ x: worldX, y: worldY, z: targetZ }, 520);
    }
  }

  /** 单击 NOW 封面：高亮选中（双击才进入播放台）。 */
  private pickNow(art: HTMLElement): void {
    this.clearPick();
    this.pickedNow = true;
    art.classList.add('is-picked');
    const state = playerState();
    if (!state.track) return;
    this.pickEl.innerHTML = '';
    this.pickEl.append(
      h('b', { class: 'mg-pick-title', text: state.track.title }),
      h('span', { class: 'mg-pick-artist', text: state.track.artist }),
      h('span', { class: 'mg-pick-hint', text: '双击进入播放台 · Esc 取消' }),
    );
    this.pickEl.hidden = false;
    this.pickEl.classList.add('is-on');
    this.crumbEl.textContent = `${state.track.title} · 已选中`;
    this.hideHover();
  }

  private clearPick(): void {
    if (this.picked) this.picked.el.classList.remove('is-picked');
    this.picked = null;
    if (this.pickedNow) {
      this.nowLayer.querySelectorAll('.mg-now-art.is-picked').forEach((el) => el.classList.remove('is-picked'));
    }
    this.pickedNow = false;
    this.pickEl.classList.remove('is-on');
    this.pickEl.hidden = true;
    if (this.scene === 'world') this.crumbEl.textContent = '平面世界 · 拖动探索';
  }

  /** 双击封面：直接开播（不跳页面，世界里的 NOW 封面会更新为这首）。 */
  private playCover(binding: MgCoverBinding): void {
    this.clearPick();
    // 从展开列表里双击播放时先收起列表（不恢复镜头，随后由 focusNow 飞到 NOW）。
    this.closeZone(false);
    this.callbacks.play(binding.tracks, binding.index, binding.scope);
    // 播放页已取消；这里保留旧入口的兜底调用但永不触发（autoTheater 恒为 false）。
    if (this.autoTheater) this.enterTheaterFrom(binding.el);
    this.focusNow();
  }

  private playNow(): void {
    if (!playerState().track) return;
    this.clearPick();
    this.closeZone(false);
    if (this.autoTheater) this.enterTheaterFrom(null);
    this.focusNow();
  }

  /** 播放时把相机移到 NOW 封面 + 歌词所在位置，让当前曲目与歌词同屏。 */
  private focusNow(): void {
    const targetZ = Math.min(1.1, Math.max(this.cam.z, 0.95));
    void this.flyTo({ x: MG_NOW.x + 430, y: MG_NOW.y + 120, z: targetZ }, 560);
  }

  private enterTheaterFrom(from: HTMLElement | null): void {
    if (!playerState().track) return;
    this.clearPick();
    this.enterTheater();
    const art = this.theaterEl.querySelector('.mg-th-art');
    if (!(art instanceof HTMLElement)) return;
    art.classList.remove('is-fly');
    if (!from || this.reducedMotion) return;
    const target = art.getBoundingClientRect();
    const source = from.getBoundingClientRect();
    if (!target.width || !source.width) return;
    const scale = source.width / target.width;
    art.style.setProperty('--mg-fly-x', `${source.left + source.width / 2 - (target.left + target.width / 2)}px`);
    art.style.setProperty('--mg-fly-y', `${source.top + source.height / 2 - (target.top + target.height / 2)}px`);
    art.style.setProperty('--mg-fly-s', String(scale));
    void art.offsetWidth;
    art.classList.add('is-fly');
  }

  private buildTheater(): void {
    this.theaterEl.innerHTML = '';
  }

  private buildMini(): void {
    for (const zone of MG_ZONES) {
      const dot = h('i', { class: 'mg-mini-dot' });
      dot.style.left = `${(zone.x / MG_WORLD_W) * 100}%`;
      dot.style.top = `${(zone.y / MG_WORLD_H) * 100}%`;
      dot.title = zone.cn;
      dot.addEventListener('click', () => this.flyToZone(zone));
      this.miniEl.append(dot);
    }
    const nowDot = h('i', { class: 'mg-mini-dot is-now' });
    nowDot.style.left = `${(MG_NOW.x / MG_WORLD_W) * 100}%`;
    nowDot.style.top = `${(MG_NOW.y / MG_WORLD_H) * 100}%`;
    this.miniEl.append(nowDot, this.miniFrame, h('span', { class: 'mg-mini-cap', text: 'PLANE · 6 ZONES' }));
  }

  private buildSelection(): void {
    const play = h('button', { class: 'mg-sel-btn', type: 'button' }, icon('play', 13), h('span', { text: '播放选中' }));
    play.addEventListener('click', () => {
      const tracks = Array.from(this.sel).map((key) => this.selTracks.get(key)).filter((item): item is OnlineTrack => Boolean(item));
      if (!tracks.length) return;
      this.callbacks.play(tracks, 0, this.selScope);
      this.exitSelection();
    });
    const like = h('button', { class: 'mg-sel-btn', type: 'button' }, icon('heart', 13), h('span', { text: '收藏选中' }));
    like.addEventListener('click', () => {
      const tracks = Array.from(this.sel).map((key) => this.selTracks.get(key)).filter((item): item is OnlineTrack => Boolean(item));
      const online = tracks.filter((track) => !mgIsLocal(track));
      if (!online.length) {
        this.toast('本地曲目无需在线收藏');
        return;
      }
      void Promise.all(online.map((track) => addLikedTrack(track.source, track.id).catch(() => undefined)))
        .then(() => this.toast(`已收藏 ${online.length} 首`))
        .finally(() => this.exitSelection());
    });
    const cancel = h('button', { class: 'mg-sel-btn', type: 'button' }, icon('close', 13), h('span', { text: '取消' }));
    cancel.addEventListener('click', () => this.exitSelection());
    this.selEl.append(
      h('b', { class: 'mg-sel-count', text: '已选 0 首' }),
      h('div', { class: 'mg-sel-actions' }, play, like, cancel),
    );
  }

  /* ------------------------------------------------------------------ */
  /* 世界渲染（按数据签名增量重建）                                       */
  /* ------------------------------------------------------------------ */



  private renderZones(): void {
    this.covers.length = 0;
    this.coversLayer.innerHTML = '';
    this.zoneLayer.innerHTML = '';
    this.nowLayer.innerHTML = '';
    this.seedLoaded();
    for (const zone of MG_ZONES) this.buildStackZone(zone);
    this.buildPlaylistZone();
    this.buildNow();
    if (this.openKind) {
      this.renderStrip(this.openKind);
      this.updateOpenMarks();
    } else if (this.plOpen) {
      this.renderPlaylistStrip();
      this.updateOpenMarks();
    }
  }

  private addZoneLabel(zone: MgZoneSpec, halfHeight: number, extra?: HTMLElement): void {
    const label = h('div', { class: 'mg-zone-label' });
    label.style.left = `${zone.x}px`;
    label.style.top = `${zone.y - halfHeight - 18}px`;
    label.append(
      h('span', { class: 'mg-zone-kicker', text: `${zone.no} / ${zone.en}` }),
      h('b', { class: 'mg-zone-name', text: zone.cn }),
      h('span', { class: 'mg-zone-hint', text: zone.hint }),
    );
    if (extra) label.append(extra);
    const open = h('button', { class: 'mg-zone-open', type: 'button', 'aria-label': `打开${zone.cn}` }, icon('list', 12), h('span', { text: '打开列表' }));
    open.addEventListener('click', (event) => {
      event.stopPropagation();
      this.callbacks.openList(zone.kind);
    });
    label.append(open);
    this.zoneLayer.append(label);
  }

  private placeCover(track: OnlineTrack, size: number, x: number, y: number, tracks: OnlineTrack[], index: number, scope: MgCoverBinding['scope'], host: HTMLElement = this.coversLayer): HTMLElement {
    const btn = h('button', { class: 'mg-cover', type: 'button', 'aria-label': `${track.title} · ${track.artist}` });
    btn.style.left = `${x - size / 2}px`;
    btn.style.top = `${y - size / 2}px`;
    btn.dataset.worldX = String(x);
    btn.dataset.worldY = String(y);
    btn.style.width = `${size}px`;
    btn.style.height = `${size}px`;
    btn.dataset.key = mgTrackKey(track);
    btn.append(coverImg(track, track.title));
    btn.append(h('i', { class: 'mg-cover-edge', 'aria-hidden': 'true' }));
    const binding: MgCoverBinding = { track, tracks, index, scope, el: btn, size };
    this.covers.push(binding);
    btn.addEventListener('pointerenter', () => this.showHover(binding));
    btn.addEventListener('pointerleave', () => this.hideHover());
    btn.addEventListener('click', (event) => {
      if (this.drag.moved || this.pressConsumed()) return;
      event.stopPropagation();
      if (this.sel.size) {
        this.toggleSelection(binding);
        return;
      }
      this.pickCover(binding);
    });
    btn.addEventListener('dblclick', (event) => {
      if (this.drag.moved || this.sel.size) return;
      event.stopPropagation();
      this.playCover(binding);
    });
    host.append(btn);
    return btn;
  }

  private tracksFor(kind: MgListKind): OnlineTrack[] {
    const source =
      kind === 'daily' ? this.data.daily :
      kind === 'recent' ? this.data.recent :
      kind === 'liked' ? this.data.likedTracks :
      kind === 'radar' ? this.data.radar : [];
    return source.slice(0, ZONE_VIS[kind]);
  }

  /* ------------------------------------------------------------------ */
  /* v3：分区叠放 / 展开纵向列表 / 滚轮与分页                             */
  /* ------------------------------------------------------------------ */

  private seedLoaded(): void {
    for (const zone of MG_ZONES) {
      if (!this.loadedTracks.has(zone.kind) || this.loadedTracks.get(zone.kind)!.length === 0) {
        this.loadedTracks.set(zone.kind, this.tracksFor(zone.kind));
      }
    }
  }

  private loadedOf(kind: MgListKind): OnlineTrack[] {
    return this.loadedTracks.get(kind) ?? this.tracksFor(kind);
  }

  private countOf(kind: MgListKind): number {
    if (kind === 'local') return this.data.localCount;
    if (kind === 'liked') return this.data.likedCount;
    return this.loadedOf(kind).length;
  }

  private zoneOf(kind: MgListKind): MgZoneSpec {
    return MG_ZONES.find((zone) => zone.kind === kind) ?? MG_ZONES[0]!;
  }

  private buildStack(zone: MgZoneSpec, kind: MgListKind): void {
    const pool = this.loadedOf(kind);
    const stack = h('button', { class: 'mg-stack', type: 'button', 'data-kind': kind, 'aria-label': `展开${zone.cn}` });
    stack.style.left = `${zone.x}px`;
    stack.style.top = `${zone.y}px`;
    const rotations = ['-2deg', '1deg', '3deg'];
    const offsets = [0, 14, 28];
    for (let index = 0; index < 3; index += 1) {
      const card = h('i', { class: 'mg-stack-card', 'aria-hidden': 'true' });
      card.style.transform = `translate(${offsets[index]}px, ${offsets[index]}px) rotate(${rotations[index]})`;
      const track = pool[index];
      if (track) card.append(coverImg(track, track.title));
      stack.append(card);
    }
    stack.append(
      h('span', { class: 'mg-stack-count', text: `${this.countOf(kind)} 首` }),
      h('span', { class: 'mg-stack-hint', text: '点击展开 · 滚轮翻页' }),
    );
    stack.addEventListener('click', (event) => {
      event.stopPropagation();
      this.openZone(kind);
    });
    this.coversLayer.append(stack);
  }

  private buildStackZone(zone: MgZoneSpec): void {
    this.buildStack(zone, zone.kind);
    this.addZoneLabel(zone, 260);
  }

  private buildPlaylistZone(): void {
    const zone = MG_PLAYLIST_ZONE;
    const f = h('div', { class: 'mg-zone-frame', 'data-frame': 'playlists' });
    f.style.left = `${zone.x - 560}px`;
    f.style.top = `${zone.y - 400}px`;
    f.style.width = '1120px';
    f.style.height = '800px';
    f.append(h('span', { class: 'mg-zone-num', text: '04' }));
    this.zoneLayer.append(f);
    const groups = this.playlistGroups();
    const active = groups.find((group) => group.id === this.plGroupId) ?? groups[0];
    const stack = h('button', { class: 'mg-stack mg-stack-pl', type: 'button', 'aria-label': '展开热门歌单' });
    stack.style.left = `${zone.x}px`;
    stack.style.top = `${zone.y - 110}px`;
    const rotations = ['-2deg', '1deg', '3deg'];
    const offsets = [0, 14, 28];
    for (let index = 0; index < 3; index += 1) {
      const card = h('i', { class: 'mg-stack-card', 'aria-hidden': 'true' });
      card.style.transform = `translate(${offsets[index]}px, ${offsets[index]}px) rotate(${rotations[index]})`;
      const item = active?.items[index];
      if (item) card.append(playlistArt(item));
      stack.append(card);
    }
    const total = groups.reduce((sum, group) => sum + group.items.length, 0);
    stack.append(
      h('span', { class: 'mg-stack-count', text: `${active?.items.length ?? 0} / ${total} 张` }),
      h('span', { class: 'mg-stack-hint', text: '点击展开 · 滚轮翻页' }),
    );
    stack.addEventListener('click', (event) => {
      event.stopPropagation();
      this.openPlaylistZone(true);
    });
    this.coversLayer.append(stack);
    const zoneLabel = h('div', { class: 'mg-zone-label' });
    zoneLabel.style.left = `${zone.x}px`;
    zoneLabel.style.top = `${zone.y - 400 - 18}px`;
    zoneLabel.append(
      h('span', { class: 'mg-zone-kicker', text: '04 / PLAYLISTS' }),
      h('b', { class: 'mg-zone-name', text: zone.cn }),
      h('span', { class: 'mg-zone-hint', text: '点叠放展开歌单分册' }),
    );
    if (groups.length) {
      if (!groups.some((group) => group.id === this.plGroupId)) this.plGroupId = groups[0]!.id;
      const tabs = h('div', { class: 'mg-pl-tabs' });
      groups.forEach((group) => {
        const tab = h('button', {
          class: `mg-pl-tab${group.id === this.plGroupId ? ' is-on' : ''}`,
          type: 'button',
          text: group.label,
        });
        tab.addEventListener('click', (event) => {
          event.stopPropagation();
          this.plGroupId = group.id;
          this.renderZones();
          if (this.plOpen) this.renderPlaylistStrip();
        });
        tabs.append(tab);
      });
      zoneLabel.append(tabs);
    }
    this.zoneLayer.append(zoneLabel);
    const open = h('button', { class: 'mg-zone-open', type: 'button', 'aria-label': '打开热门歌单' }, icon('list', 12), h('span', { text: '我的歌单' }));
    open.addEventListener('click', (event) => {
      event.stopPropagation();
      this.callbacks.myPlaylists();
    });
    zoneLabel.append(open);
  }

  /* ---------- 展开 / 收拢 ---------- */

  private openZone(kind: MgListKind): void {
    if (this.openKind === kind) return;
    this.closeExpand(false);
    this.closeRing();
    this.exitSelection();
    this.clearPick();
    this.openKind = kind;
    this.plOpen = false;
    this.root.classList.add('is-zone-open');
    this.root.dataset.openKind = kind;
    this.renderZones();
    this.updateOpenMarks();
    const zone = this.zoneOf(kind);
    const top = clamp(zone.y - 590, 40, MG_WORLD_H - 1240);
    void this.flyTo({ x: zone.x, y: top + 590, z: clamp(900 / 1180, 0.5, 0.95) }, 480);
  }

  private openPlaylistZone(animate: boolean): void {
    this.closeExpand(false);
    this.closeRing();
    this.exitSelection();
    this.clearPick();
    this.openKind = null;
    this.plOpen = true;
    this.root.classList.add('is-zone-open');
    this.root.dataset.openKind = 'playlist';
    this.updateOpenMarks();
    this.renderPlaylistStrip();
    if (animate) {
      const zone = MG_PLAYLIST_ZONE;
      void this.flyTo({ x: zone.x, y: zone.y, z: clamp(900 / 1180, 0.5, 0.95) }, 480);
    }
  }

  private closeZone(restoreCamera = true): void {
    if (!this.openKind && !this.plOpen) return;
    this.openKind = null;
    this.plOpen = false;
    this.root.classList.remove('is-zone-open');
    delete this.root.dataset.openKind;
    this.stopStrip();
    const strip = this.stripEl;
    this.stripEl = null;
    this.stripView = null;
    this.stripInner = null;
    this.stripBar = null;
    this.stripContent = 0;
    if (strip) {
      strip.classList.add('is-closing');
      window.setTimeout(() => strip.remove(), this.reducedMotion ? 0 : 180);
    }
    this.updateOpenMarks();
    if (restoreCamera) this.flyToOverview();
  }

  private updateOpenMarks(): void {
    this.coversLayer.querySelectorAll('.mg-stack').forEach((node) => node.classList.remove('is-active'));
    if (this.openKind) {
      const stack = this.coversLayer.querySelector(`.mg-stack[data-kind="${this.openKind}"]`);
      if (stack instanceof HTMLElement) stack.classList.add('is-active');
    }
    if (this.plOpen) {
      const stack = this.coversLayer.querySelector('.mg-stack-pl');
      if (stack instanceof HTMLElement) stack.classList.add('is-active');
    }
  }

  /* ---------- 曲目列表 ---------- */

  private renderStrip(kind: MgListKind): void {
    this.removeStrip();
    const zone = this.zoneOf(kind);
    const top = clamp(zone.y - 590, 40, MG_WORLD_H - 1240);
    const strip = h('div', { class: 'mg-strip', 'data-strip': kind });
    strip.style.left = `${zone.x - 210}px`;
    strip.style.top = `${top}px`;
    const head = h('div', { class: 'mg-strip-head' },
      h('div', { class: 'mg-strip-title' },
        h('span', { class: 'mg-strip-kicker', text: `${zone.no} / ${zone.en}` }),
        h('b', { class: 'mg-strip-name', text: zone.cn }),
        h('span', { class: 'mg-strip-count', text: `${this.countOf(kind)} 首` }),
      ),
      h('button', { class: 'mg-strip-close', type: 'button', title: '收起', 'aria-label': '收起' }, icon('close', 14)),
    );
    head.querySelector('.mg-strip-close')?.addEventListener('click', (event) => {
      event.stopPropagation();
      this.closeZone();
    });
    const view = h('div', { class: 'mg-strip-view' });
    const inner = h('div', { class: 'mg-strip-inner' });
    view.append(inner);
    const bar = h('div', { class: 'mg-strip-bar' }, h('i', { class: 'mg-strip-thumb' }));
    strip.append(head, view, bar, h('span', { class: 'mg-strip-foot', text: '滚轮 / 拖动 · 单击选中 · 双击播放 · Esc 收起' }));
    this.coversLayer.append(strip);
    this.stripEl = strip;
    this.stripView = view;
    this.stripInner = inner;
    this.stripBar = bar;
    this.stripViewH = 0;
    this.stripContent = 0;
    this.stripScroll = 0;
    this.stripTarget = 0;
    this.rebuildTrackCards(kind, 0);
    this.bindStripScroll(view);
    strip.classList.add('is-in');
  }

  private rebuildTrackCards(kind: MgListKind, staggerFrom: number): void {
    const zone = this.zoneOf(kind);
    const inner = this.stripInner;
    if (!inner) return;
    const tracks = this.loadedOf(kind);
    inner.innerHTML = '';
    const size = 200;
    const gap = 24;
    const stripTop = parseFloat(this.stripEl?.style.top ?? '0') || 0;
    tracks.forEach((track, index) => {
      const top = index * (size + gap);
      const card = this.placeCover(track, size, zone.x, stripTop + top + size / 2, tracks, index, kind, inner);
      card.style.position = 'relative';
      card.style.left = '0';
      card.style.top = '0';
      card.classList.add('mg-strip-card');
      if (!this.reducedMotion && index >= staggerFrom) {
        card.classList.add('is-append');
        card.style.animationDelay = `${(index - staggerFrom) * 40}ms`;
      }
    });
    const end = this.moreState.get(kind)?.done
      ? h('button', { class: 'mg-strip-end', type: 'button' },
          h('b', { text: '已经到底了' }),
          h('span', { text: '打开完整列表 →' }))
      : null;
    if (end) {
      end.style.top = `${tracks.length * (size + gap) + 8}px`;
      end.addEventListener('click', (event) => {
        event.stopPropagation();
        this.callbacks.openList(kind);
      });
      inner.append(end);
    }
    this.stripContent = tracks.length * (size + gap) + (end ? 120 : 0);
    this.stripScroll = clamp(this.stripScroll, 0, Math.max(0, this.stripContent - this.stripViewH));
    this.stripTarget = this.stripScroll;
    this.applyStripScroll();
    this.updateStripBar();
  }

  /* ---------- 歌单列表 ---------- */

  private renderPlaylistStrip(): void {
    this.removeStrip();
    const zone = MG_PLAYLIST_ZONE;
    const groups = this.playlistGroups();
    const active = groups.find((group) => group.id === this.plGroupId) ?? groups[0];
    const items = active ? active.items : [];
    const strip = h('div', { class: 'mg-strip', 'data-strip': 'playlist' });
    strip.style.left = `${zone.x - 210}px`;
    strip.style.top = `${clamp(zone.y - 590, 40, MG_WORLD_H - 1240)}px`;
    const head = h('div', { class: 'mg-strip-head' },
      h('div', { class: 'mg-strip-title' },
        h('span', { class: 'mg-strip-kicker', text: '04 / PLAYLISTS' }),
        h('b', { class: 'mg-strip-name', text: active ? active.label : '热门歌单' }),
        h('span', { class: 'mg-strip-count', text: `${items.length} 张` }),
      ),
      h('button', { class: 'mg-strip-close', type: 'button', title: '收起', 'aria-label': '收起' }, icon('close', 14)),
    );
    head.querySelector('.mg-strip-close')?.addEventListener('click', (event) => {
      event.stopPropagation();
      this.closeZone();
    });
    const view = h('div', { class: 'mg-strip-view' });
    const inner = h('div', { class: 'mg-strip-inner' });
    view.append(inner);
    const bar = h('div', { class: 'mg-strip-bar' }, h('i', { class: 'mg-strip-thumb' }));
    const tabs = h('div', { class: 'mg-pl-tabs mg-strip-tabs' });
    for (const group of groups) {
      const tab = h('button', {
        class: `mg-pl-tab${group.id === this.plGroupId ? ' is-on' : ''}`,
        type: 'button',
        text: group.label,
      });
      tab.addEventListener('click', (event) => {
        event.stopPropagation();
        if (this.plGroupId === group.id) return;
        this.plGroupId = group.id;
        this.renderPlaylistStrip();
      });
      tabs.append(tab);
    }
    strip.append(head, tabs, view, bar, h('span', { class: 'mg-strip-foot', text: '滚轮 / 拖动 · 点击歌单展开曲目环 · Esc 收起' }));
    this.coversLayer.append(strip);
    this.stripEl = strip;
    this.stripView = view;
    this.stripInner = inner;
    this.stripBar = bar;
    this.stripViewH = 0;
    this.stripContent = 0;
    this.stripScroll = 0;
    this.stripTarget = 0;
    const cardW = 320;
    const cardH = 180;
    const gap = 16;
    items.forEach((item, index) => {
      const card = h('button', { class: 'mg-pl-strip-card', type: 'button', 'aria-label': `打开歌单 ${item.title}` });
      card.style.top = `${index * (cardH + gap)}px`;
      card.style.left = `${210 - cardW / 2}px`;
      card.style.width = `${cardW}px`;
      card.style.height = `${cardH}px`;
      card.append(playlistArt(item));
      card.append(
        h('div', { class: 'mg-pl-strip-meta' },
          h('b', { text: item.title }),
          h('span', { text: `${item.count} 首 · ${item.creator ?? '精选歌单'}` }),
        ),
        h('i', { class: 'mg-pl-shade', 'aria-hidden': 'true' }),
      );
      card.addEventListener('click', (event) => {
        event.stopPropagation();
        void this.openRing(item);
      });
      if (!this.reducedMotion) {
        card.classList.add('is-append');
        card.style.animationDelay = `${index * 26}ms`;
      }
      inner.append(card);
    });
    const all = h('button', { class: 'mg-strip-end', type: 'button' },
      h('b', { text: '全部歌单' }),
      h('span', { text: '在我的人歌单里继续 →' }));
    all.style.top = `${items.length * (cardH + gap) + 8}px`;
    all.addEventListener('click', (event) => {
      event.stopPropagation();
      this.callbacks.myPlaylists();
    });
    inner.append(all);
    this.stripContent = items.length * (cardH + gap) + 120;
    this.bindStripScroll(view);
    this.applyStripScroll();
    this.updateStripBar();
    strip.classList.add('is-in');
  }

  /* ---------- 列表滚动（平滑 / 拖拽 / 分页） ---------- */

  private bindStripScroll(view: HTMLDivElement): void {
    view.addEventListener('wheel', (event) => {
      if (!this.stripEl) return;
      event.preventDefault();
      event.stopPropagation();
      const delta = event.deltaY * 1.1;
      this.setStripTarget(this.stripTarget + delta);
      this.maybeLoadMore();
    }, { passive: false });
    let dragId = -1;
    let startY = 0;
    let startScroll = 0;
    let moved = false;
    view.addEventListener('pointerdown', (event) => {
      if ((event.target as HTMLElement).closest('button.mg-cover, .mg-pl-strip-card, .mg-strip-end, .mg-strip-close')) return;
      dragId = event.pointerId;
      startY = event.clientY;
      startScroll = this.stripTarget;
      moved = false;
      view.setPointerCapture?.(event.pointerId);
    });
    view.addEventListener('pointermove', (event) => {
      if (event.pointerId !== dragId) return;
      const dy = event.clientY - startY;
      if (Math.abs(dy) > 4) moved = true;
      if (!moved) return;
      this.setStripTarget(startScroll - dy / Math.max(0.2, this.cam.z));
      this.maybeLoadMore();
    });
    const end = (event: PointerEvent): void => {
      if (event.pointerId !== dragId) return;
      dragId = -1;
      if (moved) this.drag.moved = true;
      window.setTimeout(() => { this.drag.moved = false; }, 0);
    };
    view.addEventListener('pointerup', end);
    view.addEventListener('pointercancel', end);
  }

  private setStripTarget(value: number): void {
    const max = Math.max(0, this.stripContent - this.stripViewH);
    this.stripTarget = clamp(value, 0, max);
    if (this.reducedMotion) {
      this.stripScroll = this.stripTarget;
      this.applyStripScroll();
      return;
    }
    if (!this.stripRaf) this.stripRaf = requestAnimationFrame(() => this.tickStrip());
  }

  private tickStrip(): void {
    this.stripRaf = 0;
    const diff = this.stripTarget - this.stripScroll;
    const k = 0.22;
    this.stripScroll += diff * k;
    if (Math.abs(this.stripTarget - this.stripScroll) < 0.5) this.stripScroll = this.stripTarget;
    this.applyStripScroll();
    if (this.stripScroll !== this.stripTarget) this.stripRaf = requestAnimationFrame(() => this.tickStrip());
  }

  private applyStripScroll(): void {
    if (this.stripInner) this.stripInner.style.transform = `translateY(${-this.stripScroll}px)`;
    if (this.stripView && this.stripViewH === 0) {
      this.stripViewH = this.stripView.clientHeight || 0;
      const max = Math.max(0, this.stripContent - this.stripViewH);
      this.stripTarget = clamp(this.stripTarget, 0, max);
    }
    this.updateStripBar();
  }

  private updateStripBar(): void {
    const bar = this.stripBar;
    if (!bar) return;
    const viewH = this.stripViewH || 0;
    const max = Math.max(0, this.stripContent - viewH);
    const thumb = bar.querySelector('.mg-strip-thumb');
    if (!(thumb instanceof HTMLElement)) return;
    if (max <= 0 || viewH <= 0) {
      thumb.style.height = '0px';
      thumb.style.transform = 'translateY(0px)';
      return;
    }
    const height = Math.max(24, (viewH / this.stripContent) * viewH);
    const offset = (this.stripScroll / max) * (viewH - height);
    thumb.style.height = `${height}px`;
    thumb.style.transform = `translateY(${offset}px)`;
  }

  private stopStrip(): void {
    if (this.stripRaf) cancelAnimationFrame(this.stripRaf);
    this.stripRaf = 0;
  }

  private removeStrip(): void {
    this.stopStrip();
    if (this.stripEl) this.stripEl.remove();
    this.stripEl = null;
    this.stripView = null;
    this.stripInner = null;
    this.stripBar = null;
  }

  private maybeLoadMore(): void {
    const kind = this.openKind;
    if (!kind) return;
    if (this.stripViewH === 0) return;
    const remain = this.stripContent - Math.max(this.stripScroll, this.stripTarget) - this.stripViewH;
    if (remain > this.stripViewH * 0.6) return;
    const state = this.moreState.get(kind) ?? { loading: false, done: false };
    if (state.loading || state.done) return;
    state.loading = true;
    this.moreState.set(kind, state);
    const loaded = this.loadedOf(kind).slice();
    const before = loaded.length;
    void this.callbacks.moreTracks(kind, before, 20)
      .then((list) => {
        state.loading = false;
        const seen = new Set(loaded.map((track) => mgTrackKey(track)));
        const fresh = list.filter((track) => {
          const key = mgTrackKey(track);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (!fresh.length) {
          state.done = true;
          this.rebuildTrackCards(kind, before);
          this.toast('已经到底了');
          return;
        }
        for (const track of fresh) loaded.push(track);
        this.loadedTracks.set(kind, loaded);
        this.rebuildTrackCards(kind, before);
        const strip = this.stripEl;
        if (strip) {
          const count = strip.querySelector('.mg-strip-count');
          if (count instanceof HTMLElement) count.textContent = `${this.countOf(kind)} 首`;
        }
        this.toast(`加载 ${fresh.length} 首`);
      })
      .catch(() => {
        state.loading = false;
        state.done = true;
        this.rebuildTrackCards(kind, before);
      });
  }

  private playlistGroups(): MgPlaylistGroup[] {
    if (this.data.playlistGroups.length) return this.data.playlistGroups;
    if (this.data.playlists.length) return [{ id: 'hot', label: '热门歌单', items: this.data.playlists }];
    return [];
  }



  private renderNow(): void {
    this.nowLayer.innerHTML = '';
    this.buildNow();
  }

  /** 切歌过渡：旧信息先淡出 140ms，再重建新内容并依次入场（MG 式过渡）。 */
  private transitionNow(): void {
    if (this.reducedMotion) {
      this.buildNow();
      return;
    }
    this.nowLayer.classList.add('is-swapping');
    this.timers.push(window.setTimeout(() => {
      this.buildNow(true);
      this.nowLayer.classList.remove('is-swapping');
    }, 140));
  }

  private buildNow(animate = false): void {
    // 每次重建先清空，避免切歌时新旧封面/标题叠加（首曲进入时尤其明显）。
    this.nowLayer.innerHTML = '';
    const state = playerState();
    const track = state.track;
    if (!track) {
      this.nowLyricEl.remove();
      const hint = h('div', { class: 'mg-now-empty' });
      hint.style.left = `${MG_NOW.x - 260}px`;
      hint.style.top = `${MG_NOW.y - 90}px`;
      hint.append(
        h('b', { text: '还没有在放的唱片' }),
        h('span', { text: '点一张封面开始播放' }),
      );
      this.nowLayer.append(hint);
      return;
    }
    const art = h('button', { class: 'mg-now-art', type: 'button', 'aria-label': `当前播放 ${track.title}` });
    art.style.left = `${MG_NOW.x - 260}px`;
    art.style.top = `${MG_NOW.y - 260}px`;
    art.append(coverImg(track, track.title));
    art.addEventListener('click', () => this.pickNow(art));
    art.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      this.playNow();
    });
    const info = h('div', { class: 'mg-now-info' });
    info.style.left = `${MG_NOW.x + 330}px`;
    // 歌名等信息与封面顶部对齐（不再垂直居中）。
    info.style.top = `${MG_NOW.y - 260}px`;
    info.append(
      h('span', { class: 'mg-now-kicker', text: 'NOW PLAYING' }),
      h('b', { class: 'mg-now-title', text: track.title }),
      h('span', { class: 'mg-now-artist', text: `${track.artist}${track.album ? ` · ${track.album}` : ''}` }),
      h('span', { class: 'mg-now-meta', text: `${String(state.index + 1).padStart(2, '0')} / ${String(Math.max(state.queue.length, 1)).padStart(2, '0')} · ${mgDuration(track.durationMs)}${state.playing ? ' · 播放中' : ''}` }),
    );
    // 歌词贴在歌曲名下方（随信息块自然排版），不再单独定位到世界远处。
    info.append(this.nowLyricEl);
    this.nowLayer.append(art, info);
    if (animate && !this.reducedMotion) {
      // 切歌入场：封面先落位，文字行依次跟进（stagger 46ms）。
      art.classList.add('is-enter');
      const lines = [
        info.querySelector('.mg-now-kicker'),
        info.querySelector('.mg-now-title'),
        info.querySelector('.mg-now-artist'),
        info.querySelector('.mg-now-meta'),
        this.nowLyricEl,
      ];
      lines.forEach((node, index) => {
        if (!(node instanceof HTMLElement)) return;
        node.classList.add('is-enter');
        node.style.setProperty('--i', String(index));
      });
    }
  }

  private syncTheaterTrack(): void {
    if (this.scene !== 'theater') return;
    this.buildTheaterContent();
  }

  /* ------------------------------------------------------------------ */
  /* 剧场（开场）                                                        */
  /* ------------------------------------------------------------------ */

  private buildTheaterContent(): void {
    const state = playerState();
    const track = state.track;
    this.theaterEl.innerHTML = '';
    if (!track) {
      this.theaterTrackKey = '';
      return;
    }
    const key = `${mgTrackKey(track)}:${state.index}`;
    const art = h('div', { class: 'mg-th-art' });
    art.append(coverImg(track, track.title));
    const stage = h('div', { class: 'mg-th-stage' }, art);
    const progress = state.durationMs > 0 ? clamp(state.positionMs / state.durationMs, 0, 1) : 0.32;
    const fill = h('i', { class: 'mg-th-fill' });
    fill.style.width = `${progress * 100}%`;
    const bar = h('div', { class: 'mg-th-progress' },
      fill,
      h('span', { class: 'mg-th-time', text: `${state.positionMs > 0 ? mgDuration(state.positionMs) : '0:00'} / ${mgDuration(state.durationMs)}` }),
    );
    const info = h('div', { class: 'mg-th-info' },
      h('b', { class: 'mg-th-title', text: track.title }),
      h('span', { class: 'mg-th-artist', text: track.artist }),
      bar,
    );
    this.theaterEl.append(stage, info, h('div', { class: 'mg-th-hint', text: 'Esc 回封面墙' }));
    if (this.theaterTrackKey && this.theaterTrackKey !== key) art.classList.add('is-swap');
    this.theaterTrackKey = key;
  }

  /** 世界画布右中位置的歌词窗口：上一句 / 当前句 / 下一句；无歌词或不在世界态时隐藏。 */
  private applyNowLyric(): void {
    const track = playerState().track;
    if (!track || this.scene !== 'world') {
      this.nowLyricEl.classList.remove('is-on');
      return;
    }
    let line = { prev: '', now: '', next: '' };
    try {
      line = this.callbacks.lyric();
    } catch {
      line = { prev: '', now: '', next: '' };
    }
    const prev = (line.prev || '').trim();
    const now = (line.now || '').trim();
    const next = (line.next || '').trim();
    if (!prev && !now && !next) {
      this.nowLyricEl.classList.remove('is-on');
      this.lyricKey = '';
      return;
    }
    const key = `${prev}\u0001${now}\u0001${next}`;
    if (key !== this.lyricKey) {
      const wasOn = this.nowLyricEl.classList.contains('is-on');
      this.lyricKey = key;
      const nodes = this.nowLyricEl.querySelectorAll('.mg-now-ly');
      const values = [prev, now, next];
      nodes.forEach((node, index) => {
        if (node instanceof HTMLElement) node.textContent = values[index] ?? '';
      });
      // 逐句切换也做一次轻量上浮动画，避免歌词生硬跳变。
      if (wasOn && !this.reducedMotion) {
        this.nowLyricEl.classList.remove('is-flip');
        void this.nowLyricEl.offsetWidth;
        this.nowLyricEl.classList.add('is-flip');
        this.timers.push(window.setTimeout(() => this.nowLyricEl.classList.remove('is-flip'), 280));
      }
    }
    this.nowLyricEl.classList.add('is-on');
  }

  /** 播放进度（不重建播放台，和歌词一起做轻量同步）。 */
  private syncTheaterProgress(): void {
    const state = playerState();
    const progress = state.durationMs > 0 ? clamp(state.positionMs / state.durationMs, 0, 1) : 0;
    const fill = this.theaterEl.querySelector('.mg-th-fill');
    if (fill instanceof HTMLElement) fill.style.width = `${progress * 100}%`;
    const time = this.theaterEl.querySelector('.mg-th-time');
    if (time instanceof HTMLElement) time.textContent = `${state.positionMs > 0 ? mgDuration(state.positionMs) : '0:00'} / ${mgDuration(state.durationMs)}`;
  }

  private renderTheaterState(): void {
    const hasTrack = Boolean(playerState().track);
    if (!hasTrack) {
      this.scene = 'world';
    } else if (this.scene !== 'theater' && this.scene !== 'world') {
      this.scene = 'world';
    }
    this.root.dataset.scene = this.scene;
    if (this.scene === 'theater') this.buildTheaterContent();
  }

  private enterTheater(): void {
    this.autoTheater = false;
    if (!playerState().track) return;
    this.closeExpand(false);
    this.closeRing();
    this.exitSelection();
    this.scene = 'theater';
    this.root.dataset.scene = 'theater';
    this.renderTheaterState();
    this.stopAuto();
    this.applyNowLyric();
    this.crumbEl.textContent = '正在播放 · 播放台';
  }

  private leaveTheater(): void {
    if (this.scene !== 'theater') return;
    this.scene = 'world';
    this.root.dataset.scene = 'world';
    this.applyNowLyric();
    this.crumbEl.textContent = '平面世界 · 拖动探索';
  }

  /* ------------------------------------------------------------------ */
  /* 相机                                                                */
  /* ------------------------------------------------------------------ */

  private size(): { w: number; h: number } {
    return { w: this.root.clientWidth || 1280, h: this.root.clientHeight || 720 };
  }

  private computeFit(): number {
    const { w, h } = this.size();
    const usableH = Math.max(320, h - 40);
    return Math.min((w * 0.92) / MG_WORLD_W, (usableH * 0.9) / MG_WORLD_H);
  }

  /**
   * 相机可移动范围（世界坐标）。
   *
   * 视野比「世界 + 安全边」还大时（缩到全貌），世界本来就装得下，不限制移动而是
   * 固定在世界中心，否则会被错误地夹到一侧（旧实现第一次拖动会跳一下）。
   * 视野更小时，允许看到世界外最多 MG_SAFE 的留白。
   */
  private camLimits(z: number): { minX: number; maxX: number; minY: number; maxY: number } {
    const { w, h } = this.size();
    const viewW = w / z;
    const viewH = h / z;
    const spanX = MG_WORLD_W + MG_SAFE * 2;
    const spanY = MG_WORLD_H + MG_SAFE * 2;
    if (viewW >= spanX) {
      const x = MG_WORLD_W / 2;
      if (viewH >= spanY) {
        const y = MG_WORLD_H / 2;
        return { minX: x, maxX: x, minY: y, maxY: y };
      }
      return {
        minX: x,
        maxX: x,
        minY: -MG_SAFE + viewH / 2,
        maxY: MG_WORLD_H + MG_SAFE - viewH / 2,
      };
    }
    if (viewH >= spanY) {
      const y = MG_WORLD_H / 2;
      return {
        minX: -MG_SAFE + viewW / 2,
        maxX: MG_WORLD_W + MG_SAFE - viewW / 2,
        minY: y,
        maxY: y,
      };
    }
    return {
      minX: -MG_SAFE + viewW / 2,
      maxX: MG_WORLD_W + MG_SAFE - viewW / 2,
      minY: -MG_SAFE + viewH / 2,
      maxY: MG_WORLD_H + MG_SAFE - viewH / 2,
    };
  }

  private clampCam(cam: MgCam): MgCam {
    const limits = this.camLimits(cam.z);
    return { x: clamp(cam.x, limits.minX, limits.maxX), y: clamp(cam.y, limits.minY, limits.maxY), z: cam.z };
  }

  private applyCam(): void {
    const { w, h } = this.size();
    const style = this.worldEl.style;
    style.transform = `translate(${w / 2 - this.cam.x * this.cam.z}px, ${h / 2 - this.cam.y * this.cam.z}px) scale(${this.cam.z})`;
    this.readoutEl.textContent = `X ${Math.round(this.cam.x)} · Y ${Math.round(this.cam.y)} · Z ${this.cam.z.toFixed(2)}`;
    this.root.dataset.cam = `${Math.round(this.cam.x)},${Math.round(this.cam.y)},${this.cam.z.toFixed(3)}`;
    const left = ((this.cam.x - this.size().w / (2 * this.cam.z)) / MG_WORLD_W) * 100;
    const top = ((this.cam.y - this.size().h / (2 * this.cam.z)) / MG_WORLD_H) * 100;
    const wPct = ((this.size().w / this.cam.z) / MG_WORLD_W) * 100;
    const hPct = ((this.size().h / this.cam.z) / MG_WORLD_H) * 100;
    this.miniFrame.style.left = `${clamp(left, 0, 100)}%`;
    this.miniFrame.style.top = `${clamp(top, 0, 100)}%`;
    this.miniFrame.style.width = `${clamp(wPct, 4, 100)}%`;
    this.miniFrame.style.height = `${clamp(hPct, 4, 100)}%`;
    if (this.parallaxOn) {
      const dx = (this.cam.x - MG_WORLD_W / 2) * 0.012;
      const dy = (this.cam.y - MG_WORLD_H / 2) * 0.012;
      this.gridEl.style.transform = `translate(${dx}px, ${dy}px)`;
      this.zoneLayer.style.transform = `translate(${dx * 0.45}px, ${dy * 0.45}px)`;
    } else {
      this.gridEl.style.transform = '';
      this.zoneLayer.style.transform = '';
    }
  }

  private cancelCamAnim(): void {
    if (!this.camAnim) return;
    cancelAnimationFrame(this.camAnim.raf);
    const resolve = this.camAnim.resolve;
    this.camAnim = null;
    resolve();
  }

  /** prefers-reduced-motion：动画降级为 80ms 线性 / 直接到位。 */
  private get reducedMotion(): boolean {
    return Boolean(this.motionQuery?.matches);
  }

  private zoomMin(): number {
    // 规格下限 0.3；但 1600×960 世界全貌 fit≈0.22，若硬性 0.3，第一次向下滚会“缩小却变大”。
    // 所以取 min(0.3, 全貌下限)，既尊重规格又保证从全貌能继续缩小。
    return Math.min(ZOOM_MIN, this.minZoom());
  }

  /** 停止滚轮平滑缩放（不清目标值，供指针按下 / 飞行 / dispose 打断）。 */
  private stopZoomAnim(): void {
    if (this.zoomRaf) cancelAnimationFrame(this.zoomRaf);
    this.zoomRaf = 0;
    this.zoomAnchor = null;
    this.zoomTarget = this.cam.z;
  }

  /** 用 rAF 指数趋近目标缩放（时间常数 ~100ms），指针锚定世界点保持不动。 */
  private startZoomAnim(): void {
    if (this.zoomRaf) return;
    let last = nowMs();
    const step = (): void => {
      this.zoomRaf = 0;
      if (this.disposed || !this.isActive()) return;
      const now = nowMs();
      const dt = clamp(now - last, 1, 64);
      last = now;
      const { w, h } = this.size();
      const k = this.reducedMotion ? 1 : 1 - Math.exp(-dt / ZOOM_TAU);
      const zNext = this.cam.z + (this.zoomTarget - this.cam.z) * k;
      const z = Math.abs(this.zoomTarget - zNext) < ZOOM_SETTLE ? this.zoomTarget : zNext;
      const anchor = this.zoomAnchor;
      this.cam = this.clampCam(
        anchor
          ? {
              x: anchor.wx - (anchor.px - w / 2) / z,
              y: anchor.wy - (anchor.py - h / 2) / z,
              z,
            }
          : { ...this.cam, z },
      );
      this.applyCam();
      if (Math.abs(this.zoomTarget - this.cam.z) > ZOOM_SETTLE) {
        this.zoomRaf = requestAnimationFrame(step);
      } else {
        this.zoomAnchor = null;
      }
    };
    this.zoomRaf = requestAnimationFrame(step);
  }

  private flyTo(to: Partial<MgCam>, duration = FLY_MS, ease: (t: number) => number = easeInOut): Promise<void> {
    const targetZ = clamp(to.z ?? this.cam.z, this.minZoom(), CAM_MAX_Z);
    const limits = this.camLimits(targetZ);
    const target: MgCam = {
      x: clamp(to.x ?? this.cam.x, limits.minX, limits.maxX),
      y: clamp(to.y ?? this.cam.y, limits.minY, limits.maxY),
      z: targetZ,
    };
    this.cancelCamAnim();
    this.stopZoomAnim();
    const targetDuration = this.reducedMotion ? Math.min(REDUCED_MS, duration) : duration;
    const easing = this.reducedMotion ? (t: number): number => t : ease;
    const from = { ...this.cam };
    return new Promise((resolve) => {
      const started = nowMs();
      const step = (): void => {
        const t = clamp((nowMs() - started) / targetDuration, 0, 1);
        const k = easing(t);
        this.cam = {
          x: from.x + (target.x - from.x) * k,
          y: from.y + (target.y - from.y) * k,
          z: from.z + (target.z - from.z) * k,
        };
        this.applyCam();
        if (t >= 1) {
          this.camAnim = null;
          this.zoomTarget = this.cam.z;
          resolve();
          return;
        }
        if (this.camAnim) this.camAnim.raf = requestAnimationFrame(step);
      };
      const raf = requestAnimationFrame(step);
      this.camAnim = { raf, from, to: target, started, duration: targetDuration, resolve };
    });
  }

  private minZoom(): number {
    return Math.max(CAM_MIN_Z, Math.min(this.fitZ * 0.92, CAM_MAX_Z));
  }

  private flyToZone(zone: MgZoneSpec): void {
    this.leaveTheater();
    this.crumbEl.textContent = `${zone.no} / ${zone.cn}`;
    void this.flyTo({ x: zone.x, y: zone.y - 40, z: Math.max(this.fitZ * 2.2, 0.8) });
  }

  private flyToOverview(): void {
    this.crumbEl.textContent = '平面世界 · 拖动探索';
    void this.flyTo({ x: MG_WORLD_W / 2, y: MG_WORLD_H / 2, z: this.fitZ });
  }

  private onResize(): void {
    if (this.disposed) return;
    const previousFit = this.fitZ;
    this.fitZ = this.computeFit();
    const wasOverview = Math.abs(this.cam.z - previousFit) < 0.001;
    if (wasOverview) {
      this.cam = { x: MG_WORLD_W / 2, y: MG_WORLD_H / 2, z: this.fitZ };
    } else {
      this.cam.z = clamp(this.cam.z, this.minZoom(), CAM_MAX_Z);
    }
    this.zoomTarget = this.cam.z;
    this.applyCam();
  }

  /* ------------------------------------------------------------------ */
  /* 指针                                                                */
  /* ------------------------------------------------------------------ */

  private bindPointer(): void {
    this.root.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.root.addEventListener('pointermove', (event) => this.onPointerMove(event));
    this.root.addEventListener('pointerup', (event) => this.onPointerUp(event));
    this.root.addEventListener('pointercancel', (event) => this.onPointerUp(event));
    this.root.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
    this.root.addEventListener('click', (event) => {
      if (event.target === this.root || event.target === this.viewportEl || event.target === this.worldEl) {
        this.onBlankClick();
      }
    });
  }

  private isUiTarget(target: EventTarget | null): boolean {
    const el = target instanceof Element ? target : null;
    if (!el) return false;
    return Boolean(el.closest('.mg-expand, .mg-ring, .mg-selbar, .mg-debug, .mg-hud, .mg-mini, .mg-radial, .mg-theater'));
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== undefined && event.button !== 0) return;
    this.stopAuto();
    this.root.focus({ preventScroll: true });
    this.autoTheater = false;
    if (this.scene === 'theater') {
      this.leaveTheater();
      // 剧场态第一下：既揭幕，也继续完成这次按下（可立即拖动），不再直接 return
      this.theaterPress = true;
    } else {
      this.theaterPress = false;
    }
    // 剧场层已经隐藏，本次按下不再按 UI 目标拦截，否则第一下拖动会被吞掉
    if (!this.theaterPress && this.isUiTarget(event.target)) return;
    if (this.expanded) this.closeExpand(false);
    if (this.ring) this.closeRing();
    this.clearRadial();
    if (this.sel.size > 0) {
      // 多选态下点空白不退出，方便框选；点封面由封面自己处理
    }
    const coverEl = event.target instanceof Element ? event.target.closest('.mg-cover') : null;
    this.drag.active = true;
    this.drag.id = event.pointerId;
    this.drag.startX = event.clientX;
    this.drag.startY = event.clientY;
    this.drag.camX = this.cam.x;
    this.drag.camY = this.cam.y;
    this.drag.lastX = this.cam.x;
    this.drag.lastY = this.cam.y;
    this.drag.lastT = nowMs();
    this.drag.moved = false;
    this.drag.pointerType = event.pointerType;
    // 不在 pointerdown 立即 setPointerCapture：一旦捕获，浏览器会把 pointerup 重定向到
    // root，导致封面/NOW 封面的原生 click 永远不触发（「哪都点不了」的根因）。
    // 真正开始拖动（超过阈值）时才捕获，保证单击仍能命中按钮。
    this.cancelCamAnim();
    this.stopZoomAnim();
    if (coverEl instanceof HTMLElement) {
      const binding = this.covers.find((item) => item.el === coverEl);
      if (binding) {
        this.pressCover = binding;
        this.pressStart = { x: event.clientX, y: event.clientY };
        this.clearPress();
        this.pressTimer = window.setTimeout(() => {
          this.pressTimer = 0;
          if (!this.drag.moved && this.pressCover) this.openRadial(this.pressCover, this.pressStart ?? { x: event.clientX, y: event.clientY });
        }, LONG_PRESS_MS);
        this.timers.push(this.pressTimer);
      }
    }
  }

  private onPointerMove(event: PointerEvent): void {
    if (!this.drag.active || event.pointerId !== this.drag.id) {
      this.trackHover(event);
      return;
    }
    const dx = event.clientX - this.drag.startX;
    const dy = event.clientY - this.drag.startY;
    if (!this.drag.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      this.drag.moved = true;
      // 超过拖动阈值才捕获指针：拖动划出画布仍可跟手；单击事件保持原生派发。
      this.root.setPointerCapture?.(event.pointerId);
      this.clearPress();
      this.hideHover();
      this.root.classList.add('is-dragging');
      this.buildMotionGhosts();
    }
    if (!this.drag.moved) return;
    const t = nowMs();
    const z = this.cam.z;
    const next = this.clampCam({ x: this.drag.camX - dx / z, y: this.drag.camY - dy / z, z });
    const dt = Math.max(4, t - this.drag.lastT);
    const vx = (next.x - this.cam.x) / dt;
    const vy = (next.y - this.cam.y) / dt;
    this.drag.lastT = t;
    this.drag.lastX = vx;
    this.drag.lastY = vy;
    this.cam = next;
    this.applyCam();
    this.updateMotionGhosts(vx * z, vy * z);
  }

  private onPointerUp(event: PointerEvent): void {
    if (!this.drag.active || event.pointerId !== this.drag.id) return;
    this.drag.active = false;
    this.theaterPress = false;
    this.clearPress();
    this.root.classList.remove('is-dragging');
    this.clearMotionGhosts();
    if (this.root.hasPointerCapture?.(event.pointerId)) this.root.releasePointerCapture(event.pointerId);
    if (!this.drag.moved) {
      this.drag.moved = false;
      return;
    }
    // 惯性以「屏幕像素/ms」计，与缩放无关：阈值 20px/s，上限 2200px/s。
    const vxScreen = this.drag.lastX * this.cam.z;
    const vyScreen = this.drag.lastY * this.cam.z;
    const speed = Math.hypot(vxScreen, vyScreen);
    if (this.inertiaOn && !this.reducedMotion && speed > INERTIA_START) {
      const scale = speed > INERTIA_MAX ? INERTIA_MAX / speed : 1;
      this.startInertia(vxScreen * scale, vyScreen * scale);
    }
    // 拖动后短暂抑制 click
    this.drag.moved = false;
  }

  /** 边界软限制：允许最多 bounce 像素越界，用于惯性撞墙的 6px 微弹。 */
  private clampCamSoft(cam: MgCam, bounce: number): { cam: MgCam; hitX: boolean; hitY: boolean } {
    const { w, h } = this.size();
    const viewW = w / cam.z;
    const viewH = h / cam.z;
    const minX = Math.max(-MG_SAFE, viewW / 2 - MG_SAFE * 0.5);
    const maxX = MG_WORLD_W - minX;
    const minY = Math.max(-MG_SAFE, viewH / 2 - MG_SAFE * 0.5);
    const maxY = MG_WORLD_H - minY;
    const x = clamp(cam.x, minX - bounce, maxX + bounce);
    const y = clamp(cam.y, minY - bounce, maxY + bounce);
    return { cam: { x, y, z: cam.z }, hitX: x !== cam.x, hitY: y !== cam.y };
  }

  private startInertia(vxScreen: number, vyScreen: number): void {
    let last = nowMs();
    const step = (): void => {
      this.inertiaRaf = 0;
      if (this.disposed || !this.isActive()) return;
      const t = nowMs();
      const dt = clamp(t - last, 1, 48);
      last = t;
      const z = this.cam.z;
      const soft = this.clampCamSoft(
        { x: this.cam.x + (vxScreen * dt) / z, y: this.cam.y + (vyScreen * dt) / z, z },
        INERTIA_BOUNCE,
      );
      this.cam = soft.cam;
      this.applyCam();
      // 撞边界：该轴速度归零（保留软越界，由停靠时吸附回边界）
      if (soft.hitX) vxScreen = 0;
      if (soft.hitY) vyScreen = 0;
      const damp = Math.pow(0.92, dt / 16.67);
      vxScreen *= damp;
      vyScreen *= damp;
      if (Math.hypot(vxScreen, vyScreen) < INERTIA_STOP) {
        // 480ms 停靠：吸附回合法范围
        this.cam = this.clampCam(this.cam);
        this.applyCam();
        return;
      }
      this.inertiaRaf = requestAnimationFrame(step);
    };
    if (this.inertiaRaf) cancelAnimationFrame(this.inertiaRaf);
    this.inertiaRaf = requestAnimationFrame(step);
  }

  private onWheel(event: WheelEvent): void {
    if (this.scene === 'theater') this.leaveTheater();
    if (this.isUiTarget(event.target)) return;
    event.preventDefault();
    if (this.drag.active) return;
    this.stopAuto();
    // 只打断飞行类动画，保留缩放累加状态（连续滚轮可以平滑衔接）
    this.cancelCamAnim();
    const rect = this.root.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const { w, h } = this.size();
    // 以当前目标为基准累加；向下滚 deltaY>0 → 缩小，向上滚 → 放大
    const baseZ = this.zoomTarget > 0 ? this.zoomTarget : this.cam.z;
    const nextZ = clamp(baseZ * Math.exp(-event.deltaY * ZOOM_WHEEL_K), this.zoomMin(), CAM_MAX_Z);
    this.zoomTarget = nextZ;
    this.zoomAnchor = {
      wx: this.cam.x + (px - w / 2) / this.cam.z,
      wy: this.cam.y + (py - h / 2) / this.cam.z,
      px,
      py,
    };
    if (this.reducedMotion) {
      const anchor = this.zoomAnchor;
      this.cam = this.clampCam({
        x: anchor.wx - (anchor.px - w / 2) / nextZ,
        y: anchor.wy - (anchor.py - h / 2) / nextZ,
        z: nextZ,
      });
      this.zoomTarget = this.cam.z;
      this.zoomAnchor = null;
      this.applyCam();
      return;
    }
    this.startZoomAnim();
  }

  private trackHover(event: PointerEvent): void {
    if (this.scene === 'theater' || this.drag.active) return;
    const target = event.target instanceof Element ? event.target.closest('.mg-cover') : null;
    if (!target) this.hideHover();
  }

  private onBlankClick(): void {
    if (this.openKind || this.plOpen) {
      this.closeZone();
      return;
    }
    if (this.expanded) {
      this.closeExpand(true);
      return;
    }
    if (this.ring) {
      this.closeRing();
      return;
    }
    this.clearRadial();
  }

  /* ------------------------------------------------------------------ */
  /* 悬停提示 / 长按径向 / 运动残影                                       */
  /* ------------------------------------------------------------------ */

  private showHover(binding: MgCoverBinding): void {
    if (this.drag.active || this.scene === 'theater') return;
    window.clearTimeout(this.hoverTimer);
    this.hoverTimer = window.setTimeout(() => {
      const rect = binding.el.getBoundingClientRect();
      const rootRect = this.root.getBoundingClientRect();
      this.hoverEl.innerHTML = '';
      this.hoverEl.append(
        h('b', { text: binding.track.title }),
        h('span', { text: `${binding.track.artist} · ${mgDuration(binding.track.durationMs)}` }),
      );
      this.hoverEl.style.left = `${clamp(rect.left - rootRect.left, 8, rootRect.width - 240)}px`;
      this.hoverEl.style.top = `${Math.min(rect.bottom - rootRect.top + 8, rootRect.height - 120)}px`;
      this.hoverEl.classList.add('is-on');
    }, 90);
    this.timers.push(this.hoverTimer);
  }

  private hideHover(): void {
    window.clearTimeout(this.hoverTimer);
    this.hoverEl.classList.remove('is-on');
  }

  private clearPress(): void {
    if (this.pressTimer) window.clearTimeout(this.pressTimer);
    this.pressTimer = 0;
    this.pressCover = null;
  }

  private pressConsumed(): boolean {
    return false;
  }

  private clearRadial(): void {
    if (!this.radialEl) return;
    this.radialEl.remove();
    this.radialEl = null;
  }

  private openRadial(binding: MgCoverBinding, point: { x: number; y: number }): void {
    this.clearRadial();
    const rootRect = this.root.getBoundingClientRect();
    const x = clamp(point.x - rootRect.left, 70, rootRect.width - 70);
    const y = clamp(point.y - rootRect.top, 70, rootRect.height - 70);
    const radial = h('div', { class: 'mg-radial', role: 'menu', 'aria-label': '封面操作' });
    const actions: Array<{ label: string; iconName: string; run: () => void }> = [
      { label: '播放', iconName: 'play', run: () => this.callbacks.play(binding.tracks, binding.index, binding.scope) },
      { label: '详情', iconName: 'info', run: () => this.openCover(binding) },
      { label: '收藏', iconName: 'heart', run: () => void this.likeTracks([binding.track]) },
      { label: '选择', iconName: 'maximize', run: () => this.enterSelection(binding) },
      { label: '关闭', iconName: 'close', run: () => this.clearRadial() },
    ];
    actions.forEach((action, index) => {
      const angle = (-150 + index * 30) * (Math.PI / 180);
      const btn = h('button', { class: 'mg-radial-btn', type: 'button', 'aria-label': action.label });
      btn.style.left = `${x + Math.cos(angle) * 74}px`;
      btn.style.top = `${y + Math.sin(angle) * 74}px`;
      btn.append(icon(action.iconName, 15), h('span', { text: action.label }));
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        this.clearRadial();
        action.run();
      });
      radial.append(btn);
    });
    radial.style.left = `${x}px`;
    radial.style.top = `${y}px`;
    this.root.append(radial);
    this.radialEl = radial;
  }

  private buildMotionGhosts(): void {
    if (!this.motionOn) return;
    this.clearMotionGhosts();
    const visible = this.covers.slice(0, 6);
    visible.forEach((item, index) => {
      if (index > 2) return;
      const rect = item.el.getBoundingClientRect();
      const rootRect = this.root.getBoundingClientRect();
      for (let layer = 1; layer <= 2; layer += 1) {
        const ghost = h('i', { class: 'mg-ghost' });
        ghost.style.left = `${rect.left - rootRect.left + layer * 16}px`;
        ghost.style.top = `${rect.top - rootRect.top - layer * 6}px`;
        ghost.style.width = `${rect.width}px`;
        ghost.style.height = `${rect.height}px`;
        ghost.style.opacity = String(0.22 / layer);
        ghost.style.background = `center / cover no-repeat url("${item.el.querySelector('img')?.getAttribute('src') ?? ''}")`;
        this.ghostEl.append(ghost);
      }
    });
    this.root.classList.add('is-motion');
  }

  private updateMotionGhosts(vx: number, vy: number): void {
    const speed = Math.hypot(vx, vy);
    if (speed > MOTION_SPEED / 1.4) {
      this.root.classList.add('is-motion');
      const ghost = this.ghostEl;
      ghost.style.transform = `translate(${clamp(vx * 0.006, -18, 18)}px, ${clamp(vy * 0.006, -14, 14)}px)`;
    } else {
      this.root.classList.remove('is-motion');
    }
  }

  private clearMotionGhosts(): void {
    this.root.classList.remove('is-motion');
    this.ghostEl.innerHTML = '';
    this.ghostEl.style.transform = '';
  }

  /* ------------------------------------------------------------------ */
  /* 封面展开                                                            */
  /* ------------------------------------------------------------------ */

  private openCover(binding: MgCoverBinding): void {
    if (this.scene === 'theater') this.leaveTheater();
    this.stopAuto();
    this.callbacks.play(binding.tracks, binding.index, binding.scope);
    this.expanded = { track: binding.track, tracks: binding.tracks, index: binding.index, scope: binding.scope };
    this.showExpand();
    const sourceRect = binding.el.getBoundingClientRect();
    void this.flyTo({ x: binding.track ? MG_NOW.x : this.cam.x, y: this.cam.y, z: this.cam.z });
    this.animateExpandFrom(sourceRect);
    this.crumbEl.textContent = `${binding.track.title} · 展开`;
  }

  private showExpand(): void {
    const info = this.expanded;
    if (!info) return;
    const track = info.track;
    this.expandEl.innerHTML = '';
    const cover = h('div', { class: 'mg-exp-cover' });
    const img = coverImg(track, track.title);
    cover.append(img);
    const close = h('button', { class: 'mg-exp-close', type: 'button', title: '收回', 'aria-label': '收回' }, icon('close', 16));
    close.addEventListener('click', () => this.closeExpand(true));
    const playBtn = h('button', { class: 'mg-exp-btn is-primary', type: 'button' }, icon('play', 14), h('span', { text: 'PLAY' }));
    playBtn.addEventListener('click', () => this.callbacks.play(info.tracks, info.index, info.scope));
    const queueBtn = h('button', { class: 'mg-exp-btn', type: 'button' }, icon('plus', 14), h('span', { text: 'QUEUE' }));
    queueBtn.addEventListener('click', () => this.toast('已加入队列（演示）'));
    const liked = this.liked.has(mgTrackKey(track));
    const likeBtn = h('button', { class: 'mg-exp-btn', type: 'button' }, icon(liked ? 'heartFill' : 'heart', 14), h('span', { text: liked ? 'LIKED' : 'LIKE' }));
    likeBtn.addEventListener('click', () => void this.likeTracks([track]).then(() => this.showExpand()));
    const moreBtn = h('button', { class: 'mg-exp-btn', type: 'button' }, icon('more', 14), h('span', { text: 'MORE' }));
    moreBtn.addEventListener('click', () => {
      if (info.scope === 'playlist') this.toast('歌单曲目 · 暂无更多操作');
      else this.callbacks.openList(info.scope);
    });
    const meta = h('div', { class: 'mg-exp-info' },
      h('span', { class: 'mg-exp-kicker', text: 'EXPANDED · 原地展开 · 无页面跳转' }),
      h('b', { class: 'mg-exp-title', text: track.title }),
      h('span', { class: 'mg-exp-artist', text: track.artist }),
      h('span', { class: 'mg-exp-sub', text: `${track.album || '未知专辑'} · ${mgDuration(track.durationMs)} · ${track.source.toUpperCase()}` }),
      h('div', { class: 'mg-exp-tags' },
        h('i', { text: info.scope === 'playlist' ? 'PLAYLIST' : info.scope.toUpperCase() }),
        h('i', { text: track.source.toUpperCase() }),
        h('i', { text: `${String(info.index + 1).padStart(2, '0')} / ${String(info.tracks.length).padStart(2, '0')}` }),
      ),
      h('div', { class: 'mg-exp-actions' }, playBtn, queueBtn, likeBtn, moreBtn),
      h('span', { class: 'mg-exp-hint', text: 'Esc 收回 · 点空白处收回' }),
    );
    this.expandEl.append(cover, meta, close);
    this.expandEl.hidden = false;
    this.expandEl.classList.add('is-on');
    this.applyGrade(track);
  }

  private animateExpandFrom(from: DOMRect | null): void {
    const target = this.expandEl.querySelector('.mg-exp-cover');
    if (!(target instanceof HTMLElement)) return;
    target.classList.remove('is-in');
    void target.offsetWidth;
    target.classList.add('is-in');
    if (from && from.width > 0) target.dataset.from = `${Math.round(from.left)},${Math.round(from.top)}`;
  }

  private closeExpand(restoreCamera: boolean): void {
    if (!this.expanded) return;
    this.expanded = null;
    this.expandEl.classList.remove('is-on');
    this.expandEl.querySelector('.mg-exp-cover')?.classList.remove('is-in');
    window.setTimeout(() => {
      if (!this.expanded) this.expandEl.hidden = true;
    }, 220);
    if (restoreCamera) void this.flyTo({ z: Math.max(this.fitZ * 1.8, 0.62) });
    this.crumbEl.textContent = '平面世界 · 拖动探索';
  }

  /* ------------------------------------------------------------------ */
  /* 歌单环                                                              */
  /* ------------------------------------------------------------------ */

  private async openRing(item: LibraryPlaylist): Promise<void> {
    this.stopAuto();
    this.toast(`载入《${item.title}》…`);
    let tracks: OnlineTrack[] = [];
    try {
      const detail = await fetchPlaylist(item.source, item.id, 0, 80);
      tracks = detail.tracks.slice(0, 12);
    } catch {
      tracks = [];
    }
    if (this.disposed) return;
    if (!tracks.length) {
      this.toast('歌单载入失败，打开列表页');
      this.callbacks.openPlaylist(item);
      return;
    }
    this.ring = { item, tracks };
    this.showRing();
  }

  private showRing(): void {
    const info = this.ring;
    if (!info) return;
    this.ringEl.innerHTML = '';
    const box = this.size();
    const rx = Math.min(430, box.w * 0.34);
    const ry = Math.min(290, box.h * 0.34);
    const cx = box.w / 2;
    const cy = box.h / 2;
    const cards: HTMLElement[] = [];
    info.tracks.forEach((track, index) => {
      const angle = (-90 + (index * 360) / info.tracks.length) * (Math.PI / 180);
      const focus = index === 0;
      const size = focus ? 240 : 140 / Math.max(0.82, Math.min(1.1, box.w / 1600 + 0.45));
      const card = h('button', {
        class: `mg-ring-card${focus ? ' is-focus' : ''}`,
        type: 'button',
        'aria-label': `播放 ${track.title}`,
        style: `left:${cx + Math.cos(angle) * rx - size / 2}px;top:${cy + Math.sin(angle) * ry - size / 2}px;width:${size}px;height:${size}px`,
      });
      card.append(coverImg(track, track.title));
      card.addEventListener('click', (event) => {
        event.stopPropagation();
        this.callbacks.play(info.tracks, index, 'playlist');
        this.toast(`播放 · ${track.title}`);
      });
      cards.push(card);
      this.ringEl.append(card);
    });
    const center = h('div', { class: 'mg-ring-center' });
    center.append(
      h('b', { class: 'mg-ring-title', text: info.item.title }),
      h('span', { class: 'mg-ring-meta', text: `${info.item.count} 首${info.item.creator ? ` · ${info.item.creator}` : ''}` }),
      h('button', { class: 'mg-ring-play', type: 'button' }, icon('play', 13), h('span', { text: '播放全部' })),
    );
    center.querySelector('.mg-ring-play')?.addEventListener('click', (event) => {
      event.stopPropagation();
      this.callbacks.play(info.tracks, 0, 'playlist');
    });
    const close = h('button', { class: 'mg-ring-close', type: 'button', title: '收回', 'aria-label': '收回' }, icon('close', 16));
    close.addEventListener('click', () => this.closeRing());
    this.ringEl.append(center, close);
    this.ringEl.hidden = false;
    this.ringEl.classList.add('is-on');
    this.crumbEl.textContent = `歌单 · ${info.item.title}`;
    cards.forEach((card, index) => {
      card.style.opacity = '0';
      card.style.transform = 'translateY(14px) scale(.94)';
      window.setTimeout(() => {
        card.style.transition = 'opacity 260ms ease, transform 320ms cubic-bezier(.22,.8,.28,1)';
        card.style.opacity = '1';
        card.style.transform = 'translateY(0) scale(1)';
      }, 48 * index);
    });
  }

  private closeRing(): void {
    if (!this.ring) return;
    this.ring = null;
    this.ringEl.classList.remove('is-on');
    window.setTimeout(() => {
      if (!this.ring) this.ringEl.hidden = true;
    }, 200);
    this.crumbEl.textContent = '平面世界 · 拖动探索';
  }

  /* ------------------------------------------------------------------ */
  /* 选择态                                                              */
  /* ------------------------------------------------------------------ */

  private enterSelection(binding: MgCoverBinding): void {
    this.sel.clear();
    this.selTracks.clear();
    this.selScope = binding.scope;
    this.sel.add(mgTrackKey(binding.track));
    this.selTracks.set(mgTrackKey(binding.track), binding.track);
    this.root.classList.add('is-select');
    this.selEl.hidden = false;
    this.selEl.classList.add('is-on');
    this.renderSelection();
  }

  private exitSelection(): void {
    if (!this.sel.size && !this.root.classList.contains('is-select')) return;
    this.sel.clear();
    this.selTracks.clear();
    this.root.classList.remove('is-select');
    this.selEl.classList.remove('is-on');
    window.setTimeout(() => {
      if (!this.sel.size) this.selEl.hidden = true;
    }, 200);
    this.renderSelection();
  }

  private toggleSelection(binding: MgCoverBinding): void {
    const key = mgTrackKey(binding.track);
    if (this.sel.has(key)) {
      this.sel.delete(key);
      this.selTracks.delete(key);
    } else {
      this.sel.add(key);
      this.selTracks.set(key, binding.track);
      this.selScope = binding.scope;
    }
    this.renderSelection();
  }

  private renderSelection(): void {
    const count = this.sel.size;
    const label = this.selEl.querySelector('.mg-sel-count');
    if (label) label.textContent = `已选 ${count} 首`;
    for (const binding of this.covers) {
      const selected = this.sel.has(mgTrackKey(binding.track));
      binding.el.classList.toggle('is-sel', selected);
      binding.el.style.setProperty('--mg-sel-lift', selected ? '-8px' : '0px');
    }
    if (!count) this.exitSelection();
  }

  /** 收藏 / 取消收藏（在线源；本地跳过）。 */
  private async likeTracks(tracks: OnlineTrack[]): Promise<void> {
    const online = tracks.filter((track) => !mgIsLocal(track));
    if (!online.length) {
      this.toast('本地曲目无需在线收藏');
      return;
    }
    for (const track of online) {
      const key = mgTrackKey(track);
      const has = this.liked.has(key);
      try {
        if (has) {
          await removeLikedTrack(track.source, track.id);
          this.liked.delete(key);
        } else {
          await addLikedTrack(track.source, track.id);
          this.liked.add(key);
        }
      } catch {
        this.toast('收藏操作失败，请稍后再试');
        return;
      }
    }
    this.toast(`已收藏 ${online.length} 首`);
  }

  /* ------------------------------------------------------------------ */
  /* 调试面板                                                            */
  /* ------------------------------------------------------------------ */

  private buildDebug(): void {
    const fold = h('button', { class: 'mg-debug-fold', type: 'button', title: '收起/展开调试面板', 'aria-label': '收起调试面板' }, icon('minimize', 14));
    const head = h('div', { class: 'mg-debug-head' }, h('span', { text: '调试 · TUNE' }), fold);
    const body = h('div', { class: 'mg-debug-body' });
    fold.addEventListener('click', () => {
      this.debugFolded = !this.debugFolded;
      this.debugEl.classList.toggle('is-folded', this.debugFolded);
    });
    const toggleBtn = (label: string, initial: boolean, apply: (on: boolean) => void): HTMLButtonElement => {
      const btn = h('button', { class: 'mg-debug-toggle', type: 'button', 'aria-pressed': String(initial) }, h('i'), h('span', { text: label }));
      btn.classList.toggle('is-on', initial);
      btn.addEventListener('click', () => {
        const next = !btn.classList.contains('is-on');
        btn.classList.toggle('is-on', next);
        btn.setAttribute('aria-pressed', String(next));
        apply(next);
      });
      return btn;
    };
    const inertia = toggleBtn('拖动惯性', true, (on) => { this.inertiaOn = on; });
    const parallax = toggleBtn('视差', true, (on) => { this.parallaxOn = on; this.applyCam(); });
    const motion = toggleBtn('运动残影', true, (on) => { this.motionOn = on; if (!on) this.clearMotionGhosts(); });
    const gradeRow = h('div', { class: 'mg-debug-row' }, h('span', { text: 'grade' }));
    const gradeBtns: HTMLButtonElement[] = [];
    (['follow', 'a', 'b'] as const).forEach((mode) => {
      const btn = h('button', { class: 'mg-debug-grade', type: 'button' }, h('span', { text: mode === 'follow' ? '跟随封面' : mode.toUpperCase() }));
      btn.classList.toggle('is-on', this.gradeMode === mode);
      btn.addEventListener('click', () => {
        this.gradeMode = mode;
        gradeBtns.forEach((item) => item.classList.toggle('is-on', item === btn));
        this.applyGrade(playerState().track);
      });
      gradeBtns.push(btn);
      gradeRow.append(btn);
    });
    const reset = h('button', { class: 'mg-debug-wide', type: 'button' }, h('span', { text: '重置视角' }));
    reset.addEventListener('click', () => this.flyToOverview());
    const auto = h('button', { class: 'mg-debug-wide', type: 'button' }, h('span', { text: '自动演示' }));
    auto.addEventListener('click', () => this.runAuto());
    body.append(
      h('div', { class: 'mg-debug-row' }, inertia, parallax, motion),
      gradeRow,
      h('div', { class: 'mg-debug-row' }, reset, auto),
      h('span', { class: 'mg-debug-note', text: '滚轮缩放 · 拖动画面 · 单击封面展开 · 长按径向 · Tab 分区 · / 搜索' }),
    );
    this.debugEl.append(head, body);
  }

  private toggleDebug(): void {
    this.debugOpen = !this.debugOpen;
    this.debugEl.classList.toggle('is-on', this.debugOpen);
  }

  /* ------------------------------------------------------------------ */
  /* grade                                                               */
  /* ------------------------------------------------------------------ */

  private applyGrade(track: OnlineTrack | null): void {
    this.lastGradeTrack = track;
    const token = ++this.gradeToken;
    const fallback = fallbackColors(track ? `${track.source}:${track.id}:${track.title}` : 'mg-plane');
    const tint = (hex: string, alpha: number): string => {
      const clean = hex.replace('#', '');
      const full = clean.length === 3 ? clean.split('').map((ch) => ch + ch).join('') : clean;
      const value = Number.parseInt(full.slice(0, 6), 16);
      if (!Number.isFinite(value)) return `rgba(140, 120, 96, ${alpha})`;
      const r = (value >> 16) & 255;
      const g = (value >> 8) & 255;
      const b = value & 255;
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };
    const paint = (colors: { dominant: string; palette: string[] }): void => {
      if (token !== this.gradeToken || this.disposed) return;
      const palette = colors.palette.length ? colors.palette : [colors.dominant];
      this.gradeEl.style.setProperty('--mg-g1', tint(colors.dominant, 0.34));
      this.gradeEl.style.setProperty('--mg-g2', tint(palette[0] ?? colors.dominant, 0.26));
      this.gradeEl.style.setProperty('--mg-g3', tint(palette[1] ?? palette[0] ?? colors.dominant, 0.24));
      this.gradeEl.classList.add('is-on');
    };
    if (this.gradeMode === 'a') {
      paint({ dominant: '#b9603a', palette: ['#7d5a37', '#2d7a9a'] });
      return;
    }
    if (this.gradeMode === 'b') {
      paint({ dominant: '#2f8f8a', palette: ['#3d6f86', '#d96a8c'] });
      return;
    }
    paint(fallback);
    if (!track) return;
    void coverColorsOf(track).then((colors) => {
      if (colors) paint(colors);
    });
  }

  /* ------------------------------------------------------------------ */
  /* 播放状态                                                            */
  /* ------------------------------------------------------------------ */

  private onPlayerState(state: PlayerState): void {
    const track = state.track;
    const key = track ? `${mgTrackKey(track)}:${state.index}:${state.queue.length}` : '';
    if (key !== this.lastPlayerKey) {
      const hadTrack = this.lastPlayerKey !== '';
      this.lastPlayerKey = key;
      if (hadTrack) this.transitionNow();
      else this.buildNow(!this.reducedMotion);
      if (this.scene === 'theater') this.buildTheaterContent();
      this.applyGrade(track);
      if (this.expanded && track && mgTrackKey(this.expanded.track) === mgTrackKey(track)) {
        // 展开面板保持当前曲目信息
      }
    }
    // 启动自动进场：应用刚打开时播放器曲目可能尚未恢复，第一首曲目到达时补上「开场剧场」。
    // 用户一旦交互过（autoTheater=false）就不再自动进场，之后的播放不会抢镜头。
    if (track && this.autoTheater && this.scene === 'world' && !this.expanded) {
      this.enterTheater();
    }
    if (this.scene === 'theater' && track) {
      this.syncTheaterProgress();
    }
    this.applyNowLyric();
    this.root.classList.toggle('is-playing', state.playing);
  }

  /* ------------------------------------------------------------------ */
  /* 键盘                                                                */
  /* ------------------------------------------------------------------ */

  private isActive(): boolean {
    if (this.disposed || !this.root.isConnected) return false;
    if (this.root.closest('.is-hidden')) return false;
    const rect = this.root.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  private bindKeyboard(): void {
    window.addEventListener('keydown', this.onKeyDownBound);
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (!this.isActive()) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    const key = event.key;
    if (key === 'Escape') {
      if (this.radialEl) {
        this.clearRadial();
      } else if (this.expanded) {
        this.closeExpand(true);
      } else if (this.ring) {
        this.closeRing();
      } else if (this.openKind || this.plOpen) {
        this.closeZone();
      } else if (this.sel.size) {
        this.exitSelection();
      } else if (this.picked || this.pickedNow) {
        this.clearPick();
      } else if (this.scene === 'theater') {
        this.leaveTheater();
      } else {
        this.flyToOverview();
      }
      event.preventDefault();
      return;
    }
    if (key === 'Home' || key === '0') {
      this.flyToOverview();
      event.preventDefault();
      return;
    }
    const ownsFocus = document.activeElement === this.root || this.root.contains(document.activeElement);
    if (key === 'Tab') {
      if (!ownsFocus) return;
      const index = this.zoneIndex + 1;
      this.zoneIndex = index % (MG_ZONES.length + 1);
      if (this.zoneIndex === MG_ZONES.length) this.flyToOverview();
      else this.flyToZone(MG_ZONES[this.zoneIndex]!);
      event.preventDefault();
      return;
    }
    if (key === 'Enter') {
      if (this.picked) {
        this.playCover(this.picked);
        event.preventDefault();
        return;
      }
      if (this.pickedNow) {
        this.playNow();
        event.preventDefault();
        return;
      }
    }
    if (key === ' ' || key === 'Spacebar') {
      toggle();
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (key === '/') {
      this.callbacks.search();
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (key === 'f' || key === 'F') {
      this.toggleDebug();
      event.preventDefault();
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') {
      // 320 屏幕像素 / 320ms ease-out；可被下一次按键或指针打断（flyTo 内部会取消上一段）
      const dxScreen = key === 'ArrowLeft' ? -PAN_STEP : key === 'ArrowRight' ? PAN_STEP : 0;
      const dyScreen = key === 'ArrowUp' ? -PAN_STEP : key === 'ArrowDown' ? PAN_STEP : 0;
      void this.flyTo(
        {
          x: this.cam.x + dxScreen / this.cam.z,
          y: this.cam.y + dyScreen / this.cam.z,
          z: this.cam.z,
        },
        PAN_MS,
        easeOutCubic,
      );
      event.preventDefault();
      return;
    }
  }

  private zoneIndex = -1;

  /* ------------------------------------------------------------------ */
  /* 自动演示                                                            */
  /* ------------------------------------------------------------------ */

  private stopAuto(): void {
    for (const id of this.autoSteps.splice(0)) window.clearTimeout(id);
    if (this.autoTimer) window.clearTimeout(this.autoTimer);
    this.autoTimer = 0;
  }

  private runAuto(): void {
    this.stopAuto();
    this.toast('自动演示开始 · 任意操作可中断');
    const steps: Array<() => void> = [
      () => this.flyToZone(MG_ZONES[0]!),
      () => {
        const binding = this.covers.find((item) => item.scope === 'daily');
        if (binding) this.openCover(binding);
      },
      () => this.closeExpand(true),
      () => this.flyToZone(MG_ZONES[3]!),
      () => {
        const item = this.data.playlists[0];
        if (item) void this.openRing(item);
      },
      () => this.closeRing(),
      () => this.flyToOverview(),
    ];
    let delay = 0;
    steps.forEach((step, index) => {
      delay += 900;
      const id = window.setTimeout(() => {
        if (this.disposed) return;
        step();
        if (index === steps.length - 1) this.toast('自动演示结束');
      }, delay);
      this.autoSteps.push(id);
      this.timers.push(id);
    });
  }

  /* ------------------------------------------------------------------ */
  /* 提示条                                                              */
  /* ------------------------------------------------------------------ */

  private toast(message: string): void {
    window.clearTimeout(this.toastTimer);
    this.toastEl.textContent = message;
    this.toastEl.classList.add('is-on');
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.classList.remove('is-on');
    }, 1600);
    this.timers.push(this.toastTimer);
  }
}
