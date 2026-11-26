import type { TemperaGlyphPlacement } from './temperaLayout';
import type { TemperaPalette } from './temperaPalette';
import type { TemperaDecorFragment, TemperaDecorWatermark } from './types';
import type { TemperaGlyphMotionInput } from './temperaMotion';

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
    /** Keyword halo: a blurred, additive copy that lights up as the word is sung. */
    glow?: { display: import('pixi.js').Text; filter: import('pixi.js').BlurFilter | null; maximum: number; create: () => import('pixi.js').BlurFilter };
    /** Motion echoes trailing back along the entrance vector; empty when echoes are off. */
    echoes: import('pixi.js').Text[];
    /** Everything the per-frame motion solver needs; the runtime never reads layout again. */
    motion: TemperaGlyphMotionInput;
    /** The colour the glyph was written in; the mask pass restores it after a knockout. */
    fill: string;
    /** The keyword colour when this glyph is emphasised, otherwise null. */
    keyword: string | null;
    /** Whether the glyph is currently knocked out by the mask bar (cached to avoid re-rasterising). */
    masked?: boolean;
    maskStep?: number;
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
}

const SHADOW_OFFSET_X = 0.06;
const SHADOW_OFFSET_Y = 0.08;
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

        // Keywords get a halo copy underneath the glyph. It is a blurred second printing of the
        // same character in the same hue, drawn additively: alpha can only reach the ink colour,
        // add can push it towards white as the word is sung.
        let glow: TemperaGlyphView['glow'];
        if (placement.color) {
            const halo = new Text({
                text: placement.char,
                style: new TextStyle({...baseStyle, fill: placement.color,
                    stroke: options.blurAfterSinging
                        ? {color: placement.color, width: Math.max(1.5, placement.fontSize * 0.05), join: 'round'}
                        : undefined}),
            });
            halo.anchor.set(0.5);
            halo.rotation = placement.rotation;
            halo.alpha = 0;
            halo.visible = false;
            halo.blendMode = options.blurAfterSinging ? 'normal' : 'add';
            // Filters are made on first use, not at build: a scene can hold hundreds of glyphs
            // and each BlurFilter allocates render targets, which is what made track changes hitch.
            const createGlowFilter = () => new pixi.BlurFilter({strength: 0, quality: 3, resolution: 1});
            options.keywordLayer.addChild(halo);
            glow = {display: halo, filter: null, create: createGlowFilter, maximum: Math.min(9, Math.max(3.5, placement.fontSize * 0.05))};
        }
        (placement.color ? options.keywordLayer : options.textLayer).addChild(display);
        views.push({
            rowIndex: placement.rowIndex,
            display,
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
