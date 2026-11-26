/**
 * 软件内壁纸层（规格书 §5.1 / §5.6 / §5.8 / §5.9）。
 *
 * 画面由页面自己播，不交给 WPF：同一段 1080p60 视频，WPF 每帧 WritePixels 上传位图要
 * 吃掉近一个核（实测 30fps 就 97% CPU），交给 Chromium 的 <video> 只有 4%。所以宿主
 * 只推「指令」（哪张素材、什么滤镜、什么转场），像素全部在这里产生。
 *
 * 层级：html > body > #wallpaper-root（position:fixed; inset:0; z-index:0）
 * 页面内容（.app）在它上面，`html.is-wallpaper-layer` 时让出背景色。
 */

import type { WallpaperLayerState } from '../core/bridge';
import { host, onWallpaperLayer } from '../core/bridge';
import { onlineEndpoint } from '../online/client';
import { onBeat, startBeatClock } from '../core/beatClock';
import { getSettings } from '../core/settings';
import { pageImmersiveEnabled, pageWallpaperAllowed } from '../wallpaper/client';

const ROOT_ID = 'wallpaper-root';

/** 转场键 → 新层入场用的 CSS 关键帧参数（与 WPF 侧的 WallpaperTransitionId 对齐）。 */
interface TransitionSpec {
  opacity?: [number, number];
  transform?: [string, string];
  filter?: [string, string];
  flash?: 'black' | 'white';
}

const TRANSITION_SPECS: Record<string, TransitionSpec> = {
  fade: { opacity: [0, 1] },
  'fade-black': { opacity: [0, 1], flash: 'black' },
  'fade-white': { opacity: [0, 1], flash: 'white' },
  'slide-left': { transform: ['translateX(6%)', 'translateX(0)'] },
  'slide-right': { transform: ['translateX(-6%)', 'translateX(0)'] },
  'slide-up': { transform: ['translateY(6%)', 'translateY(0)'] },
  'zoom-in': { transform: ['scale(1.08)', 'scale(1)'] },
  'blur-dissolve': { filter: ['blur(14px)', 'blur(0px)'] },
  'radial-blur': { filter: ['blur(10px) saturate(120%)', 'blur(0px) saturate(100%)'] },
  exposure: { opacity: [0, 1], flash: 'white' },
  glitch: { transform: ['translate3d(1.2%,-0.6%,0)', 'translate3d(0,0,0)'], flash: 'white' },
  'film-grain': { opacity: [0, 1] },
  'dissolve-noise': { opacity: [0, 1] },
  ripple: { transform: ['scale(1.04)', 'scale(1)'], filter: ['blur(3px)', 'blur(0px)'] },
};

export class WallpaperLayer {
  private readonly root: HTMLDivElement;
  private readonly dim: HTMLDivElement;
  private readonly flash: HTMLDivElement;
  /** 沉浸态的压暗层：挂在壁纸层内部，跟壁纸一起淡入淡出。 */
  private readonly scrim: HTMLDivElement;
  private current: HTMLVideoElement | HTMLImageElement | null = null;
  /** 转场承载层（画面变换在里面的 media 上，两者不抢 transform）。 */
  private currentFrame: HTMLDivElement | null = null;
  private readonly overlay: HTMLDivElement;
  private overlayTimer: number | null = null;
  private overlayTemplate = '{time}';
  private currentKey = '';
  private lastLayer: WallpaperLayerState | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly onOptions = (): void => {
    syncImmersiveClass();
    if (this.lastLayer) this.setHidden(!layerVisible(this.lastLayer));
  };
  private beatPulse = 0;
  private beatTimer = 0;
  /** 「这一页暂时不显示壁纸」时保留媒体的宽限期，超时才真正销毁（见 park）。 */
  private parkTimer = 0;
  /** park 之后延迟暂停解码的定时器（两秒内切回来就不用重启解码器）。 */
  private parkPauseTimer = 0;
  private hideTimer = 0;
  /** 淡入前等第一帧的兜底定时器（见 setHidden）。 */
  private revealTimer = 0;
  /** 续播巡检：桌面层那块页面被系统判成不可见时 video 会被暂停，定时补一次 play()。 */
  private resumeTimer = 0;
  /** 上一次真正应用过的显隐状态：轮询只在变化时才动 DOM，否则每 250ms 一次强制布局会把主线程喂满。 */
  private hiddenState = false;
  /** 宿主把窗口收进托盘（离屏停放）时暂停解码，避免后台白烧一个核；回来再续播。 */
  private hostParked = false;
  /** 停放期间被我们暂停的页面动画：只恢复自己停过的那批。 */
  private readonly parkedAnimations = new Set<Animation>();

  constructor() {
    this.root = document.createElement('div');
    this.root.id = ROOT_ID;

    this.dim = document.createElement('div');
    this.dim.className = 'wp-layer-dim';

    this.flash = document.createElement('div');
    this.flash.className = 'wp-layer-flash';

    // 音频可视化（§5.9）：canvas 叠在压暗层之上、闪层之下，不参与转场。

    startBeatClock();
    onBeat((event) => {
      // 「界面辉光」关掉时不再做节拍脉冲：整层与界面跟着鼓点缩放，在亮色壁纸上
      // 就是一片来回明暗的光晕，看着像「固定闪烁的辉光」。
      if (!getSettings().appearance.glow) return;
      const amount = (this.lastLayer?.beatStrength ?? 50) / 100;
      if (amount <= 0) return;
      // 开方放大弱拍，否则 strength 0.1 的拍子在 1% 幅度下根本看不出来。
      this.beatPulse = Math.min(1, Math.sqrt(Math.max(0, event.strength))) * amount;
      window.clearTimeout(this.beatTimer);
      this.beatTimer = window.setTimeout(() => {
        this.beatPulse = 0;
        this.applyBeatPulse();
      }, 150);
      this.applyBeatPulse();
    });

    this.overlay = document.createElement('div');
    this.overlay.className = 'wp-overlay is-empty';

    // 沉浸态的压暗层挂在壁纸层内部，跟着壁纸一起淡入淡出。
    // 原来压暗写在 .lyrics-scrim 上，切回「纯壁纸」时那层 gradient 是瞬间换掉的，
    // 壁纸还在、压暗先跳一下 —— 那一下就是切换瞬间的「闪」。
    this.scrim = document.createElement('div');
    this.scrim.className = 'wp-immersive-scrim';

    this.root.append(this.dim, this.scrim, this.overlay, this.flash);
    document.body.insertBefore(this.root, document.body.firstChild ?? null);
  }

  /** 背景歌词场景要把壁纸层搬进歌词视图，才能和 stage 处于同一个 stacking context。 */
  get element(): HTMLElement {
    return this.root;
  }

  /** 开始跟随宿主推送。重复调用无副作用。 */
  start(): void {    if (this.unsubscribe) return;
    this.unsubscribe = onWallpaperLayer((layer) => {
      // 宿主推送可能正好落在 App 挂载的中途：把建媒体挪到下一轮任务，避免在布局过程中
      // 插入 4K <video> 打断首次绘制（那会让首屏一直出不来）。
      window.setTimeout(() => this.apply(layer), 0);
    });
    window.addEventListener('zilux:wallpaper-options', this.onOptions);
    // 只补暂停的视频，不碰布局，4 秒一次足够。
    this.resumeTimer = window.setInterval(() => this.resumePlayback(), 4000);
    // 桌面层那块页面被 Windows 判成「不可见」时会停掉解码：回落桌面后要自己把
    // 视频续上，否则表现就是「壁纸有时候自己停住」。看门狗兜住所有漏掉的时机。
  }



  stop(): void {
    this.unsubscribe?.();
    window.clearInterval(this.resumeTimer);
    this.resumeTimer = 0;
    this.unsubscribe = null;
    window.removeEventListener('zilux:wallpaper-options', this.onOptions);
    this.clear();
  }

  /** 只在「该显示/该隐藏」真的变了才动 DOM。 */
  /** 每 4 秒一次：把被系统节流暂停的 video 续上，顺便看住「画面定住但元素没暂停」的情况。 */
  private resumePlayback(): void {
    const layer = this.lastLayer;
    // 托盘停放期间不要续播：4s 巡检会把刚暂停的解码器又拉起来，离屏白烧一个核。
    if (!layer || layer.paused || !layerVisible(layer) || this.hostParked) return;
    for (const video of Array.from(this.root.querySelectorAll('video'))) {
      const time = video.currentTime;
      const last = Number(video.dataset.lastTime ?? '-1');
      video.dataset.lastTime = String(time);
      const frozen = last >= 0 && Math.abs(time - last) < 0.02;

      if (video.paused) {
        if (video.readyState >= 2) void video.play().catch(() => {});
        video.dataset.frozen = '0';
        continue;
      }

      // 还在缓冲（readyState 不够）时不动它，那是正常等数据。
      if (!frozen || video.readyState < 2) {
        video.dataset.frozen = '0';
        continue;
      }

      const frozenTicks = Number(video.dataset.frozen ?? '0') + 1;
      video.dataset.frozen = String(frozenTicks);
      const counters = window as unknown as { __wpFrozen?: number; __wpNudges?: number };
      counters.__wpFrozen = (counters.__wpFrozen ?? 0) + 1;

      if (frozenTicks === 1) {
        void video.play().catch(() => {});
        continue;
      }

      // 连着两个巡检周期（≈8 秒）画面都没动、元素也没暂停：往前推一帧逼它重新出帧，
      // 位置基本不变，但能让卡住的呈现管线重新走一遍。
      try {
        video.currentTime = time + 0.05;
      } catch {
        // 元素还没准备好转动时间轴时忽略，下次巡检再来。
      }
      counters.__wpNudges = (counters.__wpNudges ?? 0) + 1;
      // 落到宿主日志里，方便下次「又定住了」时确认是不是同一条路径救回来的。
      console.warn(`[wallpaper] media stalled at ${time.toFixed(2)}s, nudged`);
      video.dataset.frozen = '0';
    }
  }

  private syncVisibility(): void {
    // 三种情况都该藏：
    // 1) 没有可见图层（关掉了 / 这一页不允许壁纸）；
    // 2) 全屏挂起 —— 前台有全屏应用，先淡出露出系统桌面壁纸；
    // 3) 当前媒体还没解出第一帧（见 setHidden 的等帧逻辑，这里只是兜底）。
    const layer = this.lastLayer;
    const want = !layer
      ? true
      : !layerVisible(layer) || layer.suspended === true;
    // 不能只信缓存：启动早期 refreshVisibility() 会先把 root 藏起来，
    // 之后第一次推可见层时若缓存仍写 false，就会「以为已经显示」而不撤 is-hidden，
    // 结果三块屏里只有碰巧没被藏起来的那块有画面。
    const actual = this.root.classList.contains('is-hidden');
    if (want === this.hiddenState && want === actual) return;
    this.setHidden(want);
  }

  /** 收到宿主推来的图层状态（公开：桌面歌词页要自己按样式决定何时吃）。 */
  apply(layer: WallpaperLayerState | null): void {
    if (!layer) {
      this.clear();
      return;
    }

    this.lastLayer = layer;
    // 总开关（或软件内画布开关）关了：连 <video> 一起收掉，别让它继续在后台解码 ——
    // 桌面层每块屏一路 4K，只藏不销毁的话关掉开关 CPU 也不会掉。这里的 paused=false
    // 才是「关了」；paused=true 只是用户暂停，位置要保住。
    if (!layerVisible(layer)) {
      if (layer.visible === false && !layer.paused) {
        this.clear();
        return;
      }
      // 只是「这一页暂时不该显示壁纸」（比如常规页切到「关闭/随歌曲封面」，或歌词页没开沉浸壁纸）：
      // 不要把 4K <video> 销毁掉。销毁后切回「动态壁纸」要重新拉流 + 等首帧，
      // 观感就是「按钮按了没反应 / 要等好几秒」，正是用户反馈的那个卡顿。
      this.park();
      return;
    }
    window.clearTimeout(this.parkTimer);
    this.parkTimer = 0;
    window.clearTimeout(this.parkPauseTimer);
    this.parkPauseTimer = 0;
    // TEMP-EMERGENCY（2026-11-18 04:5x）：软件内背景层建媒体会让主窗口卡成黑屏，先停用，
    // 保证主界面可用；桌面层各屏页面与歌词页走的是另外的页面，不受这一条影响。
    if (suspendInAppLayer()) {
      this.setHidden(true);
      return;
    }
    // 出入点变了要重建 <video>（起播点与回绕都绑在元素上）；镜像/旋转/裁剪/速度可以就地改。
    // mediaUrl 只比「路径」：宿主每次推的 baseUrl/token 可能不同（在线端点重启就换端口和令牌），
    // 把整串算进 key 会让同一张壁纸被反复 swap —— 每 swap 一次 <video> 就从 0 重新拉流，
    // 表现就是「放着放着画面定住」。路径变了（换素材）仍然重建。
    const mediaPath = String(layer.mediaUrl ?? '').replace(/^[a-z]+:\/\/[^/]+/i, '').split('?')[0];
    const key = `${layer.assetId}:${layer.kind}:${layer.trimInMs ?? 0}:${layer.trimOutMs ?? 0}:${mediaPath}`;
    const changed = key !== this.currentKey;

    if (changed) {
      this.swap(layer);
      this.currentKey = key;
    }

    this.applyFilters(layer);
    this.applyPicture(layer);
    // 帧率是就地生效的：不重建 <video>，只按需挂上/摘掉取帧用的 canvas。
    if (this.currentFrame) this.capFrameRate(this.currentFrame, layer);
    this.applyOverlay(layer);
    this.setPaused(layer.paused);
    (window as unknown as { __wpLayer?: { key: string; el: Element | null } }).__wpLayer = {
      key,
      el: this.current,
    };
    this.syncVisibility();
    syncImmersiveClass();
  }

  private swap(layer: WallpaperLayerState): void {
    // 两层：外层 frame 只做转场（opacity/transform/filter），内层 media 只做画面变换
    // （镜像/旋转/裁剪）。放同一元素上会互相覆盖 —— 转场写 transform 时镜像就没了。
    const frame = document.createElement('div');
    frame.className = 'wp-layer-frame';

    const screens = layer.screens;
    let media: HTMLVideoElement | HTMLImageElement;
    if (Array.isArray(screens) && screens.length > 1) {
      // 多屏（第 25 轮 C）：每块屏一个 media，各自铺满自己的矩形，
      // 接缝处是同一帧的不同裁切，不存在「一块屏有壁纸一块没有」。
      media = this.createImage(layer);
      for (const screen of screens) {
        const cell = document.createElement('div');
        cell.className = 'wp-screen';
        cell.style.left = `${screen.l * 100}%`;
        cell.style.top = `${screen.t * 100}%`;
        cell.style.width = `${screen.w * 100}%`;
        cell.style.height = `${screen.h * 100}%`;
        const one = layer.kind === 'image' || layer.kind === 'gif'
          ? this.createImage(layer)
          : this.createVideo(layer);
        applyPictureTransform(one, layer);
        cell.appendChild(one);
        frame.appendChild(cell);
        if (one instanceof HTMLVideoElement) {
          media = one;
        }
      }
    } else {
      media = layer.kind === 'image' || layer.kind === 'gif'
        ? this.createImage(layer)
        : this.createVideo(layer);
      frame.appendChild(media);
      applyPictureTransform(media, layer);
    }

    const previous = this.currentFrame;
    this.current = media;
    this.currentFrame = frame;
    this.root.insertBefore(frame, this.dim);

    // 帧率上限（每屏一份设置）：低于 60 时改成「隐藏的 <video> 解码 + canvas 按目标帧率取帧」，
    // 合成器每帧只看到一张 canvas 纹理，GPU 上屏次数被压到设定值。
    this.capFrameRate(frame, layer);

    const spec = TRANSITION_SPECS[layer.transition] ?? TRANSITION_SPECS.fade;
    const duration = Math.max(0, Math.min(5000, layer.transitionMs || 0));

    if (duration <= 0) {
      frame.style.opacity = '1';
    } else {
      const from = frame.style;
      from.opacity = String(spec.opacity?.[0] ?? 1);
      if (spec.transform) from.transform = spec.transform[0];
      if (spec.filter) from.filter = spec.filter[0];
      // 强制一次样式计算，保证起始帧生效后再过渡。
      void frame.offsetWidth;
      frame.style.transition = `opacity ${duration}ms ease, transform ${duration}ms ease, filter ${duration}ms ease`;
      frame.style.opacity = String(spec.opacity?.[1] ?? 1);
      if (spec.transform) frame.style.transform = spec.transform[1];
      if (spec.filter) frame.style.filter = spec.filter[1];
      window.setTimeout(() => {
        frame.style.transition = '';
      }, duration + 40);
    }

    if (spec.flash) {
      this.flash.style.background = spec.flash === 'white' ? '#fff' : '#000';
      this.flash.style.transition = 'none';
      this.flash.style.opacity = '0.85';
      void this.flash.offsetWidth;
      this.flash.style.transition = `opacity ${Math.max(120, duration * 0.8)}ms ease`;
      this.flash.style.opacity = '0';
    }

    if (previous) {
      // 旧层先「冻结」：pause 之后不再解码（连续切换不会堆解码实例，CPU 才能压在 10% 以内），
      // 但最后一帧还留在元素上，所以交叉淡化看得见。淡出结束再清 src 释放解码器。
      freezeFrame(previous);
      if (duration > 0) {
        previous.style.transition = `opacity ${duration}ms ease, transform ${duration}ms ease, filter ${duration}ms ease`;
        previous.style.opacity = '0';
        window.setTimeout(() => disposeFrame(previous), duration + 60);
      } else {
        disposeFrame(previous);
      }
    }
  }

  /**
   * 按 layer.fps 限制上屏帧率：给每个 <video> 配一张同尺寸 canvas，video 隐藏但继续解码，
   * canvas 每 1/fps 秒 copy 一帧。>=60 或 0 表示不限（原生播放最省）。
   * 幂等：fps 变了就重挂/摘掉 canvas，不动 <video> 本身 —— 改帧率不该重载视频。
   */
  private capFrameRate(frame: HTMLElement, layer: WallpaperLayerState): void {
    const fps = Math.round(Number(layer.fps ?? 0));
    const wanted = Number.isFinite(fps) && fps > 0 && fps < 60 ? fps : 0;

    for (const video of Array.from(frame.querySelectorAll('video'))) {
      const active = Number(video.dataset.capFps ?? 0);
      if (active === wanted) continue;

      // 先拆旧的（换帧率或改回原生都要走这一步）。
      (video as unknown as { __capStop?: () => void }).__capStop?.();

      if (wanted === 0) continue;

      const canvas = document.createElement('canvas');
      canvas.className = 'wp-layer-media wp-layer-canvas';
      video.dataset.capFps = String(wanted);
      video.classList.add('wp-layer-src');
      // visibility:hidden 仍然解码（rAF 里 drawImage 拿得到帧），但不参与合成。
      video.style.visibility = 'hidden';
      video.after(canvas);
      const stop = startFrameCap(video, canvas, wanted);
      (video as unknown as { __capStop?: () => void }).__capStop = () => {
        stop();
        canvas.remove();
        video.style.visibility = '';
        video.classList.remove('wp-layer-src');
        delete video.dataset.capFps;
      };
    }
  }

  private createVideo(layer: WallpaperLayerState): HTMLVideoElement {
    const video = document.createElement('video');
    video.className = 'wp-layer-media';
    video.src = onlineEndpoint(layer.mediaUrl);
    // 壁纸音轨默认静音；只有 audioEnabled 才出声，音量取 0–100。
    // 音乐在播时宿主会把 audioEnabled 传成 false（第 4 轮「音乐优先」）。
    video.muted = layer.audioEnabled !== true;
    video.volume = Math.max(0, Math.min(1, (layer.audioVolume ?? 40) / 100));
    video.loop = true;
    video.autoplay = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.playbackRate = clampSpeed(layer.speed);
    // 片段裁剪（第 80 轮）：入点起播，出点回绕。有出点时关掉原生 loop，
    // 否则浏览器会从头循环、跳过设好的区间。
    const trimIn = Math.max(0, layer.trimInMs ?? 0) / 1000;
    const trimOut = Math.max(0, layer.trimOutMs ?? 0) / 1000;
    if (trimOut > trimIn) {
      video.loop = false;
      video.addEventListener('loadedmetadata', () => {
        if (trimIn > 0 && Math.abs(video.currentTime - trimIn) > 0.05) video.currentTime = trimIn;
      });
      video.addEventListener('timeupdate', () => {
        if (trimOut > 0 && video.currentTime >= trimOut) video.currentTime = trimIn;
      });
    } else if (trimIn > 0) {
      video.addEventListener('loadedmetadata', () => {
        video.currentTime = trimIn;
      });
    }

    // 播放失败（编解码不支持）时退回封面，至少留个画面。
    video.addEventListener('error', () => {
      if (!layer.coverUrl) return;
      const img = this.createImage({ ...layer, kind: 'image', coverUrl: layer.coverUrl });
      applyPictureTransform(img, layer);
      img.style.opacity = '1';
      video.replaceWith(img);
      this.current = img;
    });
    void video.play().catch(() => {
      // 自动播放被拦或格式不支持，交给上面的 error 分支兜底。
    });
    return video;
  }

  private createImage(layer: WallpaperLayerState): HTMLImageElement {
    const img = document.createElement('img');
    img.className = 'wp-layer-media';
    // 静态图加 Ken Burns 缓慢推拉（第 10 章第 14 条：静态图否则很呆）。
    // 用独立的 CSS `scale` 属性做，不动 transform —— 那是镜像/旋转/裁剪和转场在用的。
    if (layer.kind === 'image') img.classList.add('is-kenburns');
    const src = layer.kind === 'image' || layer.kind === 'gif'
      ? layer.mediaUrl
      : `/api/wallpaper/v2/cover/${layer.assetId}`;
    img.src = onlineEndpoint(src);
    img.draggable = false;
    return img;
  }

  /**
   * 把节拍脉冲写成 root 上的 CSS 变量（0.8% 幅度，肉眼可感但不晃）。
   * 不直接改 media 的 transform —— 那是转场用的，两者会互相覆盖。
   */
  private applyBeatPulse(): void {
    const scale = 1 + this.beatPulse * 0.010;
    this.root.style.setProperty('--wp-beat', scale.toFixed(4));
    // 界面侧的节拍微动效（二期第 3 项）消费同一个脉冲：幅度更大一点才看得出，
    // 挂到 documentElement 上是因为界面元素不在 #wallpaper-root 里面。
    const ui = 1 + this.beatPulse * 0.022;
    document.documentElement.style.setProperty('--wp-beat-ui', ui.toFixed(4));
  }

  /** 画面变换与播放速度就地在当前媒体上生效（不重建元素，避免闪一下）。 */
  private applyPicture(layer: WallpaperLayerState): void {
    if (!this.currentFrame) return;
    const targets = this.currentFrame.querySelectorAll<HTMLVideoElement | HTMLImageElement>('.wp-layer-media');
    for (const target of targets) {
      applyPictureTransform(target, layer);
      if (target instanceof HTMLVideoElement) {
        target.playbackRate = clampSpeed(layer.speed);
      }
    }
    const media = this.current;
    if (!media) return;
    if (media instanceof HTMLVideoElement) {
      const rate = clampSpeed(layer.speed);
      if (media.playbackRate !== rate) media.playbackRate = rate;
    }
  }

  /** 可视化：按设置开关与样式；只在壁纸层可见时跑动画循环。 */
  /**
   * 叠层（第 23 轮 D / 第 76 轮 E）：壁纸之上的时钟/文字，模板支持
   * {time} {date} {weekday} {year} {month} {day} 这些占位符。
   */
  private applyOverlay(layer: WallpaperLayerState): void {
    const enabled = layer.overlayEnabled === true;
    const template = (layer.overlayTemplate || '{time}').slice(0, 120);
    this.overlayTemplate = template;
    this.overlay.classList.toggle('is-empty', !enabled);
    this.root.classList.toggle('has-overlay', enabled);

    if (!enabled) {
      this.stopOverlay();
      return;
    }

    this.renderOverlayText();
    if (this.overlayTimer === null) {
      // 一秒一次只重写文本，不值当上 rAF。
      this.overlayTimer = window.setInterval(() => this.renderOverlayText(), 1000);
    }
  }

  private renderOverlayText(): void {
    const now = new Date();
    const pad = (value: number): string => value.toString().padStart(2, '0');
    const map: Record<string, string> = {
      time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
      date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
      weekday: '周日周一周二周三周四周五周六'.slice((now.getDay() % 7) * 2, (now.getDay() % 7) * 2 + 2),
      year: now.getFullYear().toString(),
      month: pad(now.getMonth() + 1),
      day: pad(now.getDate()),
    };

    const text = this.overlayTemplate.replace(/\{(\w+)\}/g, (whole, key: string) => map[key] ?? whole);
    if (this.overlay.textContent !== text) this.overlay.textContent = text;
  }

  private stopOverlay(): void {
    if (this.overlayTimer !== null) {
      window.clearInterval(this.overlayTimer);
      this.overlayTimer = null;
    }
  }


  private applyFilters(layer: WallpaperLayerState): void {
    const media = this.current;
    if (media) {
      const parts: string[] = [];
      if (layer.brightness) parts.push(`brightness(${1 + layer.brightness / 100})`);
      if (layer.contrast) parts.push(`contrast(${1 + layer.contrast / 100})`);
      if (layer.saturation) parts.push(`saturate(${1 + layer.saturation / 100})`);
      if (layer.blur) parts.push(`blur(${layer.blur}px)`);
      const value = parts.join(' ') || 'none';
      // 转场动画作用在外层 frame 上，media 自己不参与，所以这里直接写就行。
      // （早先那版写了个 if (!media.style.transition) 的守卫，结果只要 media 上
      //   残留过一个 transition，滤镜就永远不落地。）
      media.dataset.filter = value;
      media.style.filter = value;
    }

    if (media) {
      // 第 52 轮：智能自动按宽高比选 cover/contain，单张可覆盖。
      // smart 交给 CSS（cover 铺满并裁切，最稳），其余按值写。
      const fit = layer.fitMode && layer.fitMode !== 'smart' ? layer.fitMode : 'cover';
      media.style.objectFit = fit;
    }

    // 音轨开关/音量每次推送都同步：改设置不会重建 <video>，只在 createVideo 里设会一直不生效。
    for (const el of this.currentFrame?.querySelectorAll<HTMLVideoElement>('.wp-layer-media') ?? []) {
      el.muted = layer.audioEnabled !== true;
      el.volume = Math.max(0, Math.min(1, (layer.audioVolume ?? 40) / 100));
    }

    this.dim.style.opacity = String(Math.max(0, Math.min(1, layer.dim)));
  }

  /** 页面类型变化后重算显隐（壁纸层本身不重建）。 */
  refreshVisibility(): void {
    if (!this.lastLayer) return;
    // 必须走带缓存的 syncVisibility：这里原来无条件 setHidden，
    // 每次调用都会 classList 改写 + 对整棵子树强制回流（子树里是 4K <video>）。
    // 配合 start() 里那个在 document.body 上蹲 class 变化的观察器，
    // 歌词逐字高亮每帧都在改 class → 每帧强制回流一次 → 主线程被打满，页面卡死。
    this.syncVisibility();
  }

  /**
   * 壁纸层显隐带过渡：切换「动态壁纸 ⇄ 关闭 / 随歌曲封面 / 自定义」时不是硬切。
   * 隐藏 = 先挂 .is-fading 让 opacity 过渡到 0，过渡结束再补 .is-hidden 收掉 display；
   * 显示 = 先撤 .is-hidden，强制回流一帧，再撤 .is-fading，opacity 从 0 过渡回 1。
   * 过渡时长与 wallpaper.css 里 #wallpaper-root 的 opacity 一致。
   */
  private setHidden(hidden: boolean): void {
    window.clearTimeout(this.hideTimer);
    this.hiddenState = hidden;
    const root = this.root;
    if (hidden) {
      if (root.classList.contains('is-hidden')) return;
      root.classList.add('is-fading');
      this.hideTimer = window.setTimeout(() => {
        root.classList.add('is-hidden');
        root.classList.remove('is-fading');
      }, 420);
      return;
    }
    if (!root.classList.contains('is-hidden') && !root.classList.contains('is-fading')) return;
    // 之前几次切换会「先黑一下」：元素刚 display 出来时 video 还没解出第一帧，
    // 这一层露的就是自己的底（原先写死 #000）。先等第一帧（最多 400ms），
    // 拿不到就照常淡入，不阻塞交互。
    const ready = this.current;
    const needFrame = ready instanceof HTMLVideoElement && ready.readyState < 2;
    const reveal = (): void => {
      root.classList.add('is-fading');
      root.classList.remove('is-hidden');
      void root.offsetWidth;
      root.classList.remove('is-fading');
    };
    if (!needFrame) { reveal(); return; }
    window.clearTimeout(this.revealTimer);
    let done = false;
    const once = (): void => {
      if (done) return;
      done = true;
      window.clearTimeout(this.revealTimer);
      ready.removeEventListener('loadeddata', once);
      reveal();
    };
    ready.addEventListener('loadeddata', once);
    this.revealTimer = window.setTimeout(once, 400);
  }

  private setPaused(paused: boolean): void {
    const media = this.current;
    if (!(media instanceof HTMLVideoElement)) return;
    if (paused) {
      media.pause();
    } else {
      void media.play().catch(() => {});
    }
  }

  /**
   * 只隐藏不解码：这一页不该显示壁纸时把媒体暂停并淡出，但保留元素与缓冲。
   * 30 秒内没有被重新用上再真正销毁 —— 既让「切走再切回」是瞬时的，
   * 又不会让一张 4K 壁纸在后台无限期占着解码器。
   */
  private park(): void {
    this.setHidden(true);
    // 先藏着、晚一点再停解码：来来回回切「关闭 ⇄ 动态壁纸」时最常见的就是两秒内又切回来，
    // 那时候暂停再恢复 4K 流要等解码器重启（体感一两秒）。藏满 2 秒还没回来才真暂停。
    window.clearTimeout(this.parkPauseTimer);
    this.parkPauseTimer = window.setTimeout(() => {
      this.parkPauseTimer = 0;
      if (this.root.classList.contains('is-hidden') && this.current instanceof HTMLVideoElement && !this.current.paused) {
        this.current.pause();
      }
    }, 2000);
    window.clearTimeout(this.parkTimer);
    this.parkTimer = window.setTimeout(() => {
      this.parkTimer = 0;
      if (this.root.classList.contains('is-hidden')) this.clear();
    }, 30_000);
  }

  /** 宿主收进托盘 / 从托盘回来：暂停解码与页面装饰动画（窗在屏幕外，没人看得见）。 */
  setHostParked(parked: boolean): void {
    this.hostParked = parked;
    // 给页面级循环一个可观察的开关：舞台光效等 rAF 自循环靠这个类休眠，
    // 否则整窗离屏时仍在按 200Hz 续订 rAF，白白烧一个核。
    document.documentElement.classList.toggle('is-host-parked', parked);

    // 页面上的装饰动画（卡片网点/印花/星标等几十条无限 alternate）在 200Hz 屏幕上
    // 合计能吃掉半个核；停放期间整窗离屏，全部暂停，回来再按记录恢复。
    if (parked) {
      for (const anim of document.getAnimations()) {
        if (anim.playState !== 'running') continue;
        try {
          anim.pause();
          this.parkedAnimations.add(anim);
        } catch {
          // 已经被移除的动画忽略。
        }
      }
    } else {
      for (const anim of this.parkedAnimations) {
        try {
          anim.play();
        } catch {
          // 元素已卸载忽略。
        }
      }
      this.parkedAnimations.clear();
    }

    if (!(this.current instanceof HTMLVideoElement)) {
      return;
    }

    if (parked) {
      if (!this.current.paused) {
        this.current.pause();
      }
      return;
    }

    if (this.current.paused) {
      void this.current.play().catch(() => undefined);
    }
  }

  /** 停掉这一层（清媒体、隐藏 DOM），可再被 start/apply 唤醒。 */
  clear(): void {
    window.clearTimeout(this.parkTimer);
    this.parkTimer = 0;
    window.clearTimeout(this.parkPauseTimer);
    this.parkPauseTimer = 0;
    if (this.currentFrame) disposeFrame(this.currentFrame);
    this.current = null;
    this.currentFrame = null;
    this.currentKey = '';
    // 没有图层了：清掉引用，后续 refreshVisibility / syncVisibility 一律按「该隐藏」处理。
    this.lastLayer = null;
    // 停层是直接收掉，不做淡出：媒体已经销毁，留着只会是一块黑。
    window.clearTimeout(this.hideTimer);
    this.root.classList.remove('is-fading');
    this.root.classList.add('is-hidden');
    // 壁纸没了就不能再让歌词页透壁纸：撤掉开关类，否则歌词页会变成一块没有底的透明层。
    if (immersiveClassOn) {
      immersiveClassOn = false;
      document.querySelector('.app')?.classList.remove('is-wallpaper-immersive');
    }
  }
}

/** 播放速度夹到 0.5–2（§5.2 第 80 轮）。 */
function clampSpeed(speed: number | undefined): number {
  if (!speed || !Number.isFinite(speed)) return 1;
  return Math.min(2, Math.max(0.5, speed));
}

/** 裁剪百分比 0–45，其余按 0 处理。 */
function clampCrop(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return 0;
  return Math.min(45, Math.max(0, value));
}

/**
 * 画面变换：镜像 / 旋转 / 画面位置 / 缩放 / 模糊。
 *
 * 只作用在内层 media 上 —— 外层的 frame 归转场用，两者写同一个 transform 会互相覆盖。
 * 旋转 90/270 后宽高比翻过来，cover 会留边，所以按画布比例补一个缩放。
 *
 * 四个「左/上/右/下」滑杆调的是**画面在画框里的位置**，不是挪画布：
 * 早先用 translate 挪元素，结果只是把整块画布推走、边缘漏出背板，被裁掉的内容依旧看不见。
 * 现在改成 `object-position`（0–100%），配合 cover 就是「在已经铺满的画里看哪一块」，
 * 任何时候都不漏底；要看到完整的整张画面，把「缩放」调到 1 以下即可。
 */
function applyPictureTransform(
  media: HTMLVideoElement | HTMLImageElement,
  layer: WallpaperLayerState,
): void {
  const parts: string[] = [];

  const rotate = (((layer.rotation ?? 0) % 360) + 360) % 360;
  if (layer.mirrorH) parts.push('scaleX(-1)');
  if (layer.mirrorV) parts.push('scaleY(-1)');

  const panLeft = clampCrop(layer.cropLeft);
  const panTop = clampCrop(layer.cropTop);
  const panRight = clampCrop(layer.cropRight);
  const panBottom = clampCrop(layer.cropBottom);

  // 0–45 的读数映射到 object-position 的 0–100%（50% 居中）：
  // 「左」调大 = 想看画面左边 = 位置往 0% 走，所以是减。
  const posX = 50 - (panLeft - panRight) * (50 / 45);
  const posY = 50 - (panTop - panBottom) * (50 / 45);
  media.style.objectPosition =
    Math.abs(posX - 50) < 0.05 && Math.abs(posY - 50) < 0.05
      ? ''
      : `${posX.toFixed(2)}% ${posY.toFixed(2)}%`;
  media.style.clipPath = '';

  if (rotate) parts.push(`rotate(${rotate}deg)`);

  // 缩放（0.5–3）：小于 1 是缩小、能看到完整画面（留一点背板），大于 1 是放大。
  const zoom = Math.min(3, Math.max(0.5, layer.pictureZoom ?? 1));
  if (Math.abs(zoom - 1) > 0.001) parts.push(`scale(${zoom.toFixed(3)})`);

  // 模糊只作用在画面本身（用户 2026-11-17 要求的「画面模糊」），
  // 背板模糊是 layer.blur，两者互不影响。
  const pictureBlur = Math.min(24, Math.max(0, layer.pictureBlur ?? 0));
  media.style.filter = pictureBlur > 0.05 ? `blur(${pictureBlur.toFixed(1)}px)` : '';
  if (rotate === 90 || rotate === 270) {
    const w = media.clientWidth || window.innerWidth || 16;
    const h = media.clientHeight || window.innerHeight || 9;
    const ratio = Math.max(w / h, h / w);
    if (Number.isFinite(ratio) && ratio > 1) parts.push(`scale(${ratio.toFixed(3)})`);
  }

  media.style.transform = parts.length > 0 ? parts.join(' ') : '';
}

/** 冻结一帧：暂停解码但保留画面，用于转场淡出。 */
function freezeMedia(el: HTMLVideoElement | HTMLImageElement): void {
  if (el instanceof HTMLVideoElement) {
    try {
      el.pause();
    } catch {
      // 元素已脱离文档时忽略。
    }
  }
}

/** 真正释放：清掉 src 让浏览器回收解码器，再从 DOM 摘掉。 */
function disposeMedia(el: HTMLVideoElement | HTMLImageElement): void {
  if (el instanceof HTMLVideoElement) {
    const stop = (el as unknown as { __capStop?: () => void }).__capStop;
    if (stop) stop();
    try {
      el.pause();
      el.removeAttribute('src');
      el.load();
    } catch {
      // 元素已脱离文档时忽略。
    }
  }
  el.remove();
}

/** 冻结整个 frame（暂停里面的 video）。 */
function freezeFrame(frame: HTMLElement): void {
  for (const media of Array.from(frame.querySelectorAll<HTMLVideoElement | HTMLImageElement>('.wp-layer-media'))) {
    freezeMedia(media);
  }
}

/** 释放 frame 里的 media 再摘掉 frame。 */
function disposeFrame(frame: HTMLElement): void {
  for (const media of Array.from(frame.querySelectorAll<HTMLVideoElement | HTMLImageElement>('.wp-layer-media'))) {
    const stop = (media as unknown as { __capStop?: () => void }).__capStop;
    if (stop) stop();
    disposeMedia(media);
  }
  frame.remove();
}

/** 第 16 轮：常规页铺、沉浸播放页关（歌词页要让位给歌词）、房间/登录空间关。 */
export function pageAllowsWallpaper(): boolean {
  const app = document.querySelector('.app');
  if (!app) return true;
  const classes = app.classList;
  // 四类页面各自一个开关（设置 → 壁纸 → 页面显示壁纸），默认只有普通页开。
  // 沉浸播放页开着时，歌词与画布效果（纯字/拼合）用 screen 混合叠在壁纸上。
  if (classes.contains('is-lyrics-open')) return pageImmersiveEnabled();
  if (classes.contains('is-room')) return pageWallpaperAllowed('room');
  if (classes.contains('is-login')) return pageWallpaperAllowed('login');
  return pageWallpaperAllowed('normal');
}

/**
 * 歌词页透壁纸的开关类：只有「沉浸开关开着 + 当前在歌词页」时才给 .app 挂上。
 * CSS 靠它把歌词页的底色、模糊封面、暗场收掉，并让画布效果（纯字/拼合）改用
 * screen 混合——画布里的黑底在合成时几乎不贡献颜色，壁纸就透出来了。
 */
let immersiveClassOn = false;

/** 页面切换（进/出歌词页、房间页）后调用：由 app.ts 在这些时机直接触发，不轮询。 */
export function syncPageWallpaperClass(): void {
  syncImmersiveClass();
  // 整页导航时顺手把壁纸层搬到目标页（搬动只在这么几次发生）。
  attachWallpaperToPage();
}

function syncImmersiveClass(): void {
  const app = document.querySelector('.app');
  if (!app) return;
  const on = pageImmersiveEnabled() && app.classList.contains('is-lyrics-open');
  if (on === immersiveClassOn) return;
  immersiveClassOn = on;
  app.classList.toggle('is-wallpaper-immersive', on);
}

/**
 * 把壁纸层搬进 / 搬出歌词页。
 *
 * 只在「进出歌词页」时调用，**不在切换背景歌词样式时调用**：
 * 搬动一棵含 4K `<video>` 的子树会让 GPU 重新合成整块画面，观感就是壁纸定住一两秒，
 * 切「纯壁纸 / 封面在左 / 动态壁纸」时也就没有过渡（搬完透明度动画从头开始）。
 * 现在样式切换只改 class + 透明度，腾挪留给整页导航。
 */
export function attachWallpaperToPage(): void {
  const app = document.querySelector('.app');
  const root = document.getElementById(ROOT_ID);
  if (!app || !root) return;
  const view = app.classList.contains('is-lyrics-open') ? app.querySelector('.lyrics-view') : null;
  if (view) {
    if (root.parentElement !== view) view.insertBefore(root, view.firstChild);
  } else if (root.parentElement !== document.body) {
    document.body.insertBefore(root, document.body.firstChild ?? null);
  }
}

/**
 * 限帧画布的后备分辨率倍率。
 * 半分辨率（0.5）虽然省 3/4 的填充量，但在 2560/4K 面板上肉眼可见地变糊、边缘发锯齿，
 * 所以保持 1:1 按显示尺寸绘制；省开销走别的路子（少解一路视频）。
 */
const CAP_RENDER_SCALE = 1;

/**
 * 帧率上限的取帧循环：每 1/fps 秒把 <video> 当前帧按 cover 规则画进 canvas。
 * 用 rAF 计时而不是 setInterval —— 窗口不可见时 rAF 自动停，回来再接着画。
 * 返回停止函数（清 rAF，不再取帧）。
 */
function startFrameCap(video: HTMLVideoElement, canvas: HTMLCanvasElement, fps: number): () => void {
  const target = Math.max(1, Math.min(240, Math.round(fps)));
  const interval = 1000 / target;
  const ctx = canvas.getContext('2d', { alpha: false });
  let timer = 0;
  let next = 0;
  let stopped = false;

  const draw = (now: number): void => {
    if (stopped) return;
    // 用定时器而不是 requestAnimationFrame：桌面层被「桌面背景歌词」那扇窗口盖住后，
    // Chromium 会停掉这块页面的 rAF（合成被判定为不可见），限帧的画面就整个定住；
    // 定时器在宿主关掉后台节流后仍按正常频率跑，画面就不会停。
    timer = window.setTimeout(() => draw(performance.now()), Math.max(0, next - now));
    if (now + 0.5 < next) return;
    next = now + interval;

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!ctx || !vw || !vh || video.readyState < 2) return;

    const box = canvas.parentElement?.getBoundingClientRect();
    const cw = Math.max(1, Math.round((box?.width ?? vw) * CAP_RENDER_SCALE));
    const ch = Math.max(1, Math.round((box?.height ?? vh) * CAP_RENDER_SCALE));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    // object-fit: cover 等价算法：按大的一边铺满，另一边居中裁掉。
    const scale = Math.max(cw / vw, ch / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    ctx.drawImage(video, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
  };

  next = performance.now() + interval;
  timer = window.setTimeout(() => draw(performance.now()), interval);

  return () => {
    stopped = true;
    window.clearTimeout(timer);
  };
}

/** TEMP-EMERGENCY：软件内壁纸层暂停（主窗口黑屏回归定位中），恢复时把这个函数改回 false 即可。 */
function suspendInAppLayer(): boolean {
  return false;
}

function layerVisible(layer: WallpaperLayerState): boolean {  // visible 由宿主按「总开关 + 软件内画布开关」算好一起推过来（enabled=false 时是 false）；
  // 页面类型的开关在 pageAllowsWallpaper() 里判。
  return layer.visible !== false && layer.assetId > 0 && pageAllowsWallpaper();
}

/** 页面启动时挂上壁纸层（幂等）。 */
let shared: WallpaperLayer | null = null;

export function startWallpaperLayer(): WallpaperLayer {
  if (!shared) {
    shared = new WallpaperLayer();
    shared.start();
    // 宿主 windowState 里的 parked：托盘停放时暂停壁纸解码（窗已经在屏幕外，没人看得见）。
    host.onMessage((message) => {
      if (message.type !== 'host') return;
      if ((message.event === 'windowState' || message.event === 'ready') && typeof message.parked === 'boolean') {
        shared?.setHostParked(message.parked);
      }
    });
    // 只盯 .app 自己的 class（页面级导航会改它），不再观察整棵 document：
    // 歌词逐字高亮、进度条、卡片动画每帧都在改 class，subtree 观察器会被打成
    // 每帧一次回调，回调里再强制回流，主线程直接卡死（双击歌词页复现）。
    let queued = 0;
    const kick = () => {
      window.clearTimeout(queued);
      queued = window.setTimeout(() => shared?.refreshVisibility(), 120);
    };
    const attach = (tries: number) => {
      const app = document.querySelector('.app');
      if (!app) {
        if (tries > 0) window.setTimeout(() => attach(tries - 1), 150);
        return;
      }
      const observer = new MutationObserver(kick);
      observer.observe(app, { attributes: true, attributeFilter: ['class'] });
    };
    attach(40);
  }
  return shared;
}
