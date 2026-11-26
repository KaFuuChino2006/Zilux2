import { applyFlowPalette, type FlowSettings } from '../../../../flowSettings';
import { overlapFx } from '../../../../overlapSettings';
import { perfMark, perfOn } from '../../../../perfProbe';
import type { TemperaTuning, Theme } from '../../../types';
import { resolveThemeFontStack, resolveThemeFontWeight } from '../../../utils/fontStacks';
import { buildWordColorRangesFromMatchers, prepareWordColorMatchers } from '../wordColoring';
import type { TemperaParagraph, TemperaShot } from './types';
import { hashTemperaSeed, temperaHash01 } from './temperaRandom';
import { easeTemperaEnter } from './temperaMotion';
import { resolveTemperaPalette, type TemperaPalette } from './temperaPalette';
import { buildTemperaBlocks, type TemperaBlocksView } from './temperaBlocks';
import { isTemperaLayoutSegment, resolveTemperaLayout } from './temperaLayout';
import type { TemperaGlyphPlacement } from './temperaLayout';
import {
    buildTemperaFragmentViews,
    buildTemperaTextViews,
    buildTemperaWatermark,
    type TemperaGlyphView,
} from './temperaTextView';
import { createTemperaDifferenceFilter } from './temperaDifferenceFilter';
import {
    resolveTemperaPassResolution,
    resolveTemperaTransitionBlurResolution,
    type TemperaSceneFilterTarget,
} from './temperaSceneFilters';
import { buildTemperaImageLayer, type TemperaImageLayerView } from './temperaImageLayer';
import {
    buildCrossRow,
    buildCrossingLines,
    buildDotGrid,
    buildHatchSpec,
    circlePolygon,
    rectPolygon,
} from './temperaHatch';
import {
    drawCrossMarks,
    drawHatchFill,
    drawLines,
    drawPolyline,
    drawPolygonFill,
    drawPolygonOutline,
    drawSquareMarks,
    type TemperaGradientFill,
} from './temperaShapes';
import { createSonnetPostProcessFilters } from '../sonnet/sonnetPostProcess';

// @note Version Control: Project Folia version 0.6.13-750617

// src/components/visualizer/tempera/temperaSceneBuilder.ts
// Builds one bounded paragraph scene; playback-time mutation remains in the runtime controller.
type PixiModule = typeof import('pixi.js');

/**
 * The lyric's colour filter. In gradient mode the ramp only exists as this filter's tint, so
 * switching `textInversion` off must not take the filter with it - that would drop the whole
 * colour mode back to flat ink. Without a ramp and without the inversion there is nothing left
 * to do, and the layer stays unfiltered.
 */
const createTemperaTextFilter = (
    pixi: PixiModule,
    palette: TemperaPalette,
    inversion: boolean,
    tintAnchor?: import('pixi.js').Sprite,
): import('pixi.js').Filter | null => {
    if (!inversion && !palette.textGradient) return null;
    return createTemperaDifferenceFilter(pixi, {
        ink: palette.ink,
        paper: palette.paper,
        tint: palette.textGradient,
        tintAnchor,
        inversion,
    });
};

export interface TemperaBracketView {
    /** Turns and travels with the shot; both ends are its children. */
    group: import('pixi.js').Container;
    /** The closing end, which travels along the line as it is sung (bracket style only). */
    right: import('pixi.js').Graphics | null;
    /** Which mark this line drew: the two ends, or the four corner crosses. */
    style: 'bracket' | 'cross';
    /** Cross style: the two horizontal rules, drawn left to right first. */
    horizontal: import('pixi.js').Graphics | null;
    /** Cross style: the two vertical rules, drawn top to bottom a beat after the horizontals. */
    vertical: import('pixi.js').Graphics | null;
    /** Half the frame's height and the corner overshoot, in writing-space pixels. */
    top: number;
    bottom: number;
    overshoot: number;
    /** Half the sentence's width, padding included, in writing-space pixels. */
    half: number;
    /** Softens the frame as the line dissolves, so it dries out with the type. */
    blur: import('pixi.js').BlurFilter;
    /** Seconds after the first word before this frame starts to open. */
    delay: number;
}

export interface TemperaFieldView {
    /** Short strokes flicked around each character as it lands. */
    graphics: import('pixi.js').Graphics;
}

export interface TemperaMaskView {
    /** A paper plate that hides the type it covers. */
    bar: import('pixi.js').Graphics;
    /** Centre of the covered word, in shot-local pixels. */
    x: number;
    y: number;
    width: number;
    height: number;
    /** Playback time the plate arrives at (a touch before the word is sung). */
    start: number;
    /** Playback time the covered word finishes; the plate leaves from here. */
    end: number;
    /** 0 slide+fade, 1 unfold from one end, 2 bloom, 3 stamp. */
    variant: number;
    /** 0 left, 1 right, 2 top, 3 bottom - the side the plate enters from. */
    direction: number;
    /** Extra distance the slide variant travels, so it starts clear of the word. */
    travel: number;
    /** The line's writing angle; the plate's long edge lies along the baseline. */
    orientation: number;
    /** When the plate was first drawn; the entrance starts here, so a late first frame still plays it. */
    shownAt?: number;
    /** 0 rectangle, 1 capsule, 2 thin rule, 3 slanted band, 4 framed band. */
    shape: number;
    /** Height fraction the band actually paints (the thin rule is a slice of the block). */
    slice: number;
    /** Shear for the slanted band, in x per unit y. */
    slant: number;
    /** Paper tone the covered glyphs are repainted to; only the type reacts, nothing else. */
    paper: string;
    /** The 2-4 glyphs under the plate. */
    covered: TemperaGlyphView[];
}

export interface TemperaUnderlineView {
    /** Turns with the sentence; the rail and its head are its children. */
    group: import('pixi.js').Container;
    /** A left-anchored rule, scaled along x as the words are sung. */
    rail: import('pixi.js').Graphics;
    /** The bright nib that rides the end of the rule. */
    head: import('pixi.js').Graphics;
    /** Half the sentence's width, so the rail starts at the left edge. */
    half: number;
    x: number;
    y: number;
    /** Softens the rule as it lets go, matching the type's exit. */
    blur: import('pixi.js').BlurFilter;
    /** Seconds after the first word before the rule starts to write. */
    delay: number;
}

export interface TemperaShotView {
    shot: TemperaShot;
    container: import('pixi.js').Container;
    glyphs: TemperaGlyphView[];

    blocks: TemperaBlocksView;
    images: TemperaImageLayerView;
    baseX: number;
    baseY: number;
    /** This frame's composition drift (shot camera path + breathing), in viewport pixels.
     * The shared follow camera adds it to the line's anchor; without it the camera aims at
     * where the glyphs were laid out and a line that pans inside its own plate drifts off
     * centre while it is sung. */
    frameX: number;
    frameY: number;
    /** The shot camera's zoom this frame (applied about the viewport centre). */
    frameScale: number;
    /** Quarter turns this line is written at, in radians, unbounded. The follow camera unwinds
     * it so the line is upright while it is sung. */
    orientation: number;
    /** Carries the difference inversion filter; the runtime clears it on destroy. */
    textLayer: import('pixi.js').Container;
    /** Grains of ink flicked off each character as it lands; 重合 only, null elsewhere. */
    specks: import('pixi.js').Graphics | null;
    /** Colour of those grains: the palette's ink, so they read as spray off the type. */
    speckColor: string;
    /** The sentence's own frame, turned with the type; 重合 only, null elsewhere. */
    bracket: TemperaBracketView | null;
    /** A paper plate that sweeps across one word; 重合 only, null elsewhere. */
    mask: TemperaMaskView | null;
    /** The rule under the sentence, written from left to right as it is sung. */
    underline: TemperaUnderlineView | null;
    /** Under the type: a thin frame under each character, like a block of movable type. */
    moulds: import('pixi.js').Graphics | null;
    /** The glyphs picked to sit in a compositor's forme, as indexes into `glyphs`. */
    mouldGlyphs: number[];
    /** The disturbance field: short strokes around each character as it lands; 重合 only. */
    field: TemperaFieldView | null;
    progressArc: import('pixi.js').Graphics | null;
    interGlyph: import('pixi.js').Graphics | null;
    interGlyphStyles: ('ticks' | 'beads' | 'stitch' | 'rings' | 'chevron' | 'diamond')[];
    lyricMarks: import('pixi.js').Container | null;
    progressHalo: import('pixi.js').Graphics | null;
    accentColor: string;
    /** A chop mark stamped at the end of the line; 重合 only, null elsewhere. */
    seal: import('pixi.js').Graphics | null;
    sealX: number;
    sealY: number;
    sealSize: number;
    sealRotation: number;
    sealStart: number;
    sealColor: string;
    revealDoneTime: number;
}

export interface TemperaSceneView extends TemperaSceneFilterTarget {
    paragraph: TemperaParagraph;
    container: import('pixi.js').Container;
    shots: TemperaShotView[];
    palette: TemperaPalette;
    /** Everything the runtime has to destroy with the scene, blur included. */
    postProcessFilters: import('pixi.js').Filter[];
    activeShotIndex: number;
}

export interface TemperaSceneBuildOptions {
    programSeed: string;
    followingLine?: number;
    host: HTMLDivElement;
    theme: Theme;
    tuning: TemperaTuning;
    /**
     * What the canvas is actually running at, i.e. `tuning.textureResolution` after the
     * texture-pool snap. Every fixed-resolution pass on this scene is derived from it, so that
     * a pass never asks the pool for a bigger bucket than the surface it lands on.
     */
    renderResolution: number;
    lyricsFontScale: number;
    staticMode: boolean;
    /** "重合" stage: every lyric line gets its own place on the page, and the camera centres
     * the line being sung. Off for the flow stage, whose compositions own their layout. */
    lyricsOnly?: boolean;
    /** Cover-art colours for the gradient colour mode; empty falls back to the theme hues. */
    coverColors: string[];
    /** Loaded textures for the user's placed images, keyed by placement id. */
    imageTextures: Map<string, import('pixi.js').Texture>;
}

export interface TemperaCreditsMetadata {
    title?: string | null;
    artist?: string | null;
    album?: string | null;
}

export const hasTemperaCreditsMetadata = (metadata: TemperaCreditsMetadata) => Boolean(
    (metadata.title && metadata.title.trim())
    || (metadata.artist && metadata.artist.trim())
    || (metadata.album && metadata.album.trim()),
);

/**
 * Closing card. It is assembled from the same vocabulary as the shot compositions - a flat
 * tone ground, opaque tone masses with hard ink seams, one screentone hatch pass, and the
 * shared crossing lines and corner motif - so the outro reads as one more shot rather than as
 * a separate title screen bolted onto the end of the song.
 *
 * The masses are partial discs whose centres all sit outside the frame: each sweeps in from
 * its own edge and the arcs cross over the middle, so the title straddles two or three tone
 * boundaries at once and the inversion filter flips it mid-word.
 *
 * Everything is drawn around the container's own origin, so the runtime centres it by position
 * alone; giving this container a viewport pivot as well is what once parked the whole poster
 * in the top-left corner with half of it off screen.
 */
export interface TemperaCreditsView {
    container: import('pixi.js').Container;
    filters: import('pixi.js').Filter[];
    /** `elapsed` is seconds since the card started; negative before it appears. */
    updateTime: (elapsed: number) => void;
}

export interface TemperaCreditsOptions {
    theme: Theme;
    tuning: TemperaTuning;
    palette: TemperaPalette;
    metadata: TemperaCreditsMetadata;
    width: number;
    height: number;
    lyricsFontScale: number;
    /**
     * 重合档的曲名卡：只借这层画「歌名」，不复制拼合那套纸块/圆盘/网点拼贴。
     * 版式用重合自己的语言——纸底、手写弧、方括号，标题压在正中。
     */
    plain?: boolean;
}

interface CreditsItem {
    node: import('pixi.js').Container;
    baseX: number;
    baseY: number;
    baseAlpha: number;
    enterDX: number;
    enterDY: number;
    delay: number;
    driftX: number;
    driftY: number;
    grow: number;
}

/** Asymptotic: always moving, never running away. */
const creditsCreep = (elapsed: number) => 1 - Math.exp(-Math.max(0, elapsed) / 7);

/** How many masses press in. Three is enough to cross over the type without muddying it. */
const CREDITS_DISC_COUNT = 3;

export const buildTemperaCreditsPoster = (
    pixi: PixiModule,
    options: TemperaCreditsOptions,
): TemperaCreditsView => {
    const { palette, metadata, width, height } = options;
    if (options.plain) return buildPlainCreditsPoster(pixi, options);
    const { Container, Text, TextStyle } = pixi;
    const container = new Container();
    const filters: import('pixi.js').Filter[] = [];
    const items: CreditsItem[] = [];
    const seed = hashTemperaSeed(`${metadata.title ?? ''}|${metadata.artist ?? ''}`);
    const diagonal = Math.hypot(width, height);
    const bleed = diagonal * 0.25;
    const halfWidth = width / 2;
    const halfHeight = height / 2;
    // One seeded bit mirrors the whole layout, so the card is not always the same picture.
    const flip = temperaHash01(seed, 1, 229) > 0.5 ? 1 : -1;
    // Gradient mode ramps every shot's fills; without this the card would be the one flat
    // frame in the song, which is exactly what reads as a foreign design.
    const gradient: TemperaGradientFill | null = palette.gradient
        ? { colors: palette.gradient, angle: temperaHash01(seed, 3, 197) * Math.PI * 2 }
        : null;

    const add = (
        node: import('pixi.js').Container,
        item: Partial<Omit<CreditsItem, 'node' | 'baseX' | 'baseY'>> = {},
    ) => {
        items.push({
            node,
            baseX: node.x,
            baseY: node.y,
            baseAlpha: item.baseAlpha ?? 1,
            enterDX: item.enterDX ?? 0,
            enterDY: item.enterDY ?? 0,
            delay: item.delay ?? 0,
            driftX: item.driftX ?? 0,
            driftY: item.driftY ?? 0,
            grow: item.grow ?? 0,
        });
        container.addChild(node);
    };

    // The tone ground, exactly as a composition lays it: full bleed, no motion of its own.
    container.addChild(drawPolygonFill(
        pixi,
        rectPolygon(-halfWidth - bleed, -halfHeight - bleed, width + bleed * 2, height + bleed * 2),
        palette.tone1,
        1,
        gradient,
    ));

    // The masses climb the tone ladder as they stack, so the last one in is the brightest and
    // the type has a real edge to cross rather than three near-identical greys.
    const tones = [palette.tone2, palette.tone3, palette.tone4];
    const baseAngle = temperaHash01(seed, 4, 241) * Math.PI * 2;
    const hatchIndex = Math.floor(temperaHash01(seed, 5, 251) * CREDITS_DISC_COUNT) % CREDITS_DISC_COUNT;

    for (let index = 0; index < CREDITS_DISC_COUNT; index += 1) {
        // Spread around the frame, then jittered inside its own share of the circle.
        const angle = baseAngle
            + (index * Math.PI * 2) / CREDITS_DISC_COUNT
            + (temperaHash01(seed, index, 257) - 0.5) * 0.7;
        const distance = diagonal * (0.58 + temperaHash01(seed, index, 263) * 0.14);
        // The near edge lands past the middle, which is what makes the arcs cross the type.
        const radius = distance + diagonal * (0.06 + temperaHash01(seed, index, 269) * 0.1);
        const polygon = circlePolygon(0, 0, radius, 72);
        const cx = Math.cos(angle) * distance;
        const cy = Math.sin(angle) * distance;
        const delay = 0.08 + index * 0.16;
        // Enters along its own inward vector and keeps creeping the same way afterwards.
        const travel = {
            enterDX: Math.cos(angle) * diagonal * 0.16,
            enterDY: Math.sin(angle) * diagonal * 0.16,
            driftX: -Math.cos(angle) * diagonal * 0.024,
            driftY: -Math.sin(angle) * diagonal * 0.024,
        };
        const place = (node: import('pixi.js').Graphics, itemDelay: number) => {
            node.position.set(cx, cy);
            add(node, { ...travel, delay: itemDelay });
        };

        place(drawPolygonFill(pixi, polygon, tones[index], 1, gradient), delay);
        if (index === hatchIndex) {
            // The one screentone pass. Without it the card is flat vector art, which is the
            // single thing none of the shot compositions ever are.
            place(drawHatchFill(pixi, polygon, buildHatchSpec(seed, 271), palette.paper, 0.28), delay + 0.06);
        }
        // Seam weight matches addSeam in the split compositions: hard ink, not a hairline.
        place(drawPolygonOutline(pixi, polygon, palette.ink, 2.4, 0.8), delay + 0.04);
    }

    // The two layers every shot carries: full-bleed guide lines, then a corner motif.
    const lines = buildCrossingLines(seed, 31, width, height, 2)
        .map(line => ({
            x1: line.x1 - halfWidth,
            y1: line.y1 - halfHeight,
            x2: line.x2 - halfWidth,
            y2: line.y2 - halfHeight,
        }));
    add(drawLines(pixi, lines, palette.tone4, 1.3, 0.6), { delay: 0.5, enterDX: width * 0.2 });

    if (options.tuning.showDecor) {
        const cornerX = halfWidth * 0.66 * flip;
        const cornerY = halfHeight * 0.62;
        add(drawCrossMarks(
            pixi,
            buildCrossRow(seed, 71, cornerX - width * 0.1, cornerY, 5, width * 0.05, 8),
            palette.tone4,
            2,
            0.8,
        ), { delay: 0.62, enterDX: -width * 0.06 });
        const box = rectPolygon(-cornerX - 19, -cornerY - 19, 38, 38);
        add(drawHatchFill(pixi, box, buildHatchSpec(seed, 67), palette.tone4, 0.7), { delay: 0.68, grow: 0.06 });
        add(drawPolygonOutline(pixi, box, palette.tone4, 1.2, 0.6), { delay: 0.72 });
    }

    const fontFamily = resolveThemeFontStack(options.theme);
    const fontWeight = String(resolveThemeFontWeight(options.theme, 600)) as import('pixi.js').TextStyleFontWeight;
    const wrapWidth = Math.min(width * 0.72, diagonal * 0.52);
    const subtitle = [metadata.artist, metadata.album].filter(Boolean).join(' - ');
    const titleLayer = new Container();
    const titleSize = Math.max(26, Math.min(width, height) * 0.085 * options.lyricsFontScale);

    const buildLine = (text: string, size: number, offsetY: number, alpha: number) => {
        const node = new Text({
            text,
            style: new TextStyle({
                fontFamily,
                fontWeight,
                fontSize: size,
                fill: palette.ink,
                align: 'center',
                wordWrap: true,
                wordWrapWidth: wrapWidth,
            }),
        });
        node.anchor.set(0.5);
        node.position.set(0, offsetY);
        node.alpha = alpha;
        titleLayer.addChild(node);
        return node;
    };

    const title = buildLine(metadata.title?.trim() || '\u266a', titleSize, subtitle ? -titleSize * 0.35 : 0, 1);
    if (subtitle) buildLine(subtitle, Math.max(14, titleSize * 0.34), title.height / 2 + titleSize * 0.22, 0.75);

    // The title stays put while the shapes move under it, so the inversion keeps re-cutting it.
    const titleFilter = createTemperaTextFilter(pixi, palette, options.tuning.textInversion);
    if (titleFilter) {
        titleLayer.filters = [titleFilter];
        filters.push(titleFilter);
    }
    add(titleLayer, { enterDY: diagonal * 0.03, delay: 0.78 });

    const updateTime = (elapsed: number) => {
        const creep = creditsCreep(elapsed);
        for (const item of items) {
            const enter = easeTemperaEnter((elapsed - item.delay) / 1.1);
            item.node.alpha = item.baseAlpha * enter;
            item.node.visible = enter > 0.001;
            item.node.position.set(
                item.baseX + item.enterDX * (1 - enter) + item.driftX * creep,
                item.baseY + item.enterDY * (1 - enter) + item.driftY * creep,
            );
            if (item.grow !== 0) item.node.scale.set(1 + item.grow * creep);
        }
    };
    updateTime(0);
    return { container, filters, updateTime };
};

// Assembles the scene post-process chain from tuning; GLSL factories are shared with sonnet.
const applyTemperaScenePostProcess = (
    pixi: PixiModule,
    container: import('pixi.js').Container,
    tuning: TemperaTuning,
    seed: number,
    renderResolution: number,
) => {
    const filters = createSonnetPostProcessFilters(pixi, {
        lensDistortion: tuning.postProcessLensDistortion,
        lensDispersion: 0,
        noise: tuning.postProcessGrain * 0.35,
        contrast: tuning.postProcessContrast * 0.5,
        printEffects: {
            rgbShift: tuning.postProcessRgbShift,
            halftone: 0,
            vignette: tuning.postProcessVignette,
        },
    }, seed);
    // Every pass in the array has to carry the same resolution - Pixi keeps the minimum for the
    // whole container - and none of the shared sonnet factories set one, so they would each
    // default to a hard 1. See `resolveTemperaPassResolution` for why that softened the scene
    // and why it is safe for the inversion nested below.
    const resolution = resolveTemperaPassResolution(tuning, renderResolution);
    filters.forEach(filter => {
        filter.resolution = resolution;
    });
    if (filters.length > 0) container.filters = filters;
    return filters;
};

/** Hex mix used for the overlap ink wash; palette colours are always #rrggbb. */
const mixHex = (from: string, to: string, amount: number): string => {
    const parse = (value: string) => {
        const hex = value.replace('#', '');
        const full = hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex;
        return [0, 2, 4].map(index => parseInt(full.slice(index, index + 2), 16));
    };
    const a = parse(from);
    const b = parse(to);
    const channel = (index: number) => Math.round(a[index] + (b[index] - a[index]) * amount);
    return `#${[0, 1, 2].map(index => channel(index).toString(16).padStart(2, '0')).join('')}`;
};

/**
 * 重合的歌词不再是一整块平色：整句从主墨色向强调色走一层很浅的渐变，最后一个字最暖。
 * 关键字仍然优先（`placement.color` 覆盖 tint），所以重点词不会被这层洗掉。
 */
const applyOverlapInkTint = (
    placements: TemperaGlyphPlacement[],
    palette: { ink: string; accent: string },
    enabled: boolean | undefined,
) => {
    if (!enabled) return placements;
    const strength = overlapFx().lyricTint;
    const last = Math.max(1, placements.length - 1);
    return placements.map((placement, index) => ({
        ...placement,
        tint: strength > 0.001
            ? mixHex(palette.ink, palette.accent, strength * (index / last))
            : null,
    }));
};

/** Where a line is written: a seeded random spot a short way off centre, not a fixed corner.
 *
 * The offset is stable for a line (same seed, same spot on replay) but successive lines scatter
 * around the frame instead of walking a cycle, so the type never reads as pinned to the corners.
 * Keeping it within ~15% also keeps the follow camera's pan short: the corners demanded a
 * three-quarter-frame shove that read as a hard cut every line. */
const resolveOverlapAnchor = (lineIndex: number, width: number, height: number, seed: number) => {
    const index = Math.abs(lineIndex);
    const angle = temperaHash01(seed, index, 307) * Math.PI * 2;
    // Spread is the dial in the panel; the 2.2 factor opens the ring up so a mid setting already
    // reaches the edges of the frame instead of clustering around the centre.
    const radius = 0.07 + temperaHash01(seed, index, 311) * overlapFx().scatter * 2.2;
    return {x: Math.cos(angle) * radius * width, y: Math.sin(angle) * radius * height};
};

/** How often a line is written out of the stage's current angle. The turn is an accent, not the
 * rule: roughly one line in ten gets it, and the rest are written upright and are simply glided
 * to the middle by the follow camera. */
const resolveOverlapOrientation = (lineIndex: number, seed: number) => {
    const fx = overlapFx();
    const chance = Math.min(1, Math.max(0, fx.turnChance));
    const minDeg = Math.min(fx.turnMinDeg, fx.turnMaxDeg);
    const maxDeg = Math.max(fx.turnMinDeg, fx.turnMaxDeg);
    let previousPrevious = 0;
    let previous = 0;
    let turn = 0;
    for (let index = 1; index <= Math.abs(lineIndex); index += 1) {
        // No turn on this line: the stage keeps the angle it already has, so the line reads
        // upright exactly like it did before the turn accent existed.
        if (temperaHash01(seed, index, 211) >= chance) continue;
        const direction = previous !== 0 && previous === previousPrevious
            ? -previous
            : (temperaHash01(seed, index, 223) < 0.5 ? -1 : 1);
        const magnitude = (minDeg + temperaHash01(seed, index, 227) * (maxDeg - minDeg)) * Math.PI / 180;
        turn += direction * magnitude;
        previousPrevious = previous;
        previous = direction;
    }
    return lineIndex < 0 ? -turn : turn;
};

/** Lays one line out for 重合: a seeded turn about the block's own centre (positions and glyph
 * orientation together, so the line really runs at that angle), then the block is nudged to its
 * seeded spot. Rotating the block instead of the plate keeps the type at a readable size; the
 * camera does the righting, not the layout.
 *
 * The returned `bracket` is the line's own frame, in writing space: the two ends are measured
 * before the turn so they sit at the ends of the sentence, and the group is turned with the type.
 *
 * `placementIndex` is the shot's serial position in the song (paragraph * 32 + shot), not the
 * lyric line: with 拆句 on, one sung line becomes several chunks, and keying the spot on the line
 * put every chunk of it on exactly the same anchor - the chunks then read as one pile of type.
 * The turn still comes from `lineIndex`, so a split line keeps a single tilt. */
const resolveOverlapPlacement = (
    placementIndex: number,
    lineIndex: number,
    placements: TemperaGlyphPlacement[],
    width: number,
    height: number,
    seed: number,
): {
    placements: TemperaGlyphPlacement[];
    orientation: number;
    bracket: {x: number; y: number; halfWidth: number; halfHeight: number; rotation: number} | null;
    underline: {x: number; y: number; halfWidth: number; bottom: number; rotation: number} | null;
} => {
    if (!placements.length) return {placements, orientation: 0, bracket: null, underline: null};
    let minX = Number.POSITIVE_INFINITY, maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY, maxY = Number.NEGATIVE_INFINITY;
    for (const placement of placements) {
        if (placement.x < minX) minX = placement.x;
        if (placement.x > maxX) maxX = placement.x;
        if (placement.y < minY) minY = placement.y;
        if (placement.y > maxY) maxY = placement.y;
    }
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const orientation = resolveOverlapOrientation(lineIndex, seed);
    const cos = Math.cos(orientation);
    const sin = Math.sin(orientation);
    const rotated = placements.map(placement => {
        const dx = placement.x - centerX;
        const dy = placement.y - centerY;
        return {
            ...placement,
            x: centerX + dx * cos - dy * sin,
            y: centerY + dx * sin + dy * cos,
            rotation: placement.rotation + orientation,
        };
    });
    let rMinX = Number.POSITIVE_INFINITY, rMaxX = Number.NEGATIVE_INFINITY;
    let rMinY = Number.POSITIVE_INFINITY, rMaxY = Number.NEGATIVE_INFINITY;
    for (const placement of rotated) {
        if (placement.x < rMinX) rMinX = placement.x;
        if (placement.x > rMaxX) rMaxX = placement.x;
        if (placement.y < rMinY) rMinY = placement.y;
        if (placement.y > rMaxY) rMaxY = placement.y;
    }
    const margin = Math.max(24, Math.min(width, height) * 0.05);
    const fx = overlapFx();
    // Where the block sits. Three ways, all measured on the block's own bounding box:
    //
    // scatter - the original seeded spot. A wide line (half-width up to ~0.3W) leaves almost no
    //   sideways room, so two clamped offsets can pile onto the same wall; that is the old look,
    //   kept for anyone who preferred it.
    // grid - shots take turns in a 2x3 grid laid on the frame; two rows is the most that still
    //   guarantees the next line cannot sit on the previous one, whatever its size, and columns
    //   step every two shots so the line after next lands beside it instead of on it.
    const boxX = (rMinX + rMaxX) / 2 - centerX, boxY = (rMinY + rMaxY) / 2 - centerY;
    const halfW = (rMaxX - rMinX) / 2, halfH = (rMaxY - rMinY) / 2;
    const reachX = Math.max(0, width / 2 - margin - halfW);
    // Asymmetric clamp: the block may be off-centre inside its own layout box, so "keep it inside
    // the frame" is not the same as "shift it at most reachX/reachY".
    const limitX = (shift: number): number => {
        const base = centerX + boxX - width / 2;
        return Math.max(margin + halfW - width / 2 - base, Math.min(width - margin - halfW - width / 2 - base, shift));
    };
    const limitY = (shift: number): number => {
        const base = centerY + boxY - height / 2;
        return Math.max(margin + halfH - height / 2 - base, Math.min(height - margin - halfH - height / 2 - base, shift));
    };
    const rowPhase = Math.floor(temperaHash01(seed, 0, 401) * 2);
    const colPhase = Math.floor(temperaHash01(seed, 0, 409) * 3);
    const grid = (index: number): {shiftX: number; shiftY: number} => {
        const step = Math.abs(index);
        const row = (step + rowPhase) % 2;
        const column = (Math.floor(step / 2) + colPhase) % 3;
        // Cell centres in frame space; ±quarter frame for the rows keeps both of them a whole
        // half-frame apart, which is as much room as a block can need.
        const cellX = (column - 1) * reachX * 0.85
            + (temperaHash01(seed, index, 307) - 0.5) * reachX * 0.15;
        const cellY = (row === 0 ? -1 : 1) * (height / 4 - margin / 2)
            + (temperaHash01(seed, index, 311) - 0.5) * height * 0.04;
        return {shiftX: limitX(cellX - boxX), shiftY: limitY(cellY - boxY)};
    };
    let spot: {shiftX: number; shiftY: number};
    if (fx.placement === 'scatter') {
        const anchor = resolveOverlapAnchor(placementIndex, width, height, seed);
        spot = {shiftX: limitX(anchor.x - boxX), shiftY: limitY(anchor.y - boxY)};
    } else {
        spot = grid(placementIndex);
    }
    const {shiftX, shiftY} = spot;
    if (perfOn()) {
        const bucket = ((window as unknown as {__overlapSpots?: {i: number; x: number; y: number; s: number; h: number; w: number; bh: number; bx: number; by: number}[]}).__overlapSpots ??= []);
        if (bucket.length < 4000) bucket.push({
            i: placementIndex,
            x: Math.round(shiftX),
            y: Math.round(shiftY),
            s: seed % 100000,
            h: Math.round(height),
            w: Math.round(rMaxX - rMinX),
            bh: Math.round(rMaxY - rMinY),
            bx: Math.round(boxX),
            by: Math.round(boxY),
        });
    }
    return {
        placements: rotated.map(placement => ({
            ...placement,
            x: placement.x + shiftX,
            y: placement.y + shiftY,
        })),
        orientation,
        bracket: {
            x: centerX + shiftX,
            y: centerY + shiftY,
            halfWidth: (maxX - minX) / 2,
            halfHeight: (maxY - minY) / 2,
            rotation: orientation,
        },
        underline: {
            x: centerX + shiftX,
            y: centerY + shiftY,
            halfWidth: (maxX - minX) / 2,
            // The rule sits below the writing frame's own bottom edge, in the sentence's frame.
            bottom: (maxY - minY) / 2 + Math.max(5, (placements[0]?.fontSize ?? 16) * 0.18),
            rotation: orientation,
        },
    };
};

/**
 * Picks one contiguous run of glyphs and the plate that covers it. The run length is random per
 * line (two to four characters), and the plate is measured from the real glyph boxes so it
 * wraps the whole word - a single character gives a short square, four give a long bar. The plate
 * rides the line's rotation, so it reads as a mask laid on the type rather than a UI rectangle.
 */
const resolveOverlapMask = (
    pixi: PixiModule,
    lineIndex: number,
    glyphs: TemperaGlyphView[],
    palette: TemperaPalette,
    seed: number,
    orientation: number,
): TemperaMaskView | null => {
    const fx = overlapFx();
    if (!fx.showMask || glyphs.length === 0) return null;
    if (temperaHash01(seed, lineIndex, 401) >= fx.maskChance) return null;
    const count = glyphs.length;
    const minSpan = Math.min(2, count);
    const maxSpan = Math.min(4, count);
    const span = minSpan + Math.floor(temperaHash01(seed, lineIndex, 409) * (maxSpan - minSpan + 1));
    const first = Math.min(count - span, Math.floor(temperaHash01(seed, lineIndex, 413) * (count - span + 1)));
    const covered = glyphs.slice(first, first + span);
    const originX = covered.reduce((sum, glyph) => sum + glyph.baseX, 0) / span;
    const originY = covered.reduce((sum, glyph) => sum + glyph.baseY, 0) / span;
    const cos = Math.cos(orientation);
    const sin = Math.sin(orientation);
    let minX = Number.POSITIVE_INFINITY, maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY, maxY = Number.NEGATIVE_INFINITY;
    let fontSize = 0;
    for (const glyph of covered) {
        // Measure in the line's own writing frame, so the plate's long edge runs along the
        // baseline instead of cutting across a turned line as a screen-aligned box would.
        const dx = glyph.baseX - originX;
        const dy = glyph.baseY - originY;
        const localX = dx * cos + dy * sin;
        const localY = -dx * sin + dy * cos;
        const halfWidth = glyph.display.width / 2;
        const halfHeight = glyph.display.height / 2;
        minX = Math.min(minX, localX - halfWidth);
        maxX = Math.max(maxX, localX + halfWidth);
        minY = Math.min(minY, localY - halfHeight);
        maxY = Math.max(maxY, localY + halfHeight);
        fontSize = Math.max(fontSize, glyph.display.height);
    }
    const pad = Math.max(4, fontSize * 0.08);
    const width = maxX - minX + pad * 2;
    const height = maxY - minY + pad * 2;
    const centreX = (minX + maxX) / 2;
    const centreY = (minY + maxY) / 2;
    const x = originX + centreX * cos - centreY * sin;
    const y = originY + centreX * sin + centreY * cos;
    const direction = Math.floor(temperaHash01(seed, lineIndex, 419) * 4) % 4;
    // Four seeded entrances so consecutive masks do not all arrive the same way.
    const variant = Math.floor(temperaHash01(seed, lineIndex, 421) * 4) % 4;
    // Five cuts of the same band: proof rectangle, capsule, thin rule, slanted strip, framed
    // band. The ellipse was dropped — over a line of type it read as a smudge, not a gesture.
    const shape = Math.floor(temperaHash01(seed, lineIndex, 431) * 5) % 5;
    const slice = shape === 2 ? 0.34 : 1;
    const slant = (temperaHash01(seed, lineIndex, 433) - 0.5) * 0.36;
    const travel = (direction < 2 ? width : height) * 0.62 + 36;
    const start = Math.min(...covered.map(glyph => glyph.motion.startTime));
    // The plate holds until the line is sung out, not just until its own fragment is: only then
    // does it begin to fade.
    const end = Math.max(...glyphs.map(glyph => glyph.motion.endTime));
    const bar = new pixi.Graphics();
    // A translucent accent band, nothing more. The inversion is applied to the glyphs it covers
    // (see the frame pass), so arcs, trails, specks and the ruler underneath are only tinted,
    // never inverted. Keyword glyphs are left alone entirely.
    const fill = {color: palette.accent, alpha: 1};
    if (shape === 1) {
        bar.roundRect(-width / 2, -height / 2, width, height, Math.min(height / 2, width * 0.18)).fill(fill);
    } else if (shape === 2) {
        const h = height * slice;
        bar.rect(-width / 2, -h / 2, width, h).fill(fill);
    } else if (shape === 3) {
        const shear = slant * height / 2;
        bar.poly([
            -width / 2 - shear, -height / 2,
            width / 2 - shear, -height / 2,
            width / 2 + shear, height / 2,
            -width / 2 + shear, height / 2,
        ]).fill(fill);
    } else {
        bar.rect(-width / 2, -height / 2, width, height).fill(fill);
        if (shape === 4) {
            bar.rect(-width / 2, -height / 2, width, height)
                .stroke({color: palette.ink, width: 1.6, alpha: 0.9, alignment: 0.5});
        }
    }
    bar.position.set(x, y);
    bar.rotation = orientation;
    bar.visible = false;
    return {
        bar, x, y, width, height, start, end, variant, direction, travel, orientation,
        shape, slice, slant, paper: palette.paper, covered,
    };
};

/**
 * Builds one paragraph scene a shot at a time.
 *
 * The body is unchanged from the synchronous builder; the only difference is the `yield` at
 * the end of every shot, which lets the runtime spend a fixed slice per frame instead of
 * paying 200 ms in a single frame when a dense paragraph is being prepared. Everything the
 * generator touches stays invisible until the caller adopts the finished view, so pausing
 * between shots cannot be seen.
 */
export function* temperaSceneSteps(
    pixi: PixiModule,
    options: TemperaSceneBuildOptions,
    paragraph: TemperaParagraph,
    holder?: { container?: import('pixi.js').Container },
): Generator<void, TemperaSceneView, void> {
    const { Container, Graphics } = pixi;
    const buildAt = perfOn() ? performance.now() : 0;
    let blocksMs = 0, imageMs = 0, layoutMs = 0, glyphMs = 0;
    const width = Math.max(options.host.clientWidth, 320);
    const height = Math.max(options.host.clientHeight, 240);
    const container = new Container();
    // Handed out before the first yield so a cancelled build can still free what it created.
    if (holder) holder.container = container;
    const { tuning } = options;
    const palette = resolveTemperaPalette(options.theme, tuning, options.coverColors);
    const sceneSeed = hashTemperaSeed(`${options.programSeed}:${paragraph.id}`);
    // `tempera-p<index>`; only used to keep spots apart across paragraphs (see placementIndex).
    const paragraphIndex = Number(/p(\d+)$/.exec(paragraph.id)?.[1] ?? 0);
    const flowStyle=(options.theme as Theme & {flowStyle?:FlowSettings}).flowStyle;
    if(flowStyle) applyFlowPalette(palette,flowStyle,options.coverColors??[],sceneSeed);
    const fontFamily = resolveThemeFontStack(options.theme);
    const fontWeight = resolveThemeFontWeight(options.theme, 600);

    // A translucent paper wash unifies the block colors with the shell background, and the
    // dot lattice on top gives the whole frame its printed-paper grain. Both are built once
    // per paragraph scene and never touched again during playback.
    const paperWash = new Graphics()
        .rect(0, 0, width, height)
        .fill({ color: pixi.Color.shared.setValue(palette.paper).toNumber(), alpha: 0.35 });
    paperWash.visible = tuning.showBlocks;
    container.addChild(paperWash);
    if (tuning.showBlocks) {
        // Spacing grows with the viewport so the lattice stays around 3k dots on any display.
        const toneSpacing = Math.max(26, Math.sqrt((width * height) / 6000));
        const screentone = drawSquareMarks(pixi, buildDotGrid(width, height, toneSpacing, 1.6), palette.tone4, 0.05);
        container.addChild(screentone);
    }

    const postProcessFilters: import('pixi.js').Filter[] = [];
    // Tempera deliberately has no glow layer: a screen-blend halo washes the glyph toward
    // white and, wherever it lands, becomes backdrop the inversion filter has to read.
    //
    // The inversion is NOT a post-process pass: it is how this mode colors type, so it has its
    // own `textInversion` switch (default on) rather than riding `postProcessEnabled`, which
    // defaults to false and once left the effect dead for everyone.

    // 关键字着色: the theme's wordColors are matched once per line and handed to the typesetter
    // as per-segment colours. Matched glyphs opt out of the inversion filter so the hue lands.
    const wordColorMatchers = prepareWordColorMatchers(options.theme.wordColors);
    const colorRangesByLine = new Map(paragraph.lines.map(line => [
        line.sourceIndex,
        wordColorMatchers.length > 0
            ? buildWordColorRangesFromMatchers(line.line.fullText, wordColorMatchers)
            : [],
    ]));

    // Threaded so two neighbouring shots do not land on the same picture.
    let lastImageId: string | null = null;
    const shots: TemperaSceneView['shots'] = [];
    for (let shotIndex = 0; shotIndex < paragraph.shots.length; shotIndex += 1) {
        const shot = paragraph.shots[shotIndex];
        const shotContainer = new Container();
        // A shot normally shows one half-phrase slice; whole-line mode deliberately trades
        // some of that type scale for keeping the source lyric line together.
        const sliceSegments = shot.slices.map(slice => ({
            slice,
            segments: paragraph.lines.find(item => item.sourceIndex === slice.lineIndex)
                ?.segments.slice(slice.segmentStart, slice.segmentEnd)
                .filter(isTemperaLayoutSegment) ?? [],
        })).filter(entry => entry.segments.length > 0);
        const linesSegments = sliceSegments.map(entry => entry.segments);
        const segmentColors = sliceSegments.map(entry => {
            const ranges = colorRangesByLine.get(entry.slice.lineIndex) ?? [];
            return entry.segments.map(segment => ranges.find(range => (
                range.startOffset < segment.endOffset && segment.startOffset < range.endOffset
            ))?.color ?? null);
        });

        const maxGraphemes = Math.max(3, ...linesSegments.map(
            segments => segments.reduce((sum, segment) => sum + segment.graphemes.length, 0),
        ));
        const baseFontSize = Math.max(34, Math.min(150, (
            width / Math.max(5, maxGraphemes * 1.05)
        ) * 1.5)) * options.lyricsFontScale * (flowStyle?.sizeScale ?? 1);

        const shotSeed = sceneSeed + shotIndex * 97;
        const phaseAt = perfOn() ? performance.now() : 0;
        const blocks = buildTemperaBlocks(pixi, {
            kind: shot.kind,
            mg: shot.mgVariants?.map(variant => ({variant,density:flowStyle?.mgDensity??1,scale:flowStyle?.mgScale??1,opacity:flowStyle?.mgOpacity??.8,stagger:flowStyle?.mgStagger??.65})),
            drawOriginal: shot.drawOriginalComposition,
            originalKind: shot.originalCompositionKind,
            decor: shot.decor,
            palette,
            width,
            height,
            seed: shotSeed,
            showDecor: tuning.showDecor,
            flowAngle: shot.flowAngle,
        });
        blocks.container.visible = tuning.showBlocks;
        if (phaseAt) { blocksMs += performance.now() - phaseAt; }

        const imageAt = perfOn() ? performance.now() : 0;
        const images = buildTemperaImageLayer(pixi, {
            pool: tuning.layerImages,
            frequency: tuning.layerImageFrequency,
            depth: tuning.layerImageDepth,
            textures: options.imageTextures,
            width,
            height,
            seed: shotSeed,
            flowAngle: shot.flowAngle,
            previousId: lastImageId,
        });
        lastImageId = images.chosenId ?? lastImageId;
        if (imageAt) { imageMs += performance.now() - imageAt; }
        const watermarkLayer = new Container();
        const textLayer = new Container();
        const echoLayer = new Container();
        const keywordLayer = new Container();
        // Order matters. Everything the inversion filter should read must render before the
        // text layer - that includes the decorative watermark, which is the point of it: the
        // lyric flips colour where it crosses those strokes. Nothing glyph-shaped may go there
        // though, or each glyph inverts against its own ghost and shatters into patches.
        // Echoes and keyword-coloured glyphs render after it, unfiltered, keeping their colour.
        // A `back` image joins the artwork the inversion reads; a `front` one sits over
        // everything, including the lyric.
        shotContainer.addChild(
            blocks.container,
            images.back,
            watermarkLayer,
            textLayer,
            echoLayer,
            keywordLayer,
            images.front,
        );
        // Wet-ink specks sit in front of everything: they are the only mark allowed over the
        // type, and at this size they read as paper spray rather than as a layer on top.
        const specks = options.lyricsOnly && overlapFx().specks > 0 ? new Graphics() : null;
        if (specks) shotContainer.addChild(specks);

        const layoutAt = perfOn() ? performance.now() : 0;
        const placements = resolveTemperaLayout({
            lines: linesSegments,
            shotKind: shot.kind,
            width,
            height,
            baseFontSize,
            fontFamily,
            fontWeight,
            seed: shotSeed,
            segmentColors,
            settleStretch: tuning.glyphSettleStretch,
        });
        if (layoutAt) { layoutMs += performance.now() - layoutAt; }
        // Serial position in the song, not the lyric line: with 拆句 on, one line is several shots
        // and each one needs its own spot (see resolveOverlapPlacement).
        const placementIndex = paragraphIndex * 32 + shotIndex;
        const placement = options.lyricsOnly
            ? resolveOverlapPlacement(
                placementIndex,
                shot.slices[0]?.lineIndex ?? shotIndex,
                placements, width, height,
                hashTemperaSeed(options.programSeed),
            )
            : {placements, orientation: 0, bracket: null, underline: null};
        const placedGlyphs = applyOverlapInkTint(placement.placements, palette, options.lyricsOnly);
        let bracket: TemperaBracketView | null = null;
        const lineIndex = shot.slices[0]?.lineIndex ?? shotIndex;
        const accentSeed = hashTemperaSeed(options.programSeed);
        if (placement.bracket && overlapFx().showBracket
            && temperaHash01(accentSeed, lineIndex, 271) < overlapFx().bracketChance) {
            const frame = placement.bracket;
            const group = new Container();
            group.position.set(frame.x, frame.y);
            group.rotation = frame.rotation;
            const half = frame.halfWidth + 14;
            const top = -(frame.halfHeight + 10);
            const bottom = frame.halfHeight + 10;
            const arm = Math.min(16, Math.max(8, frame.halfHeight * 0.6));
            const stroke = {width: 1.1, color: palette.ink, alpha: 1, cap: 'round' as const, join: 'round' as const};
            // Two marks share this slot. The default is the pair of ends: the opening end stays
            // at the start of the sentence, the closing end is moved by the frame pass as the
            // lyric is sung, so the frame opens along the words instead of appearing whole.
            // The alt is a crop-mark frame - four sides that overshoot their corners, like the
            // registration crosses a print shop draws around a plate. It is revealed by a mask
            // that walks left to right on the same progress, so both read as one gesture.
            const cross = temperaHash01(accentSeed, lineIndex, 331) < overlapFx().bracketCrossChance;
            const overshoot = 13;
            let right: import('pixi.js').Graphics | null = null;
            let horizontal: import('pixi.js').Graphics | null = null;
            let vertical: import('pixi.js').Graphics | null = null;
            if (cross) {
                // The two axes are separate beats, not one box: the horizontals are ruled
                // first, left to right, and the verticals follow top to bottom a beat later,
                // the way a compositor would lay a register frame down in two passes.
                horizontal = new Graphics();
                vertical = new Graphics();
                group.addChild(horizontal, vertical);
            } else {
                const left = new Graphics();
                left.moveTo(arm, top).lineTo(0, top).lineTo(0, bottom).lineTo(arm, bottom)
                    .stroke(stroke);
                left.position.x = -half;
                right = new Graphics();
                right.moveTo(-arm, top).lineTo(0, top).lineTo(0, bottom).lineTo(-arm, bottom)
                    .stroke(stroke);
                // Starts closed against the opening end; the frame pass walks it outwards.
                right.position.x = -half;
                group.addChild(left, right);
            }
            // The frame is drawn on the paper as ink too: when the line is let go it should
            // soften and dry out with the glyphs instead of staying razor sharp beside them.
            const blur = new pixi.BlurFilter({strength: 0, quality: 2, resolution: 1});
            group.alpha = 0;
            // Behind the type but in front of the paper: the frame is drawn around the line, not
            // over it.
            shotContainer.addChildAt(group, 3);
            // Not everything on the page arrives on the same beat: each mark waits its own
            // seeded turn inside the stagger window, so a line assembles instead of snapping.
            const delay = overlapFx().stagger * temperaHash01(accentSeed, lineIndex, 311);
            bracket = {group, right, style: cross ? 'cross' : 'bracket', horizontal, vertical, top, bottom, overshoot, half, blur, delay};
        }
        let underline: TemperaUnderlineView | null = null;
        if (placement.underline && overlapFx().showUnderline
            && temperaHash01(accentSeed, lineIndex, 277) < overlapFx().underlineChance) {
            const frame = placement.underline;
            const group = new Container();
            group.position.set(frame.x, frame.y);
            group.rotation = frame.rotation;
            const rail = new Graphics();
            rail.moveTo(0, 0).lineTo(frame.halfWidth * 2, 0)
                .stroke({width: 1.6, color: palette.ink, alpha: 0.55, cap: 'round'});
            rail.position.set(-frame.halfWidth, frame.bottom);
            const head = new Graphics();
            head.circle(0, 0, 1.9).fill({color: palette.accent, alpha: 0.95});
            head.position.set(-frame.halfWidth, frame.bottom);
            const blur = new pixi.BlurFilter({strength: 0, quality: 2, resolution: 1});
            group.addChild(rail, head);
            group.alpha = 0;
            // Under the type, on the same paper as the frame.
            shotContainer.addChildAt(group, 3);
            const delay = overlapFx().stagger * temperaHash01(accentSeed, lineIndex, 313);
            underline = {group, rail, head, half: frame.halfWidth, x: frame.x, y: frame.y, blur, delay};
        }
        const glyphAt = perfOn() ? performance.now() : 0;
        const glyphs = buildTemperaTextViews(pixi, {
            placements: placedGlyphs,
            palette,
            fontFamily,
            fontWeight,
            blurAfterSinging: shot.holdUntil !== undefined,
            shadowEnabled: tuning.showDecor,
            echoCount: tuning.showDecor && !options.staticMode ? 2 : 0,
            textLayer,
            echoLayer,
            keywordLayer,
        });
        if (glyphAt) { glyphMs += performance.now() - glyphAt; }
        // Under the type: one hairline block per character, the way a compositor sets type
        // into a forme. It is drawn under the text so the character sits in the box rather than
        // on top of a rectangle, and it uses the rendered bounds so a turned glyph's box turns
        // with it.
        const overlap = overlapFx();
        let moulds: import('pixi.js').Graphics | null = null;
        const mouldGlyphs: number[] = [];
        if (options.lyricsOnly && overlap.showMould && glyphs.length > 0
            && temperaHash01(accentSeed, lineIndex, 357) < overlap.mouldChance) {
            // A forme is never the whole sentence: the compositor sets one short run of type
            // into the box and leaves the rest on the page. Two or three adjacent characters,
            // picked per line, read as a deliberate selection rather than a grid over the type.
            const span = Math.min(glyphs.length, 2 + Math.floor(temperaHash01(accentSeed, lineIndex, 361) * 2));
            const start = Math.min(
                glyphs.length - span,
                Math.floor(temperaHash01(accentSeed, lineIndex, 359) * Math.max(1, glyphs.length - span + 1)),
            );
            for (let index = start; index < start + span; index += 1) mouldGlyphs.push(index);
            moulds = new Graphics();
            shotContainer.addChildAt(moulds, 3);
        }
        // The disturbance field: each character, as it lands, flicks a few very short
        // strokes out around itself. They are particles only in behaviour - a handful of
        // hairlines, deterministic per line, that drift out, turn a little and fade. Nothing
        // is simulated frame to frame, so scrubbing back replays the same field.
        let field: TemperaFieldView | null = null;
        if (options.lyricsOnly && overlap.showField && glyphs.length > 0
            && temperaHash01(accentSeed, lineIndex, 371) < overlap.fieldChance) {
            const graphics = new Graphics();
            shotContainer.addChild(graphics);
            field = {graphics};
        }
        // A chop mark at the end of the line: a small square, inked in the accent, stamped
        // with a quick press once the last character has landed. It is drawn as strokes rather
        // than a glyph so it needs no font and reads at any size.
        let seal: import('pixi.js').Graphics | null = null;
        let sealX = 0;
        let sealY = 0;
        let sealSize = 0;
        let sealRotation = 0;
        let sealStart = 0;
        if (options.lyricsOnly && overlap.showSeal && glyphs.length > 0
            && temperaHash01(accentSeed, lineIndex, 367) < overlap.sealChance) {
            // The seal belongs at the bottom-right corner of the *last character*, not at the
            // bounding box of the whole line: measure inside the line's own writing frame, then
            // rotate that corner back onto the stage. Using the stage-space max X/Y made the
            // chop drift off the last glyph whenever the line was turned or parked far from
            // the centre.
            const last = glyphs[glyphs.length - 1];
            let centreX = 0;
            let centreY = 0;
            for (const glyph of glyphs) {
                centreX += glyph.baseX;
                centreY += glyph.baseY;
            }
            centreX /= glyphs.length;
            centreY /= glyphs.length;
            const theta = placement.orientation;
            const cos = Math.cos(theta);
            const sin = Math.sin(theta);
            sealSize = Math.max(15, Math.min(30, baseFontSize * 0.42));
            const half = baseFontSize * 0.5;
            const gap = sealSize * 0.5 + 5;
            const dx = last.baseX - centreX;
            const dy = last.baseY - centreY;
            const localX = dx * cos + dy * sin + half + gap;
            const localY = -dx * sin + dy * cos + half + gap;
            sealX = centreX + localX * cos - localY * sin;
            sealY = centreY + localX * sin + localY * cos;
            sealRotation = (temperaHash01(accentSeed, lineIndex, 369) - 0.5) * 0.24;
            sealStart = Math.max(...glyphs.map(glyph => glyph.motion.endTime)) - 0.04;
            seal = new Graphics();
            shotContainer.addChild(seal);
        }
        // Above the type: the plate inverts whatever it covers. Its box is measured in the
        // line's own writing frame, so a turned or vertical line is wrapped along the baseline
        // rather than by a screen-aligned box cutting across it.
        const mask = options.lyricsOnly
            ? resolveOverlapMask(
                pixi,
                shot.slices[0]?.lineIndex ?? shotIndex,
                glyphs,
                palette,
                hashTemperaSeed(options.programSeed),
                placement.orientation,
            )
            : null;
        // Under the type: the plate is a tinted ground the glyphs are knocked out of. Drawn on
        // top it would wash the paper-toned glyphs back into the band and the inversion would
        // disappear, which is exactly what a 55% film does.
        if (mask) shotContainer.addChildAt(mask.bar, 0);
        if (shot.decor.watermark && tuning.showDecor) {
            buildTemperaWatermark(pixi, {
                watermark: shot.decor.watermark,
                palette,
                fontFamily,
                fontWeight,
                baseFontSize,
                width,
                height,
                layer: watermarkLayer,
            });
        }
        if (shot.decor.fragments.length > 0 && tuning.showDecor) {
            buildTemperaFragmentViews(pixi, {
                fragments: shot.decor.fragments,
                palette,
                fontFamily,
                fontWeight,
                baseFontSize,
                width,
                height,
                layer: textLayer,
            });
        }
        // Scoped to the text layer only: blendRequired copies the pixels under these bounds
        // every frame, so a full-scene filter here would be a viewport-sized blit. In gradient
        // colour mode the ramp rides along as a tint - the filter still decides the luminance,
        // which is the only thing keeping the lyric readable over arbitrary artwork. With the
        // inversion switched off the same ramp is applied on its own, with no backdrop read.
        let tintAnchor: import('pixi.js').Sprite | undefined;
        if (palette.textGradient && glyphs.length) {
            // Map the ramp across the finished layout, including letters revealed later.
            const cos = Math.cos(placement.orientation);
            const sin = Math.sin(placement.orientation);
            let left = Infinity;
            let right = -Infinity;
            for (const glyph of glyphs) {
                const center = glyph.baseX * cos + glyph.baseY * sin;
                const half = glyph.display.width / 2;
                left = Math.min(left, center - half);
                right = Math.max(right, center + half);
            }
            tintAnchor = new pixi.Sprite(pixi.Texture.WHITE);
            tintAnchor.renderable = false;
            tintAnchor.position.set(left * cos, left * sin);
            tintAnchor.rotation = placement.orientation;
            tintAnchor.width = Math.max(1, right - left);
            textLayer.addChild(tintAnchor);
        }
        const textFilter = createTemperaTextFilter(pixi, palette, tuning.textInversion, tintAnchor);
        if (textFilter) {
            textLayer.filters = [textFilter];
            postProcessFilters.push(textFilter);
        }
        // A bridge shot has no type to reveal, so the camera breath may start immediately -
        // an instrumental gap should not hold a rigid frame.
        const revealDoneTime = glyphs.length > 0
            ? Math.max(...glyphs.map(glyph => glyph.motion.settleTime))
            : shot.startTime;

        shotContainer.pivot.set(width / 2, height / 2);
        const penStyles = ['ticks', 'beads', 'stitch', 'rings', 'chevron', 'diamond'] as const;
        const interGlyphStyles = options.lyricsOnly ? penStyles.filter((style, index) =>
            temperaHash01(accentSeed, lineIndex, 953 + index * 47) < overlap[`${style}Chance`]) : [];
        const progressArc = options.lyricsOnly && overlap.showProgressArc && glyphs.length
            && temperaHash01(accentSeed, lineIndex, 1291) < overlap.progressArcChance
            ? new Graphics() : null;
        const progressHalo = progressArc ? new Graphics() : null;
        const interGlyph = glyphs.length && interGlyphStyles.length ? new Graphics() : null;
        if (interGlyph) shotContainer.addChild(interGlyph);
        let lyricMarks: import('pixi.js').Container | null = null;
        if (options.lyricsOnly && overlap.showLyricMarks && glyphs.length
            && temperaHash01(accentSeed, lineIndex, 817) < 0.45) {
            const nextLine = paragraph.lines.find(line => line.sourceIndex > lineIndex)?.sourceIndex ?? options.followingLine;
            if (nextLine !== undefined) {
                const here = resolveOverlapAnchor(placementIndex, width, height, accentSeed);
                const there = resolveOverlapAnchor(placementIndex + 1, width, height, accentSeed);
                const unit = Math.min(32, Math.max(12, baseFontSize * 0.33));
                lyricMarks = new Container();
                lyricMarks.addChild(
                    new Graphics().roundRect(-1.02, -0.18, 0.42, 0.42, 0.05).fill({color: palette.ink, alpha: 0.28}),
                    new Graphics().poly([-0.71, -0.26, 0.04, -0.26, 0.19, -0.1, 0.19, 0.24, -0.71, 0.24])
                        .fill({color: palette.ink, alpha: 0.48}),
                    new Graphics().poly([-0.12, -0.32, 0.46, -0.32, 0.79, 0, 0.46, 0.32, -0.12, 0.32])
                        .fill(mixHex(palette.accent, palette.paper, 0.28)),
                );
                lyricMarks.rotation = Math.atan2(there.y - here.y, there.x - here.x);
                lyricMarks.scale.set(unit);
                shotContainer.addChild(lyricMarks);
            }
        }
        if (progressArc && progressHalo) {
            const blur = new pixi.BlurFilter({strength: 3.5, quality: 3, resolution: 1});
            blur.padding = 16;
            progressHalo.filters = [blur];
            postProcessFilters.push(blur);
            shotContainer.addChild(progressHalo, progressArc);
        }
        shotContainer.position.set(width / 2, height / 2);
        // The runtime opts shots into rendering from absolute playback time.
        shotContainer.visible = false;
        container.addChild(shotContainer);
        shots.push({
            shot,
            container: shotContainer,
            glyphs,
            blocks,
            images,
            baseX: shotContainer.x,
            baseY: shotContainer.y,
            frameX: 0,
            frameY: 0,
            frameScale: 1,
            orientation: placement.orientation,
            textLayer,
            specks,
            speckColor: palette.ink,
            bracket,
            mask,
            underline,
            moulds,
            mouldGlyphs,
            field,
            progressArc,
            interGlyph,
            interGlyphStyles,
            lyricMarks,
            progressHalo,
            accentColor: palette.accent,
            seal,
            sealX,
            sealY,
            sealSize,
            sealRotation,
            sealStart,
            sealColor: palette.accent,
            revealDoneTime,
        });
        yield;
    }

    const baseFilters: import('pixi.js').Filter[] = [];
    if (tuning.postProcessEnabled && !options.staticMode && !options.lyricsOnly) {
        const sceneFilters = applyTemperaScenePostProcess(pixi, container, tuning, sceneSeed, options.renderResolution);
        if (sceneFilters.length > 0) {
            // Keep full-scene shaders in viewport space even when visible bounds are smaller.
            container.filterArea = new pixi.Rectangle(0, 0, width, height);
            baseFilters.push(...sceneFilters);
            postProcessFilters.push(...sceneFilters);
        }
    }

    const transitionBlurFilter = tuning.enableTransitions && !options.staticMode
        ? new pixi.BlurFilter({
            strength: 0,
            quality: 1,
            kernelSize: 5,
            resolution: resolveTemperaTransitionBlurResolution(tuning, options.renderResolution),
        })
        : null;
    if (transitionBlurFilter) {
        // Pins padding at 0 so ramping blur never rescales the shared vignette pass.
        transitionBlurFilter.repeatEdgePixels = true;
        // Left attached-but-disabled it becomes a skipped stack entry that misplaces the
        // inversion's backdrop copy, so the runtime attaches it per transition instead -
        // see `temperaSceneFilters.ts`.
        postProcessFilters.push(transitionBlurFilter);
    }
    container.visible = false;
    if (buildAt) {
        perfMark('scene.build', buildAt, {
            shots: paragraph.shots.length,
            blocks: Math.round(blocksMs),
            image: Math.round(imageMs),
            layout: Math.round(layoutMs),
            glyph: Math.round(glyphMs),
        });
    }
    return {
        paragraph,
        container,
        shots,
        palette,
        postProcessFilters,
        baseFilters,
        transitionBlurFilter,
        transitionBlurAttached: false,
        activeShotIndex: -1,
    };
}

/** Synchronous build: drives the shot generator to completion in one frame. */
export const buildTemperaScene = (
    pixi: PixiModule,
    options: TemperaSceneBuildOptions,
    paragraph: TemperaParagraph,
): TemperaSceneView => {
    const steps = temperaSceneSteps(pixi, options, paragraph);
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
};

/**
 * 重合档的曲名卡。拼合那张卡是「纸块 + 圆盘 + 网点」的拼贴版式，搬到重合上像换了个设计；
 * 这里只留重合自己会画的东西：纸底、一两笔手写弧、把歌名括起来的方括号。
 */
const buildPlainCreditsPoster = (
    pixi: PixiModule,
    options: TemperaCreditsOptions,
): TemperaCreditsView => {
    const { palette, metadata, width, height } = options;
    const { Container, Text, TextStyle } = pixi;
    const container = new Container();
    const filters: import('pixi.js').Filter[] = [];
    const items: CreditsItem[] = [];
    const seed = hashTemperaSeed(`${metadata.title ?? ''}|plain`);
    const halfWidth = width / 2;
    const halfHeight = height / 2;
    const bleed = Math.hypot(width, height) * 0.25;
    const flip = temperaHash01(seed, 1, 229) > 0.5 ? 1 : -1;

    const add = (
        node: import('pixi.js').Container,
        item: Partial<Omit<CreditsItem, 'node' | 'baseX' | 'baseY'>> = {},
    ) => {
        items.push({
            node,
            baseX: node.x,
            baseY: node.y,
            baseAlpha: item.baseAlpha ?? 1,
            enterDX: item.enterDX ?? 0,
            enterDY: item.enterDY ?? 0,
            delay: item.delay ?? 0,
            driftX: item.driftX ?? 0,
            driftY: item.driftY ?? 0,
            grow: item.grow ?? 0,
        });
        container.addChild(node);
    };

    // 纸底：重合的每一页都是纸，卡不能浮在黑上。
    container.addChild(drawPolygonFill(
        pixi,
        rectPolygon(-halfWidth - bleed, -halfHeight - bleed, width + bleed * 2, height + bleed * 2),
        palette.paper,
        1,
        null,
    ));

    const fontFamily = resolveThemeFontStack(options.theme);
    const fontWeight = String(resolveThemeFontWeight(options.theme, 600)) as import('pixi.js').TextStyleFontWeight;
    const titleSize = Math.max(26, Math.min(width, height) * 0.11 * options.lyricsFontScale);
    const title = new Text({
        text: metadata.title?.trim() || '\u266a',
        style: new TextStyle({
            fontFamily,
            fontWeight,
            fontSize: titleSize,
            fill: palette.ink,
            align: 'center',
            wordWrap: true,
            wordWrapWidth: Math.min(width * 0.78, Math.hypot(width, height) * 0.6),
        }),
    });
    title.anchor.set(0.5);
    title.position.set(0, 0);

    const arcPoints = (x1: number, y1: number, cx: number, cy: number, x2: number, y2: number) => {
        const points: number[] = [];
        for (let step = 0; step <= 20; step += 1) {
            const t = step / 20;
            const u = 1 - t;
            points.push(
                u * u * x1 + 2 * u * t * cx + t * t * x2,
                u * u * y1 + 2 * u * t * cy + t * t * y2,
            );
        }
        return points;
    };

    // 标题上方一笔、下方一笔，方向各偏一次，像随手划的。
    const reach = Math.max(title.width, titleSize * 2.4) * 0.62;
    const topY = -titleSize * 0.95;
    const bottomY = titleSize * 0.95;
    add(
        drawPolyline(
            pixi,
            arcPoints(-reach * flip, topY + titleSize * 0.25, reach * 0.1 * flip, topY - titleSize * 0.55, reach * 0.92 * flip, topY - titleSize * 0.1),
            palette.accent,
            2.1,
            0.55,
        ),
        { delay: 0.34, enterDX: -28 * flip, driftX: -6 * flip },
    );
    add(
        drawPolyline(
            pixi,
            arcPoints(-reach * 0.8 * flip, bottomY - titleSize * 0.12, -reach * 0.05 * flip, bottomY + titleSize * 0.5, reach * 0.72 * flip, bottomY + titleSize * 0.06),
            palette.accent,
            1.7,
            0.42,
        ),
        { delay: 0.46, enterDX: 24 * flip, driftX: 5 * flip },
    );

    // 方括号：重合画面里包住一句词的那个记号。
    const bracketW = title.width / 2 + titleSize * 0.42;
    const bracketH = title.height / 2 + titleSize * 0.3;
    const tick = titleSize * 0.28;
    const leftBracket = [
        -bracketW + tick, -bracketH,
        -bracketW, -bracketH,
        -bracketW, bracketH,
        -bracketW + tick, bracketH,
    ];
    const rightBracket = leftBracket.map((value, index) => (index % 2 === 0 ? -value : value));
    add(drawPolyline(pixi, leftBracket, palette.ink, 1.6, 0.6), { delay: 0.56, enterDX: -14 });
    add(drawPolyline(pixi, rightBracket, palette.ink, 1.6, 0.6), { delay: 0.6, enterDX: 14 });
    add(title, { delay: 0.18, enterDY: titleSize * 0.18 });

    const updateTime = (elapsed: number) => {
        const creep = creditsCreep(elapsed);
        for (const item of items) {
            const enter = easeTemperaEnter((elapsed - item.delay) / 1.1);
            item.node.alpha = item.baseAlpha * enter;
            item.node.visible = enter > 0.001;
            item.node.position.set(
                item.baseX + item.enterDX * (1 - enter) + item.driftX * creep,
                item.baseY + item.enterDY * (1 - enter) + item.driftY * creep,
            );
            if (item.grow !== 0) item.node.scale.set(1 + item.grow * creep);
        }
    };
    updateTime(0);
    return { container, filters, updateTime };
};
