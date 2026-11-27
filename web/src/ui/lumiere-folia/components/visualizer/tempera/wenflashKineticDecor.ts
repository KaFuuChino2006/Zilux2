import { temperaHash01 } from './temperaRandom';

type PixiModule = typeof import('pixi.js');

/** One glyph's current screen-space ink box, in the shot container's coordinates. */
export interface WenflashKineticGlyph {
    x: number;
    y: number;
    /** Unscaled ink-box width. Pixi's Text.width already includes scale, so passing that here
     * would multiply the stretch twice and blow the frame up on the entrance frame. */
    width: number;
    height: number;
    alpha: number;
    scaleX: number;
    scaleY: number;
    rotation: number;
    /** Settled layout centre and rotation; the shared frame uses these so its size never pumps. */
    finalX: number;
    finalY: number;
    finalRotation: number;
    /** The colour the glyph is actually painted in; decorations follow it instead of a fixed accent. */
    color: string;
    startTime: number;
    endTime: number;
    settleTime: number;
    enterX: number;
    enterY: number;
    keyword: boolean;
    rowIndex: number;
    index: number;
}

export interface WenflashKineticPalette {
    ink: string;
    accent: string;
    paper: string;
}

export interface WenflashKineticDecor {
    container: import('pixi.js').Container;
    update(
        time: number,
        glyphs: WenflashKineticGlyph[],
        progress: number,
        enter: number,
        exit: number,
        impact: number,
        intensity: number,
        density: number,
        speed: number,
        flashAlpha: number,
    ): void;
    destroy(): void;
}

const TWO_PI = Math.PI * 2;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => {
    const t = clamp01(value);
    return t * t * (3 - 2 * t);
};

const hashUnit = (seed: number, index: number, salt: number) => temperaHash01(seed, index, salt);

/** Most common sung colour, so the shared rails/corners read as part of the same word. */
const dominantColor = (glyphs: WenflashKineticGlyph[], fallback: string) => {
    const counts = new Map<string, number>();
    for (const glyph of glyphs) {
        if (glyph.color) counts.set(glyph.color, (counts.get(glyph.color) ?? 0) + 1);
    }
    let best = fallback;
    let bestCount = 0;
    for (const [color, count] of counts) {
        if (count > bestCount) {
            best = color;
            bestCount = count;
        }
    }
    return best;
};

/** Colour of the glyph nearest a point on the progress axis; used by cells and the scan head. */
const colorNear = (
    glyphs: WenflashKineticGlyph[],
    axis: number,
    vertical: boolean,
    fallback: string,
) => {
    let best = fallback;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const glyph of glyphs) {
        if (!glyph.color) continue;
        const distance = Math.abs((vertical ? glyph.y : glyph.x) - axis);
        if (distance < bestDistance) {
            best = glyph.color;
            bestDistance = distance;
        }
    }
    return best;
};

/**
 * 文闪的几何图形层。图形不做大椭圆、大飘带或手绘圈，而是贴在句子边缘的：
 * - 上下（竖排时左右）两条细边线，按进度点亮；
 * - 一排小方块进度格，逐字填满，当前格会稍微抬起；
 * - 四角短括号、每个字上方的小刻度、字角小方框；
 * - 一条随进度扫过句子的细游标线。
 *
 * 所有位置都从当前帧的字形包围盒重算，所以它跟着这一句的排版、镜头、入场、
 * 退场和撞击一起走；相位按字自己的 startTime 起算，不是全场一个时钟。
 */
export function createWenflashKineticDecor(
    pixi: PixiModule,
    palette: WenflashKineticPalette,
    seed: number,
): WenflashKineticDecor {
    const container = new pixi.Container();
    container.eventMode = 'none';
    const rails = new pixi.Graphics();
    const cells = new pixi.Graphics();
    const brackets = new pixi.Graphics();
    const ticks = new pixi.Graphics();
    const scan = new pixi.Graphics();
    container.addChild(rails, cells, brackets, ticks, scan);

    let bounds = {cx: 0, cy: 0, w: 0, h: 0};
    let release = 0;
    let lastUpdate = Number.NEGATIVE_INFINITY;

    const measure = (glyphs: WenflashKineticGlyph[]) => {
        let minX = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        let count = 0;
        for (const glyph of glyphs) {
            // The shared frame is measured from every glyph's settled layout box, not from
            // the glyphs that have already appeared. That keeps the rails / progress cells
            // at their final size from the first frame of the entrance.
            if (glyph.width <= 1 || glyph.height <= 1) continue;
            const cos = Math.abs(Math.cos(glyph.finalRotation));
            const sin = Math.abs(Math.sin(glyph.finalRotation));
            const halfW = (cos * glyph.width + sin * glyph.height) * 0.5;
            const halfH = (sin * glyph.width + cos * glyph.height) * 0.5;
            minX = Math.min(minX, glyph.finalX - halfW);
            maxX = Math.max(maxX, glyph.finalX + halfW);
            minY = Math.min(minY, glyph.finalY - halfH);
            maxY = Math.max(maxY, glyph.finalY + halfH);
            count += 1;
        }
        if (!count) return false;
        bounds = {
            cx: (minX + maxX) * 0.5,
            cy: (minY + maxY) * 0.5,
            w: Math.max(46, maxX - minX),
            h: Math.max(28, maxY - minY),
        };
        return true;
    };

    const drawRails = (
        glyphs: WenflashKineticGlyph[],
        time: number,
        progress: number,
        intensity: number,
        impact: number,
        vertical: boolean,
        pad: number,
    ) => {
        rails.clear();
        const {cx, cy, w, h} = bounds;
        const left = cx - w * 0.5 - pad;
        const right = cx + w * 0.5 + pad;
        const top = cy - h * 0.5 - pad;
        const bottom = cy + h * 0.5 + pad;
        const span = vertical ? (bottom - top) : (right - left);
        const dash = Math.max(5, Math.min(13, span / 22));
        const gap = 4;
        const step = dash + gap;
        const alpha = (0.14 + intensity * 0.34 + impact * 0.16) * (1 + Math.sin(time * 1.2) * 0.08);
        const head = (vertical ? top : left) + span * clamp01(progress);
        const baseColor = dominantColor(glyphs, palette.ink);
        const headColor = colorNear(glyphs, head, vertical, palette.accent);

        // Two thin edge rails, dashed so they read as geometry rather than a picture frame.
        for (let d = 0; d < span; d += step) {
            const a = (vertical ? top : left) + d;
            const b = Math.min((vertical ? bottom : right), a + dash);
            const active = a <= head;
            const color = active ? headColor : baseColor;
            const a0 = active ? alpha : alpha * 0.44;
            if (vertical) {
                rails.moveTo(left, a).lineTo(left, b).stroke({width: active ? 1.15 : 0.7, color, alpha: a0});
                rails.moveTo(right, a).lineTo(right, b).stroke({width: active ? 0.9 : 0.6, color, alpha: a0 * 0.8});
            } else {
                rails.moveTo(a, top).lineTo(b, top).stroke({width: active ? 1.15 : 0.7, color, alpha: a0});
                rails.moveTo(a, bottom).lineTo(b, bottom).stroke({width: active ? 0.9 : 0.6, color, alpha: a0 * 0.8});
            }
        }

        // End caps: short perpendicular ticks instead of a closed frame.
        const cap = 3 + intensity * 4;
        if (vertical) {
            rails.moveTo(left - cap, top).lineTo(left + cap, top).stroke({width: 0.9, color: baseColor, alpha: alpha * 0.8});
            rails.moveTo(left - cap, bottom).lineTo(left + cap, bottom).stroke({width: 0.9, color: baseColor, alpha: alpha * 0.8});
        } else {
            rails.moveTo(left, top - cap).lineTo(left, top + cap).stroke({width: 0.9, color: baseColor, alpha: alpha * 0.8});
            rails.moveTo(right, top - cap).lineTo(right, top + cap).stroke({width: 0.9, color: baseColor, alpha: alpha * 0.8});
        }
    };

    const drawCells = (
        glyphs: WenflashKineticGlyph[],
        time: number,
        progress: number,
        intensity: number,
        impact: number,
        vertical: boolean,
        pad: number,
    ) => {
        cells.clear();
        const {cx, cy, w, h} = bounds;
        const left = cx - w * 0.5 - pad;
        const right = cx + w * 0.5 + pad;
        const top = cy - h * 0.5 - pad;
        const bottom = cy + h * 0.5 + pad;
        const span = vertical ? (bottom - top) : (right - left);
        const count = Math.max(5, Math.min(20, Math.round(span / 23)));
        const gap = 3;
        const cell = Math.max(2, (span - gap * (count - 1)) / count);
        const thickness = 2.4 + intensity * 2.4 + impact * 1.8;
        const p = clamp01(progress);
        const filled = Math.floor(p * count + 0.0001);
        const base = vertical ? right + 4 : bottom + 4;
        for (let i = 0; i < count; i += 1) {
            const a = (vertical ? top : left) + i * (cell + gap);
            const isFilled = i < filled;
            const isHead = isFilled && i === Math.max(0, filled - 1);
            const breathe = isHead ? 1 + Math.sin(time * 4.2) * 0.12 : 1;
            const length = cell * breathe;
            const x = vertical ? base : a;
            const y = vertical ? a : base;
            const cellColor = colorNear(glyphs, a + cell * 0.5, vertical, palette.ink);
            if (isFilled) {
                cells.rect(x, y, vertical ? thickness : length, vertical ? length : thickness)
                    .fill({color: cellColor, alpha: 0.34 + intensity * 0.5 + impact * 0.2});
            } else {
                cells.rect(x, y, vertical ? Math.max(1, thickness * 0.45) : length, vertical ? length : Math.max(1, thickness * 0.45))
                    .stroke({width: 0.7, color: cellColor, alpha: 0.16 + intensity * 0.12});
            }
        }
    };

    const drawBrackets = (
        glyphs: WenflashKineticGlyph[],
        time: number,
        intensity: number,
        impact: number,
        pad: number,
    ) => {
        brackets.clear();
        const {cx, cy, w, h} = bounds;
        const left = cx - w * 0.5 - pad;
        const right = cx + w * 0.5 + pad;
        const top = cy - h * 0.5 - pad;
        const bottom = cy + h * 0.5 + pad;
        const arm = Math.min(15, Math.max(7, Math.min(right - left, bottom - top) * 0.12));
        const alpha = 0.2 + intensity * 0.4 + impact * 0.18;
        const baseColor = dominantColor(glyphs, palette.ink);
        const corners = [
            {x: left, y: top, sx: 1, sy: 1},
            {x: right, y: top, sx: -1, sy: 1},
            {x: right, y: bottom, sx: -1, sy: -1},
            {x: left, y: bottom, sx: 1, sy: -1},
        ];
        for (let i = 0; i < corners.length; i += 1) {
            const c = corners[i];
            const pulse = 1 + Math.sin(time * 1.9 + i * 1.7) * 0.16;
            const lx = c.x + c.sx * arm * pulse;
            const ly = c.y + c.sy * arm * pulse;
            brackets.moveTo(lx, c.y).lineTo(c.x, c.y).lineTo(c.x, ly)
                .stroke({width: 1.05, color: baseColor, alpha});
        }
    };

    const drawGlyphTicks = (
        glyphs: WenflashKineticGlyph[],
        time: number,
        intensity: number,
        impact: number,
        vertical: boolean,
    ) => {
        ticks.clear();
        for (const glyph of glyphs) {
            if (time < glyph.startTime) continue;
            const born = smooth(clamp01((time - glyph.startTime) / 0.28));
            const halfW = glyph.width * 0.5;
            const halfH = glyph.height * 0.5;
            const phase = hashUnit(seed, glyph.index, 211) * TWO_PI;
            const breathe = 0.65 + 0.35 * Math.sin(time * 2.2 + phase);
            const len = (2.6 + intensity * 4.2 + (glyph.keyword ? 2 : 0) + impact * 2.4) * breathe;
            // Do not multiply by glyph.alpha: that is the text's flash/hollow alpha, and
            // would make every tick blink in sync with the character.
            const alpha = (0.16 + intensity * 0.36) * born;
            if (alpha <= 0.004) continue;
            if (vertical) {
                ticks.moveTo(glyph.x - halfW - 2, glyph.y).lineTo(glyph.x - halfW - 2 - len, glyph.y)
                    .stroke({width: 0.9, color: glyph.color, alpha});
            } else {
                ticks.moveTo(glyph.x, glyph.y - halfH - 2).lineTo(glyph.x, glyph.y - halfH - 2 - len)
                    .stroke({width: 0.9, color: glyph.color, alpha});
            }
        }
    };

    const drawGlyphCorners = (
        glyphs: WenflashKineticGlyph[],
        time: number,
        intensity: number,
        vertical: boolean,
    ) => {
        // Small squares at each sung glyph's top-left ink corner. They are deliberately tiny;
        // this is the geometric equivalent of a registration mark, not a sticker.
        for (const glyph of glyphs) {
            if (time < glyph.startTime) continue;
            const halfW = glyph.width * 0.5;
            const halfH = glyph.height * 0.5;
            const size = 1.8 + intensity * 2.4 + (glyph.keyword ? 1.4 : 0);
            const x = glyph.x - halfW;
            const y = glyph.y - halfH;
            const born = smooth(clamp01((time - glyph.startTime) / 0.28));
            // Same as the ticks: geometry has its own life, it does not blink with the glyph.
            const alpha = (0.20 + intensity * 0.42) * born;
            brackets.rect(x - size * 0.5, y - size * 0.5, size, size)
                .fill({color: glyph.color, alpha});
            if (vertical && glyph.index % 3 === 0) {
                brackets.moveTo(x - 3, y + size).lineTo(x - 3, y + size + Math.min(8, halfH * 0.2))
                    .stroke({width: 0.8, color: glyph.color, alpha: alpha * 0.8});
            }
        }
    };

    const drawScan = (
        glyphs: WenflashKineticGlyph[],
        time: number,
        progress: number,
        intensity: number,
        impact: number,
        speed: number,
        vertical: boolean,
        pad: number,
    ) => {
        scan.clear();
        const {cx, cy, w, h} = bounds;
        const left = cx - w * 0.5 - pad;
        const right = cx + w * 0.5 + pad;
        const top = cy - h * 0.5 - pad;
        const bottom = cy + h * 0.5 + pad;
        const p = clamp01(progress);
        const pulse = 0.72 + 0.28 * Math.sin(time * 2.8 * Math.max(0.2, speed));
        const alpha = (0.30 + intensity * 0.5 + impact * 0.2) * pulse;
        if (vertical) {
            const y = top + (bottom - top) * p;
            const color = colorNear(glyphs, y, true, palette.accent);
            scan.moveTo(left, y).lineTo(right, y).stroke({width: 1.2, color, alpha});
            scan.rect(right - 2.5, y - 2.5, 5, 5).fill({color, alpha: Math.min(1, alpha * 1.4)});
        } else {
            const x = left + (right - left) * p;
            const color = colorNear(glyphs, x, false, palette.accent);
            scan.moveTo(x, top).lineTo(x, bottom).stroke({width: 1.2, color, alpha});
            scan.rect(x - 2.5, top - 2.5, 5, 5).fill({color, alpha: Math.min(1, alpha * 1.4)});
        }
    };

    return {
        container,
        update(time, glyphs, progress, _enter, _exit, impact, intensity, _density, speed, flashAlpha) {
            const target = clamp01(intensity);
            const dt = lastUpdate === Number.NEGATIVE_INFINITY ? 0 : Math.max(0, Math.min(0.1, time - lastUpdate));
            lastUpdate = time;
            // 关闭时也继续更新，让图形在 0.18s 内收干净，而不是把最后一帧冻在句尾。
            release = target > release
                ? Math.min(target, release + dt / 0.14)
                : Math.max(target, release - dt / 0.18);
            const visible = measure(glyphs);
            // 文闪风格：几何层的出入场闪烁由 shotFrame 用与文字相同的
            // 闪烁次数/窗口/暗拍比例算好，再作为透明度传进来；几何层只负责自己的淡入淡出。
            const power = release * clamp01(flashAlpha);
            container.visible = visible && power > 0.002;
            container.alpha = power;
            if (!container.visible) {
                rails.clear();
                cells.clear();
                brackets.clear();
                ticks.clear();
                scan.clear();
                return;
            }
            const vertical = bounds.h > bounds.w * 1.08;
            const pad = Math.min(18, Math.max(8, Math.min(bounds.w, bounds.h) * 0.16));
            drawRails(glyphs, time, progress, power, impact, vertical, pad);
            drawCells(glyphs, time, progress, power, impact, vertical, pad);
            drawBrackets(glyphs, time, power, impact, pad);
            drawGlyphTicks(glyphs, time, power, impact, vertical);
            drawGlyphCorners(glyphs, time, power, vertical);
            drawScan(glyphs, time, progress, power, impact, speed, vertical, pad);
        },
        destroy() {
            container.destroy({children: true});
        },
    };
}
