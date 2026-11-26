import { overlapFx } from '../../../../overlapSettings';
type PixiModule = typeof import('pixi.js');

// src/components/visualizer/tempera/temperaOverlapHud.ts
// A surveyor's frame for 重合: graduated rules down all four edges and four cursors showing
// where on the page the line being sung sits. It hangs on the stage rather than inside the
// follow camera, so it stays put while the page turns underneath it - the frame is the room,
// the type is what moves through it. When the word under the playhead is a keyword the four
// cursors take that word's colour and the rules around them light up.

export interface OverlapHudState {
    time: number;
    /** Stage-space centre of the current line, in viewport pixels. */
    line: {x: number; y: number} | null;
    /** Colour of the keyword under the playhead, or null when the current glyph is plain. */
    keyword: string | null;
    /** Camera pan speed in page pixels per second, for the long-exposure streaks. */
    panSpeed?: number;
    /** Signed horizontal pan velocity, so the streaks trail on the correct side. */
    panVX?: number;
}

export interface TemperaOverlapHud {
    container: import('pixi.js').Container;
    update: (state: OverlapHudState, dt: number) => void;
    resize: (width: number, height: number) => void;
    setAccent: (accent: string) => void;
    destroy: () => void;
}

const TICK_ALPHA = 0.16;
const TICK_MAJOR_ALPHA = 0.34;
const CURSOR_ALPHA = 0.62;
const CORNER_ALPHA = 0.5;

export const createTemperaOverlapHud = (
    pixi: PixiModule,
    width: number,
    height: number,
    accent: string,
): TemperaOverlapHud => {
    const container = new pixi.Container();
    const streaks = new pixi.Graphics();
    const frame = new pixi.Graphics();
    const cursor = new pixi.Graphics();
    container.addChild(streaks, frame, cursor);

    let viewWidth = width;
    let viewHeight = height;
    let accentHex = accent;
    let keywordHex: string | null = null;
    let cursorX = width / 2;
    let cursorY = height / 2;
    let highlight = 0;
    let ready = false;

    const drawFrame = () => {
        frame.clear();
        const longTick = 14;
        const shortTick = 6;
        const columns = 24;
        const rows = 16;
        const alpha = overlapFx().decorAlpha;
        // Inner hairline: the frame should read as a plate the page sits inside, not just ticks.
        frame.rect(1, 1, viewWidth - 2, viewHeight - 2)
            .stroke({width: 1, color: accentHex, alpha: 0.08 * alpha});
        for (let column = 0; column <= columns; column += 1) {
            const x = (viewWidth * column) / columns;
            const major = column % 6 === 0;
            const length = major ? longTick : shortTick;
            frame.moveTo(x, 0).lineTo(x, length)
                .moveTo(x, viewHeight - length).lineTo(x, viewHeight)
                .stroke({
                    width: major ? 1.3 : 1,
                    color: accentHex,
                    alpha: (major ? TICK_MAJOR_ALPHA : TICK_ALPHA) * alpha,
                });
        }
        for (let row = 0; row <= rows; row += 1) {
            const y = (viewHeight * row) / rows;
            const major = row % 4 === 0;
            const length = major ? longTick : shortTick;
            frame.moveTo(0, y).lineTo(length, y)
                .moveTo(viewWidth - length, y).lineTo(viewWidth, y)
                .stroke({
                    width: major ? 1.3 : 1,
                    color: accentHex,
                    alpha: (major ? TICK_MAJOR_ALPHA : TICK_ALPHA) * alpha,
                });
        }
        // Corner brackets: four L-marks that give the frame a deliberate, built edge.
        const arm = 22;
        const inset = 4;
        const stroke = {width: 1.6, color: accentHex, alpha: CORNER_ALPHA * alpha, cap: 'round' as const};
        frame.moveTo(inset, inset + arm).lineTo(inset, inset).lineTo(inset + arm, inset).stroke(stroke);
        frame.moveTo(viewWidth - inset - arm, inset).lineTo(viewWidth - inset, inset).lineTo(viewWidth - inset, inset + arm).stroke(stroke);
        frame.moveTo(inset, viewHeight - inset - arm).lineTo(inset, viewHeight - inset).lineTo(inset + arm, viewHeight - inset).stroke(stroke);
        frame.moveTo(viewWidth - inset - arm, viewHeight - inset).lineTo(viewWidth - inset, viewHeight - inset).lineTo(viewWidth - inset, viewHeight - inset - arm).stroke(stroke);
    };

    const drawCursor = (time: number) => {
        cursor.clear();
        const alpha = overlapFx().decorAlpha;
        // The cursor takes the keyword's own colour while one is under the playhead, then eases
        // back to the stage accent as the plain type resumes.
        const ink = keywordHex && highlight > 0.05 ? keywordHex : accentHex;
        const baseAlpha = (CURSOR_ALPHA + 0.33 * highlight) * alpha;
        const glowAlpha = 0.2 * highlight * alpha * (0.85 + 0.15 * Math.sin(time * 2.6));
        // 四个边上的走动箭头：原来是 7px 的小三角，远看几乎看不见，放大一号才读得出「读到哪儿」。
        const size = 11.5 + highlight * 3.4;
        const reach = 26 + highlight * 7;
        // Bottom, top, left and right: the same mark on all four rules, so the reading position
        // is legible from whichever edge the eye is nearest.
        cursor.moveTo(cursorX, viewHeight - reach)
            .lineTo(cursorX - size, viewHeight - 1)
            .lineTo(cursorX + size, viewHeight - 1)
            .closePath()
            .fill({color: ink, alpha: baseAlpha});
        cursor.moveTo(cursorX, reach)
            .lineTo(cursorX - size, 1)
            .lineTo(cursorX + size, 1)
            .closePath()
            .fill({color: ink, alpha: baseAlpha});
        cursor.moveTo(reach, cursorY)
            .lineTo(1, cursorY - size)
            .lineTo(1, cursorY + size)
            .closePath()
            .fill({color: ink, alpha: baseAlpha});
        cursor.moveTo(viewWidth - reach, cursorY)
            .lineTo(viewWidth - 1, cursorY - size)
            .lineTo(viewWidth - 1, cursorY + size)
            .closePath()
            .fill({color: ink, alpha: baseAlpha});
        if (glowAlpha > 0.002) {
            const bloom = size * 2;
            cursor.moveTo(cursorX, viewHeight - reach - 4)
                .lineTo(cursorX - bloom, viewHeight - 1)
                .lineTo(cursorX + bloom, viewHeight - 1)
                .closePath()
                .fill({color: ink, alpha: glowAlpha * 0.55});
            cursor.moveTo(cursorX, reach + 4)
                .lineTo(cursorX - bloom, 1)
                .lineTo(cursorX + bloom, 1)
                .closePath()
                .fill({color: ink, alpha: glowAlpha * 0.55});
            cursor.moveTo(reach + 4, cursorY)
                .lineTo(1, cursorY - bloom)
                .lineTo(1, cursorY + bloom)
                .closePath()
                .fill({color: ink, alpha: glowAlpha * 0.55});
            cursor.moveTo(viewWidth - reach - 4, cursorY)
                .lineTo(viewWidth - 1, cursorY - bloom)
                .lineTo(viewWidth - 1, cursorY + bloom)
                .closePath()
                .fill({color: ink, alpha: glowAlpha * 0.55});
        }
        // Rules brighten in a short window around the cursor while a keyword is sung.
        if (highlight > 0.01) {
            const lit = 0.55 * highlight * alpha;
            const span = 16 + highlight * 6;
            for (const offset of [-8, 0, 8]) {
                const x = cursorX + offset;
                if (x < 2 || x > viewWidth - 2) continue;
                cursor.moveTo(x, 0).lineTo(x, span).stroke({width: 1.4, color: ink, alpha: lit * 0.7});
                cursor.moveTo(x, viewHeight - span).lineTo(x, viewHeight).stroke({width: 1.4, color: ink, alpha: lit * 0.7});
            }
            for (const offset of [-8, 0, 8]) {
                const y = cursorY + offset;
                if (y < 2 || y > viewHeight - 2) continue;
                cursor.moveTo(0, y).lineTo(span, y).stroke({width: 1.4, color: ink, alpha: lit * 0.7});
                cursor.moveTo(viewWidth - span, y).lineTo(viewWidth, y).stroke({width: 1.4, color: ink, alpha: lit * 0.7});
            }
        }
    };

    drawFrame();

    const update = (state: OverlapHudState, dt: number) => {
        const step = Math.max(0, Math.min(0.1, dt));
        if (state.line) {
            if (!ready) {
                cursorX = state.line.x;
                cursorY = state.line.y;
                ready = true;
            } else {
                const absorb = 1 - Math.exp(-step / 0.3);
                cursorX += (state.line.x - cursorX) * absorb;
                cursorY += (state.line.y - cursorY) * absorb;
            }
        }
        cursorX = Math.max(0, Math.min(viewWidth, cursorX));
        cursorY = Math.max(0, Math.min(viewHeight, cursorY));
        const target = state.keyword ? 1 : 0;
        keywordHex = state.keyword;
        highlight += (target - highlight) * (1 - Math.exp(-step / 0.16));
        if (ready) drawCursor(state.time);
        // Long exposure: only while the camera is actually travelling, and only at the two
        // sides the page is sliding toward, so it reads as motion blur rather than texture.
        streaks.clear();
        const travel = Math.max(0, Math.min(1, (state.panSpeed ?? 0) / 420)) * overlapFx().panStreak * overlapFx().decorAlpha;
        if (travel > 0.02) {
            const direction = (state.panVX ?? 0) >= 0 ? 1 : -1;
            for (let index = 0; index < 4; index += 1) {
                const wobble = Math.sin(state.time * 1.7 + index * 2.3);
                const y = viewHeight * (0.18 + index * 0.21) + wobble * 14;
                const length = 50 + 190 * (0.5 + 0.5 * Math.sin(state.time * 2.1 + index));
                const edge = direction > 0 ? 0 : viewWidth;
                streaks.moveTo(edge, y).lineTo(edge - direction * length, y)
                    .stroke({width: 1.4, color: '#ffffff', alpha: 0.24 * travel});
            }
        }
    };

    const setAccent = (next: string) => {
        if (next === accentHex) return;
        accentHex = next;
        drawFrame();
        drawCursor(0);
    };

    const resize = (nextWidth: number, nextHeight: number) => {
        viewWidth = nextWidth;
        viewHeight = nextHeight;
        cursorX = Math.max(0, Math.min(viewWidth, cursorX));
        cursorY = Math.max(0, Math.min(viewHeight, cursorY));
        drawFrame();
        drawCursor(0);
    };

    const destroy = () => {
        container.destroy({children: true});
    };

    return {container, update, resize, setAccent, destroy};
};
