import type { TemperaTuning, Theme } from '../../../types';
import { destroyPixiContainerChildren, destroyPixiDisplayTree } from '../pixi/pixiDisplayResources';
import {
    buildTemperaCreditsPoster,
    hasTemperaCreditsMetadata,
    type TemperaCreditsMetadata,
    type TemperaCreditsView,
    type TemperaSceneView,
} from './temperaSceneBuilder';
import { resolveTemperaPalette } from './temperaPalette';
import { easeTemperaInOut } from './temperaMotion';
import { destroyTemperaGradientFills } from './temperaShapes';

// @note Version Control: Project Folia version 0.6.13-750617

// src/components/visualizer/tempera/temperaCreditsLayer.ts
// 片尾海报层：建海报（可离屏建好留给换歌交接）、装进 credits 容器、按最后一段结束后的时间淡入。
// 不持有歌曲或设置，每次调用都由运行时传入当下的值。
type PixiModule = typeof import('pixi.js');

export interface TemperaCreditsBuildInput {
    theme: Theme;
    coverColors: string[];
    tuning: TemperaTuning;
    metadata: TemperaCreditsMetadata;
    lyricsFontScale: number;
    /** 重合档用简版卡：纸底 + 手写弧 + 方括号，不套拼合的圆盘拼贴。 */
    plain?: boolean;
}

export type TemperaCreditsFrame = ReturnType<typeof resolveTemperaCreditsFrame>;

/**
 * Title-card envelope.
 *
 * Two windows share one poster: the intro (`0 → 第一句唱词`) and the outro (`最后一段唱完`).
 * The intro has to be gone before the first glyph lands, otherwise the song name sits on top
 * of the opening line; the outro keeps the original slow rise.
 */
export const resolveTemperaCreditsFrame = (
    time: number,
    finalEndTime: number,
    firstStartTime = 0,
) => {
    const lyricAlpha = 1 - easeTemperaInOut((time - finalEndTime - 0.1) / 0.9);
    const posterProgress = easeTemperaInOut((time - finalEndTime - 0.9) / 1.1);
    // 开场：0.15 s 起淡入，比第一句早 0.85 s 开始退，正好在第一句开口时收干净。
    const introIn = easeTemperaInOut((time - 0.15) / 0.7);
    const introOut = 1 - easeTemperaInOut((time - (firstStartTime - 0.85)) / 0.7);
    const introAlpha = Math.max(0, Math.min(introIn, introOut));
    const introActive = introAlpha > 0.004 && time < firstStartTime;
    const outroActive = time > finalEndTime + 0.35;
    return {
        active: introActive || outroActive,
        introActive,
        lyricAlpha,
        posterAlpha: introActive ? introAlpha : posterProgress,
        posterOffsetY: introActive ? (1 - introAlpha) * 0.05 : (1 - posterProgress) * 0.06,
        posterScale: introActive ? 0.97 + introAlpha * 0.03 : 0.96 + posterProgress * 0.04,
    };
};

export class TemperaCreditsLayer {
    readonly container: import('pixi.js').Container;
    private view: TemperaCreditsView | null = null;

    constructor(private readonly pixi: PixiModule) {
        this.container = new pixi.Container();
    }

    /** Whether a poster is installed; read once per frame before the scenes are posed. */
    get hasPoster() {
        return this.container.children.length > 0;
    }

    /**
     * Builds the credits poster for a song without installing it, so a handover can prepare the
     * incoming one under the block rather than on the frame the swap lands.
     */
    build(
        input: TemperaCreditsBuildInput,
        scenePalette: TemperaSceneView['palette'] | undefined,
        width: number,
        height: number,
    ): TemperaCreditsView | null {
        if (!hasTemperaCreditsMetadata(input.metadata)) return null;
        // Before any scene exists (metadata-only songs) the poster uses a freshly resolved palette.
        const palette = scenePalette
            ?? resolveTemperaPalette(input.theme, input.tuning, input.coverColors);
        return buildTemperaCreditsPoster(this.pixi, {
            theme: input.theme,
            tuning: input.tuning,
            palette,
            metadata: input.metadata,
            width,
            height,
            lyricsFontScale: input.lyricsFontScale,
            plain: input.plain === true,
        });
    }

    adopt(view: TemperaCreditsView | null, width: number, height: number) {
        this.dispose();
        this.view = view;
        if (!view) return;
        this.container.addChild(view.container);
        // The poster is already built around its own origin, so the pivot stays at zero and
        // the per-frame position alone centres it. Giving it a viewport pivot as well parked
        // the whole card in the top-left corner with half of it off screen.
        this.container.pivot.set(0, 0);
        this.container.position.set(width / 2, height / 2);
        this.container.visible = false;
    }

    dispose() {
        this.view?.container.children.forEach(child => {
            child.filters = null;
        });
        this.view?.filters.forEach(filter => filter.destroy());
        this.view = null;
        destroyTemperaGradientFills(this.pixi, this.container);
        destroyPixiContainerChildren(this.container);
    }

    /** Frees a poster that was never installed in the credits container. */
    destroyView(view: TemperaCreditsView) {
        view.container.children.forEach(child => {
            child.filters = null;
        });
        view.filters.forEach(filter => filter.destroy());
        destroyTemperaGradientFills(this.pixi, view.container);
        destroyPixiDisplayTree(view.container);
    }

    applyFrame(
        frame: TemperaCreditsFrame,
        hasPoster: boolean,
        time: number,
        finalEndTime: number | undefined,
        width: number,
        height: number,
    ) {
        this.container.visible = frame.active && hasPoster;
        this.container.alpha = frame.posterAlpha;
        // The card is never a still frame: shapes keep drifting under the fixed title, so the
        // inversion filter re-cuts it for as long as the outro runs.
        if (this.container.visible) {
            // 开场卡要从「歌刚开口」那一刻开始算入场：拿 time - finalEndTime 会得到一个大负数，
            // 每一条都被判成还没入场，于是 alpha 全是 0，画面看着像根本没画。
            this.view?.updateTime(frame.introActive ? time : time - (finalEndTime ?? time));
        }
        this.container.position.set(
            width / 2,
            height / 2 + frame.posterOffsetY * height,
        );
        this.container.scale.set(frame.posterScale);
    }
}
