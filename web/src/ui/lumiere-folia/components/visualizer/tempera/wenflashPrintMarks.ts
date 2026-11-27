import { hashTemperaSeed } from './temperaRandom';

type PixiModule = typeof import('pixi.js');

// src/components/visualizer/tempera/wenflashPrintMarks.ts
//
// 文闪的「版面框架」：把文字周围当成一张印前校样纸，而不是空背景。
// 这组标记只画在舞台边缘：裁切规矩线、套准靶、色标条、标尺、装订孔、
// 页边批注和版权行。它们不覆盖正文，不参与逐字布局，也不改变任何歌词时间；
// 作用是把「这一句正在被印刷/校对」这件事讲清楚，让画面有工序感。
//
// 所有位置由 computeWenflashPrintLayout() 纯函数解出，渲染层只做 alpha/scale
// 的薄动画。这样 seek、切歌、拖动进度条都不会让版式跳动。

export interface WenflashPrintPalette {
    ink: number;
    accent: number;
    paper: number;
    fontFamily: string;
}

export interface WenflashPrintRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface WenflashPrintLayout {
    width: number;
    height: number;
    frame: WenflashPrintRect;
    /** 四个裁切角，按左上/右上/右下/左下排列。 */
    corners: {x: number; y: number; sx: number; sy: number}[];
    targets: {x: number; y: number}[];
    ticks: {x: number; y: number; major: boolean}[];
    perforations: {x: number; y: number}[];
    bar: WenflashPrintRect & {swatch: number; gap: number};
    labels: {kind: 'issue' | 'time' | 'proof' | 'edition'; x: number; y: number; rotation: number}[];
    foldMarks: {x: number; y: number; rotation: number}[];
}

export interface WenflashPrintMarks {
    container: import('pixi.js').Container;
    update: (time: number, progress: number, enter: number, exit: number, impact: number, intensity?: number) => void;
    resize: (width: number, height: number) => void;
    setPalette: (palette: WenflashPrintPalette) => void;
    destroy: () => void;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => {
    const t = clamp01(value);
    return t * t * (3 - 2 * t);
};

/**
 * 版心与四周辅具的纯几何。frame 是正文的“安全版心”，所有标记都落在它外面；
 * 因此无论横排、竖排还是图形排，标记都不会压到字。
 */
export const computeWenflashPrintLayout = (width: number, height: number): WenflashPrintLayout => {
    const w = Math.max(320, width);
    const h = Math.max(240, height);
    const inset = Math.max(34, Math.min(72, Math.min(w, h) * 0.062));
    const frame = {x: inset, y: inset, w: w - inset * 2, h: h - inset * 2};
    const crop = Math.max(14, Math.min(28, Math.min(w, h) * 0.024));
    const gap = Math.max(6, crop * 0.42);
    const corners = [
        {x: frame.x - gap, y: frame.y - gap, sx: -1, sy: -1},
        {x: frame.x + frame.w + gap, y: frame.y - gap, sx: 1, sy: -1},
        {x: frame.x + frame.w + gap, y: frame.y + frame.h + gap, sx: 1, sy: 1},
        {x: frame.x - gap, y: frame.y + frame.h + gap, sx: -1, sy: 1},
    ];
    const targets = [
        {x: frame.x - gap * 2.4, y: frame.y + frame.h / 2},
        {x: frame.x + frame.w + gap * 2.4, y: frame.y + frame.h / 2},
    ];
    const ticks: {x: number; y: number; major: boolean}[] = [];
    const tickGap = Math.max(16, Math.min(26, frame.h / 24));
    let index = 0;
    for (let y = frame.y + 18; y <= frame.y + frame.h - 18; y += tickGap) {
        ticks.push({x: frame.x - gap * 1.25, y, major: index % 5 === 0});
        index += 1;
    }
    const perforations: {x: number; y: number}[] = [];
    const perfGap = Math.max(14, Math.min(22, frame.w / 34));
    for (let x = frame.x + perfGap; x <= frame.x + frame.w - perfGap; x += perfGap) {
        perforations.push({x, y: frame.y - gap * 1.55});
    }
    const swatch = Math.max(8, Math.min(15, frame.w * 0.012));
    const barGap = Math.max(2, swatch * 0.18);
    const bar = {
        x: frame.x + frame.w - swatch * 10 - barGap * 9,
        y: frame.y + frame.h + gap * 2.5,
        w: swatch * 10 + barGap * 9,
        h: swatch,
        swatch,
        gap: barGap,
    };
    const labels = [
        {kind: 'issue' as const, x: frame.x, y: frame.y + frame.h + gap * 2.6, rotation: 0},
        {kind: 'time' as const, x: frame.x + frame.w - swatch * 10 - barGap * 9, y: frame.y + frame.h + gap * 4.4, rotation: 0},
        {kind: 'proof' as const, x: frame.x - gap * 2.2, y: frame.y + 26, rotation: -Math.PI / 2},
        {kind: 'edition' as const, x: frame.x + frame.w + gap * 2.0, y: frame.y + frame.h - 12, rotation: -Math.PI / 2},
    ];
    const foldMarks = [
        {x: frame.x + frame.w * 0.5, y: frame.y - gap * 2.2, rotation: 0},
        {x: frame.x + frame.w + gap * 2.2, y: frame.y + frame.h * 0.5, rotation: Math.PI / 2},
    ];
    return {width: w, height: h, frame, corners, targets, ticks, perforations, bar, labels, foldMarks};
};

/** 色标条只借用版面色，不引入第二套主题；顺序固定，便于肉眼比对。 */
export const wenflashPrintBarColors = (palette: WenflashPrintPalette): number[] => [
    palette.ink,
    palette.accent,
    palette.paper,
    0x1b1b1f,
    0xe7dfcf,
    0xc94f4f,
    0x4f86c9,
    0xd6b24f,
    0x55a37a,
    0x8c6bb1,
];

const labelText = (kind: WenflashPrintLayout['labels'][number]['kind'], seed: number): string => {
    switch (kind) {
        case 'issue': return `NO. ${String((seed % 900) + 100).padStart(3, '0')}`;
        case 'time': return `PROOF  ${(seed % 59).toString().padStart(2, '0')}:${(seed % 60).toString().padStart(2, '0')}`;
        case 'proof': return '文闪 / WENFLASH';
        default: return 'ED. 01 · 印前校样';
    }
};

export const createWenflashPrintMarks = (
    pixi: PixiModule,
    width: number,
    height: number,
    palette: WenflashPrintPalette,
    seed: string | number,
): WenflashPrintMarks => {
    let viewWidth = Math.max(320, width);
    let viewHeight = Math.max(240, height);
    let colors = {...palette};
    const hash = hashTemperaSeed(String(seed));
    const container = new pixi.Container();
    container.eventMode = 'none';
    const staticMarks = new pixi.Graphics();
    const dynamicMarks = new pixi.Graphics();
    const labels = new pixi.Container();
    const labelNodes: import('pixi.js').Text[] = [];
    container.addChild(staticMarks, dynamicMarks, labels);

    let layout = computeWenflashPrintLayout(viewWidth, viewHeight);
    let lastProgress = -1;
    let lastImpact = -1;

    const makeLabel = (text: string): import('pixi.js').Text => {
        const node = new pixi.Text({
            text,
            style: new pixi.TextStyle({
                fontFamily: colors.fontFamily,
                fontSize: 10,
                letterSpacing: 1.4,
                fill: colors.paper,
            }),
        });
        node.alpha = 0.42;
        node.resolution = 2;
        labels.addChild(node);
        labelNodes.push(node);
        return node;
    };

    const rebuildLabels = () => {
        for (const node of labelNodes) node.destroy();
        labelNodes.length = 0;
        labels.removeChildren();
        for (const item of layout.labels) {
            const node = makeLabel(labelText(item.kind, hash + item.kind.length * 37));
            node.anchor.set(0, 0.5);
            node.position.set(item.x, item.y);
            node.rotation = item.rotation;
        }
    };

    const drawStatic = () => {
        staticMarks.clear();
        const {frame, corners, targets, ticks, perforations, bar, foldMarks} = layout;
        // 版心：只在四角留短角标，不画完整矩形，避免像 UI 边框。
        const cornerArm = Math.max(20, Math.min(42, Math.min(frame.w, frame.h) * 0.045));
        for (const corner of corners) {
            const x = corner.x;
            const y = corner.y;
            staticMarks.moveTo(x, y + corner.sy * cornerArm).lineTo(x, y).lineTo(x + corner.sx * cornerArm, y)
                .stroke({width: 1.5, color: colors.accent, alpha: 0.65});
            staticMarks.moveTo(x + corner.sx * 5, y + corner.sy * 5)
                .lineTo(x + corner.sx * 14, y + corner.sy * 5)
                .stroke({width: 1, color: colors.ink, alpha: 0.42});
        }
        // 套准靶：圆 + 十字，左右各一。
        for (const target of targets) {
            staticMarks.circle(target.x, target.y, 7.5).stroke({width: 1.1, color: colors.accent, alpha: 0.62});
            staticMarks.circle(target.x, target.y, 2.2).fill({color: colors.accent, alpha: 0.62});
            staticMarks.moveTo(target.x - 12, target.y).lineTo(target.x + 12, target.y)
                .moveTo(target.x, target.y - 12).lineTo(target.x, target.y + 12)
                .stroke({width: 1, color: colors.ink, alpha: 0.38});
        }
        // 左标尺：长短刻度交替，像校样纸上的行高尺。
        for (const tick of ticks) {
            staticMarks.moveTo(tick.x, tick.y)
                .lineTo(tick.x + (tick.major ? 11 : 5), tick.y)
                .stroke({width: tick.major ? 1.2 : 0.8, color: tick.major ? colors.accent : colors.ink,
                    alpha: tick.major ? 0.55 : 0.3});
        }
        // 装订孔：上沿一排小孔，暗示这是从样本册上撕下来的。
        for (const hole of perforations) {
            staticMarks.circle(hole.x, hole.y, 1.7).fill({color: colors.ink, alpha: 0.28});
        }
        // 色标条：10 格，默认低 alpha，当前格在 dynamic 层点亮。
        const barColors = wenflashPrintBarColors(colors);
        for (let i = 0; i < 10; i += 1) {
            const x = bar.x + i * (bar.swatch + bar.gap);
            staticMarks.rect(x, bar.y, bar.swatch, bar.h).fill({color: barColors[i], alpha: 0.42});
            staticMarks.rect(x, bar.y, bar.swatch, bar.h).stroke({width: 0.6, color: colors.ink, alpha: 0.3});
        }
        // 折页标记：上下两个小三角。
        for (const fold of foldMarks) {
            staticMarks.moveTo(fold.x - 9, fold.y).lineTo(fold.x, fold.y - 6).lineTo(fold.x + 9, fold.y)
                .stroke({width: 1, color: colors.accent, alpha: 0.34});
        }
    };

    const drawDynamic = (progress: number, impact: number) => {
        dynamicMarks.clear();
        const barColors = wenflashPrintBarColors(colors);
        const active = Math.max(0, Math.min(9, Math.floor(clamp01(progress) * 10)));
        const pulse = 0.55 + impact * 0.45;
        const x = layout.bar.x + active * (layout.bar.swatch + layout.bar.gap);
        dynamicMarks.rect(x - 2, layout.bar.y - 2, layout.bar.swatch + 4, layout.bar.h + 4)
            .stroke({width: 1.8, color: colors.accent, alpha: 0.9});
        dynamicMarks.rect(x, layout.bar.y, layout.bar.swatch, layout.bar.h)
            .fill({color: barColors[active], alpha: 0.9});
        dynamicMarks.circle(x + layout.bar.swatch / 2, layout.bar.y - 9, 2.2 + impact * 2.8)
            .fill({color: colors.accent, alpha: pulse});
        // 进度游标：在左标尺上滑动的短横线。
        const cursorY = layout.frame.y + 18 + (layout.frame.h - 36) * clamp01(progress);
        dynamicMarks.moveTo(layout.frame.x - 22, cursorY).lineTo(layout.frame.x - 4, cursorY)
            .stroke({width: 2, color: colors.accent, alpha: 0.85});
        dynamicMarks.circle(layout.frame.x - 24, cursorY, 2.4).fill({color: colors.accent, alpha: pulse});
        // 套准靶的旋转十字，靠 dynamic 层重画来转，避免旋转 Text。
        const spin = progress * Math.PI * 2;
        for (const target of layout.targets) {
            const r = 10 + impact * 4;
            dynamicMarks.moveTo(target.x + Math.cos(spin) * r, target.y + Math.sin(spin) * r)
                .lineTo(target.x - Math.cos(spin) * r, target.y - Math.sin(spin) * r)
                .stroke({width: 0.8, color: colors.accent, alpha: 0.35});
        }
    };

    const rebuild = () => {
        layout = computeWenflashPrintLayout(viewWidth, viewHeight);
        drawStatic();
        rebuildLabels();
        lastProgress = -1;
        lastImpact = -1;
    };

    rebuild();

    return {
        container,
        update: (time, progress, enter, exit, impact, intensity = 1) => {
            const safeProgress = clamp01(progress);
            const safeImpact = clamp01(impact);
            container.alpha = smooth(enter) * (1 - smooth(exit)) * 0.92 * clamp01(intensity);
            container.visible = container.alpha > 0.005;
            if (Math.abs(safeProgress - lastProgress) > 0.002 || Math.abs(safeImpact - lastImpact) > 0.04) {
                lastProgress = safeProgress;
                lastImpact = safeImpact;
                drawDynamic(safeProgress, safeImpact);
            }
            const breathe = 1 + Math.sin(time * 0.7 + hash * 0.001) * 0.006;
            container.scale.set(breathe);
            container.position.set((viewWidth * (1 - breathe)) / 2, (viewHeight * (1 - breathe)) / 2);
        },
        resize: (nextWidth, nextHeight) => {
            viewWidth = Math.max(320, nextWidth);
            viewHeight = Math.max(240, nextHeight);
            rebuild();
        },
        setPalette: (next) => {
            colors = {...next};
            for (const node of labelNodes) {
                node.style.fill = colors.paper;
                node.style.fontFamily = colors.fontFamily;
            }
            rebuild();
        },
        destroy: () => {
            for (const node of labelNodes) node.destroy();
            labelNodes.length = 0;
            container.destroy({children: true});
        },
    };
};
