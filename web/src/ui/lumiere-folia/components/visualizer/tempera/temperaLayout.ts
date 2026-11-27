import type { TemperaSegment, TemperaShotKind } from './types';
import { temperaHash01 } from './temperaRandom';
import { resolveTemperaShotProfile } from './temperaShotProfiles';
import { TEMPERA_ENTER_STYLES, type TemperaEnterStyle } from './temperaEnterStyles';
import {
    buildTemperaWordUnit,
    createTemperaMeasureContext,
    type TemperaMeasureContext,
    type TemperaWordUnit,
} from './temperaMeasure';
import type { WenflashLineDirection, WenflashLineDirectionMode } from '../../../../wenflashSettings';

// @note Version Control: Project Folia version 0.6.13-750617

// src/components/visualizer/tempera/temperaLayout.ts
// Collage typesetting: words from wordSegmentation.ts (resolved at compile time) are measured through
// pretext, packed into ragged rows inside the shot's region, then each row and word gets a
// seeded indent / baseline shift / rotation. The result keeps a readable reading order while
// looking assembled rather than typed.
export type TemperaTextArrangement = 'horizontal' | 'vertical' | 'graphic';
export type TemperaGraphicShape = 'ring' | 'wave' | 'burst';

/** 文闪的排列选择；`mixed` 按歌词行交替横排/竖排。 */
export const resolveTemperaArrangement = (
    arrangement: TemperaTextArrangement | 'mixed',
    lineIndex: number,
): TemperaTextArrangement => (
    arrangement === 'mixed'
        ? (lineIndex % 2 === 0 ? 'horizontal' : 'vertical')
        : arrangement
);

export interface TemperaGlyphPlacement {
    /** Per-glyph base ink (a wash along the line); keyword `color` still wins over it. */
    tint?: string | null;
    char: string;
    rowIndex: number;
    lineIndex: number;
    segmentIndex: number;
    x: number;
    y: number;
    /** Measured ink advance of this glyph at its laid-out font size. */
    width: number;
    rotation: number;
    startTime: number;
    endTime: number;
    settleTime: number;
    fontSize: number;
    /** Keyword colour from the theme; keeps its hue instead of being inverted. */
    color: string | null;
    enterX: number;
    enterY: number;
    enterRotation: number;
    enterScale: number;
    /** How this glyph arrives; picked per word so a word lands as one gesture. */
    enterStyle: TemperaEnterStyle;
    /** Post-sung release: when the tracking expansion completes, and this glyph's lever arm. */
    releaseTime: number;
    trackingX: number;
    trackingY: number;
}

export interface TemperaLineAnchor {
    /** Last glyph's left edge / bottom edge; keeps the original downward chain exact. */
    left: number;
    bottom: number;
    /** Full line box, used by the 8-way direction chain to avoid overlapping the previous line. */
    lineLeft: number;
    lineRight: number;
    lineTop: number;
    lineBottom: number;
    centerX: number;
    centerY: number;
    fontSize: number;
}

interface TemperaLayoutOptions {
    /** Segments per lyric line of the shot; each inner array is one lyric line. */
    lines: TemperaSegment[][];
    centered?: boolean;
    shotKind: TemperaShotKind;
    width: number;
    height: number;
    baseFontSize: number;
    fontFamily: string;
    fontWeight: number;
    seed: number;
    /** Per-segment keyword colours, shaped exactly like `lines`. */
    segmentColors?: (string | null)[][];
    /** 0..1 entrance pacing; see SETTLE_STRETCH. Defaults to the balanced middle. */
    settleStretch?: number;
    /** 文闪: horizontal is the collage rows; vertical stacks each lyric line into a column. */
    arrangement?: TemperaTextArrangement;
    /** 文闪图形档的轨迹。 */
    graphicShape?: TemperaGraphicShape;
    /** 文闪链式排版：每句作为整体，下一句接上一句末字。 */
    chained?: boolean;
    /** 上一句最后一个字的左边缘与底边；首句为 null。 */
    previousLineAnchor?: TemperaLineAnchor | null;
    /** 文闪链式排版的落点：跟随上一句、按 8 方向接续，或落在画面内的随机位置。 */
    linePlacement?: 'follow' | 'direction' | 'random';
    /** `direction` 档的固定方向。 */
    lineDirection?: WenflashLineDirection;
    /** `direction` 档的方向演变：固定 / 每句顺时针转 45° / 按句种子随机。 */
    lineDirectionMode?: WenflashLineDirectionMode;
}

interface LayoutRegion {
    centerX: number;
    centerY: number;
    width: number;
    height: number;
    align: 'center' | 'left' | 'right';
    rotation: number;
    fontScale: number;
}

interface LayoutRow {
    words: TemperaWordUnit[];
    width: number;
    height: number;
}


export const isTemperaLayoutSegment = (segment: TemperaSegment) => segment.text.trim().length > 0;

// Regions and entrance vectors are data, held per composition in temperaShotProfiles.
const resolveRegion = (shotKind: TemperaShotKind, width: number, height: number): LayoutRegion => {
    const { region } = resolveTemperaShotProfile(shotKind);
    return {
        centerX: region.cx * width,
        centerY: region.cy * height,
        width: region.w * width,
        height: region.h * height,
        align: region.align,
        rotation: region.rotation,
        fontScale: region.fontScale,
    };
};

const resolveEnterVector = (shotKind: TemperaShotKind, fontSize: number) => {
    const { enter } = resolveTemperaShotProfile(shotKind);
    return { x: enter.x * fontSize, y: enter.y * fontSize };
};

const rotateAbout = (x: number, y: number, cx: number, cy: number, angle: number) => {
    if (angle === 0) return { x, y };
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dx = x - cx;
    const dy = y - cy;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
};

// One word per lyric line is promoted to a hero size; the rest vary slightly around the base
// so a row reads as a composed group instead of a uniform strip.
const resolveWordScales = (segments: TemperaSegment[], seed: number, lineIndex: number) => {
    const lengths = segments.map(segment => (segment.isWordLike ? segment.graphemes.length : 0));
    const maxLength = Math.max(0, ...lengths);
    const heroCandidates = lengths.flatMap((length, index) => (
        length > 0 && length >= maxLength - 1 ? [index] : []
    ));
    const heroIndex = heroCandidates.length > 0
        ? heroCandidates[Math.floor(temperaHash01(seed, lineIndex, 101) * heroCandidates.length) % heroCandidates.length]
        : -1;
    // A wide gap between the hero and the rest is what gives the shot a center of gravity.
    return segments.map((_, index) => (
        index === heroIndex
            ? 1.34 + temperaHash01(seed, lineIndex * 31 + index, 103) * 0.26
            : 0.7 + temperaHash01(seed, lineIndex * 31 + index, 107) * 0.16
    ));
};

// Greedy packing with a seeded per-row fill budget, which is what makes the rows ragged.
// A new lyric line always starts a new row so the reading order stays obvious.
const packRows = (words: TemperaWordUnit[], maxWidth: number, seed: number): LayoutRow[] => {
    const rows: LayoutRow[] = [];
    let current: TemperaWordUnit[] = [];
    let currentWidth = 0;
    const budgetFor = (rowIndex: number) => maxWidth * (0.72 + temperaHash01(seed, rowIndex, 109) * 0.28);
    const flush = () => {
        if (current.length === 0) return;
        rows.push({ words: current, width: currentWidth, height: 0 });
        current = [];
        currentWidth = 0;
    };

    words.forEach(word => {
        const newLine = current.length > 0 && word.lineIndex !== current[0].lineIndex;
        const advance = current.length === 0 ? word.width : word.width + word.leadingGap;
        if (newLine || (current.length > 0 && currentWidth + advance > budgetFor(rows.length))) flush();
        currentWidth += current.length === 0 ? word.width : advance;
        current.push(word);
    });
    flush();
    return rows;
};

/**
 * Word segmentation exists to pick font sizes, not to space the text out. The gap before a
 * word is a real space only when the source actually had whitespace there; a plain
 * segmentation boundary (every CJK word break) gets nothing but an optical hair.
 */
const buildWordUnits = (
    ctx: TemperaMeasureContext,
    lines: TemperaSegment[][],
    fontSize: number,
    seed: number,
) => lines.flatMap((segments, lineIndex) => {
    const scales = resolveWordScales(segments, seed, lineIndex);
    let previousEnd: number | null = null;
    return segments.flatMap((segment, segmentIndex) => {
        const unit = buildTemperaWordUnit(ctx, segment, lineIndex, segmentIndex, fontSize, scales[segmentIndex]);
        if (!unit) return [];
        const spaced = previousEnd !== null && segment.startOffset > previousEnd;
        unit.leadingGap = previousEnd === null ? 0 : fontSize * (spaced ? 0.26 : 0.035);
        previousEnd = segment.endOffset;
        return [unit];
    });
});

/** Shortest entrance any glyph gets, whatever else the shot's pace says. */
const MIN_SETTLE_SECONDS = 0.34;
/**
 * Default for how much of the way to the shot's lyric end an entrance stretches, past the
 * floor. Exposed as a tuning (`glyphSettleStretch`); this is the single dial between the two
 * behaviours that were tried on their own:
 *
 * - 0 gives every glyph the same short window regardless of where it sits in the shot. Dense,
 *   quickly cut songs read percussively that way - each glyph snaps in ~0.09s and then holds -
 *   but a slow phrase lands everything in the first second and then nothing moves.
 * - 1 lands the whole shot exactly on its lyric end. That keeps a slow phrase alive the whole
 *   way through, but leaves a fast shot with no moment at rest at all: the mean dwell before
 *   the cut goes to zero, every glyph is still travelling, and the type reads as mush.
 *
 * Half keeps most of the shot settled before it cuts while still giving a long phrase an
 * entrance that runs deep into it.
 */
const DEFAULT_SETTLE_STRETCH = 0.5;

/**
 * Paces every entrance against the end of the lyric *this shot* carries, then sets the
 * post-sung release.
 *
 * A glyph starts on its own lyric time and its window is the floor plus a share of whatever
 * distance is left to that end, so the stagger shortens smoothly from the first glyph to the
 * last and the shot arrives as one sweep rather than as a row of independent pops. Because the
 * curve is heavily front-loaded, a long window is a decisive opening followed by a slow creep,
 * not a slow arrival.
 *
 * The target is the shot's own lyric end. By default a shot shows a half-phrase and one source
 * line commonly runs across several shots; whole-line mode instead makes that shot end equal
 * the line's lyric end. In either case `lines` is already the exact slice set this shot carries,
 * and slices shown together are paced together. Only a glyph that starts within the floor of
 * the end lands after it.
 *
 * The alpha and echo ramps do not follow this window (see temperaMotion): a glyph that stayed
 * half-transparent for the length of a shot would not be readable.
 *
 * The release is separate: a glyph that stops moving the moment it has been sung leaves the
 * whole line frozen for the rest of a long shot, so the block slowly widens its tracking from
 * its centre outward and each glyph's lever arm is simply its offset from that centre. That
 * ramp lasts as long as the glyph's own line and no longer.
 */
const applyGlyphTiming = (placements: TemperaGlyphPlacement[], settleStretch: number) => {
    if (placements.length === 0) return placements;
    const stretch = Number.isFinite(settleStretch) ? Math.min(1, Math.max(0, settleStretch)) : DEFAULT_SETTLE_STRETCH;
    const lineSpans = new Map<number, number>();
    placements.forEach(placement => {
        const current = lineSpans.get(placement.lineIndex) ?? 0;
        lineSpans.set(placement.lineIndex, Math.max(current, placement.endTime));
    });
    const lineStarts = new Map<number, number>();
    placements.forEach(placement => {
        const current = lineStarts.get(placement.lineIndex) ?? Number.POSITIVE_INFINITY;
        lineStarts.set(placement.lineIndex, Math.min(current, placement.startTime));
    });

    // Every placement here belongs to the one shot being laid out.
    const shotLyricEnd = placements.reduce((latest, p) => Math.max(latest, p.endTime), 0);
    placements.forEach(placement => {
        const reach = Math.max(0, shotLyricEnd - placement.startTime - MIN_SETTLE_SECONDS);
        placement.settleTime = placement.startTime + MIN_SETTLE_SECONDS + reach * stretch;
    });
    // Centre of the composed block; the expansion is measured from here, so the layout keeps
    // its exact shape and only its spacing opens up.
    const centerX = placements.reduce((sum, placement) => sum + placement.x, 0) / placements.length;
    const centerY = placements.reduce((sum, placement) => sum + placement.y, 0) / placements.length;
    placements.forEach(placement => {
        const span = Math.max(
            0.5,
            (lineSpans.get(placement.lineIndex) ?? placement.endTime)
            - (lineStarts.get(placement.lineIndex) ?? placement.startTime),
        );
        placement.releaseTime = Math.max(placement.endTime, placement.settleTime) + span;
        placement.trackingX = placement.x - centerX;
        placement.trackingY = placement.y - centerY;
    });

    return placements;
};


interface TemperaFlowGlyph {
    char: string;
    startTime: number;
    endTime: number;
    lineIndex: number;
    segmentIndex: number;
    color: string | null;
    width: number;
}

/** Measures one lyric line and returns its drawable glyphs in reading order. */
const collectTemperaLineGlyphs = (
    ctx: TemperaMeasureContext,
    segments: TemperaSegment[],
    lineIndex: number,
    fontSize: number,
    segmentColors?: (string | null)[][],
): TemperaFlowGlyph[] => segments.flatMap((segment, segmentIndex) => {
    const unit = buildTemperaWordUnit(ctx, segment, lineIndex, segmentIndex, fontSize, 1);
    if (!unit) return [];
    const color = segmentColors?.[lineIndex]?.[segmentIndex] ?? null;
    return unit.glyphs
        .filter(glyph => glyph.char.trim().length > 0)
        .map(glyph => ({
            char: glyph.char,
            startTime: glyph.startTime,
            endTime: glyph.endTime,
            lineIndex,
            segmentIndex,
            color,
            width: glyph.width,
        }));
});

const resolveFlowEntrance = (
    shotKind: TemperaShotKind,
    fontSize: number,
    seed: number,
    salt: number,
) => {
    const base = resolveEnterVector(shotKind, fontSize);
    const baseAngle = Math.atan2(base.y, base.x);
    const baseMagnitude = Math.hypot(base.x, base.y);
    const spread = (temperaHash01(seed, salt, 149) - 0.5) * 1.7;
    const magnitude = baseMagnitude * (0.55 + temperaHash01(seed, salt, 151) * 1.05);
    const angle = baseAngle + spread;
    return {
        enterX: Math.cos(angle) * magnitude,
        enterY: Math.sin(angle) * magnitude,
        enterRotation: (temperaHash01(seed, salt, 157) - 0.5) * 0.7,
        enterScale: 0.6 + temperaHash01(seed, salt, 163) * 0.3,
        enterStyle: TEMPERA_ENTER_STYLES[
            Math.floor(temperaHash01(seed, salt, 193) * TEMPERA_ENTER_STYLES.length)
            % TEMPERA_ENTER_STYLES.length
        ],
    };
};

const pushFlowPlacement = (
    placements: TemperaGlyphPlacement[],
    input: Omit<TemperaGlyphPlacement, 'settleTime' | 'releaseTime' | 'trackingX' | 'trackingY'>,
) => {
    placements.push({
        ...input,
        settleTime: input.endTime,
        releaseTime: 0,
        trackingX: 0,
        trackingY: 0,
    });
};

/** 竖排：每行歌词成一列，字自上而下落位；列序仍按阅读顺序从左到右。 */
const layoutVerticalFlow = (options: {
    lines: TemperaSegment[][];
    ctx: TemperaMeasureContext;
    baseFontSize: number;
    shotKind: TemperaShotKind;
    seed: number;
    segmentColors?: (string | null)[][];
    width: number;
    height: number;
    centerX: number;
    centerY: number;
}): TemperaGlyphPlacement[] => {
    const active = options.lines
        .map((segments, lineIndex) => ({ segments, lineIndex }))
        .filter(entry => entry.segments.some(isTemperaLayoutSegment));
    if (active.length === 0) return [];
    const counts = active.map(entry => entry.segments.reduce(
        (sum, segment) => sum + segment.graphemes.filter(grapheme => grapheme.char.trim().length > 0).length,
        0,
    ));
    const maxCount = Math.max(1, ...counts);
    const areaWidth = options.width * 0.78;
    const areaHeight = options.height * 0.74;
    const fontSize = Math.max(18, Math.min(
        options.baseFontSize,
        areaHeight * 0.94 / Math.max(1, maxCount * 1.06),
        areaWidth * 0.94 / Math.max(1, active.length * 1.16),
    ));
    const columnGap = fontSize * 1.16;
    const totalWidth = (active.length - 1) * columnGap;
    const placements: TemperaGlyphPlacement[] = [];
    active.forEach((entry, columnIndex) => {
        const glyphs = collectTemperaLineGlyphs(
            options.ctx,
            entry.segments,
            columnIndex,
            fontSize,
            options.segmentColors,
        );
        if (glyphs.length === 0) return;
        const advance = fontSize * 1.06;
        const totalHeight = glyphs.length * advance;
        const x = options.centerX - totalWidth / 2 + columnIndex * columnGap;
        let y = options.centerY - totalHeight / 2 + fontSize * 0.53;
        glyphs.forEach((glyph, glyphIndex) => {
            const entrance = resolveFlowEntrance(
                options.shotKind,
                fontSize,
                options.seed,
                entry.lineIndex * 997 + glyphIndex * 37 + 7,
            );
            pushFlowPlacement(placements, {
                char: glyph.char,
                rowIndex: columnIndex,
                lineIndex: columnIndex,
                segmentIndex: glyph.segmentIndex,
                x,
                y,
                width: glyph.width,
                rotation: 0,
                startTime: glyph.startTime,
                endTime: glyph.endTime,
                fontSize,
                color: glyph.color,
                ...entrance,
            });
            y += advance;
        });
    });
    return placements;
};

/** 图形档：把整句字沿环形、波浪或放射轨迹排开，字仍按歌词时钟逐个落位。 */
const layoutGraphicFlow = (options: {
    lines: TemperaSegment[][];
    ctx: TemperaMeasureContext;
    baseFontSize: number;
    shotKind: TemperaShotKind;
    seed: number;
    segmentColors?: (string | null)[][];
    width: number;
    height: number;
    centerX: number;
    centerY: number;
    shape: TemperaGraphicShape;
}): TemperaGlyphPlacement[] => {
    const count = options.lines.reduce((total, segments) => total + segments.reduce(
        (sum, segment) => sum + segment.graphemes.filter(grapheme => grapheme.char.trim().length > 0).length,
        0,
    ), 0);
    if (count === 0) return [];
    const areaWidth = options.width * 0.8;
    const areaHeight = options.height * 0.76;
    const minDim = Math.min(areaWidth, areaHeight);
    let fontSize = Math.min(options.baseFontSize, areaHeight * 0.18);
    if (options.shape === 'ring') {
        fontSize = Math.min(
            fontSize,
            (Math.PI * 2 * minDim * 0.33) / Math.max(1, count) * 0.92,
        );
    } else if (options.shape === 'wave') {
        fontSize = Math.min(
            fontSize,
            (areaWidth * 0.76) / Math.max(1, count) * 0.92,
        );
    } else {
        const spokes = Math.min(6, Math.max(3, Math.ceil(count / 4)));
        const perSpoke = Math.ceil(count / spokes);
        const startR = minDim * 0.10;
        const maxR = minDim * 0.36;
        const stepR = perSpoke > 1 ? (maxR - startR) / (perSpoke - 1) : maxR * 0.2;
        fontSize = Math.min(fontSize, stepR * 0.82);
    }
    fontSize = Math.max(18, fontSize);
    const glyphs = options.lines.flatMap((segments, lineIndex) => collectTemperaLineGlyphs(
        options.ctx,
        segments,
        lineIndex,
        fontSize,
        options.segmentColors,
    ));
    const n = glyphs.length;
    const placements: TemperaGlyphPlacement[] = [];
    const spokes = Math.min(6, Math.max(3, Math.ceil(n / 4)));
    const perSpoke = Math.ceil(n / spokes);
    const startR = minDim * 0.10;
    const maxR = minDim * 0.36;
    const stepR = perSpoke > 1 ? (maxR - startR) / (perSpoke - 1) : 0;
    glyphs.forEach((glyph, index) => {
        let x = options.centerX;
        let y = options.centerY;
        let rotation = 0;
        if (n > 1 && options.shape === 'ring') {
            const angle = -Math.PI / 2 + (index / n) * Math.PI * 2;
            const radius = minDim * 0.33;
            x = options.centerX + Math.cos(angle) * radius;
            y = options.centerY + Math.sin(angle) * radius;
            // 保持字正立，只随环切线轻微倾斜；整字旋转会让下半圈倒过来。
            rotation = Math.sin(angle) * 0.18;
        } else if (n > 1 && options.shape === 'wave') {
            const span = areaWidth * 0.76;
            const phase = (index / (n - 1)) * Math.PI * 2 * 1.15;
            x = options.centerX - span / 2 + (index / (n - 1)) * span;
            y = options.centerY + Math.sin(phase) * Math.min(areaHeight * 0.14, span * 0.09);
            rotation = Math.cos(phase) * 0.16;
        } else if (n > 1) {
            const spoke = index % spokes;
            const ring = Math.floor(index / spokes);
            const angle = -Math.PI / 2 + (spoke / spokes) * Math.PI * 2;
            const radius = startR + ring * stepR;
            x = options.centerX + Math.cos(angle) * radius;
            y = options.centerY + Math.sin(angle) * radius;
            // 放射只负责位置，字仍保持正立，避免下半圈倒字。
            rotation = Math.sin(angle) * 0.12;
        }
        const entrance = resolveFlowEntrance(options.shotKind, fontSize, options.seed, index * 991 + 7);
        pushFlowPlacement(placements, {
            char: glyph.char,
            rowIndex: 0,
            lineIndex: glyph.lineIndex,
            segmentIndex: glyph.segmentIndex,
            x,
            y,
            width: glyph.width,
            rotation,
            startTime: glyph.startTime,
            endTime: glyph.endTime,
            fontSize,
            color: glyph.color,
            ...entrance,
        });
    });
    return placements;
};

const LINE_DIRECTIONS: WenflashLineDirection[] = [
    'south', 'southeast', 'east', 'northeast', 'north', 'northwest', 'west', 'southwest',
];

const resolveChainedDirection = (
    options: {
        seed: number;
        lineDirection?: WenflashLineDirection;
        lineDirectionMode?: WenflashLineDirectionMode;
    },
    lineOrdinal: number,
    lineClock: number,
): WenflashLineDirection => {
    const base = Math.max(0, LINE_DIRECTIONS.indexOf(options.lineDirection ?? 'south'));
    if (options.lineDirectionMode === 'rotate') {
        return LINE_DIRECTIONS[(base + lineOrdinal) % LINE_DIRECTIONS.length];
    }
    if (options.lineDirectionMode === 'random') {
        const salt = lineClock * 17 + lineOrdinal * 131 + 29;
        return LINE_DIRECTIONS[Math.floor(temperaHash01(options.seed, salt, 251) * LINE_DIRECTIONS.length)];
    }
    return LINE_DIRECTIONS[base];
};

/**
 * 文闪链式排版：一整句保持为一个整体，下一句的首字接在上一句末字的左边缘下方。
 * 不换行、不缩放适配屏幕；每句唱完/出画面都由舞台裁切，不做摄像机跟随。
 */
const layoutChainedFlow = (options: {
    lines: TemperaSegment[][];
    ctx: TemperaMeasureContext;
    baseFontSize: number;
    shotKind: TemperaShotKind;
    seed: number;
    segmentColors?: (string | null)[][];
    width: number;
    height: number;
    direction: 'horizontal' | 'vertical';
    previousLineAnchor?: TemperaLineAnchor | null;
    linePlacement?: 'follow' | 'direction' | 'random';
    lineDirection?: WenflashLineDirection;
    lineDirectionMode?: WenflashLineDirectionMode;
}): TemperaGlyphPlacement[] => {
    const active = options.lines
        .map((segments, lineIndex) => ({segments, lineIndex}))
        .filter(entry => entry.segments.some(isTemperaLayoutSegment));
    if (active.length === 0) return [];

    const placements: TemperaGlyphPlacement[] = [];
    let anchor = options.previousLineAnchor ?? null;
    active.forEach((entry, lineOrdinal) => {
        const glyphs = collectTemperaLineGlyphs(
            options.ctx,
            entry.segments,
            entry.lineIndex,
            options.baseFontSize,
            options.segmentColors,
        );
        if (glyphs.length === 0) return;

        const fontSize = options.baseFontSize;
        const gap = Math.max(2, fontSize * 0.18);
        const totalWidth = glyphs.reduce((sum, glyph) => sum + glyph.width, 0);
        const totalHeight = glyphs.length * fontSize * 1.06;
        let cursorX: number;
        let cursorY: number;
        const randomPlacement = options.linePlacement === 'random';
        const directionPlacement = options.linePlacement === 'direction';
        if (randomPlacement) {
            // 每句落在画面内的随机位置；用句子的绝对时间做盐，保证整首歌每一句都不同，
            // 又不会因为分镜重建、拖动或重播而跳位。仅靠行号的话每个镜头都从 0 开始，
            // 整首只会重复那几个点。
            const margin = Math.max(16, fontSize * 0.45);
            const lineClock = Math.round((glyphs[0]?.startTime ?? 0) * 1000);
            const salt = lineClock * 31 + entry.lineIndex * 131 + lineOrdinal * 541;
            if (options.direction === 'horizontal') {
                const spanX = Math.max(0, options.width - totalWidth - margin * 2);
                const spanY = Math.max(0, options.height - fontSize - margin * 2);
                cursorX = margin + temperaHash01(options.seed, salt, 211) * spanX;
                cursorY = margin + fontSize / 2 + temperaHash01(options.seed, salt, 223) * spanY;
            } else {
                const spanX = Math.max(0, options.width - fontSize - margin * 2);
                const spanY = Math.max(0, options.height - totalHeight - margin * 2);
                cursorX = margin + fontSize / 2 + temperaHash01(options.seed, salt, 227) * spanX;
                cursorY = margin + fontSize / 2 + temperaHash01(options.seed, salt, 229) * spanY;
            }
        } else if (directionPlacement && anchor) {
            const lineClock = Math.round((glyphs[0]?.startTime ?? 0) * 1000);
            const direction = resolveChainedDirection(options, lineOrdinal, lineClock);
            if (options.direction === 'horizontal') {
                switch (direction) {
                    case 'north':
                        cursorX = anchor.left;
                        cursorY = anchor.lineTop - gap - fontSize / 2;
                        break;
                    case 'northeast':
                        cursorX = anchor.lineRight + gap;
                        cursorY = anchor.lineTop - gap - fontSize / 2;
                        break;
                    case 'east':
                        cursorX = anchor.lineRight + gap;
                        cursorY = anchor.centerY;
                        break;
                    case 'southeast':
                        cursorX = anchor.lineRight + gap;
                        cursorY = anchor.lineBottom + gap + fontSize / 2;
                        break;
                    case 'south':
                        cursorX = anchor.left;
                        cursorY = anchor.bottom + gap + fontSize / 2;
                        break;
                    case 'southwest':
                        cursorX = anchor.lineLeft - gap - totalWidth;
                        cursorY = anchor.lineBottom + gap + fontSize / 2;
                        break;
                    case 'west':
                        cursorX = anchor.lineLeft - gap - totalWidth;
                        cursorY = anchor.centerY;
                        break;
                    default:
                        cursorX = anchor.lineLeft - gap - totalWidth;
                        cursorY = anchor.lineTop - gap - fontSize / 2;
                        break;
                }
            } else {
                switch (direction) {
                    case 'north':
                        cursorX = anchor.left;
                        cursorY = anchor.lineTop - gap - totalHeight + fontSize / 2;
                        break;
                    case 'northeast':
                        cursorX = anchor.lineRight + gap;
                        cursorY = anchor.lineTop - gap - totalHeight + fontSize / 2;
                        break;
                    case 'east':
                        cursorX = anchor.lineRight + gap;
                        cursorY = anchor.centerY - totalHeight / 2 + fontSize / 2;
                        break;
                    case 'southeast':
                        cursorX = anchor.lineRight + gap;
                        cursorY = anchor.lineBottom + gap + fontSize / 2;
                        break;
                    case 'south':
                        cursorX = anchor.left;
                        cursorY = anchor.bottom + gap + fontSize / 2;
                        break;
                    case 'southwest':
                        cursorX = anchor.lineLeft - gap - fontSize;
                        cursorY = anchor.lineBottom + gap + fontSize / 2;
                        break;
                    case 'west':
                        cursorX = anchor.lineLeft - gap - fontSize;
                        cursorY = anchor.centerY - totalHeight / 2 + fontSize / 2;
                        break;
                    default:
                        cursorX = anchor.lineLeft - gap - fontSize;
                        cursorY = anchor.lineTop - gap - totalHeight + fontSize / 2;
                        break;
                }
            }
        } else if (anchor) {
            cursorX = anchor.left;
            cursorY = anchor.bottom + gap + fontSize / 2;
        } else if (options.direction === 'horizontal') {
            cursorX = options.width / 2 - totalWidth / 2;
            cursorY = options.height / 2;
        } else {
            cursorX = options.width / 2;
            cursorY = options.height / 2 - totalHeight / 2 + fontSize / 2;
        }

        let lastX = cursorX;
        let lastY = cursorY;
        let lineLeft = Number.POSITIVE_INFINITY;
        let lineRight = Number.NEGATIVE_INFINITY;
        let lineTop = Number.POSITIVE_INFINITY;
        let lineBottom = Number.NEGATIVE_INFINITY;
        const columnCenterX = cursorX + glyphs[0].width / 2;
        glyphs.forEach((glyph, glyphIndex) => {
            const entrance = resolveFlowEntrance(
                options.shotKind,
                fontSize,
                options.seed,
                entry.lineIndex * 997 + glyphIndex * 37 + 7,
            );
            const x = options.direction === 'horizontal' ? cursorX + glyph.width / 2 : columnCenterX;
            const y = options.direction === 'horizontal' ? cursorY : cursorY + glyphIndex * fontSize * 1.06;
            pushFlowPlacement(placements, {
                char: glyph.char,
                rowIndex: lineOrdinal,
                lineIndex: glyph.lineIndex,
                segmentIndex: glyph.segmentIndex,
                x,
                y,
                width: glyph.width,
                rotation: 0,
                startTime: glyph.startTime,
                endTime: glyph.endTime,
                fontSize,
                color: glyph.color,
                ...entrance,
            });
            if (options.direction === 'horizontal') cursorX += glyph.width;
            lastX = x;
            lastY = y;
            lineLeft = Math.min(lineLeft, x - glyph.width / 2);
            lineRight = Math.max(lineRight, x + glyph.width / 2);
            lineTop = Math.min(lineTop, y - fontSize / 2);
            lineBottom = Math.max(lineBottom, y + fontSize / 2);
        });

        const last = glyphs[glyphs.length - 1];
        anchor = {
            left: lastX - last.width / 2,
            bottom: lastY + fontSize / 2,
            lineLeft,
            lineRight,
            lineTop,
            lineBottom,
            centerX: (lineLeft + lineRight) / 2,
            centerY: (lineTop + lineBottom) / 2,
            fontSize,
        };
    });
    return placements;
};

export const resolveTemperaLayout = ({
    lines,
    shotKind,
    width,
    height,
    baseFontSize,
    fontFamily,
    fontWeight,
    seed,
    segmentColors,
    centered = false,
    settleStretch = DEFAULT_SETTLE_STRETCH,
    arrangement = 'horizontal',
    graphicShape = 'ring',
    chained = false,
    previousLineAnchor = null,
    linePlacement = 'follow',
    lineDirection = 'south',
    lineDirectionMode = 'fixed',
}: TemperaLayoutOptions): TemperaGlyphPlacement[] => {
    const region = resolveRegion(shotKind, width, height);
    if (centered) Object.assign(region, {centerX: width / 2, centerY: height / 2, width: width * 0.82, align: 'center'});
    const ctx = createTemperaMeasureContext(fontFamily, fontWeight);
    const areaFontSize = baseFontSize * region.fontScale;

    if (chained && arrangement !== 'graphic') {
        return applyGlyphTiming(layoutChainedFlow({
            lines,
            ctx,
            baseFontSize: areaFontSize,
            shotKind,
            seed,
            segmentColors,
            width,
            height,
            direction: arrangement,
            previousLineAnchor,
            linePlacement,
            lineDirection,
            lineDirectionMode,
        }), settleStretch);
    }

    if (arrangement !== 'horizontal') {
        const flowPlacements = arrangement === 'vertical'
            ? layoutVerticalFlow({
                lines, ctx, baseFontSize: areaFontSize, shotKind, seed, segmentColors,
                width, height, centerX: region.centerX, centerY: region.centerY,
            })
            : layoutGraphicFlow({
                lines, ctx, baseFontSize: areaFontSize, shotKind, seed, segmentColors,
                width, height, centerX: region.centerX, centerY: region.centerY, shape: graphicShape,
            });
        return applyGlyphTiming(flowPlacements, settleStretch);
    }

    // Fit loop: shrink until the packed rows sit inside the region.
    let fontSize = Math.max(14, baseFontSize * region.fontScale);
    let rows: LayoutRow[] = [];
    let blockHeight = 0;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        rows = packRows(buildWordUnits(ctx, lines, fontSize, seed), region.width, seed);
        rows.forEach((row, rowIndex) => {
            const tallest = Math.max(...row.words.map(word => word.scale));
            // Tight leading: the block should read as one mass, not as spaced-out lines.
            row.height = fontSize * tallest * (1.02 + temperaHash01(seed, rowIndex, 113) * 0.1);
        });
        blockHeight = rows.reduce((sum, row) => sum + row.height, 0);
        const maxRowWidth = Math.max(1, ...rows.map(row => row.width));
        const fit = Math.min(
            1,
            blockHeight > region.height ? region.height / blockHeight : 1,
            maxRowWidth > region.width ? region.width / maxRowWidth : 1,
        );
        if (fit >= 0.999) break;
        fontSize *= fit;
    }

    const base = resolveEnterVector(shotKind, fontSize);
    const baseAngle = Math.atan2(base.y, base.x);
    const baseMagnitude = Math.hypot(base.x, base.y);
    const placements: TemperaGlyphPlacement[] = [];
    let cursorY = region.centerY - blockHeight / 2;

    rows.forEach((row, rowIndex) => {
        const rowCenterY = cursorY + row.height / 2;
        cursorY += row.height;
        // Rows stagger horizontally and tilt slightly; that is the layered collage read.
        const drift = centered ? 0 : (temperaHash01(seed, rowIndex, 127) - 0.5) * region.width * 0.06;
        const rowRotation = centered ? 0 : (temperaHash01(seed, rowIndex, 131) - 0.5) * 0.06;
        const rowLeft = region.align === 'center'
            ? region.centerX - row.width / 2 + drift
            : region.align === 'left'
                ? region.centerX - region.width / 2 + Math.abs(drift) * 0.6
                : region.centerX + region.width / 2 - row.width - Math.abs(drift) * 0.6;
        const rowCenterX = rowLeft + row.width / 2;

        let cursorX = rowLeft;
        row.words.forEach((word, wordIndex) => {
            const salt = rowIndex * 37 + wordIndex;
            // One entrance style per word: neighbouring words arrive differently, but a word
            // never breaks apart into several different gestures.
            const enterStyle = TEMPERA_ENTER_STYLES[
                Math.floor(temperaHash01(seed, salt, 193) * TEMPERA_ENTER_STYLES.length)
                % TEMPERA_ENTER_STYLES.length
            ];
            const wordRotation = (temperaHash01(seed, salt, 137) - 0.5) * 0.07;
            const wordShiftY = (temperaHash01(seed, salt, 139) - 0.5) * fontSize * 0.09;
            const wordLeft = cursorX + (wordIndex === 0 ? 0 : word.leadingGap);
            cursorX = wordLeft + word.width;
            const wordCenterX = wordLeft + word.width / 2;
            const wordCenterY = rowCenterY + wordShiftY;
            const glyphSize = fontSize * word.scale;

            word.glyphs.forEach((glyph, glyphIndex) => {
                if (glyph.char.trim().length === 0) return;
                const localX = wordLeft + glyph.offset + glyph.width / 2;
                const rotatedWord = rotateAbout(localX, wordCenterY, wordCenterX, wordCenterY, wordRotation);
                const rotatedRow = rotateAbout(rotatedWord.x, rotatedWord.y, rowCenterX, rowCenterY, rowRotation);
                const finalPoint = rotateAbout(
                    rotatedRow.x,
                    rotatedRow.y,
                    region.centerX,
                    region.centerY,
                    region.rotation,
                );

                // Per-glyph entrance: the shot's base direction fanned out and re-scaled, so
                // no two glyphs in a row arrive on exactly the same vector.
                const glyphSalt = salt * 53 + glyphIndex;
                const spread = (temperaHash01(seed, glyphSalt, 149) - 0.5) * 1.7;
                const magnitude = baseMagnitude * (0.55 + temperaHash01(seed, glyphSalt, 151) * 1.05);
                const angle = baseAngle + spread;
                placements.push({
                    char: glyph.char,
                    rowIndex,
                    lineIndex: word.lineIndex,
                    segmentIndex: word.segmentIndex,
                    x: finalPoint.x,
                    y: finalPoint.y,
                    width: glyph.width,
                    rotation: region.rotation + rowRotation + wordRotation,
                    startTime: glyph.startTime,
                    endTime: glyph.endTime,
                    settleTime: glyph.endTime,
                    fontSize: glyphSize,
                    color: segmentColors?.[word.lineIndex]?.[word.segmentIndex] ?? null,
                    enterX: Math.cos(angle) * magnitude,
                    enterY: Math.sin(angle) * magnitude,
                    enterRotation: (temperaHash01(seed, glyphSalt, 157) - 0.5) * 0.7,
                    enterScale: 0.6 + temperaHash01(seed, glyphSalt, 163) * 0.3,
                    enterStyle,
                    releaseTime: 0,
                    trackingX: 0,
                    trackingY: 0,
                });
            });
        });
    });

    return applyGlyphTiming(placements, settleStretch);
};
