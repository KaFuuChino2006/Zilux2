import type { TemperaGlyphPlacement } from './temperaLayout';
import type { TemperaPalette } from './temperaPalette';
import type { TemperaDecorFragment, TemperaDecorWatermark } from './types';
import type { TemperaGlyphMotionInput } from './temperaMotion';
import { createTemperaGlowFilter, type TemperaGlowFilter } from './temperaGlowFilter';
import { wenflashGlowChance, wenflashGlowColorMode, wenflashGlowColors } from '../../../../wenflashSettings';
import { hashTemperaSeed, temperaHash01 } from './temperaRandom';

// src/components/visualizer/tempera/temperaTextView.ts
// Builds one Pixi Text node per grapheme plus an offset ghost copy for print misregistration.
//
// The ghost lives *inside* the inverted layer, not below it. Below it, the ghost becomes part
// of the backdrop the filter samples: each glyph then flips colour against its own shadow and
// breaks into hard patches along its strokes. Inside the layer the filter colours ghost and
// glyph alike, so the offset copy reads as a second printing plate instead of corrupting the
// decision. Nothing is ever painted behind a glyph to emphasise it either - the inversion
// against the artwork is the emphasis.
type PixiModule = typeof import('pixi.js');

export interface TemperaGlyphView {
    rowIndex: number;
    display: import('pixi.js').Text;
    shadow: import('pixi.js').Text | null;
    sungBlur?: { filter: import('pixi.js').BlurFilter | null; maximum: number; create: () => import('pixi.js').BlurFilter };
    /** Text halo: a blurred, additive copy that lights up as the word is sung. */
    glow?: {
        display: import('pixi.js').Text;
        filter: import('pixi.js').BlurFilter | null;
        maximum: number;
        create: () => import('pixi.js').BlurFilter;
        /** Keywords get a moving colour ramp; every other word keeps a solid halo. */
        keyword: boolean;
        colors: [string, string, string];
        gradient?: TemperaGlowFilter;
    };
    /** Motion echoes trailing back along the entrance vector; empty when echoes are off. */
    echoes: import('pixi.js').Text[];
    /** Everything the per-frame motion solver needs; the runtime never reads layout again. */
    motion: TemperaGlyphMotionInput;
    /** The colour the glyph was written in; the mask pass restores it after a knockout. */
    fill: string;
    /** The keyword colour when this glyph is emphasised, otherwise null. */
    keyword: string | null;
    /**
     * 文闪镂空专用的描边副本。基字形永远保持正常填充，镂空只切换这一层的显隐，
     * 因此不存在「退出镂空时填充没恢复」的残留。
     */
    outline?: import('pixi.js').Text;
    posterEcho?: import('pixi.js').Text;
    /** Whether the glyph is currently knocked out by the mask bar (cached to avoid re-rasterising). */
    masked?: boolean;
    maskStep?: number;
    flashPaint?: 'solid' | 'outline';
    /** Last stroke ratio applied while the glyph was hollow, so dragging the width updates it. */
    flashOutlineWidth?: number;
    /** Absolute time until which the hollow outline lingers after being selected; 0 = line end. */
    hollowUntil?: number;
    /** Whether the per-line linger roll has already happened for this glyph. */
    hollowRolled?: boolean;
    /** Whether the glyph has ever been knocked out during this shot; used to carry hollow into exit. */
    hollowSeen?: boolean;
    /**
     * 落定后的抽帧放大一旦在这样的字上触发，就把镂空锁到本句结束。
     * 放大期间字形会把描边和填充的差异放大，若中途因为停留时长到点而回填，
     * 看起来就是「一放大镂空就没了」，同时辉光也会瞬间回到满亮度。
     */
    hollowLocked?: boolean;
    /** Whether the glyph should stay hollow through the exit flash instead of snapping back to fill. */
    exitHollow?: boolean;
    /** The solid flash block drawn behind this glyph; 文闪 only, absent elsewhere. */
    flashBox?: import('pixi.js').Graphics;
    /** The glyph's measured ink box in display-local space; the block is drawn from it. */
    flashBoxRect?: {x: number; y: number; width: number; height: number};
    /** Palette colours the block can use; resolved once when the stage is built. */
    flashBoxColors?: {accent: string; ink: string; paper: string};
    /** Cache key for the current block geometry/colour so it is not redrawn every frame. */
    flashBoxSignature?: string;
    baseX: number;
    baseY: number;
    shadowDX: number;
    shadowDY: number;
}

interface TemperaTextViewOptions {
    placements: TemperaGlyphPlacement[];
    palette: TemperaPalette;
    fontFamily: string;
    fontWeight: number;
    shadowEnabled: boolean;
    blurAfterSinging?: boolean;
    echoCount: number;
    textLayer: import('pixi.js').Container;
    /**
     * Rendered above the inverted layer and unfiltered. Echoes live here so a trail never
     * becomes backdrop the filter has to resolve against mid-entrance.
     */
    echoLayer: import('pixi.js').Container;
    /**
     * Rendered above the inverted layer and never filtered. Keyword glyphs live here so the
     * theme's `wordColors` hue survives; inverting them would throw the colour away.
     */
    keywordLayer: import('pixi.js').Container;
    /**
     * Rendered above the type as an additive bloom. Every glyph gets a halo here; keyword
     * halos add a moving colour ramp on top of the same blurred alpha.
     */
    glowLayer: import('pixi.js').Container;
    /** 文闪：每个字都有柔光；重合只给重点词，保持原样。 */
    glowAll?: boolean;
    /** 文闪 only: a layer under the type that carries the per-glyph flash blocks. */
    flashBoxLayer?: import('pixi.js').Container;
}

const SHADOW_OFFSET_X = 0.06;
const SHADOW_OFFSET_Y = 0.08;
/**
 * The solid 文闪 block must sit on the glyph's ink, not on the font's line box: a Text node is
 * as tall as the font's ascent + descent, which leaves a visible halo above and below a Han
 * character. Measure the actual ink rectangle in the display's local space (anchor 0.5) and
 * draw the block exactly there.
 */
let flashInkContext: CanvasRenderingContext2D | null | undefined;
const resolveFlashInkRect = (
    pixi: PixiModule,
    char: string,
    style: import('pixi.js').TextStyle,
): {x: number; y: number; width: number; height: number} => {
    const metrics = pixi.CanvasTextMetrics.measureText(char, style);
    const fontProperties = metrics.fontProperties;
    if (flashInkContext === undefined) {
        flashInkContext = typeof document === 'undefined'
            ? null
            : document.createElement('canvas').getContext('2d');
    }
    let inkLeft = 0;
    let inkRight = metrics.width;
    let inkAscent = fontProperties.ascent;
    let inkDescent = fontProperties.descent;
    if (flashInkContext) {
        flashInkContext.font = pixi.fontStringFromTextStyle(style);
        const ink = flashInkContext.measureText(char);
        inkLeft = ink.actualBoundingBoxLeft ?? inkLeft;
        inkRight = ink.actualBoundingBoxRight ?? inkRight;
        inkAscent = ink.actualBoundingBoxAscent ?? inkAscent;
        inkDescent = ink.actualBoundingBoxDescent ?? inkDescent;
    }
    // The Text is anchored at its centre, so the baseline sits at
    // -height/2 + ascent (+ half the extra line height) in local coordinates.
    const baseline = fontProperties.ascent
        + Math.max(0, (metrics.lineHeight - fontProperties.fontSize) / 2);
    return {
        x: -metrics.width / 2 - inkLeft,
        y: -metrics.height / 2 + baseline - inkAscent,
        width: Math.max(1, inkLeft + inkRight),
        height: Math.max(1, inkAscent + inkDescent),
    };
};
/** The ghost is tinted by the filter, so only its opacity is its own. */
export const buildTemperaTextViews = (
    pixi: PixiModule,
    options: TemperaTextViewOptions,
): TemperaGlyphView[] => {
    const { Text, TextStyle } = pixi;
    const { palette, fontFamily, fontWeight } = options;
    const views: TemperaGlyphView[] = [];
    const weightToken = String(fontWeight) as import('pixi.js').TextStyleFontWeight;

    options.placements.forEach(placement => {
        if (placement.char.trim().length === 0) return;
        const baseStyle = {
            fontFamily,
            fontWeight: weightToken,
            fontSize: placement.fontSize,
        };
        const display = new Text({
            text: placement.char,
            style: new TextStyle({ ...baseStyle, fill: placement.color ?? placement.tint ?? palette.ink }),
        });
        display.anchor.set(0.5);
        if (placement.color && options.blurAfterSinging) {
            display.style.fill = 0xffffff;
            display.tint = placement.color;
        }
        display.position.set(placement.x, placement.y);
        display.rotation = placement.rotation;

        // 文闪: an empty block parked behind the type. Its geometry is measured from the
        // glyph's ink, while colour/padding stay live so the settings sheet can tune them
        // without rebuilding the stage.
        let flashBox: import('pixi.js').Graphics | undefined;
        let flashBoxRect: TemperaGlyphView['flashBoxRect'];
        let flashBoxColors: TemperaGlyphView['flashBoxColors'];
        if (options.flashBoxLayer) {
            const ink = resolveFlashInkRect(pixi, placement.char, display.style);
            flashBox = new pixi.Graphics();
            flashBox.visible = false;
            options.flashBoxLayer.addChild(flashBox);
            flashBoxRect = ink;
            flashBoxColors = {accent: palette.accent, ink: palette.ink, paper: palette.paper};
        }

        // 文闪镂空副本：只画描边、不填色，基字形在镂空期间整体隐藏。
        // 这样基字形的 fill/stroke 从不被改写，闪烁结束后不会残留透明填充。
        const outline = options.flashBoxLayer
            ? new Text({
                text: placement.char,
                style: new TextStyle({
                    ...baseStyle,
                    fill: {color: 0xffffff, alpha: 0},
                    stroke: {color: placement.color ?? placement.tint ?? palette.ink, width: 1, join: 'round'},
                }),
            })
            : undefined;
        if (outline) {
            outline.anchor.set(0.5);
            outline.visible = false;
        }

        // Unblurred offset copy at partial alpha; the filter tints it with the glyph, so it
        // reads as an off-register second printing plate.
        let shadow: import('pixi.js').Text | null = null;
        if (options.shadowEnabled) {
            shadow = new Text({
                text: placement.char,
                style: new TextStyle({ ...baseStyle, fill: placement.color ?? placement.tint ?? palette.ink }),
            });
            shadow.anchor.set(0.5);
            shadow.rotation = placement.rotation;
            options.textLayer.addChildAt(shadow, 0);
        }

        // Motion echoes: dimmed copies parked further back along the entrance vector. The
        // runtime scales their offset per index, so they read as a trail rather than a blur.
        const echoes: import('pixi.js').Text[] = [];
        for (let index = 0; index < options.echoCount; index += 1) {
            const echo = new Text({
                text: placement.char,
                style: new TextStyle({ ...baseStyle, fill: placement.color ?? placement.tint ?? palette.tone4 }),
            });
            echo.anchor.set(0.5);
            echo.rotation = placement.rotation;
            echo.visible = false;
            options.echoLayer.addChild(echo);
            echoes.push(echo);
        }

        // 文闪的普通字按概率随机加柔光，重点词始终有；重合仍只给重点词加，避免改变既有画面。
        const keyword = placement.color;
        const glowRoll = options.glowAll && !keyword
            ? temperaHash01(hashTemperaSeed(`${placement.lineIndex}:${placement.rowIndex}:${placement.segmentIndex}:${placement.startTime.toFixed(3)}:${placement.char}`), 0, 0)
            : 0;
        const plainGlow = options.glowAll && !keyword && glowRoll < wenflashGlowChance();
        let glow: TemperaGlyphView['glow'];
        if (plainGlow || keyword) {
            const glowColor = keyword ?? placement.tint ?? palette.ink;
            const halo = new Text({
                text: placement.char,
                style: new TextStyle({...baseStyle, fill: keyword && !options.glowAll ? '#ffffff' : glowColor,
                    stroke: options.blurAfterSinging
                        ? {color: glowColor, width: Math.max(1.5, placement.fontSize * 0.05), join: 'round'}
                        : undefined}),
            });
            halo.anchor.set(0.5);
            halo.rotation = placement.rotation;
            halo.alpha = 0;
            halo.visible = false;
            halo.blendMode = options.glowAll || !options.blurAfterSinging ? 'add' : 'normal';
            // Filters are made on first use, not at build: a scene can hold hundreds of glyphs
            // and each BlurFilter allocates render targets, which is what made track changes hitch.
            const createGlowFilter = () => new pixi.BlurFilter({strength: 0, quality: 3, resolution: 1});
            options.glowLayer.addChild(halo);
            const gradientColors = options.glowAll && wenflashGlowColorMode() === 'custom'
                ? wenflashGlowColors()
                : [keyword!, palette.accent, palette.ink] as [string, string, string];
            const gradient = keyword
                ? createTemperaGlowFilter(pixi, gradientColors, glowColor)
                : undefined;
            glow = {
                display: halo,
                filter: null,
                create: createGlowFilter,
                maximum: Math.min(9, Math.max(3.5, placement.fontSize * 0.05)),
                keyword: !!keyword,
                colors: gradientColors,
                gradient,
            };
        }
        const glyphLayer = placement.color ? options.keywordLayer : options.textLayer;
        glyphLayer.addChild(display);
        if (outline) glyphLayer.addChild(outline);
        views.push({
            rowIndex: placement.rowIndex,
            display,
            outline,
            shadow,
            echoes,
            glow,
            sungBlur: options.blurAfterSinging ? {
                filter: null,
                create: () => new pixi.BlurFilter({ strength: 0, quality: 2, resolution: 1 }),
                maximum: Math.min(7, Math.max(1.5, placement.fontSize * 0.034)),
            } : undefined,
            fill: placement.color ?? placement.tint ?? palette.ink,
            keyword: placement.color,
            flashBox,
            flashBoxRect,
            flashBoxColors,
            motion: {
                startTime: placement.startTime,
                settleTime: placement.settleTime,
                endTime: placement.endTime,
                enterX: placement.enterX,
                enterY: placement.enterY,
                enterRotation: placement.enterRotation,
                enterScale: placement.enterScale,
                rotation: placement.rotation,
                enterStyle: placement.enterStyle,
                releaseTime: placement.releaseTime,
                trackingX: placement.trackingX,
                trackingY: placement.trackingY,
            },
            baseX: placement.x,
            baseY: placement.y,
            shadowDX: placement.fontSize * SHADOW_OFFSET_X,
            shadowDY: placement.fontSize * SHADOW_OFFSET_Y,
        });
    });

    // One oversized impression per phrase. Prefer a coloured word, then the
    // longest sung glyph; punctuation never becomes the centrepiece.
    if (options.glowAll) {
        let lead: TemperaGlyphView | undefined;
        let best = -1;
        for (const glyph of views) {
            if (!/[\p{L}\p{N}]/u.test(glyph.display.text)) continue;
            const score = (glyph.keyword ? 2 : 0) + Math.min(1, glyph.motion.endTime - glyph.motion.startTime);
            if (score <= best) continue;
            best = score;
            lead = glyph;
        }
        if (lead) {
            const fontSize = Number(lead.display.style.fontSize);
            const echo = new Text({text: lead.display.text, style: {
                fontFamily, fontWeight: weightToken, fontSize,
                fill: {color: 0xffffff, alpha: 0},
                stroke: {color: lead.fill, width: Math.max(0.75, fontSize * 0.014), join: 'round'},
            }});
            echo.anchor.set(0.5);
            echo.visible = false;
            options.textLayer.addChildAt(echo, 0);
            lead.posterEcho = echo;
        }
    }
    return views;
};

interface TemperaFragmentViewOptions {
    fragments: TemperaDecorFragment[];
    palette: TemperaPalette;
    fontFamily: string;
    fontWeight: number;
    baseFontSize: number;
    width: number;
    height: number;
    layer: import('pixi.js').Container;
}

// Stray glyphs parked in the margins of sparse compositions. They carry no timeline: the
// shot's own enter/exit alpha covers them, so playback never touches these nodes.
export const buildTemperaFragmentViews = (
    pixi: PixiModule,
    options: TemperaFragmentViewOptions,
) => {
    const { Text, TextStyle } = pixi;
    options.fragments.forEach(fragment => {
        const node = new Text({
            text: fragment.char,
            style: new TextStyle({
                fontFamily: options.fontFamily,
                fontWeight: String(options.fontWeight) as import('pixi.js').TextStyleFontWeight,
                fontSize: Math.max(12, options.baseFontSize * fragment.scale),
                fill: options.palette.ink,
            }),
        });
        node.anchor.set(0.5);
        node.position.set(fragment.x * options.width, fragment.y * options.height);
        node.rotation = fragment.rotation;
        node.alpha = 0.42;
        options.layer.addChild(node);
    });
};

interface TemperaWatermarkOptions {
    watermark: TemperaDecorWatermark;
    palette: TemperaPalette;
    fontFamily: string;
    fontWeight: number;
    baseFontSize: number;
    width: number;
    height: number;
    layer: import('pixi.js').Container;
}

/**
 * Oversized decorative word behind the composition. It is deliberately placed *below* the
 * inverted text layer, so the lyric flips colour where it crosses the watermark's strokes -
 * the decoration becomes part of the artwork the type reacts to, not a second lyric.
 */
export const buildTemperaWatermark = (
    pixi: PixiModule,
    options: TemperaWatermarkOptions,
) => {
    const { watermark } = options;
    if (!watermark.text.trim()) return;
    const node = new pixi.Text({
        text: watermark.text,
        style: new pixi.TextStyle({
            fontFamily: options.fontFamily,
            fontWeight: String(options.fontWeight) as import('pixi.js').TextStyleFontWeight,
            fontSize: Math.max(48, options.baseFontSize * watermark.scale),
            fill: options.palette.tone4,
        }),
    });
    node.anchor.set(0.5);
    node.position.set(watermark.x * options.width, watermark.y * options.height);
    node.rotation = watermark.rotation;
    node.alpha = 0.16;
    options.layer.addChild(node);
};
