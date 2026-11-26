import { overlapFx } from '../../../../overlapSettings';
type PixiModule = typeof import('pixi.js');

// src/components/visualizer/tempera/temperaOverlapSheet.ts
// The deep layer of 重合: a ghost of the line the size of a wall, and the creases a page picks
// up as it is turned. Both sit behind the type and lag the camera, so they read as distance
// rather than as another thing drawn on the same plane.
//
// A ghost is kept for one line after its own: it holds at full strength while the next line is
// written, then dissolves when the line after that begins. Four pooled texts cover current +
// holding + leaving + one spare; the oldest slot is recycled if a fifth line lands first.

export interface OverlapSheetState {
    time: number;
    focusX: number;
    focusY: number;
    zoom: number;
    roll: number;
}

export interface TemperaOverlapSheet {
    container: import('pixi.js').Container;
    /** Hand the line's characters, where they sit, and its stable key for the coin. */
    setLine: (text: string, x: number, y: number, time: number, key: string) => void;
    /** A page turn: lay another crease across the sheet, if this turn gets one. */
    addCrease: (time: number, key: string) => void;
    update: (state: OverlapSheetState, dt: number) => void;
    resize: (width: number, height: number) => void;
    setInk: (ink: string) => void;
    destroy: () => void;
}

interface Crease {
    angle: number;
    offset: number;
    born: number;
}

interface Ghost {
    view: import('pixi.js').Text;
    blur: import('pixi.js').BlurFilter;
    x: number;
    y: number;
    born: number;
    leaving: number | null;
    holding: boolean;
    used: boolean;
}

const hashKey = (key: string, salt: number) => {
    let hash = 2166136261 ^ salt;
    for (let index = 0; index < key.length; index += 1) {
        hash ^= key.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return ((hash >>> 0) % 100000) / 100000;
};

const CREASE_LIFE = 9;
const GHOST_ALPHA = 0.086;
const GHOST_FADE_IN = 0.9;
const GHOST_LEAVE = 1.8;
const GHOST_POOL = 4;

export const createTemperaOverlapSheet = (
    pixi: PixiModule,
    width: number,
    height: number,
    ink: string,
    fontFamily: string,
): TemperaOverlapSheet => {
    const container = new pixi.Container();
    const creases = new pixi.Graphics();
    container.addChild(creases);
    let viewWidth = width;
    let viewHeight = height;
    let inkHex = ink;
    const font = () => Math.max(72, Math.min(viewWidth, viewHeight) * 0.24);
    const ghostBlur = () => Math.max(2, Math.min(5, Math.min(viewWidth, viewHeight) * 0.0045));
    const ghosts: Ghost[] = [];
    for (let index = 0; index < GHOST_POOL; index += 1) {
        const view = new pixi.Text({
            text: '',
            style: {
                fontFamily,
                fontSize: font(),
                fontWeight: '700',
                fill: ink,
                align: 'center',
            },
        });
        view.anchor.set(0.5);
        view.alpha = 0;
        view.visible = false;
        // The ghost is a wall-sized memory of the line, so it is softened on its own: a wide,
        // low-quality blur reads as distance without touching the type in front of it.
        const blur = new pixi.BlurFilter({strength: ghostBlur(), quality: 1, resolution: 1});
        view.filters = [blur];
        container.addChild(view);
        ghosts.push({
            view, blur, x: width / 2, y: height / 2, born: -1, leaving: null, holding: false, used: false,
        });
    }
    const list: Crease[] = [];

    return {
        container,
        setLine: (text, x, y, time, key) => {
            // Not every line leaves a ghost: the coin is cast on the line's own key so a replay
            // leaves the same ones. The pool still advances when the coin misses, otherwise the
            // previous ghost would hold forever instead of handing over.
            const show = overlapFx().showSilhouette && hashKey(key, 291) < overlapFx().silhouetteChance;
            const glyphs = show ? Array.from(text).slice(0, 14).join('') : '';
            // The line being written becomes the holding ghost; the one that was holding starts
            // to dissolve. This is what delays every ghost by a full line.
            for (const ghost of ghosts) {
                if (!ghost.used || ghost.leaving !== null) continue;
                if (ghost.holding) {
                    ghost.holding = false;
                    ghost.leaving = time;
                } else {
                    ghost.holding = true;
                }
            }
            let target = ghosts.find(ghost => !ghost.used);
            if (!target) {
                const finished = ghosts
                    .filter(ghost => ghost.leaving !== null && time - ghost.leaving > GHOST_LEAVE)
                    .sort((a, b) => (a.leaving ?? 0) - (b.leaving ?? 0));
                target = finished[0]
                    ?? ghosts.filter(ghost => ghost.leaving !== null)
                        .sort((a, b) => (a.leaving ?? 0) - (b.leaving ?? 0))[0]
                    ?? ghosts.slice().sort((a, b) => a.born - b.born)[0];
            }
            target.view.text = glyphs;
            target.view.style.fontSize = font();
            target.x = x;
            target.y = y;
            // The silhouette is the furthest thing on the page, so it is the last to arrive.
            target.born = time + overlapFx().stagger * hashKey(key, 323);
            target.leaving = null;
            target.holding = false;
            target.used = true;
        },
        addCrease: (time, key) => {
            if (!overlapFx().showCrease) return;
            if (hashKey(key, 297) >= overlapFx().creaseChance) return;
            // Seeded by the moment rather than by the song: a crease belongs to the page being
            // turned now, not to a line that will be sung again on the next run.
            const seed = Math.abs(Math.sin(time * 12.9898) * 43758.5453) % 1;
            list.push({
                angle: Math.PI * 0.25 + (seed - 0.5) * 0.9,
                offset: (seed - 0.5) * Math.min(viewWidth, viewHeight) * 0.5,
                born: time + overlapFx().stagger * hashKey(key, 329),
            });
            while (list.length > 3) list.shift();
        },
        update: (state, _dt) => {
            const fx = overlapFx();
            container.visible = fx.showSilhouette || fx.showCrease;
            if (!container.visible) return;
            const parallax = 0.16;
            const dx = (state.focusX - viewWidth / 2) * parallax;
            const dy = (state.focusY - viewHeight / 2) * parallax;
            for (const ghost of ghosts) {
                const view = ghost.view;
                if (!ghost.used || state.time < ghost.born) {
                    view.visible = false;
                    continue;
                }
                const grown = Math.min(1, Math.max(0, (state.time - ghost.born) / GHOST_FADE_IN));
                let alpha = GHOST_ALPHA * grown * grown * (3 - 2 * grown) * fx.decorAlpha;
                let lift = 0;
                let scale = 1;
                if (ghost.leaving !== null) {
                    // One line later: the ghost lets go, drifting up and swelling a hair while
                    // it dries, so the background has an exit rather than a cut.
                    const out = Math.min(1, Math.max(0, (state.time - ghost.leaving) / GHOST_LEAVE));
                    const eased = out * out * (3 - 2 * out);
                    alpha *= 1 - eased;
                    lift = 26 * eased;
                    scale = 1 + 0.03 * eased;
                }
                view.visible = fx.showSilhouette && alpha > 0.002;
                view.alpha = alpha;
                // Same dolly split as the grid: the ghost lives on the far wall, so it takes
                // only the 0.35 share of the camera's push.
                const dolly = 1 + (state.zoom - 1) * (1 - overlapFx().dollySplit * 0.8);
                const gx = ghost.x - dx - viewWidth / 2;
                const gy = ghost.y - dy - lift + Math.sin(state.time * 0.6) * 6 - viewHeight / 2;
                view.position.set(viewWidth / 2 + gx * dolly, viewHeight / 2 + gy * dolly);
                view.rotation = state.roll * 0.22;
                view.scale.set(scale * dolly);
            }
            creases.clear();
            if (!fx.showCrease) return;
            for (const crease of list) {
                const age = state.time - crease.born;
                if (age < 0 || age > CREASE_LIFE) continue;
                const fadeIn = Math.min(1, age / 0.7);
                const fadeOut = Math.min(1, (CREASE_LIFE - age) / 2.2);
                const alpha = 0.05 * fadeIn * fadeOut * fx.decorAlpha;
                if (alpha < 0.002) continue;
                const cos = Math.cos(crease.angle);
                const sin = Math.sin(crease.angle);
                const cx = viewWidth / 2 + crease.offset * -sin - dx * 0.6;
                const cy = viewHeight / 2 + crease.offset * cos - dy * 0.6;
                const reach = Math.hypot(viewWidth, viewHeight) * 0.85;
                creases.moveTo(cx - cos * reach, cy - sin * reach)
                    .lineTo(cx + cos * reach, cy + sin * reach)
                    .stroke({width: 1.4, color: inkHex, alpha: alpha * 1.3});
                // A second hairline just off the first reads as the fold's lit edge.
                creases.moveTo(cx - cos * reach - sin * 2.2, cy - sin * reach + cos * 2.2)
                    .lineTo(cx + cos * reach - sin * 2.2, cy + sin * reach + cos * 2.2)
                    .stroke({width: 1, color: '#ffffff', alpha: alpha * 0.5});
            }
        },
        resize: (nextWidth, nextHeight) => {
            viewWidth = nextWidth;
            viewHeight = nextHeight;
            const strength = ghostBlur();
            for (const ghost of ghosts) ghost.blur.strength = strength;
        },
        setInk: (next) => {
            if (next === inkHex) return;
            inkHex = next;
            for (const ghost of ghosts) ghost.view.style.fill = next;
        },
        destroy: () => {
            for (const ghost of ghosts) {
                ghost.view.filters = null;
                ghost.blur.destroy();
                ghost.view.destroy();
            }
            creases.destroy();
            container.destroy();
        },
    };
};
