import type { Graphics } from 'pixi.js';

/** 文闪绘线样式的公共画布：同一套样式同时服务整句外框和底部单线。 */
export type WenflashArtRect = { x: number; y: number; width: number; height: number };

export type WenflashArtContext = {
    /** 整句文字墨迹框。 */
    rect: WenflashArtRect;
    /** 外扩后的边框矩形（底部光线用 rect 即可）。 */
    box: WenflashArtRect;
    /** box 的周长。 */
    perimeter: number;
    /** 当前样式周期内的相位，0–1。 */
    phase: number;
    /** 从样式开始运动起累计的圈数，用于拖尾/波动。 */
    cycles: number;
    alpha: number;
    color: string;
    /** 核心线宽。 */
    width: number;
    /** 线长/拖尾占外框周长的比例，来自面板「光线长度」。 */
    span: number;
    /** 辉光强度 0–1。 */
    glow: number;
    fontSize: number;
    /** 底部光线的基线 y。 */
    lineY: number;
};

export type WenflashLineStyle = {
    id: string;
    name: string;
    family: string;
    /** 跑马框形态。 */
    frame: (g: Graphics, c: WenflashArtContext) => void;
    /** 底部单线形态。 */
    line: (g: Graphics, c: WenflashArtContext) => void;
};

export const artPoint = (rect: WenflashArtRect, distance: number) => {
    const perimeter = (rect.width + rect.height) * 2;
    if (!(perimeter > 1)) return { x: rect.x + rect.width * 0.5, y: rect.y + rect.height * 0.5 };
    let d = ((distance % perimeter) + perimeter) % perimeter;
    if (d <= rect.width) return { x: rect.x + d, y: rect.y };
    d -= rect.width;
    if (d <= rect.height) return { x: rect.x + rect.width, y: rect.y + d };
    d -= rect.height;
    if (d <= rect.width) return { x: rect.x + rect.width - d, y: rect.y + rect.height };
    d -= rect.width;
    return { x: rect.x, y: rect.y + rect.height - d };
};

export const artPath = (
    g: Graphics,
    points: Array<{ x: number; y: number }>,
    width: number,
    color: string,
    alpha: number,
) => {
    if (points.length < 2 || alpha <= 0.002) return;
    g.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) g.lineTo(points[i].x, points[i].y);
    g.stroke({ width, color, alpha, cap: 'round', join: 'round' });
};

export const artComet = (
    g: Graphics,
    rect: WenflashArtRect,
    start: number,
    length: number,
    width: number,
    color: string,
    alpha: number,
    taper = 1,
) => {
    if (length <= 0.5 || alpha <= 0.002) return;
    const segments = 10;
    for (let i = 0; i < segments; i += 1) {
        const local = length * (i / segments);
        const a = alpha * (1 - i / segments) ** taper;
        const w = width * (1 - (i / segments) * 0.85);
        artPath(g, [
            artPoint(rect, start + local),
            artPoint(rect, start + length * ((i + 1) / segments)),
        ], w, color, a);
    }
};

const framePoints = (rect: WenflashArtRect, from: number, length: number, steps = 24) => {
    const count = Math.max(2, Math.ceil(steps * Math.max(0.05, length / 200)));
    const points: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= count; i += 1) points.push(artPoint(rect, from + (length * i) / count));
    return points;
};

export const artDashedFrame = (
    g: Graphics,
    rect: WenflashArtRect,
    dash: number,
    gap: number,
    offset: number,
    width: number,
    color: string,
    alpha: number,
) => {
    const perimeter = (rect.width + rect.height) * 2;
    const stride = Math.max(2, dash + gap);
    let drew = false;
    for (let d = ((offset % stride) + stride) % stride; d < perimeter; d += stride) {
        const points = framePoints(rect, d, Math.min(dash, perimeter - d), 8);
        g.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i += 1) g.lineTo(points[i].x, points[i].y);
        drew = true;
    }
    if (drew) g.stroke({ width, color, alpha, cap: 'round', join: 'round' });
};

export const artBrackets = (
    g: Graphics,
    rect: WenflashArtRect,
    length: number,
    width: number,
    color: string,
    alpha: number,
    inset = 0,
) => {
    const x0 = rect.x + inset;
    const y0 = rect.y + inset;
    const x1 = rect.x + rect.width - inset;
    const y1 = rect.y + rect.height - inset;
    const corners: Array<[number, number, number, number]> = [
        [x0, y0, 1, 1],
        [x1, y0, -1, 1],
        [x1, y1, -1, -1],
        [x0, y1, 1, -1],
    ];
    for (const [x, y, sx, sy] of corners) {
        artPath(g, [{ x, y }, { x: x + length * sx, y }], width, color, alpha);
        artPath(g, [{ x, y }, { x, y: y + length * sy }], width, color, alpha);
    }
};

export const artTicks = (
    g: Graphics,
    rect: WenflashArtRect,
    stride: number,
    length: number,
    offset: number,
    width: number,
    color: string,
    alpha: number,
) => {
    const perimeter = (rect.width + rect.height) * 2;
    let drew = false;
    for (let d = ((offset % stride) + stride) % stride; d < perimeter; d += stride) {
        const p = artPoint(rect, d);
        const inward = Math.min(
            Math.abs(p.x - rect.x),
            Math.abs(p.x - (rect.x + rect.width)),
            Math.abs(p.y - rect.y),
            Math.abs(p.y - (rect.y + rect.height)),
        );
        const dx = p.x <= rect.x + 1 ? 1 : p.x >= rect.x + rect.width - 1 ? -1 : 0;
        const dy = dx !== 0 ? 0 : p.y <= rect.y + 1 ? 1 : -1;
        const len = inward <= length ? length * 0.55 : length;
        g.moveTo(p.x, p.y).lineTo(p.x + dx * len, p.y + dy * len);
        drew = true;
    }
    if (drew) g.stroke({ width, color, alpha, cap: 'round', join: 'round' });
};

export const artWave = (
    g: Graphics,
    x0: number,
    x1: number,
    y: number,
    amplitude: number,
    waves: number,
    phase: number,
    width: number,
    color: string,
    alpha: number,
    samples = 48,
) => {
    const points: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= samples; i += 1) {
        const t = i / samples;
        points.push({
            x: x0 + (x1 - x0) * t,
            y: y + Math.sin((t * waves + phase) * Math.PI * 2) * amplitude,
        });
    }
    artPath(g, points, width, color, alpha);
};

export const artDots = (
    g: Graphics,
    points: Array<{ x: number; y: number }>,
    radius: number,
    color: string,
    alpha: number,
) => {
    if (alpha <= 0.002 || points.length === 0) return;
    for (const p of points) g.circle(p.x, p.y, Math.max(0.5, radius));
    g.fill({ color, alpha });
};

export const artScan = (
    g: Graphics,
    rect: WenflashArtRect,
    phase: number,
    width: number,
    color: string,
    alpha: number,
    vertical = false,
) => {
    const span = vertical ? rect.height : rect.width;
    const x = rect.x + (vertical ? 0 : span * phase);
    const y = rect.y + (vertical ? span * phase : 0);
    const trail = Math.max(8, span * 0.22);
    const segments = 8;
    for (let i = 0; i < segments; i += 1) {
        const k = 1 - i / segments;
        if (vertical) {
            g.rect(rect.x, y - trail * (i / segments), rect.width, trail / segments)
                .fill({ color, alpha: alpha * 0.25 * k });
        } else {
            g.rect(x - trail * (i / segments), rect.y, trail / segments, rect.height)
                .fill({ color, alpha: alpha * 0.25 * k });
        }
    }
    if (vertical) g.rect(rect.x, y, rect.width, width).fill({ color, alpha });
    else g.rect(x, rect.y, width, rect.height).fill({ color, alpha });
};
