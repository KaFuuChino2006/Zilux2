import { overlapFx } from '../../../../overlapSettings';
type PixiModule = typeof import('pixi.js');

// src/components/visualizer/tempera/temperaOverlapGrid.ts
// The sheet the line is written on. A faint ruled grid sits behind everything and drifts
// against the follow camera (parallax), so the type reads as being nearer than the paper.
// When the camera pushes in, the paper swells up from just under the line rather than denting
// towards it: the type sits on a crest, so the sheet reads as a surface with give in it.

export interface OverlapGridState {
    time: number;
    /** Viewport position the camera is centring, in screen pixels. */
    focusX: number;
    focusY: number;
    /** Follow camera zoom, 1 = rest. */
    zoom: number;
    /** Follow camera roll, radians. */
    roll: number;
}

export interface TemperaOverlapGrid {
    container: import('pixi.js').Container;
    update: (state: OverlapGridState, dt: number) => void;
    resize: (width: number, height: number) => void;
    setInk: (ink: string) => void;
    destroy: () => void;
}

const PITCH = 76;
const LINE_ALPHA = 0.07;

export const createTemperaOverlapGrid = (
    pixi: PixiModule,
    width: number,
    height: number,
    ink: string,
): TemperaOverlapGrid => {
    const container = new pixi.Container();
    const graphics = new pixi.Graphics();
    container.addChild(graphics);

    let viewWidth = width;
    let viewHeight = height;
    let inkHex = ink;

    const draw = (focusX: number, focusY: number, amount: number) => {
        const fx = overlapFx();
        graphics.clear();
        if (!fx.showGrid || fx.decorAlpha <= 0.005) return;
        const lens = fx.gridLens;
        const radius = Math.min(viewWidth, viewHeight) * 0.34;
        const reach = radius * 1.15;
        const strength = amount * lens * 0.62;
        const below = strength > 0.001;
        // The crest sits below the line, not on it: the page bulges up under the type and the
        // words rest on the shoulder of the hill.
        const bulgeX = focusX;
        const bulgeY = focusY + radius * 0.55;
        const half = Math.max(viewWidth, viewHeight) * 0.62 + PITCH;
        // Clip sampling to a box around the viewport: the plate is faint, but drawing a grid
        // for the whole rotated cover on every frame is wasted work.
        const line = (points: number[][]) => {
            if (points.length < 2) return;
            graphics.moveTo(points[0][0], points[0][1]);
            for (let i = 1; i < points.length; i++) graphics.lineTo(points[i][0], points[i][1]);
            graphics.stroke({width: 1, color: inkHex, alpha: LINE_ALPHA * fx.decorAlpha});
        };
        const push = (px: number, py: number): number[] => {
            if (below) {
                // Radial push away from the crest: a dome, not a well.
                const dx = px - bulgeX;
                const dy = py - bulgeY;
                const distance = Math.hypot(dx, dy);
                if (distance < reach && distance > 0.001) {
                    const k = (1 - distance / reach) ** 2 * strength * 1.2;
                    return [px + dx * k, py + dy * k];
                }
            }
            return [px, py];
        };
        for (let x = -half; x <= half; x += PITCH) {
            const column: number[][] = [];
            for (let y = -half; y <= half; y += PITCH) column.push(push(x, y));
            line(column);
        }
        for (let y = -half; y <= half; y += PITCH) {
            const row: number[][] = [];
            for (let x = -half; x <= half; x += PITCH) row.push(push(x, y));
            line(row);
        }
    };

    return {
        container,
        update: (state) => {
            const fx = overlapFx();
            container.visible = fx.showGrid && fx.decorAlpha > 0.005;
            if (!container.visible) return;
            const parallax = fx.gridParallax;
            const dx = (state.focusX - viewWidth / 2) * parallax;
            const dy = (state.focusY - viewHeight / 2) * parallax;
            container.position.set(viewWidth / 2 - dx, viewHeight / 2 - dy);
            container.rotation = state.roll * 0.3;
            // Dolly split: the paper drifts on a farther plane, so a push-in barely moves it.
            const paperScale = 1 + (state.zoom - 1) * (1 - overlapFx().dollySplit * 0.92);
            container.scale.set(paperScale);
            // The lens is measured in the grid's own space, so undo the transform for the focus.
            const cos = Math.cos(-container.rotation);
            const sin = Math.sin(-container.rotation);
            const ox = state.focusX - container.x;
            const oy = state.focusY - container.y;
            const localX = (ox * cos - oy * sin) / paperScale;
            const localY = (ox * sin + oy * cos) / paperScale;
            const amount = Math.min(1, Math.max(0, (state.zoom - 1) / 0.18));
            draw(localX, localY, amount);
        },
        resize: (nextWidth, nextHeight) => {
            viewWidth = nextWidth;
            viewHeight = nextHeight;
        },
        setInk: (next) => {
            inkHex = next;
        },
        destroy: () => {
            graphics.destroy();
            container.destroy();
        },
    };
};
