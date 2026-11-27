import { createWenflashLetterbox } from './wenflashLetterbox';
import type { MotionValue } from "../../../shims/framer-motion";
import type { TemperaTuning, Theme } from '../../../types';
import {
    destroyPixiDisplayTree,
    setPixiDisplayTreeVisibility,
    unloadPixiDisplayTree,
} from '../pixi/pixiDisplayResources';
import { snapResolutionToTexturePool } from '../pixi/pixiTextureBudget';
import type { TemperaProgram } from './types';
import { resolveFollowRoll, resolveFollowStart, resolveLyricCoverageZoom, resolveLyricFollow } from './temperaCamera';
import { createTemperaOverlapGrid, type TemperaOverlapGrid } from './temperaOverlapGrid';
import { createTemperaOverlapSheet, type TemperaOverlapSheet } from './temperaOverlapSheet';
import { createTemperaOverlapWave, type TemperaOverlapWave } from './temperaOverlapWave';
import { createTemperaOverlapDebris } from './temperaOverlapDebris';
import { createTemperaOverlapAmbient } from './temperaOverlapAmbient';
import { createTemperaOverlapPrintFilters } from './temperaOverlapPrint';
import { hashTemperaSeed } from './temperaRandom';
import { wenflashCameraBlend, wenflashCameraRotation, wenflashCameraSpeed, wenflashCameraSteps, wenflashCameraZoomBlend, wenflashCameraZoomSpeed, wenflashImpact, wenflashInvertFlashCount, wenflashInvertFlashDark, wenflashInvertFlashWindow, wenflashLetterboxPercent } from '../../../../wenflashSettings';

/** Critically damped follow. The camera is sprung toward the point it should be looking at, so
 * the drift along a line and the hand-off onto the next line both start and stop softly instead
 * of riding a fixed blend that snaps into motion and stops dead at the end. */

/** Critically damped spring step (Unity's SmoothDamp): no overshoot, and the velocity is zero
 * at both ends, which is what makes the hand-off read as soft rather than as a slide. */

const smoothDamp = (
    current: number, target: number, velocity: number, smoothTime: number, dt: number,
) => {
    const omega = 2 / Math.max(0.0001, smoothTime);
    const x = omega * dt;
    const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const change = current - target;
    const temp = (velocity + omega * change) * dt;
    return {
        value: target + (change + temp) * decay,
        velocity: (velocity - omega * temp) * decay,
    };
};

/** Where the line being sung actually sits on the stage this frame, for the trail. The glyph
 * layout is fixed, but the shot's own camera zoom and drift move the block, so the point has to
 * read the same terms the follow camera does. */
const resolveOverlapLine = (
    view: TemperaShotView, width: number, height: number,
): OverlapDecorLine => {
    const scale = view.frameScale;
    const map = (x: number, y: number) => ({
        x: (x - width / 2) * scale + width / 2 + view.frameX,
        y: (y - height / 2) * scale + height / 2 + view.frameY,
    });
    if (!view.glyphs.length) {
        const centre = map(width / 2, height / 2);
        return {
            key: view.shot.id, x: centre.x, y: centre.y,
            startX: centre.x, startY: centre.y, endX: centre.x, endY: centre.y,
            duration: Math.max(0.9, view.shot.endTime - view.shot.startTime),
            startColor: undefined, endColor: undefined,
            keywordX: undefined, keywordY: undefined, keywordColor: undefined,
        };
    }
    let centreX = 0;
    let centreY = 0;
    for (const glyph of view.glyphs) {
        centreX += glyph.baseX;
        centreY += glyph.baseY;
    }
    centreX /= view.glyphs.length;
    centreY /= view.glyphs.length;
    const centre = map(centreX, centreY);
    const first = view.glyphs[0];
    const last = view.glyphs[view.glyphs.length - 1];
    const start = map(first.baseX, first.baseY);
    const end = map(last.baseX, last.baseY);
    return {
        key: view.shot.id,
        x: centre.x,
        y: centre.y,
        startX: start.x,
        startY: start.y,
        endX: end.x,
        endY: end.y,
        duration: Math.max(0.9, view.shot.endTime - view.shot.startTime),
    };
};
import { findTemperaParagraphIndexAtTime } from './temperaProgram';
import {
    type TemperaCreditsView,
    type TemperaShotView,
    buildTemperaScene,
    temperaSceneSteps,
    type TemperaSceneView,
} from './temperaSceneBuilder';
import {
    type OverlapDecorLine,
    type TemperaOverlapDecor,
    createTemperaOverlapDecor,
} from './temperaOverlapDecor';
import {
    type TemperaOverlapHud,
    createTemperaOverlapHud,
} from './temperaOverlapHud';
import { PixiSceneCache } from '../pixiSceneCache';
import { perfEvent, perfMark, perfOn } from '../../../../perfProbe';
import { PixiSongSwap } from '../pixiSongSwap';
import { loadPixi } from '../pixi/loadPixi';
import { linkPixiPrograms } from '../pixi/pixiProgramLinks';
import { makePixiContext } from '../pixi/pixiWebGLContext';
import { setTemperaTransitionBlur } from './temperaSceneFilters';
import { destroyTemperaGradientFills } from './temperaShapes';
import { TemperaImageTextures } from './temperaImageTextures';
import { TemperaOverlay } from './temperaOverlay';
import { resolveTemperaCreditsFrame, TemperaCreditsLayer } from './temperaCreditsLayer';
import { heldExitSeconds, resolveAnimationScale, resolveTemperaShotExit, resolveWenflashInvertTrigger, updateTemperaShot } from './temperaShotFrame';
import { overlapCameraSpeed, overlapCameraZoomSpeed, overlapFx } from '../../../../overlapSettings';

interface TemperaImpact {
    start: number;
    angle: number;
    px: number;
    shareX: number;
    shareY: number;
    depth: number;
    z: number;
    rollDeg: number;
    decay: number;
    omega: number;
    attack: number;
}
import {
    findTemperaActiveShotIndex,
    requiresTemperaSceneRebuild,
    resolveTemperaSceneTransitionFrame,
} from './temperaSceneFrame';

// @note Version Control: Project Folia version 0.6.13-750617

// src/components/visualizer/tempera/createTemperaPixiRuntime.ts
// Owns Pixi lifecycle and mutates bounded scene views directly from absolute playback time.
// Tempera loads no external textures, so destroy only walks filters -> containers -> app.
// 片尾海报、画框与擦除块、图片纹理池、shot 逐帧姿态和场景转场决策在相邻模块；这里只管生命周期、
// 段落场景缓存、换歌交接和每帧调度。
type PixiModule = typeof import('pixi.js');

export interface TemperaSongMetadata {
    title?: string | null;
    artist?: string | null;
    album?: string | null;
}

/**
 * Everything about the runtime that belongs to one track. Swapped in place rather than rebuilt -
 * see `swapSong`.
 */
export interface TemperaSongContext {
    /**
     * Track identity. Only a change here is a real song change; the rest of this object also
     * moves when the cover palette resolves, the theme is edited, or lyrics are hidden, and
     * those must swap silently rather than play a cut.
     */
    seed: string | number | undefined;
    program: TemperaProgram;
    theme: Theme;
    coverColors: string[];
}

export interface TemperaRuntimeOptions {
    host: HTMLDivElement;
    /** Track identity of `program`; see TemperaSongContext.seed. */
    songSeed?: string | number;
    program: TemperaProgram;
    theme: Theme;
    tuning: TemperaTuning;
    currentTime: MotionValue<number>;
    lyricsFontScale: number;
    staticMode: boolean;
    coverColors?: string[];
    /** Stored files for the user's placed images, keyed by placement id. */
    imageBlobs?: Map<string, Blob>;
    lyricsOnly?: boolean;
    glyphsOnly?: boolean;
    /** 文闪链式排版（横排/竖排）的镜头跟随；graphic 档保持固定镜头。 */
    cameraFollow?: boolean;
    paused: boolean;
    songTitle?: string | null;
    songArtist?: string | null;
    songAlbum?: string | null;
    signal?: AbortSignal;
}


/** The incoming scene and poster, built a frame before the cut needs them. */
interface TemperaStagedSong {
    scene: TemperaSceneView;
    index: number;
    credits: TemperaCreditsView | null;
}

export class TemperaPixiRuntime {
    /**
     * Scenes the song handover replaced wait in the cache's retired queue to be freed. Destroying
     * a scene walks every shot and every glyph's Text, and doing that for the whole cache on the
     * frame the swap lands is exactly the stall the wipe was supposed to hide. They are dropped
     * one per frame once the sweep is over instead.
     */
    private readonly sceneCache = new PixiSceneCache<TemperaSceneView>({
        count: () => this.options.program.paragraphs.length,
        build: index => {
            const scene = this.buildScene(this.liveSong, index);
            this.sceneContainer.addChild(scene.container);
            return scene;
        },
        destroy: scene => this.destroyScene(scene),
        detach: scene => this.sceneContainer.removeChild(scene.container),
    });
    private activeParagraphIndex = -1;
    /** 分帧建场的进行中任务；同一时刻最多一个。 */
    private pendingScene: {
        index: number;
        steps: Generator<void, TemperaSceneView, void>;
        holder: { container?: import('pixi.js').Container };
        startedAt: number;
    } | null = null;
    /** Where the shared follow camera currently rests, in viewport pixels. Kept across frames
     * because an instrumental gap has no type to anchor on; the camera must stay where the last
     * line left it instead of snapping back to centre when the anchor disappears. */
    private followX = 0;
    private followY = 0;
    private followZoom = 1;
    /** Standing camera roll: the stage is always unwound so the current line reads upright. */
    private followRotation = 0;
    /** Spring velocities, kept between frames so the follow keeps its momentum across a line
     * change instead of restarting the ease from rest. */
    private followVX = 0;
    private followVY = 0;
    private followVZoom = 0;
    private followVRoll = 0;
    private followTime = Number.NEGATIVE_INFINITY;
    /** Last time the camera pose was sampled when camera stepping is on. */
    private cameraSampleTime = 0;
    // Camera impacts: a line change can bump the stage. Several bumps may ring at once when the
    // lines come fast, so each one keeps its own clock instead of replacing the previous.
    private impactLine = '';
    private impacts: TemperaImpact[] = [];
    private impactPlan: {shotId: string; at: number; fired: boolean} | null = null;
    private destroyed = false;
    private resizeObserver: ResizeObserver | null = null;
    private lastWidth = 0;
    private lastHeight = 0;
    /**
     * What the renderer is actually running at: `textureResolution` after the texture-pool snap.
     * It depends on the viewport as well as the setting, so it is recomputed on every resize and
     * every tuning change rather than read off the tuning - and the fixed-resolution filter
     * passes are derived from this, never from `tuning.textureResolution`.
     */
    private renderResolution = 1;

    private sceneContainer!: import('pixi.js').Container;
    /** Equal-height black bars that breathe with the follow camera's zoom. */
    private letterbox: ReturnType<typeof createWenflashLetterbox> | null = null;
    private letterboxLayer: import('pixi.js').Container | null = null;
    /** Full-frame wash behind the type while the background-invert flash is active. */
    /** Held invert state: every trigger flips it, the next trigger flips it back. */
    private invertOn = false;
    private invertTargetOn = false;
    private invertActive = false;
    private invertTriggerKey = '';
    private invertTransitionAt = 0;
    private invertTransitionUntil = 0;
    private invertSampleTime = Number.NEGATIVE_INFINITY;
    /** Still parent that carries the print pass, so the vignette stays in frame space. */
    private printLayer!: import('pixi.js').Container;
    private printFilters: import('pixi.js').Filter[] = [];
    private printSeed = 0;
    /** Halo + line trail for 重合; null on the flow stage. */
    private decor: TemperaOverlapDecor | null = null;
    private hud: TemperaOverlapHud | null = null;
    private grid: TemperaOverlapGrid | null = null;
    private sheet: TemperaOverlapSheet | null = null;
    private wave: TemperaOverlapWave | null = null;
    private debris: ReturnType<typeof createTemperaOverlapDebris> | null = null;
    private ambient: ReturnType<typeof createTemperaOverlapAmbient> | null = null;
    private debrisLine = '';
    private debrisPoint = {x: 0, y: 0};
    private lastFollow = {x: 0, y: 0};
    private sheetLine = '';
    private sheetParagraph = -1;
    private creditsLayer!: TemperaCreditsLayer;
    private imageTextures!: TemperaImageTextures;
    private overlay!: TemperaOverlay;
    /**
     * An in-flight song handover, spread over exactly two frames. A track change is a plain cut
     * here - no wipe, no dissolve - but a cut must not also be a stall, so the incoming scene is
     * built on the first frame while the outgoing song still holds the picture, and the content
     * changes on the second. What it replaces is freed later, one scene per frame.
     */
    private readonly songSwap = new PixiSongSwap<TemperaSongContext, TemperaStagedSong>({
        stage: song => this.stageSong(song),
        commit: (song, staged) => this.commitSongContext(song, staged),
        discard: staged => this.discardStaged(staged),
    });

    private constructor(
        private readonly pixi: PixiModule,
        private readonly options: TemperaRuntimeOptions,
        private readonly app: import('pixi.js').Application,
    ) { }

    static async create(options: TemperaRuntimeOptions) {
        const pixi = await loadPixi();
        // The options the WebGL context is made with, ahead of Pixi (makePixiContext).
        const contextOptions = {
            backgroundAlpha: 0,
            // With post-processing the scene is drawn into the filters' own multisampled target and
            // the back buffer only gets the filtered picture and the frame marks: its 4-sample buffer
            // would cost about 70 MB of video memory for those. The marks' edges are then not
            // smoothed. Switching post-processing rebuilds this runtime (rebuildKey in VisualizerTempera).
            antialias: !options.tuning.postProcessEnabled,
            powerPreference: 'high-performance',
            // The lyric layer's difference filter declares blendRequired; without the back
            // buffer the WebGL renderer skips the whole filter stack for that container.
            useBackBuffer: true,
        } as const;
        const context = await makePixiContext(pixi, contextOptions, options.signal);
        const app = new pixi.Application();
        const width = Math.max(options.host.clientWidth, 320);
        const height = Math.max(options.host.clientHeight, 240);
        const resolution = snapResolutionToTexturePool(width, height, options.tuning.textureResolution);
        await app.init({
            width,
            height,
            ...contextOptions,
            ...context,
            autoDensity: true,
            resolution,
            autoStart: false,
            sharedTicker: false,
            preference: 'webgl',
        });
        const runtime = new TemperaPixiRuntime(pixi, options, app);
        runtime.renderResolution = resolution;
        runtime.sceneContainer = new pixi.Container();
        // Paragraph scenes overlap during a boundary, so they must stack by paragraph order.
        runtime.sceneContainer.sortableChildren = true;
        // The print pass hangs on a still parent: 重合's camera moves the scenes themselves, and
        // a filter on the moving container would carry the vignette along with the line.
        runtime.printLayer = new pixi.Container();
        runtime.creditsLayer = new TemperaCreditsLayer(pixi);
        runtime.overlay = new TemperaOverlay(pixi);
        app.stage.addChild(runtime.printLayer, runtime.creditsLayer.container, runtime.overlay.container);
        runtime.printLayer.addChild(runtime.sceneContainer);
        if (options.lyricsOnly && !options.glyphsOnly) {
            // Inside the follow container: the trail and the stroke travel, turn and zoom with
            // the type, so they read as ink on the same page rather than as an overlay on the glass.
            runtime.decor = createTemperaOverlapDecor(
                pixi, width, height, options.theme.primaryColor, options.theme.accentColor,
            );
            runtime.sceneContainer.addChild(runtime.decor.container);
            // Loose bits of ink and paper live on the stage: they belong to the room the camera
            // moves through, not to the sheet that is being moved.
            runtime.debris = createTemperaOverlapDebris(
                pixi, width, height, options.theme.primaryColor, options.theme.accentColor,
            );
            app.stage.addChildAt(runtime.debris.container, 2);
            // Ambient line work sits above the printed page (the paragraph paper is opaque and
            // would hide anything under it) and below the wipe plane.
            runtime.ambient = createTemperaOverlapAmbient(
                pixi, width, height, options.theme.primaryColor,
            );
            // Parent it to the camera container: whatever the camera does to the type, it does
            // to the doodles, with no second transform to keep in sync.
            runtime.ambient.container.zIndex = 1_000_000;
            runtime.sceneContainer.addChild(runtime.ambient.container);
            // The surveyor's frame hangs on the stage, not on the page: it marks where the line
            // sits on the sheet while the camera turns the sheet underneath it.
            runtime.hud = createTemperaOverlapHud(
                pixi, width, height, options.theme.accentColor,
            );
            app.stage.addChild(runtime.hud.container);
            // Behind everything: the ruled sheet the page sits on. It drifts against the camera
            // and dents under the line, so the type reads as being nearer than the paper.
            runtime.printSeed = hashTemperaSeed(String(options.songSeed ?? 'overlap'));
            runtime.printFilters = options.tuning.postProcessEnabled && !options.staticMode
                ? createTemperaOverlapPrintFilters(pixi, options.tuning, runtime.printSeed, runtime.renderResolution)
                : [];
            if (runtime.printFilters.length > 0) {
                runtime.printLayer.filters = runtime.printFilters;
                // Pinned to the viewport: without this Pixi sizes the pass from the moving
                // child's bounds, and the vignette would ride along with the lyric.
                runtime.printLayer.filterArea = new pixi.Rectangle(0, 0, width, height);
            }
            runtime.grid = createTemperaOverlapGrid(pixi, width, height, options.theme.primaryColor);
            app.stage.addChildAt(runtime.grid.container, 0);
            // The deep layer: a wall-sized ghost of the line and the creases of the page. Above
            // the ruled sheet, below everything that belongs to the song.
            runtime.sheet = createTemperaOverlapSheet(
                pixi, width, height, options.theme.primaryColor, options.theme.fontFamily ?? 'serif',
            );
            app.stage.addChildAt(runtime.sheet.container, 1);
            runtime.wave = createTemperaOverlapWave(pixi, width, height, options.theme.accentColor);
            app.stage.addChild(runtime.wave.container);
        }
        if (options.lyricsOnly && options.glyphsOnly) {
            // 文闪也走同一套屏幕空间印刷链，但参数来自文闪自己的「印刷与画质」，
            // 不读取重合的 grain / 色版 / 暗角。
            runtime.printSeed = hashTemperaSeed(String(options.songSeed ?? 'wenflash'));
            runtime.printFilters = options.tuning.postProcessEnabled && !options.staticMode
                ? createTemperaOverlapPrintFilters(pixi, options.tuning, runtime.printSeed, runtime.renderResolution)
                : [];
            if (runtime.printFilters.length > 0) {
                runtime.printLayer.filters = runtime.printFilters;
                runtime.printLayer.filterArea = new pixi.Rectangle(0, 0, width, height);
            }
            runtime.letterbox = createWenflashLetterbox(pixi);
            const foreground = new pixi.Container();
            foreground.addChild(runtime.printLayer, runtime.creditsLayer.container);
            app.stage.addChildAt(foreground, 0);
            foreground.filters = [runtime.letterbox.filter];
            foreground.filterArea = new pixi.Rectangle(0, 0, width, height);
            runtime.letterboxLayer = foreground;
            runtime.updateLetterbox(height);
        }

        // Textures are loaded once and shared by every scene: paragraph scenes are rebuilt as
        // playback moves, and reloading a character cut-out on each one would thrash.
        runtime.imageTextures = new TemperaImageTextures(pixi);
        await runtime.imageTextures.load(options.imageBlobs, () => runtime.destroyed);

        if (options.signal?.aborted) {
            runtime.destroy();
            throw new DOMException('Tempera runtime creation was cancelled', 'AbortError');
        }
        await runtime.install();
        if (options.signal?.aborted) {
            runtime.destroy();
            throw new DOMException('Tempera runtime creation was cancelled', 'AbortError');
        }
        return runtime;
    }

    /**
     * The first frame, in steps the page runs between: the first scene is built in a task of its own,
     * its shader programs are linked while the page goes on (linkPixiPrograms), and only then does the
     * canvas go on the page, drawn. Returns early when the creation is cancelled meanwhile.
     */
    private async install() {
        await new Promise((resolve) => { window.setTimeout(resolve); });
        if (this.options.signal?.aborted) return;
        this.resizeToHost();
        {const paintAt=perfOn()?performance.now():0;this.renderFrame();if(paintAt)perfMark('rt.install.firstFrame',paintAt,{scenes:this.sceneCache.size});}
        {const linkAt=perfOn()?performance.now():0;await linkPixiPrograms(this.pixi, this.app.renderer, this.app.stage, 'Tempera', this.options.signal);if(linkAt)perfMark('rt.install.linkPrograms',linkAt);}
        if (this.options.signal?.aborted) return;
        this.options.host.appendChild(this.app.canvas);
        this.app.canvas.style.cssText = 'width:100%;height:100%;display:block';
        this.app.ticker.add(this.renderFrame);
        this.resizeObserver = new ResizeObserver(() => {
            if (this.destroyed || !this.resizeToHost()) return;
            if (this.options.paused) this.renderOnce();
        });
        this.resizeObserver.observe(this.options.host);
        this.app.renderer.render(this.app.stage);
        if (!this.options.paused) this.app.start();
    }

    /**
     * The resolution to render this viewport at. Falls back to the host's own size so it is
     * still right if a tuning change arrives before the first resize pass has run.
     */
    private resolveRenderResolution(tuning: TemperaTuning) {
        const width = this.lastWidth || Math.max(this.options.host.clientWidth, 320);
        const height = this.lastHeight || Math.max(this.options.host.clientHeight, 240);
        return snapResolutionToTexturePool(width, height, tuning.textureResolution);
    }

    private updateInvertState(view: TemperaShotView | null, time: number) {
        if (!this.options.glyphsOnly) {
            this.invertOn = false;
            this.invertActive = false;
            this.setInvertFilter(false);
            return;
        }
        // A seek is not a trigger: drop the held state and let the next trigger establish it.
        if (Math.abs(time - this.invertSampleTime) > 1.2) {
            this.invertOn = false;
            this.invertTargetOn = false;
            this.invertTriggerKey = '';
            this.invertTransitionUntil = 0;
        }
        this.invertSampleTime = time;
        const trigger = view ? resolveWenflashInvertTrigger(view) : null;
        if (!trigger) {
            this.invertOn = false;
            this.invertActive = false;
            this.invertTriggerKey = '';
            this.setInvertFilter(false);
            return;
        }
        if (trigger.at !== null && trigger.key !== this.invertTriggerKey && time >= trigger.at) {
            this.invertTriggerKey = trigger.key;
            this.invertTargetOn = !this.invertOn;
            this.invertTransitionAt = time;
            // The invert blink has its own count / window / dark ratio, independent of the
            // lyric entrance/exit flash.
            this.invertTransitionUntil = time + Math.max(0.05, wenflashInvertFlashWindow());
        }
        if (time < this.invertTransitionUntil) {
            const span = Math.max(0.02, this.invertTransitionUntil - this.invertTransitionAt);
            const phase = (time - this.invertTransitionAt) / span * Math.max(1, wenflashInvertFlashCount());
            const lit = phase % 1 >= Math.min(1, Math.max(0, wenflashInvertFlashDark()));
            this.invertActive = lit ? this.invertTargetOn : this.invertOn;
        } else {
            if (this.invertTransitionUntil > 0 && this.invertTargetOn !== this.invertOn) {
                this.invertOn = this.invertTargetOn;
            }
            this.invertActive = this.invertOn;
        }
        this.setInvertFilter(this.invertActive);
    }

    private setInvertFilter(active: boolean) {
        this.options.host.classList.toggle('is-invert-flipped', active);
    }

    private resizeToHost() {
        if (this.destroyed) return false;
        const width = Math.max(this.options.host.clientWidth, 320);
        const height = Math.max(this.options.host.clientHeight, 240);
        if (width === this.lastWidth && height === this.lastHeight) return false;
        this.lastWidth = width;
        this.lastHeight = height;
        // The snap is a function of the viewport, not just the setting: a resize can move the
        // pass across a pool boundary on its own. Passing it to `resize` keeps the surface and
        // its resolution on one call, and the scenes are dropped below anyway.
        this.renderResolution = this.resolveRenderResolution(this.options.tuning);
        this.app.renderer.resize(width, height, this.renderResolution);
        // Staged against the old viewport, so its layout no longer fits.
        this.songSwap.dropStaged();
        this.clearScenes();
        this.drawCredits(width, height);
        this.drawOverlay(width, height);
        this.decor?.resize(width, height);
        this.hud?.resize(width, height);
        this.grid?.resize(width, height);
        this.debris?.resize(width, height);
        this.ambient?.resize(width, height);
        this.sheet?.resize(width, height);
        this.wave?.resize(width, height);
        if (this.letterboxLayer) {
            this.letterboxLayer.filterArea = new this.pixi.Rectangle(0, 0, width, height);
            this.updateLetterbox(height);
        }
        if (this.printFilters.length > 0) {
            this.printLayer.filterArea = new this.pixi.Rectangle(0, 0, width, height);
            this.printFilters.forEach(filter => {
                filter.resolution = this.renderResolution;
            });
        }
        return true;
    }

    /** The incoming or live song's poster, against the metadata and tuning in force right now. */
    private buildCreditsView(
        song: TemperaSongContext,
        scenePalette: TemperaSceneView['palette'] | undefined,
        width: number,
        height: number,
    ): TemperaCreditsView | null {
        // 重合档（lyricsOnly）也要这张卡：开场第一句之前、全曲唱完之后各显示一次。
        // 但它只显示歌名——词/曲/编曲那些署名是歌词文件自带的头部信息，不该出现在画面上。
        const lyricsOnly = this.options.lyricsOnly === true;
        if (this.options.glyphsOnly || (lyricsOnly && !overlapFx().titleCard)) return null;
        return this.creditsLayer.build({
            theme: song.theme,
            coverColors: song.coverColors,
            tuning: this.options.tuning,
            metadata: {
                title: this.options.songTitle,
                artist: lyricsOnly ? null : this.options.songArtist,
                album: lyricsOnly ? null : this.options.songAlbum,
            },
            lyricsFontScale: this.options.lyricsFontScale,
            plain: lyricsOnly,
        }, scenePalette, width, height);
    }

    private drawCredits(width: number, height: number) {
        this.creditsLayer.adopt(
            this.buildCreditsView(
                this.liveSong,
                this.sceneCache.get(Math.max(0, this.activeParagraphIndex))?.palette,
                width,
                height,
            ),
            width,
            height,
        );
    }

    setSongMetadata(metadata: TemperaSongMetadata) {
        if (this.destroyed) return;
        const changed = this.options.songTitle !== metadata.title
            || this.options.songArtist !== metadata.artist
            || this.options.songAlbum !== metadata.album;
        if (!changed) return;

        this.options.songTitle = metadata.title;
        this.options.songArtist = metadata.artist;
        this.options.songAlbum = metadata.album;
        // Metadata lands in the same React commit as a track change, and the handover already
        // builds the incoming poster on its own frame. Redrawing here would be a second build.
        const swap = this.songSwap;
        if (swap.active) {
            // Unless it changed in the one frame between staging and the cut, in which case the
            // staged card carries the outgoing song's name and has to be rebuilt.
            const pending = swap.song;
            const staged = swap.staged;
            if (pending && staged && this.lastWidth > 0 && this.lastHeight > 0) {
                const stale = staged.credits;
                staged.credits = this.buildCreditsView(
                    pending,
                    staged.scene.palette,
                    this.lastWidth,
                    this.lastHeight,
                );
                if (stale) this.creditsLayer.destroyView(stale);
            }
            return;
        }
        if (this.lastWidth > 0 && this.lastHeight > 0) {
            this.drawCredits(this.lastWidth, this.lastHeight);
            if (this.options.paused) this.renderOnce();
        }
    }

    private drawOverlay(width: number, height: number) {
        this.overlay.draw(width, height, this.options.tuning, this.options.theme);
    }

    private clearScenes() {
        this.cancelPendingScene();
        this.sceneCache.clear();
        this.activeParagraphIndex = -1;
    }

    /**
     * Takes the cache off screen without paying for its teardown yet. Used only by the song
     * handover: freeing every glyph's Text on the frame the swap lands is precisely the stall
     * the block was drawn to hide.
     */
    private retireScenes() {
        this.cancelPendingScene();
        this.sceneCache.retireAll();
        this.activeParagraphIndex = -1;
    }

    private destroyScene(scene: TemperaSceneView) {
        this.sceneContainer.removeChild(scene.container);
        unloadPixiDisplayTree(scene.container);
        scene.container.filters = null;
        scene.shots.forEach(shot => {
            shot.textLayer.filters = null;
            if (shot.underline) {
                shot.underline.group.filters = null;
                shot.underline.blur.destroy();
            }
            if (shot.bracket) {
                shot.bracket.group.filters = null;
                shot.bracket.blur.destroy();
            }
            for (const glyph of shot.glyphs) {
                if (glyph.glow) {
                    glyph.glow.display.filters = null;
                    glyph.glow.gradient?.filter.destroy();
                    glyph.glow.filter?.destroy();
                }
                if (glyph.sungBlur) {
                    glyph.display.filters = null;
                    glyph.sungBlur.filter?.destroy();
                }
            }
        });
        scene.postProcessFilters.forEach(filter => filter.destroy());
        destroyTemperaGradientFills(this.pixi, scene.container);
        // 逐节点销毁：destroy({ children: true }) 会留下每个 Graphics 自建的 GraphicsContext 与它的 GPU 缓冲。
        destroyPixiDisplayTree(scene.container);
    }

    /**
     * Builds one paragraph scene. This is the expensive call in the whole runtime: it runs the
     * layout fit loop over every grapheme and then creates a `pixi.Text` per glyph, plus its
     * shadow and echo copies. Nothing here should ever run more than once per frame.
     */
    private buildScene(song: TemperaSongContext, index: number) {
        const perfStart = typeof localStorage !== 'undefined' && localStorage.getItem('zilux2.perf') === '1'
            ? performance.now() : 0;
        const scene = buildTemperaScene(this.pixi, this.sceneBuildOptions(song, index), song.program.paragraphs[index]);
        if (perfStart) {
            const list = ((window as any).__temperaSceneMs ??= []);
            list.push({
                ms: Math.round(performance.now() - perfStart),
                shots: scene.shots.length,
                glyphs: scene.shots.reduce((n, shot) => n + shot.glyphs.length, 0),
            });
        }
        return scene;
    }

    private sceneBuildOptions(song: TemperaSongContext, index: number) {
        return {
            programSeed: song.program.seed,
            followingLine: song.program.paragraphs[index + 1]?.lines[0]?.sourceIndex,
            host: this.options.host,
            theme: song.theme,
            tuning: this.options.tuning,
            renderResolution: this.renderResolution,
            lyricsFontScale: this.options.lyricsFontScale,
            staticMode: this.options.staticMode,
            lyricsOnly: this.options.lyricsOnly,
            glyphsOnly: this.options.glyphsOnly,
            previousLineAnchor: index > 0 ? this.sceneCache.get(index - 1)?.lastLineAnchor ?? null : null,
            coverColors: song.coverColors,
            imageTextures: this.imageTextures.textures,
        };
    }

    /**
     * 分帧建场：一次只建一个段落，按每帧预算推进一步。
     *
     * 密集段落（50 个镜头）一次性建完实测 200 ms 以上，正好压在「预建邻段」那一帧上。这里把
     * 同一个构建器拆成每帧一小步，建好之前容器不挂在场景层上，所以中途暂停不会被看见。
     */
    private startPendingScene(index: number) {
        if (this.pendingScene || index < 0 || index >= this.options.program.paragraphs.length) return;
        if (this.sceneCache.has(index)) return;
        const song = this.liveSong;
        const holder: { container?: import('pixi.js').Container } = {};
        const steps = temperaSceneSteps(
            this.pixi,
            this.sceneBuildOptions(song, index),
            song.program.paragraphs[index],
            holder,
        );
        this.pendingScene = { index, steps, holder, startedAt: perfOn() ? performance.now() : 0 };
        this.advancePendingScene(0);
    }

    /** 推进分帧建场；budgetMs 为 0 时只走一步。 */
    private advancePendingScene(budgetMs: number) {
        const pending = this.pendingScene;
        if (!pending) return;
        const until = performance.now() + Math.max(0, budgetMs);
        do {
            const step = pending.steps.next();
            if (step.done) {
                const scene = step.value;
                this.sceneContainer.addChild(scene.container);
                this.sceneCache.adopt(pending.index, scene);
                if (pending.startedAt) {
                    perfMark('scene.build.chunked', pending.startedAt, {
                        index: pending.index,
                        shots: scene.shots.length,
                    });
                }
                this.pendingScene = null;
                return;
            }
        } while (performance.now() < until);
    }

    /** 丢弃没建完的场景，连同它已经建出来的显示对象。 */
    private cancelPendingScene() {
        const pending = this.pendingScene;
        if (!pending) return;
        this.pendingScene = null;
        const container = pending.holder.container;
        if (!container) return;
        unloadPixiDisplayTree(container);
        container.filters = null;
        destroyPixiDisplayTree(container);
    }

    /** The live song as a context, for building scenes against what is currently on screen. */
    private get liveSong(): TemperaSongContext {
        return {
            seed: this.options.songSeed,
            program: this.options.program,
            theme: this.options.theme,
            coverColors: this.options.coverColors ?? [],
        };
    }

    private renderFrame = () => {
        if (this.destroyed) return;
        const frameStartedAt = perfOn() ? performance.now() : 0;
        const time = this.options.currentTime.get();
        // Advanced before the paragraph lookup so a cut lands on this frame's scene selection
        // instead of leaving one frame of the outgoing program on the incoming one.
        this.songSwap.advance();
        if (this.options.program.paragraphs.length === 0) {
            return;
        }
        const paragraphIndex = findTemperaParagraphIndexAtTime(this.options.program, time);
        // Songs with an intro have no paragraph before their first line: -1 used to reach
        // sceneCache.ensure and throw on an undefined paragraph, which took the whole stage down.
        if (paragraphIndex < 0) {
            this.activeParagraphIndex = -1;
            this.sceneContainer.visible = false;
            return;
        }
        this.sceneContainer.visible = true;
        if (paragraphIndex !== this.activeParagraphIndex) {
            this.activeParagraphIndex = paragraphIndex;
            // A build in progress for this very paragraph is finished now; one for a paragraph
            // that is no longer a neighbour is dropped before it wastes another frame.
            if (this.pendingScene) {
                if (this.pendingScene.index === paragraphIndex) this.advancePendingScene(Number.POSITIVE_INFINITY);
                else if (Math.abs(this.pendingScene.index - paragraphIndex) > 1) this.cancelPendingScene();
            }
            this.sceneCache.ensure(paragraphIndex);
            const retained = new Set<number>();
            if (this.options.lyricsOnly) {
                const exitWindow = heldExitSeconds();
                for (let i = 0; i < paragraphIndex; i++) {
                    if (this.options.program.paragraphs[i].shots.some(shot =>
                        shot.holdUntil !== undefined && time < shot.holdUntil + exitWindow)) {
                        retained.add(i);
                        this.sceneCache.ensure(i);
                    }
                }
            }
            this.sceneCache.prune(paragraphIndex,retained);
        } else if (!this.songSwap.active) {
            // One piece of expensive work per frame, in priority order: free what the last
            // handover left behind, then pre-roll a neighbour. Neighbours are for a boundary
            // that is still ahead, so nothing here is ever needed on this frame - which is the
            // point. Doing all of it at once was the visible hitch at a paragraph cut, and at a
            // song handover it landed right where the block was supposed to hide the swap.
            const next = paragraphIndex + 1;
            const previous = paragraphIndex - 1;
            if (this.sceneCache.hasRetired) {
                this.sceneCache.drainRetired();
            } else if (this.pendingScene) {
                // A neighbour build in progress: give it a slice, never a whole frame.
                this.advancePendingScene(4);
            } else if (next < this.options.program.paragraphs.length && !this.sceneCache.has(next)) {
                this.startPendingScene(next);
            } else if (previous >= 0 && !this.sceneCache.has(previous)) {
                this.startPendingScene(previous);
            }
        }
        if (frameStartedAt) perfMark('rt.frame.scenes', frameStartedAt);
        // The size the renderer was last fitted to. Reading the host here instead would force a
        // synchronous layout every frame, and the ResizeObserver refits both together anyway.
        const width = this.lastWidth || Math.max(this.options.host.clientWidth, 320);
        const height = this.lastHeight || Math.max(this.options.host.clientHeight, 240);
        const finalParagraph = this.options.program.paragraphs.at(-1);
        const firstParagraph = this.options.program.paragraphs[0];
        const creditsFrame = resolveTemperaCreditsFrame(
            time,
            finalParagraph?.endTime ?? Number.POSITIVE_INFINITY,
            firstParagraph?.startTime ?? 0,
        );
        const hasCredits = this.creditsLayer.hasPoster;
        if (perfOn() && (this as any).__creditsProbeT !== Math.floor(time)) {
            (this as any).__creditsProbeT = Math.floor(time);
            perfEvent('credits.frame', {
                t: Math.round(time * 10) / 10,
                first: Math.round((firstParagraph?.startTime ?? 0) * 10) / 10,
                intro: creditsFrame.introActive ? 1 : 0,
                alpha: Math.round(creditsFrame.posterAlpha * 100) / 100,
                has: hasCredits ? 1 : 0,
                only: this.options.lyricsOnly ? 1 : 0,
                titleLen: (this.options.songTitle ?? '').length,
                kids: this.creditsLayer.container.children.length,
                cw: Math.round(this.creditsLayer.container.width),
                ch: Math.round(this.creditsLayer.container.height),
                vis: this.creditsLayer.container.visible ? 1 : 0,
            });
        }
        let wipeDrawn = false;

        const transitionsEnabled = this.options.tuning.enableTransitions && !this.options.staticMode;
        const outgoingTransition = this.options.program.paragraphs[paragraphIndex]?.transitionOut ?? null;
        /**
         * A translating transition needs something on the other side. Paragraph boundaries
         * often sit in a gap with no lyric at all, and the next scene used to be drawn only
         * once its own paragraph started - so the outgoing one slid away into the bare shell.
         * Pre-rolling the incoming scene through the same window gives the move a far side.
         *
         * `block-wipe` is excluded: its block already covers the swap, and its enter phase is
         * the *uncover*, which has to happen after the boundary, not before it.
         */
        const preRoll = transitionsEnabled
            && outgoingTransition !== null
            && outgoingTransition.kind !== 'block-wipe'
            && time >= outgoingTransition.startTime;

        this.sceneCache.forEach((scene, index) => {
            const isActive = index === paragraphIndex;
            const isIncoming = preRoll && index === paragraphIndex + 1;

            const hasHeldLyric = index < paragraphIndex && scene.shots.some(view =>
                view.shot.holdUntil !== undefined && resolveTemperaShotExit(view,time) < 1);
            setPixiDisplayTreeVisibility(scene.container, isActive || isIncoming || hasHeldLyric);
            // The arriving scene has to sit above the one it is replacing; cache insertion
            // order says nothing about paragraph order.
            scene.container.zIndex = this.options.lyricsOnly && isActive
                ? this.options.program.paragraphs.length : index;
            if (this.options.lyricsOnly) scene.container.sortableChildren = true;
            if (!scene.container.visible) {
                // The scene-level unload already released every descendant. Reset shot
                // visibility so a later seek only rehydrates the shots it actually shows.
                scene.shots.forEach(shot => {
                    shot.container.visible = false;
                });
                scene.activeShotIndex = -1;
                return;
            }

            const paragraphTransitionFrame = resolveTemperaSceneTransitionFrame(
                this.options.program,
                scene,
                index,
                time,
                isIncoming,
                outgoingTransition,
                transitionsEnabled,
            );
            const activeShotIndex = findTemperaActiveShotIndex(scene, time);
            if (this.options.glyphsOnly && activeShotIndex >= 0) {
                // The invert state is held across lines; only advance it on the active shot.
                this.updateInvertState(scene.shots[activeShotIndex] ?? null, time);
            }

            // Shot boundaries need no scene-level transition any more: the compositions hand
            // off to each other directly, which is what makes a paragraph read as one take.
            const rotationCamera = scene.shots[activeShotIndex]?.shot.cameraMotion === 'rotation';
            // The shot owns rotation/zoom; a paragraph push or counter-turn must not mask it.
            const transitionFrame = rotationCamera
                ? { ...paragraphTransitionFrame, x: 0, y: 0, scale: 1, rotation: 0 }
                : paragraphTransitionFrame;
            scene.shots.forEach((shot, shotIndex) => {
                // The outgoing shot stays on screen through its hand-off window, so two
                // compositions overlap exactly while one is pushing the other out.
                const isShotActive = !hasHeldLyric && shotIndex === activeShotIndex;
                const isHandingOff = (hasHeldLyric ? shot.shot.holdUntil !== undefined : shotIndex < activeShotIndex)
                    && resolveTemperaShotExit(shot, time) < 1;
                setPixiDisplayTreeVisibility(shot.container, isShotActive || isHandingOff);
                if (!shot.container.visible) return;
                if (this.options.lyricsOnly) {
                    shot.container.zIndex = isShotActive ? scene.shots.length + 1 : shotIndex + 1;
                }
                updateTemperaShot(shot, time, width, height, this.options.tuning, this.options.theme, {
                    x: this.followX,
                    y: this.followY,
                }, this.options.lyricsOnly === true, this.options.glyphsOnly);
            });
            scene.activeShotIndex = activeShotIndex;

            const isFinalScene = index === this.options.program.paragraphs.length - 1;
            const lyricAlpha = isFinalScene && hasCredits ? creditsFrame.lyricAlpha : 1;
            scene.container.alpha = transitionFrame.alpha * lyricAlpha;
            scene.container.pivot.set(width / 2, height / 2);
            scene.container.position.set(
                width / 2 + transitionFrame.x * width,
                height / 2 + transitionFrame.y * height,
            );
            scene.container.scale.set(transitionFrame.scale);
            scene.container.rotation = transitionFrame.rotation;
            // Attached only while it blurs: a parked filter on this container would take
            // over the lyric inversion's backdrop copy (`temperaSceneFilters.ts`).
            setTemperaTransitionBlur(scene, transitionFrame.blur);
            if (transitionFrame.wipe > 0.001 && transitionFrame.wipe < 1.999) {
                this.overlay.drawWipe(
                    transitionFrame.wipe,
                    transitionFrame.wipeAngle,
                    width,
                    height,
                    scene.palette.tone3,
                );
                wipeDrawn = true;
            }
        });
        if (frameStartedAt) perfMark('rt.frame.shots', frameStartedAt);
        if (perfOn()) {
            // 临时诊断：重合模式下每一段的可见性/退场进度。perf 关闭时不产生任何开销。
            const out: Array<Record<string, unknown>> = [];
            this.sceneCache.forEach((scene, index) => {
                const first = scene.shots[0];
                out.push({
                    i: index,
                    act: index === paragraphIndex,
                    vis: scene.container.visible,
                    alpha: Number(scene.container.alpha.toFixed(3)),
                    z: scene.container.zIndex,
                    shots: scene.shots.length,
                    hold: first?.shot.holdUntil === undefined ? -1 : Number(first.shot.holdUntil.toFixed(2)),
                    exit: first ? Number(resolveTemperaShotExit(first, time).toFixed(3)) : -1,
                    shotVis: scene.shots.filter(shot => shot.container.visible).length,
                    // 首镜头首字的落点（诊断「散开是否匀速/有没有跳变」用）。
                    g: scene.shots[0]?.glyphs?.[0]
                        ? [Number(scene.shots[0].glyphs[0].display.x.toFixed(1)), Number(scene.shots[0].glyphs[0].display.y.toFixed(1))]
                        : null,
                    // 散开量：首镜头各字相对首字的位置离散度（只做诊断）。
                    disp: (() => {
                        const glyphs = scene.shots[0]?.glyphs ?? [];
                        if (glyphs.length < 2) return -1;
                        const x0 = glyphs[0].display.x;
                        const y0 = glyphs[0].display.y;
                        let sum = 0;
                        for (const glyph of glyphs) sum += Math.hypot(glyph.display.x - x0, glyph.display.y - y0);
                        return Math.round(sum / glyphs.length);
                    })(),
                });
            });
            (window as unknown as { __overlapScenes?: unknown }).__overlapScenes = { t: Number(time.toFixed(2)), p: paragraphIndex, out };
        }

        const glyphFollow = this.options.cameraFollow === true;
        if (this.options.lyricsOnly && (!this.options.glyphsOnly || glyphFollow)) {
            type ShotView = TemperaSceneView['shots'][number];
            // The line the camera should be looking at: the newest one that has type. Walk back
            // through retained scenes because an instrumental gap is usually its own
            // bridge-only paragraph, so "one paragraph back" can hold nothing but a bridge.
            let current: ShotView | null = null;
            let currentSceneIndex = -1;
            let currentShotIndex = -1;
            for (let index = paragraphIndex; index >= 0 && !current; index -= 1) {
                const scene = this.sceneCache.get(index);
                if (!scene) continue;
                const last = index === paragraphIndex
                    ? Math.min(scene.activeShotIndex, scene.shots.length - 1)
                    : scene.shots.length - 1;
                for (let shotIndex = last; shotIndex >= 0; shotIndex -= 1) {
                    const shot = scene.shots[shotIndex];
                    if (shot.glyphs.length) {
                        current = shot;
                        currentSceneIndex = index;
                        currentShotIndex = shotIndex;
                        break;
                    }
                }
            }
            // Each shot updates its own plate drift before this block runs, so the anchor sees
            // the type where it is this frame - not at its static layout position.
            const sourceOf = (shot: ShotView) => {
                const glyphs = shot.glyphs;
                const roll = glyphs.length ? (glyphs[0].motion.lineRotation ?? 0) : 0;
                const rollStart = glyphs.length
                    ? Math.min(...glyphs.map(glyph => glyph.motion.startTime))
                    : shot.shot.startTime;
                const rollEnd = glyphs.length
                    ? Math.max(...glyphs.map(glyph => glyph.motion.settleTime))
                    : rollStart + 1;
                return {
                    glyphs,
                    offsetX: shot.frameX,
                    offsetY: shot.frameY,
                    scale: shot.frameScale,
                    orientation: shot.orientation,
                    roll,
                    rollStart,
                    rollEnd,
                };
            };
            const currentSource = current ? sourceOf(current) : null;
            // 下一句的镜头目标：同一场景里的下一个 shot；没有就取下一段的第一个 shot。
            // 只在下一句真正出现前的一段窗口里叠进来，上一段不用先停住。
            let nextSource: ReturnType<typeof sourceOf> | null = null;
            if (current && currentSceneIndex >= 0) {
                // 只在下一条歌词行切换时错帧；拆分短句的同一行内不提前抢镜。
                const currentLineIndex = current.shot.slices[0]?.lineIndex;
                const nextLine = (candidate: ShotView) => {
                    if (!candidate.glyphs.length) return true;
                    return currentLineIndex !== undefined
                        && candidate.shot.slices[0]?.lineIndex === currentLineIndex;
                };
                const scene = this.sceneCache.get(currentSceneIndex);
                if (scene) {
                    for (let index = currentShotIndex + 1; index < scene.shots.length; index += 1) {
                        const candidate = scene.shots[index];
                        if (nextLine(candidate)) continue;
                        nextSource = sourceOf(candidate);
                        break;
                    }
                }
                if (!nextSource) {
                    const nextScene = this.sceneCache.get(currentSceneIndex + 1);
                    if (nextScene) {
                        for (const candidate of nextScene.shots) {
                            if (nextLine(candidate)) continue;
                            nextSource = sourceOf(candidate);
                            break;
                        }
                    }
                }
            }
            // A line change can knock the camera: an elastic bump rather than a stop. The angle is
            // deterministic per line, so the same song bumps at the same places on a replay.
            const seek = Math.abs(time - this.followTime) > 1.2;
            if (seek) {
                this.impacts.length = 0;
                this.impactPlan = null;
            }
            // The bump can land anywhere inside the line: plan it, then fire on the frame it is due.
            const spawnImpact = (hash: number, at: number, now: ReturnType<typeof overlapFx> | ReturnType<typeof wenflashImpact>) => {
                const elastic = Math.max(0.2, now.shakeElastic);
                const damping = Math.max(0.15, now.shakeDamping);
                this.impacts.push({
                    start: at,
                    angle: (((hash >>> 8) % 360) * Math.PI) / 180,
                    px: now.shakePx,
                    shareX: now.shakeX,
                    shareY: now.shakeY,
                    depth: now.shakeDepth / 100,
                    z: now.shakeZ,
                    rollDeg: now.shakeRollDeg,
                    decay: (0.14 * elastic) / damping,
                    omega: now.shakeSwing < 0.02 ? 0 : (46 / Math.sqrt(elastic)) * now.shakeSwing,
                    attack: Math.max(0.005, now.shakeAttack),
                });
                if (this.impacts.length > 6) this.impacts.shift();
            };
            const wenflashStage = this.options.glyphsOnly === true;
            const impactNow = wenflashStage ? wenflashImpact() : overlapFx();
            const impactKey = wenflashStage
                ? `line:${current?.shot.slices[0]?.lineIndex ?? current?.shot.id ?? ''}`
                : current?.shot.id ?? '';
            if (current && impactKey !== this.impactLine) {
                this.impactLine = impactKey;
                const hash = hashTemperaSeed(impactKey);
                if (((hash >>> 0) % 100000) / 100000 < impactNow.shakeChance) {
                    const span = Math.max(0.2, current.shot.endTime - current.shot.startTime);
                    const share = Math.min(1, Math.max(0, impactNow.shakeAt / 100));
                    this.impactPlan = {
                        shotId: impactKey,
                        at: current.shot.startTime + span * share,
                        fired: false,
                    };
                } else {
                    this.impactPlan = null;
                }
            }
            if (this.impactPlan && !this.impactPlan.fired && time >= this.impactPlan.at) {
                this.impactPlan.fired = true;
                const impactHash = hashTemperaSeed(this.impactPlan.shotId);
                spawnImpact(impactHash, this.impactPlan.at, impactNow);
                if (this.debris && current) {
                    const angle = (((impactHash >>> 8) % 360) * Math.PI) / 180;
                    this.debris.splash(
                        width / 2 + Math.cos(angle) * width * 0.12,
                        height / 2 + Math.sin(angle) * height * 0.12,
                        angle,
                        overlapFx().shakePx / 60,
                    );
                }
            }
            let impactKickX = 0;
            let impactKickY = 0;
            let impactRoll = 0;
            let impactZoom = 1;
            let impactDolly = 1;
            for (const impact of this.impacts) {
                const t = time - impact.start;
                const life = impact.attack + impact.decay * 6.5;
                if (t < 0 || t > life + 0.3) continue;
                // Head ramp then exponential tail: the same curve per bump, summed together.
                // Smoothstep on the way in: the bump eases off the mark instead of jerking up.
                const rise = Math.min(1, t / impact.attack);
                const env = rise * rise * (3 - 2 * rise)
                    * Math.exp(-Math.max(0, t - impact.attack) / impact.decay);
                // swing 0 means "no ring": one push that fades, instead of an oscillation.
                const osc = impact.omega > 0 ? Math.sin(t * impact.omega) : 1;
                const oscY = impact.omega > 0 ? Math.sin(t * impact.omega + 0.55) : 1;
                const oscRoll = impact.omega > 0 ? Math.sin(t * impact.omega * 0.74 + 2.1) : 1;
                const oscDepth = impact.omega > 0 ? Math.sin(t * impact.omega * 0.65 + 1.4) : 1;
                const oscZ = impact.omega > 0 ? Math.sin(t * impact.omega * 0.85 + 0.9) : 1;
                impactKickX += impact.px * env * impact.shareX * Math.cos(impact.angle) * osc;
                impactKickY += impact.px * env * impact.shareY * Math.sin(impact.angle) * oscY;
                impactRoll += (impact.rollDeg * Math.PI / 180) * (Math.cos(impact.angle) >= 0 ? 1 : -1)
                    * env * oscRoll;
                impactZoom *= 1 - impact.depth * Math.max(0, Math.exp(-t / (impact.decay * 0.5)))
                    + impact.depth * 0.6 * env * oscDepth;
                impactDolly *= 1 + (impact.z / 2400) * env * oscZ;
            }
            this.impacts = this.impacts.filter(
                (impact) => time - impact.start < impact.attack + impact.decay * 6.5 + 0.4,
            );
            // A seek or a track cut is not a glide: land directly on the new anchor.
            // Bridging and tiling can open a shot well before its first character is sung, so the
            // breathing zoom is timed from the first glyph's onset rather than the shot clock.
            const visualStart = current
                ? resolveFollowStart(currentSource ?? {glyphs: current.glyphs}, current.shot.startTime)
                : 0;
            const follow = currentSource
                ? resolveLyricFollow(
                    currentSource, time, visualStart, width, height,
                    glyphFollow ? {gain: 1, clamp: false, zoom: resolveLyricCoverageZoom(currentSource, time, width, height)} : undefined,
                )
                : {x: this.followX, y: this.followY, zoom: this.followZoom};
            // 错帧：下一句的目标在它起唱前 overlap 秒内逐步叠进来。两条运动不是首尾相接，
            // 而是在第一段还没走完时就叠加；blend 到 1 时下一句已经完全接管。
            const nextStart = nextSource ? resolveFollowStart(nextSource, 0) : 0;
            const nextFollow = nextSource
                ? resolveLyricFollow(
                    nextSource, time, nextStart, width, height,
                    glyphFollow ? {gain: 1, clamp: false, zoom: resolveLyricCoverageZoom(nextSource, time, width, height)} : undefined,
                )
                : null;
            // 错帧参数各用各的：文闪读文闪设置，重合读重合自己的「镜头错帧」。
            // 图形档没有跟随镜头（上面整段不会进），所以这里不额外判断 glyphFollow。
            const nextBlend = nextFollow
                ? wenflashCameraBlend(time, nextStart, glyphFollow ? undefined : overlapFx().cameraOverlap)
                : 0;
            // 重合只有一个「镜头错帧」滑杆，位置和缩放共用它；文闪仍按合并/分开两条走。
            const nextZoomBlend = nextFollow
                ? glyphFollow
                    ? wenflashCameraZoomBlend(time, nextStart)
                    : wenflashCameraBlend(time, nextStart, overlapFx().cameraOverlap)
                : 0;
            const targetX = nextFollow ? follow.x + (nextFollow.x - follow.x) * nextBlend : follow.x;
            const targetY = nextFollow ? follow.y + (nextFollow.y - follow.y) * nextBlend : follow.y;
            const targetZoom = nextFollow ? follow.zoom + (nextFollow.zoom - follow.zoom) * nextZoomBlend : follow.zoom;
            // The line is written at an angle to the stage; the camera rolls it back upright. With
            // no line in reach the stage holds the angle it already has. 文闪 counter-rolls the
            // whole sentence's shared entrance angle by the same motion scale the type uses; it
            // does not chase each glyph's own tilt, so the horizon does not wobble per character.
            const glyphMotion = this.options.tuning.glyphMotion * resolveAnimationScale(this.options.theme);
            const targetRoll = glyphFollow
                ? currentSource ? -resolveFollowRoll(currentSource, time) * glyphMotion * wenflashCameraRotation() : 0
                : currentSource ? -(currentSource.orientation ?? 0) : this.followRotation;
            const dt = Math.max(0, Math.min(0.1, time - this.followTime));
            // 镜头抽帧：按固定帧率采样镜头姿态，采样之间保持上一帧的位置，
            // 让跟随变成可调的定格感。0/1 帧为连续，不改变原弹簧。
            const cameraSteps = glyphFollow ? wenflashCameraSteps() : 0;
            const cameraInterval = cameraSteps > 1 ? 1 / cameraSteps : 0;
            const cameraDue = cameraSteps <= 1 || seek
                || time - this.cameraSampleTime >= cameraInterval - 1e-4;
            const cameraDt = cameraSteps > 1
                ? Math.max(0, Math.min(0.5, time - this.cameraSampleTime))
                : dt;
            if (seek) {
                this.followX = targetX;
                this.followY = targetY;
                this.followZoom = targetZoom;
                this.followRotation = targetRoll;
                this.followVX = 0;
                this.followVY = 0;
                this.followVZoom = 0;
                this.followVRoll = 0;
                this.cameraSampleTime = time;
            } else if (dt > 0 && cameraDue) {
                // Spring, not blend: the camera keeps its momentum through a line change, so the
                // move onto the next line starts at whatever speed the last one was still
                // travelling and settles out without a hard stop at the end of the ease.
                const fx = overlapFx();
                // 文闪的镜头速度曲线：横轴是本句演唱进度，纵轴是相对速度。曲线越陡，
                // 这一段镜头追得越快；弹簧的 soft 时间相应缩短，曲线平缓时则放慢。
                // 缩放共用同一条曲线，但用更宽的映射，让收放对曲线陡缓更敏感。
                const followGlyphs = currentSource?.glyphs ?? [];
                let lyricFirst = visualStart;
                let lyricLast = visualStart;
                for (const glyph of followGlyphs) {
                    const start = glyph.motion.startTime;
                    if (start < lyricFirst) lyricFirst = start;
                    if (start > lyricLast) lyricLast = start;
                }
                const lyricProgress = lyricLast > lyricFirst
                    ? Math.max(0, Math.min(1, (time - lyricFirst) / (lyricLast - lyricFirst)))
                    : 1;
                const cameraSpeed = glyphFollow ? wenflashCameraSpeed(lyricProgress) : overlapCameraSpeed(lyricProgress);
                const zoomSpeed = glyphFollow ? wenflashCameraZoomSpeed(lyricProgress) : overlapCameraZoomSpeed(lyricProgress);
                const panSoft = fx.panSoft / cameraSpeed;
                const zoomSoft = fx.zoomSoft / zoomSpeed;
                const x = smoothDamp(this.followX, targetX, this.followVX, panSoft, cameraDt);
                this.followX = x.value;
                this.followVX = x.velocity;
                const y = smoothDamp(this.followY, targetY, this.followVY, panSoft, cameraDt);
                this.followY = y.value;
                this.followVY = y.velocity;
                // The focal length gets its own, quicker spring: the breath is continuous, but a
                // line change steps it by a few percent, which would pop as a scale jump.
                const zoom = smoothDamp(
                    this.followZoom, targetZoom, this.followVZoom, zoomSoft, cameraDt,
                );
                this.followZoom = zoom.value;
                this.followVZoom = zoom.velocity;
                // A turn is a bigger gesture than a pan, so it gets a longer spring - and the
                // spring is scaled to how far the stage still has to go: a 30° nudge settles
                // quickly, a full circle takes its time instead of whipping round. The floor
                // keeps the tail of the settle from stiffening shut.
                const rollTravel = Math.abs(targetRoll - this.followRotation);
                const rollSoft = Math.min(3.2, Math.max(0.35, fx.rollSoft + rollTravel * 0.18));
                const roll = smoothDamp(
                    this.followRotation, targetRoll, this.followVRoll, rollSoft, cameraDt,
                );
                this.followRotation = roll.value;
                this.followVRoll = roll.velocity;
                this.cameraSampleTime = time;
            }
            this.followTime = time;
            const line = current && currentSource
                ? resolveOverlapLine(current, width, height)
                : null;
            if (this.decor || this.hud) {
                const page = this.sceneCache.get(paragraphIndex)?.palette;
                if (this.decor) {
                    this.decor.container.visible = overlapFx().showTrail || overlapFx().showArc;
                    if (page) this.decor.setPalette(page.ink, page.accent);
                    this.decor.update({time, line}, dt);
                }
                if (this.hud) {
                    this.hud.container.visible = overlapFx().showHud;
                    if (page) this.hud.setAccent(page.accent);
                    // The glyph under the playhead decides whether the cursors take a keyword's
                    // colour; a plain glyph hands them back to the stage accent.
                    const sung = current
                        ? current.glyphs.find(glyph => time >= glyph.motion.startTime && time <= glyph.motion.endTime) ?? null
                        : null;
                    this.hud.update({time, line, keyword: sung?.keyword ?? null, panSpeed: Math.hypot(this.followVX, this.followVY), panVX: this.followVX}, dt);
                }
            }
            // The follow zoom is applied around the viewport centre, which also makes the
            // current line itself read larger, not just closer to the middle. The pan has to be
            // multiplied by that zoom: the pivot keeps the centre fixed, so translating by the
            // raw anchor shift would leave (zoom - 1) of the offset uncorrected - at 1.2x a
            // line 300px off centre still sat 60px off after the follow, which is exactly the
            // "it never quite reaches the middle" the layout kept showing.
            // The pan is then carried through the camera roll, because the roll happens about
            // the same centre: the shift was measured in unrolled stage space.
            const fx = overlapFx();
            const speed = Math.hypot(this.followVX, this.followVY);
            // Handheld only while the camera is at rest: a travelling camera already moves, so
            // adding noise there would read as jitter rather than breath.
            const still = 1 - Math.min(1, speed / 260);
            // 文闪只做干净的跟随平移：不吃重合的手持与落定回弹；撞击改用自己的参数。
            const shake = glyphFollow ? 0 : fx.handheld * still;
            const handheldX = Math.sin(time * 0.83) * 1.6 * shake;
            const handheldY = Math.sin(time * 1.07 + 1.7) * 1.2 * shake;
            const handheldRoll = Math.sin(time * 0.71 + 0.6) * 0.0075 * shake;
            // Settle: the spring is critically damped, so a short overshoot is added on arrival
            // to give the stop a little weight. Zoom only - never the position.
            const sinceStart = Math.max(0, time - visualStart);
            const settleWave = sinceStart < 1.4 ? Math.exp(-sinceStart * 3.2) * Math.sin(sinceStart * 12.5) : 0;
            const dollyZoom = glyphFollow
                ? this.followZoom
                : this.followZoom * (1 + 0.04 * fx.settle * settleWave);
            const zoomed = dollyZoom;
            const roll = this.followRotation + handheldRoll;
            const shakeRoll = roll + impactRoll;
            const rollCos = Math.cos(shakeRoll);
            const rollSin = Math.sin(shakeRoll);
            const panX = this.followX * zoomed + impactKickX;
            const panY = this.followY * zoomed + impactKickY;
            this.sceneContainer.pivot.set(width / 2, height / 2);
            this.sceneContainer.rotation = shakeRoll;
            this.sceneContainer.position.set(
                width / 2 + panX * rollCos - panY * rollSin + handheldX,
                height / 2 + panX * rollSin + panY * rollCos + handheldY,
            );
            // Each bump also squeezes the lens and pushes along Z; rings add up instead of resetting.
            this.sceneContainer.scale.set(zoomed * impactZoom * impactDolly);
            if (this.debris && line) {
                // Shards come off where the old line actually sat, before this frame moves the
                // stage onto the new one.
                if (current && current.shot.id !== this.debrisLine) {
                    if (this.debrisLine) {
                        this.debris.shards(
                            this.debrisPoint.x, this.debrisPoint.y,
                            current.glyphs[0]?.fill ?? '#ffffff',
                        );
                    }
                    this.debrisLine = current.shot.id;
                }
                // Project the line into screen space with the same camera the type uses, so
                // splashes bloom where the word actually is - not at a stale fixed spot.
                const stageZoom = zoomed * impactZoom * impactDolly;
                const qx = (line.x - width / 2) * stageZoom + panX;
                const qy = (line.y - height / 2) * stageZoom + panY;
                this.debrisPoint = {
                    x: width / 2 + qx * rollCos - qy * rollSin,
                    y: height / 2 + qx * rollSin + qy * rollCos,
                };
                const panSpeed = Math.hypot(this.followX - this.lastFollow.x, this.followY - this.lastFollow.y)
                    / Math.max(0.001, dt);
                this.lastFollow = {x: this.followX, y: this.followY};
                const pageInk = this.sceneCache.get(paragraphIndex)?.palette;
                if (pageInk) this.debris.setPalette(pageInk.ink, pageInk.accent);
                this.debris.update({time, dt, speed: Math.min(3000, panSpeed), panX, panY}, dt);
            }
            // Ambient line art doesn't wait for a lyric: it keeps running in the gaps, but it
            // is anchored to the current line so the doodles orbit the words as the camera moves.
            if (this.ambient) {
                const anchor = line ? {x: line.x, y: line.y} : null;
                // The doodles borrow the cover's own gradient (paper ink -> accent) rather than
                // only the letters, so they stay in the same colour family as the type even when
                // the line is plain ink.
                const pageTone = this.sceneCache.get(paragraphIndex)?.palette;
                const colors = pageTone
                    ? [pageTone.ink, pageTone.accent, pageTone.tone4 ?? pageTone.accent]
                    : line
                        ? [line.startColor, line.endColor, line.keywordColor]
                            .filter((value): value is string => typeof value === 'string' && value.length > 0)
                        : [];
                const halfW = line ? Math.max(80, Math.abs(line.endX - line.startX) / 2 + 24) : 140;
                const toScreen = (x: number, y: number) => ({
                    x: width / 2 + dollyZoom
                        * ((x - width / 2 + panX) * rollCos - (y - height / 2 + panY) * rollSin),
                    y: height / 2 + dollyZoom
                        * ((x - width / 2 + panX) * rollSin + (y - height / 2 + panY) * rollCos),
                });
                const a = line ? toScreen(line.x - halfW, line.y - 58) : null;
                const b = line ? toScreen(line.x + halfW, line.y + 58) : null;
                this.ambient.update(
                    {
                        time, dt, follow: anchor,
                        panX, panY, zoom: zoomed * impactZoom * impactDolly, roll: shakeRoll,
                        halfWidth: halfW,
                        halfHeight: 46,
                        colors, width, height,
                        avoid: a && b ? {
                            x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
                            width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y),
                        } : null,
                    },
                    dt,
                );
            }
            const focusX = width / 2 + panX * rollCos - panY * rollSin;
            const focusY = height / 2 + panX * rollSin + panY * rollCos;
            if (this.grid) {
                const page = this.sceneCache.get(paragraphIndex)?.palette;
                if (page) this.grid.setInk(page.ink);
                this.grid.update({
                    time, focusX, focusY, zoom: this.followZoom, roll: this.followRotation,
                }, dt);
            }
            if (this.sheet) {
                const page = this.sceneCache.get(paragraphIndex)?.palette;
                if (page) this.sheet.setInk(page.ink);
                if (current && currentSource && line) {
                    if (current.shot.id !== this.sheetLine) {
                        this.sheetLine = current.shot.id;
                        const chars = current.glyphs.map(glyph => glyph.display.text).join('');
                        const qx = line.x - width / 2 + panX;
                        const qy = line.y - height / 2 + panY;
                        this.sheet.setLine(
                            chars,
                            width / 2 + this.followZoom * (qx * rollCos - qy * rollSin),
                            height / 2 + this.followZoom * (qx * rollSin + qy * rollCos),
                            time,
                            current.shot.id,
                        );
                    }
                    if (paragraphIndex !== this.sheetParagraph) {
                        this.sheetParagraph = paragraphIndex;
                        this.sheet.addCrease(time, String(paragraphIndex));
                    }
                }
                this.sheet.update({
                    time, focusX, focusY, zoom: this.followZoom, roll: this.followRotation,
                }, dt);
            }
            if (this.wave) {
                const page = this.sceneCache.get(paragraphIndex)?.palette;
                if (page) this.wave.setAccent(page.accent);
                const landings = current
                    ? current.glyphs.filter(glyph => {
                        const age = time - glyph.motion.startTime;
                        return age >= 0 && age < 1;
                    }).length
                    : 0;
                this.wave.update({time, energy: Math.min(1, landings / 6)}, dt);
            }
        }
        if (!wipeDrawn) this.overlay.drawWipe(0, 0, width, height, '#000000');
        this.creditsLayer.applyFrame(creditsFrame, hasCredits, time, finalParagraph?.endTime, width, height);
        this.updateLetterbox(height);
        if (frameStartedAt) perfMark('rt.frame.total', frameStartedAt);
    };

    private updateLetterbox(height: number) {
        if (!this.letterbox) return;
        const limit = Math.min(.30, Math.max(0, wenflashLetterboxPercent()));
        const zoom = Math.max(.01, this.sceneContainer.scale.x);
        this.letterbox.params.uViewHeight = height;
        this.letterbox.params.uThickness = height*limit/(1+Math.pow(zoom, 4));
        this.letterbox.filter.enabled = limit > 0;
    }

    /** 文闪切到 graphic 档时关掉镜头跟随，切回横/竖排时再打开；不重建运行时。 */
    setCameraFollow(enabled: boolean) {
        this.options.cameraFollow = enabled;
        if (enabled) return;
        // graphic 档走固定镜头：把共享跟随块留下的舞台位移/缩放/旋转归零，否则画面会停在
        // 上一次跟随的位置。跟随状态也一并复位，切回链式时从画面中心重新起步。
        this.followX = 0;
        this.followY = 0;
        this.followZoom = 1;
        this.followRotation = 0;
        this.followVX = 0;
        this.followVY = 0;
        this.cameraSampleTime = 0;
        this.sceneContainer.pivot.set(0, 0);
        this.sceneContainer.position.set(0, 0);
        this.sceneContainer.scale.set(1);
        this.sceneContainer.rotation = 0;
    }

    renderOnce() {
        if (this.destroyed || !this.app.canvas.isConnected) return;
        this.renderFrame();
        if (this.destroyed) return;
        this.app.renderer.render(this.app.stage);
    }

    /**
     * Hands the renderer a new track without rebuilding it. The argument is exactly the one that
     * `setTuning` makes for tuning changes: a rebuild re-initialises WebGL, re-decodes every
     * placed image and re-measures every line, and it does it with the canvas out of the DOM, so
     * the frame goes empty for the whole async build. Here only the scene layer changes, under
     * the block wipe that already exists for paragraph cuts.
     *
     * Resolves when the block has swept back off.
     */
    swapSong(next: TemperaSongContext, signal?: AbortSignal): Promise<void> {
        if (this.destroyed) return Promise.resolve();
        // Straight through when there is nothing to protect - no scene sized yet, an outgoing
        // program with no paragraphs, a swap already running, an abort, or a paused renderer
        // whose ticker is stopped and would never reach the second frame. A hitch none of these
        // can show is not worth a frame of latency. And a swap that is not a track change never
        // gets one either - see TemperaSongContext.seed.
        if (
            next.seed === this.options.songSeed
            || this.songSwap.active
            || this.lastWidth === 0
            || this.options.program.paragraphs.length === 0
            || this.options.paused
            || signal?.aborted
        ) {
            this.commitSongContext(next);
            if (this.options.paused) this.renderOnce();
            return Promise.resolve();
        }

        return this.songSwap.begin(next, signal);
    }

    /** The cut itself. Mirrors `setTuning`'s rebuild branch, minus the synchronous teardown. */
    private commitSongContext(
        next: TemperaSongContext,
        staged?: TemperaStagedSong | null,
    ) {
        perfEvent('rt.commitSong');
        this.options.songSeed = next.seed;
        this.options.program = next.program;
        this.options.theme = next.theme;
        this.options.coverColors = next.coverColors;
        // Neither of these walks a staged scene: it is deliberately not in the cache yet, so it
        // survives the removal of the song it is replacing.
        if (staged) this.retireScenes();
        else {const clearAt=perfOn()?performance.now():0;this.clearScenes();if(clearAt)perfMark('rt.clearScenes',clearAt);}
        if (staged) {
            staged.scene.container.visible = true;
            this.sceneContainer.addChild(staged.scene.container);
            this.sceneCache.adopt(staged.index, staged.scene);
            // Adopted as the active paragraph so the frame that cuts builds nothing at all.
            this.activeParagraphIndex = staged.index;
        }
        // Before the first resize pass there is nothing sized to redraw; the install pass
        // will draw both against real dimensions.
        if (this.lastWidth > 0 && this.lastHeight > 0) {
            const overlayAt=perfOn()?performance.now():0;
            this.drawOverlay(this.lastWidth, this.lastHeight);
            if(overlayAt)perfMark('rt.drawOverlay',overlayAt);
            if (staged) this.creditsLayer.adopt(staged.credits, this.lastWidth, this.lastHeight);
            else {const creditsAt=perfOn()?performance.now():0;this.drawCredits(this.lastWidth, this.lastHeight);if(creditsAt)perfMark('rt.drawCredits',creditsAt);}
        }
    }

    /** Frees a staged scene and poster that will never be adopted. */
    private discardStaged(staged: { scene: TemperaSceneView; credits: TemperaCreditsView | null }) {
        this.destroyScene(staged.scene);
        if (staged.credits) this.creditsLayer.destroyView(staged.credits);
    }

    /**
     * Builds the incoming scene and poster off screen. This is the expensive half of a track
     * change - the layout fit loop over every grapheme, a `pixi.Text` per glyph, and the poster's
     * own filters and discs - and it is spent here so the frame that cuts does none of it.
     */
    private stageSong(song: TemperaSongContext): TemperaStagedSong | null {
        const index = findTemperaParagraphIndexAtTime(song.program, this.options.currentTime.get());
        if (index < 0 || index >= song.program.paragraphs.length) return null;
        const scene = this.buildScene(song, index);
        scene.container.visible = false;
        this.sceneContainer.addChild(scene.container);
        const credits = this.buildCreditsView(song, scene.palette, this.lastWidth, this.lastHeight);
        return { scene, index, credits };
    }

    /**
     * Applies a tuning change in place. Rebuilding the renderer for one is ruinous: sliders
     * fire continuously while dragged, and a rebuild re-initialises WebGL, re-decodes every
     * placed image and re-measures every line. Only settings that change what a scene *is*
     * drop the cached scenes; the rest are read live or re-applied to the sprites.
     */
    setTuning(tuning: TemperaTuning) {
        if (this.destroyed) return;
        const previous = this.options.tuning;
        if (previous === tuning) return;
        this.options.tuning = tuning;
        // The print pass hangs on the still parent, not on the scenes, so the scene rebuild
        // below never touches it - it has to be rebuilt from the new tuning here or the
        // 印刷与画质 sliders would move nothing on the live stage.
        this.rebuildPrintPass(previous, tuning);
        // Compared on the snapped value, not the setting: two nearby slider positions can share
        // one pool bucket, and re-pointing the surface at the resolution it already has would
        // reallocate it for nothing. `requiresSceneRebuild` still watches the raw setting, so a
        // move inside one bucket costs a scene rebuild but not a surface one.
        const resolution = this.resolveRenderResolution(tuning);
        if (resolution !== this.renderResolution) {
            this.renderResolution = resolution;
            // Pixi can resize the backing surface without recreating the WebGL application or
            // decoding the shared image pool again. The scene rebuild below refreshes text and
            // fixed-resolution filters against that new surface.
            this.app.renderer.resolution = resolution;
        }
        if (requiresTemperaSceneRebuild(previous, tuning)) {
            // Staged against the old tuning, so it can no longer be adopted.
            this.songSwap.dropStaged();
            this.clearScenes();
            // Before the first resize pass there is nothing sized to redraw; the install pass
            // will draw both against real dimensions.
            if (this.lastWidth > 0 && this.lastHeight > 0) {
                this.drawOverlay(this.lastWidth, this.lastHeight);
                this.drawCredits(this.lastWidth, this.lastHeight);
            }
        } else {
            this.sceneCache.forEach(scene => {
                scene.shots.forEach(shot => shot.images.applyPool(tuning.layerImages));
            });
            // The corner marks live only in the overlay, so toggling them needs no scene rebuild.
            if (previous.showCornerMarks !== tuning.showCornerMarks && this.lastWidth > 0 && this.lastHeight > 0) {
                this.drawOverlay(this.lastWidth, this.lastHeight);
            }
        }
        if (this.options.paused) this.renderOnce();
    }

    /** Rebuilds the screen-space print chain when one of its five inputs moves. */
    private rebuildPrintPass(previous: TemperaTuning, next: TemperaTuning) {
        if (!this.options.lyricsOnly) return;
        const key = (t: TemperaTuning) => [
            t.postProcessEnabled,
            t.postProcessLensDistortion,
            t.postProcessRgbShift,
            t.postProcessGrain,
            t.postProcessContrast,
            t.postProcessVignette,
        ].join('|');
        if (key(previous) === key(next)) return;
        this.printFilters.forEach(filter => filter.destroy());
        this.printFilters = next.postProcessEnabled && !this.options.staticMode
            ? createTemperaOverlapPrintFilters(this.pixi, next, this.printSeed, this.renderResolution)
            : [];
        this.printLayer.filters = this.printFilters.length > 0 ? this.printFilters : null;
        if (this.printFilters.length > 0) {
            const width = this.lastWidth || this.options.host.clientWidth || 1;
            const height = this.lastHeight || this.options.host.clientHeight || 1;
            this.printLayer.filterArea = new this.pixi.Rectangle(0, 0, width, height);
        }
    }

    setPaused(paused: boolean) {
        if (this.destroyed) return;
        this.options.paused = paused;
        if (paused) {
            this.app.stop();
            this.renderOnce();
        } else {
            this.app.start();
        }
    }

    destroy() {
        const destroyAt=perfOn()?performance.now():0;
        const sceneCount=this.sceneCache.size;
        if (this.destroyed) return;
        this.destroyed = true;
        // Release whoever is awaiting the handover before tearing the app down, otherwise that
        // promise never settles and the caller's drain loop stays parked on it.
        this.songSwap.settle(false);
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.app.stop();
        this.app.ticker.remove(this.renderFrame);
        this.printFilters.forEach(filter => filter.destroy());
        this.printFilters = [];
        this.debris?.destroy();
        this.debris = null;
        this.ambient?.destroy();
        this.ambient = null;
        this.cancelPendingScene();
        this.sceneCache.destroyAll();
        this.creditsLayer.dispose();
        this.overlay.release();
        this.imageTextures.destroy();
        if (this.letterboxLayer) this.letterboxLayer.filters = null;
        this.letterbox?.filter.destroy();
        this.app.destroy({ removeView: true }, { children: true, texture: true });
        if(destroyAt)perfMark('rt.destroy',destroyAt,{scenes:sceneCount});
    }
}
