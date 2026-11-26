import * as pixi from 'pixi.js';
import { overlapFx } from '../../../../overlapSettings';

/**
 * 自己出现、自己消失的线稿：电路、星座、刻度盘，以及一批几何/制图图形。
 * 每个图形出生时记在纸面坐标上，跟着同一台相机走，走完自己的寿命再淡出；
 * 颜色每帧从当前这句歌词的取色带里取，所以会跟着句子变色。
 */
type AmbientKind = 'constellation' | 'circuit' | 'dial' | 'shape';

type ShapeKind =
    | 'ecg' | 'arrow' | 'gear' | 'nodes' | 'axes' | 'hatch'
    | 'brownian' | 'barcode' | 'lissajous' | 'rose' | 'polygon';

interface Segment {
    x1: number; y1: number; x2: number; y2: number;
    from: number;
    to: number;
}

type Point = {x: number; y: number};

interface AmbientItem {
    kind: AmbientKind;
    born: number;
    life: number;
    grow: number;
    hold: number;
    retract: number;
    ax: number;
    ay: number;
    x: number;
    y: number;
    color: number;
    tint: number;
    points?: {x: number; y: number; vx: number; vy: number}[];
    segments?: Segment[];
    total?: number;
    radius?: number;
    ticks?: number;
    spin?: number;
    direction?: number;
    phase?: number;
    shape?: ShapeKind;
    paths?: Point[][];
    spinRate?: number;
    /** 少量图形浮到文字前面，给画面一点前后层次。 */
    front?: boolean;
}

export interface TemperaOverlapAmbient {
    container: pixi.Container;
    update(state: {
        time: number;
        dt: number;
        follow: {x: number; y: number} | null;
        panX: number;
        panY: number;
        zoom: number;
        roll: number;
        halfWidth: number;
        halfHeight: number;
        colors: string[];
        /** 当前句在屏幕上的包围盒：图形不画进这里，字永远在最上层。 */
        avoid: {x: number; y: number; width: number; height: number} | null;
        width: number;
        height: number;
    }, dt: number): void;
    resize(width: number, height: number): void;
    setInk(ink: string): void;
    destroy(): void;
}

const MAX_ITEMS = 14;
const hex = (value: string): number => {
    const text = value.replace('#', '');
    return Number.parseInt(text.length === 3
        ? text.split('').map(char => char + char).join('')
        : text.slice(0, 6), 16);
};
const rand = (min: number, max: number) => min + Math.random() * (max - min);
const mix = (from: number, to: number, amount: number): number => {
    const r = Math.round(((from >> 16) & 255) + ((((to >> 16) & 255) - ((from >> 16) & 255)) * amount));
    const g = Math.round(((from >> 8) & 255) + ((((to >> 8) & 255) - ((from >> 8) & 255)) * amount));
    const b = Math.round((from & 255) + (((to & 255) - (from & 255)) * amount));
    return (r << 16) | (g << 8) | b;
};
const easeOut = (value: number) => 1 - (1 - value) * (1 - value);
const smooth = (value: number) => {
    const t = Math.min(1, Math.max(0, value));
    return t * t * (3 - 2 * t);
};

const ringSpot = (halfWidth: number, halfHeight: number, spread: number) => {
    const base = Math.hypot(halfWidth, halfHeight) + 64;
    const radius = base + rand(0, spread);
    const angle = rand(0, Math.PI * 2);
    return {x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, radius: base};
};

const pathLength = (paths: Point[][]): number => {
    let total = 0;
    for (const path of paths) {
        for (let index = 1; index < path.length; index += 1) {
            total += Math.hypot(path[index]!.x - path[index - 1]!.x, path[index]!.y - path[index - 1]!.y);
        }
    }
    return total;
};

const makeGear = (radius: number): Point[][] => {
    const teeth = Math.round(rand(12, 18));
    const step = (Math.PI * 2) / teeth;
    const outer: Point[] = [];
    for (let index = 0; index < teeth; index += 1) {
        const angle = index * step;
        const a = angle - step * 0.28;
        const b = angle + step * 0.28;
        outer.push({x: Math.cos(a) * radius, y: Math.sin(a) * radius});
        outer.push({x: Math.cos(a) * radius * 1.18, y: Math.sin(a) * radius * 1.18});
        outer.push({x: Math.cos(b) * radius * 1.18, y: Math.sin(b) * radius * 1.18});
        outer.push({x: Math.cos(b) * radius, y: Math.sin(b) * radius});
    }
    outer.push(outer[0]!);
    return [outer];
};

const makePolygon = (radius: number): Point[][] => {
    const paths: Point[][] = [];
    const layers = Math.round(rand(2, 3));
    for (let layer = 0; layer < layers; layer += 1) {
        const sides = Math.round(rand(3, 6));
        const r = radius * (1 - layer * 0.26);
        const turn = (layer * Math.PI) / sides;
        const path: Point[] = [];
        for (let index = 0; index <= sides; index += 1) {
            const angle = turn + (index / sides) * Math.PI * 2;
            path.push({x: Math.cos(angle) * r, y: Math.sin(angle) * r});
        }
        paths.push(path);
    }
    return paths;
};

const buildShape = (shape: ShapeKind, halfWidth: number, halfHeight: number): Point[][] => {
    const spot = ringSpot(halfWidth, halfHeight, 150);
    const size = rand(42, 78);
    const at = (x: number, y: number): Point => ({x: spot.x + x, y: spot.y + y});
    switch (shape) {
        case 'ecg': {
            const width = rand(150, 260);
            const path: Point[] = [at(-width / 2, 0)];
            for (let index = 1; index <= 8; index += 1) {
                const x = -width / 2 + (index / 8) * width;
                const spike = index % 3 === 0 ? rand(-26, -10) : rand(-5, 6);
                path.push(at(x, spike));
                if (index % 3 === 0) path.push(at(x + 5, rand(8, 16)));
            }
            return [path];
        }
        case 'arrow': {
            const reach = rand(80, 150);
            const y = rand(-40, 40);
            const shaft = [at(0, 0), at(reach * 0.55, 0), at(reach * 0.55, y), at(reach, y)];
            const head = [at(reach - 9, y - 5), at(reach, y), at(reach - 9, y + 5)];
            const ticks = [[at(18, -6), at(18, 6)], [at(34, -4), at(34, 4)]];
            return [shaft, head, ...ticks];
        }
        case 'gear':
            return makeGear(size * 0.8);
        case 'polygon':
            return makePolygon(size);
        case 'nodes': {
            const count = Math.round(rand(5, 7));
            const points = Array.from({length: count}, () => at(rand(-size, size), rand(-size * 0.8, size * 0.8)));
            const paths: Point[][] = [];
            for (let index = 1; index < points.length; index += 1) {
                const a = points[index - 1]!;
                const b = points[index]!;
                paths.push([a, {x: b.x, y: a.y}, b]);
            }
            return paths;
        }
        case 'axes': {
            const width = rand(90, 150);
            const height = rand(60, 110);
            const axis = [at(0, height), at(0, 0), at(width, 0)];
            const ticks: Point[][] = [];
            for (let index = 1; index <= 4; index += 1) {
                ticks.push([at(0, height - (index / 5) * height), at(-5, height - (index / 5) * height)]);
                ticks.push([at((index / 5) * width, 0), at((index / 5) * width, 5)]);
            }
            const trace = [at(10, height - 14), at(width * 0.4, height * 0.5), at(width * 0.72, height * 0.62), at(width - 8, 12)];
            return [axis, ...ticks, trace];
        }
        case 'hatch': {
            const count = Math.round(rand(6, 10));
            const span = rand(70, 120);
            const paths: Point[][] = [];
            for (let index = 0; index < count; index += 1) {
                const offset = (index / count) * span;
                paths.push([at(offset - span / 2, span / 2), at(offset - span / 2 + span, -span / 2)]);
            }
            return paths;
        }
        case 'brownian': {
            const path: Point[] = [at(0, 0)];
            let x = 0;
            let y = 0;
            for (let index = 0; index < 14; index += 1) {
                x += rand(-18, 18);
                y += rand(-14, 14);
                path.push(at(x, y));
            }
            return [path];
        }
        case 'barcode': {
            const width = rand(90, 150);
            const height = rand(28, 48);
            const paths: Point[][] = [];
            let x = 0;
            while (x < width) {
                paths.push([at(x, 0), at(x, height)]);
                x += rand(1.2, 3.6) + rand(2.4, 5.2);
            }
            return paths;
        }
        case 'lissajous': {
            const a = Math.round(rand(2, 4));
            const b = Math.round(rand(3, 5));
            const path: Point[] = [];
            for (let index = 0; index <= 72; index += 1) {
                const t = (index / 72) * Math.PI * 2;
                path.push(at(Math.sin(a * t) * size, Math.sin(b * t + 0.7) * size * 0.72));
            }
            return [path];
        }
        case 'rose': {
            const petals = Math.round(rand(3, 7));
            const path: Point[] = [];
            for (let index = 0; index <= 84; index += 1) {
                const t = (index / 84) * Math.PI * 2;
                const r = Math.cos(petals * t) * size;
                path.push(at(Math.cos(t) * r, Math.sin(t) * r));
            }
            return [path];
        }
    }
};

const SPINNERS: ShapeKind[] = ['gear', 'polygon', 'rose'];

const makeShapeItem = (shape: ShapeKind, halfWidth: number, halfHeight: number, color: number): AmbientItem => {
    const paths = buildShape(shape, halfWidth, halfHeight);
    return {
        kind: 'shape', born: 0, life: rand(9, 13), grow: rand(2.6, 4), hold: 3, retract: 1.8,
        ax: 0, ay: 0, x: 0, y: 0, color, tint: Math.random(),
        shape, paths, total: pathLength(paths),
        spinRate: SPINNERS.includes(shape) ? rand(-0.16, 0.16) : 0,
    };
};

const makeCircuit = (halfWidth: number, halfHeight: number, color: number): AmbientItem => {
    const segmentList: Segment[] = [];
    let total = 0;
    const grow = (x: number, y: number, angle: number, length: number, depth: number) => {
        const x2 = x + Math.cos(angle) * length;
        const y2 = y + Math.sin(angle) * length;
        segmentList.push({x1: x, y1: y, x2, y2, from: total, to: total + length});
        total += length;
        if (depth <= 0) return;
        if (Math.random() < 0.86) {
            grow(x2, y2, angle, length * rand(0.85, 1.25), depth - 1);
        }
        const branches = Math.random() < 0.2 ? 2 : 1;
        for (let index = 0; index < branches; index += 1) {
            const turn = (Math.PI / 2) * (Math.random() < 0.5 ? -1 : 1);
            grow(x2, y2, angle + turn, length * rand(0.6, 0.88), depth - 1);
        }
    };
    const spot = ringSpot(halfWidth, halfHeight, 130);
    grow(spot.x, spot.y, Math.random() < 0.5 ? 0 : Math.PI / 2, rand(42, 78), 5);
    return {
        kind: 'circuit', born: 0, life: 10.5, grow: 3.4, hold: 3.6, retract: 2.4,
        ax: 0, ay: 0, x: 0, y: 0, color, tint: Math.random(), segments: segmentList, total,
    };
};

const makeConstellation = (halfWidth: number, halfHeight: number, color: number): AmbientItem => {
    const count = Math.round(rand(6, 9));
    const base = Math.hypot(halfWidth, halfHeight) + 70;
    const points = Array.from({length: count}, () => {
        const angle = rand(0, Math.PI * 2);
        const radius = base + rand(0, 230);
        return {x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: rand(-7, 7), vy: rand(-5, 5)};
    });
    return {kind: 'constellation', born: 0, life: 15, grow: 1.2, hold: 12, retract: 1.8, ax: 0, ay: 0, x: 0, y: 0, color, tint: Math.random(), points};
};

const makeDial = (halfWidth: number, halfHeight: number, color: number): AmbientItem => {
    const spot = ringSpot(halfWidth, halfHeight, 200);
    return {
        kind: 'dial', born: 0, life: 9, grow: 0.9, hold: 7, retract: 1.2,
        ax: 0, ay: 0, x: spot.x, y: spot.y, color, tint: Math.random(), radius: rand(38, 66),
        ticks: Math.round(rand(20, 30)), spin: rand(0.22, 0.4),
        direction: Math.random() < 0.5 ? -1 : 1, phase: rand(0, Math.PI * 2),
    };
};

const SHAPES: ShapeKind[] = [
    'ecg', 'arrow', 'gear', 'nodes', 'axes', 'hatch',
    'brownian', 'barcode', 'lissajous', 'rose', 'polygon',
];

export const createTemperaOverlapAmbient = (
    pixiNamespace: typeof pixi,
    width: number,
    height: number,
    ink: string,
): TemperaOverlapAmbient => {
    const container = new pixiNamespace.Container();
    const graphics = new pixiNamespace.Graphics();
    container.addChild(graphics);
    let inkHex = hex(ink);
    let boxWidth = width;
    let boxHeight = height;
    let lastFollow: {x: number; y: number} | null = null;
    let lastHalfWidth = 120;
    let lastHalfHeight = 40;
    let lastColors: string[] = [];
    const items: AmbientItem[] = [];
    let nextSpawn = 1.2;
    let cursor = 0;

    // Every doodle eases in and out instead of popping: a soft 0.7s entrance and a 1.6s exit.
    const fadeOf = (item: AmbientItem, age: number): number => smooth(age / 0.7)
        * smooth((item.life - age) / 1.6)
        * (item.front ? 0.55 : 1);

    const colorOf = (item: AmbientItem): number => {
        if (!lastColors.length) return item.color;
        if (lastColors.length === 1) return hex(lastColors[0]!);
        const span = (lastColors.length - 1) * item.tint;
        const index = Math.min(lastColors.length - 2, Math.floor(span));
        return mix(hex(lastColors[index]!), hex(lastColors[index + 1]!), span - index);
    };

    const drawCircuit = (item: AmbientItem, time: number) => {
        const age = time - item.born;
        const total = item.total ?? 1;
        let reach = total;
        if (age < item.grow) reach = total * (age / item.grow);
        else if (age > item.grow + item.hold) {
            reach = total * Math.max(0, 1 - (age - item.grow - item.hold) / item.retract);
        }
        const alpha = fadeOf(item, age);
        for (const segment of item.segments ?? []) {
            if (segment.from >= reach) continue;
            const k = Math.min(1, (reach - segment.from) / Math.max(1, segment.to - segment.from));
            graphics.moveTo(item.ax + segment.x1, item.ay + segment.y1)
                .lineTo(item.ax + segment.x1 + (segment.x2 - segment.x1) * k, item.ay + segment.y1 + (segment.y2 - segment.y1) * k)
                .stroke({width: 1.1, color: colorOf(item), alpha: 0.55 * alpha, cap: 'round'});
        }
        for (const segment of item.segments ?? []) {
            if (segment.to <= reach) continue;
            const k = Math.min(1, Math.max(0, (reach - segment.from) / Math.max(1, segment.to - segment.from)));
            if (k > 0 && k < 1) {
                graphics.circle(
                    item.ax + segment.x1 + (segment.x2 - segment.x1) * k,
                    item.ay + segment.y1 + (segment.y2 - segment.y1) * k,
                    1.7,
                ).stroke({width: 1, color: colorOf(item), alpha: 0.8 * alpha});
            }
            break;
        }
    };

    const drawConstellation = (item: AmbientItem, time: number, dt: number) => {
        const points = item.points ?? [];
        const base = Math.hypot(lastHalfWidth, lastHalfHeight) + 60;
        for (const point of points) {
            point.x += point.vx * dt;
            point.y += point.vy * dt;
            const radius = Math.hypot(point.x, point.y);
            if (radius < base) {
                const k = base / Math.max(1, radius);
                point.x *= k;
                point.y *= k;
                point.vx = -point.vx;
                point.vy = -point.vy;
            } else if (radius > base + 340) {
                point.vx = -point.vx;
                point.vy = -point.vy;
            }
        }
        const age = time - item.born;
        const alpha = fadeOf(item, age);
        for (let a = 0; a < points.length; a += 1) {
            for (let b = a + 1; b < points.length; b += 1) {
                const distance = Math.hypot(points[a]!.x - points[b]!.x, points[a]!.y - points[b]!.y);
                if (distance > 240) continue;
                const near = 1 - distance / 240;
                graphics.moveTo(item.ax + points[a]!.x, item.ay + points[a]!.y)
                    .lineTo(item.ax + points[b]!.x, item.ay + points[b]!.y)
                    .stroke({width: 0.9, color: colorOf(item), alpha: 0.55 * near * alpha});
            }
        }
        for (const point of points) {
            graphics.circle(item.ax + point.x, item.ay + point.y, 1.9)
                .fill({color: colorOf(item), alpha: 0.7 * alpha});
        }
    };

    const drawDial = (item: AmbientItem, time: number) => {
        const age = time - item.born;
        const alpha = fadeOf(item, age);
        const radius = item.radius ?? 40;
        const ticks = item.ticks ?? 24;
        const angle = (item.phase ?? 0) + (item.direction ?? 1) * (item.spin ?? 0.3) * Math.min(age, item.life);
        graphics.circle(item.ax + item.x, item.ay + item.y, radius)
            .stroke({width: 1, color: colorOf(item), alpha: 0.45 * alpha});
        for (let index = 0; index < ticks; index += 1) {
            const tickAngle = (index / ticks) * Math.PI * 2;
            const inner = radius - (index % 5 === 0 ? 7 : 3.4);
            graphics.moveTo(item.ax + item.x + Math.cos(tickAngle) * inner, item.ay + item.y + Math.sin(tickAngle) * inner)
                .lineTo(item.ax + item.x + Math.cos(tickAngle) * radius, item.ay + item.y + Math.sin(tickAngle) * radius)
                .stroke({width: 1, color: colorOf(item), alpha: 0.55 * alpha});
        }
        graphics.moveTo(item.ax + item.x, item.ay + item.y)
            .lineTo(item.ax + item.x + Math.cos(angle) * radius * 0.72, item.ay + item.y + Math.sin(angle) * radius * 0.72)
            .stroke({width: 1.4, color: colorOf(item), alpha: 0.9 * alpha, cap: 'round'});
        graphics.circle(item.ax + item.x, item.ay + item.y, 1.8)
            .fill({color: colorOf(item), alpha: 0.7 * alpha});
    };

    const drawShape = (item: AmbientItem, time: number) => {
        const age = time - item.born;
        const paths = item.paths ?? [];
        const total = item.total ?? 1;
        const progress = age < item.grow
            ? easeOut(Math.min(1, age / item.grow))
            : age > item.grow + item.hold
                ? Math.max(0, 1 - (age - item.grow - item.hold) / item.retract)
                : 1;
        const alpha = fadeOf(item, age);
        const spin = (item.spinRate ?? 0) * Math.min(age, item.life);
        const cos = Math.cos(spin);
        const sin = Math.sin(spin);
        const rotate = (point: Point): Point => ({
            x: item.ax + point.x * cos - point.y * sin,
            y: item.ay + point.x * sin + point.y * cos,
        });
        let remaining = total * progress;
        for (const path of paths) {
            for (let index = 1; index < path.length; index += 1) {
                if (remaining <= 0) break;
                const a = path[index - 1]!;
                const b = path[index]!;
                const length = Math.hypot(b.x - a.x, b.y - a.y);
                if (length < 0.01) continue;
                const k = Math.min(1, remaining / length);
                const p1 = rotate(a);
                const p2 = rotate({x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k});
                graphics.moveTo(p1.x, p1.y).lineTo(p2.x, p2.y)
                    .stroke({
                        width: item.shape === 'barcode' ? 1.6 : 1.05,
                        color: colorOf(item), alpha: 0.55 * alpha, cap: 'round',
                    });
                remaining -= length * k;
            }
        }
    };

    return {
        container,
        update(state, dt) {
            if (!overlapFx().showAmbient) {
                if (items.length) items.length = 0;
                graphics.clear();
                container.visible = false;
                return;
            }
            container.visible = true;
            if (state.follow) lastFollow = state.follow;
            lastHalfWidth = state.halfWidth;
            lastHalfHeight = state.halfHeight;
            if (state.colors.length) lastColors = state.colors;
            // Doodles live on the page, not on the line: stamped into stage space at birth and
            // carried by the same camera as the type. A line change never teleports or clears
            // what is already drawn.
            const cos = Math.cos(state.roll);
            const sin = Math.sin(state.roll);
            const zoom = state.zoom;
            // The layer now lives inside the same transformed container as the type, so it must
            // not apply the camera a second time. Keeping it at identity guarantees its motion is
            // the type's motion, not an approximation of it.
            container.pivot.set(0, 0);
            container.rotation = 0;
            container.scale.set(1);
            container.position.set(0, 0);
            for (let index = items.length - 1; index >= 0; index -= 1) {
                if (state.time - items[index]!.born > items[index]!.life) items.splice(index, 1);
            }
            nextSpawn -= dt;
            let budget = 1;
            const density = Math.max(0.2, overlapFx().ambientRate);
            while (nextSpawn <= 0 && items.length < MAX_ITEMS && budget > 0) {
                budget -= 1;
                nextSpawn += Math.max(0.1, 2.6 / density);
                const pattern = ['circuit', 'shape', 'shape', 'constellation', 'dial'][cursor % 5]!;
                const shape = SHAPES[cursor % SHAPES.length]!;
                cursor += 1;
                const color = lastColors.length ? hex(lastColors[0]!) : inkHex;
                let item: AmbientItem;
                if (pattern === 'circuit') item = makeCircuit(state.halfWidth, state.halfHeight, color);
                else if (pattern === 'constellation') item = makeConstellation(state.halfWidth, state.halfHeight, color);
                else if (pattern === 'dial') item = makeDial(state.halfWidth, state.halfHeight, color);
                else item = makeShapeItem(shape, state.halfWidth, state.halfHeight, color);
                item.born = state.time;
                // A small share floats over the type; the rest yields to it.
                item.front = Math.random() < 0.16;
                item.ax = lastFollow ? lastFollow.x : boxWidth / 2;
                item.ay = lastFollow ? lastFollow.y : boxHeight / 2;
                items.push(item);
            }
            if (nextSpawn < 0) nextSpawn = 0;
            const avoid = state.avoid;
            const screenX = (localX: number, localY: number) => boxWidth / 2 + state.panX
                + zoom * (cos * (localX - boxWidth / 2) - sin * (localY - boxHeight / 2));
            const screenY = (localX: number, localY: number) => boxHeight / 2 + state.panY
                + zoom * (sin * (localX - boxWidth / 2) + cos * (localY - boxHeight / 2));
            const coversText = (localX: number, localY: number): boolean => {
                if (!avoid) return false;
                const x = screenX(localX, localY);
                const y = screenY(localX, localY);
                // Pad the box so a doodle cannot poke an edge into the type either.
                const pad = 56;
                return x > avoid.x - pad && x < avoid.x + avoid.width + pad
                    && y > avoid.y - pad && y < avoid.y + avoid.height + pad;
            };
            graphics.clear();
            for (const item of items) {
                if (!item.front && coversText(item.ax, item.ay)) continue;
                if (item.kind === 'circuit') drawCircuit(item, state.time);
                else if (item.kind === 'constellation') drawConstellation(item, state.time, dt);
                else if (item.kind === 'dial') drawDial(item, state.time);
                else drawShape(item, state.time);
            }
        },
        resize(nextWidth, nextHeight) {
            boxWidth = nextWidth;
            boxHeight = nextHeight;
        },
        setInk(nextInk) {
            inkHex = hex(nextInk);
        },
        destroy() {
            items.length = 0;
            graphics.destroy();
            container.destroy();
        },
    };
};
