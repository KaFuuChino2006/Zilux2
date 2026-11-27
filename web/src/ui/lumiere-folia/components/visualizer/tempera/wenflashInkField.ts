import { hashTemperaSeed, temperaHash01 } from './temperaRandom';

type PixiModule = typeof import('pixi.js');

// src/components/visualizer/tempera/wenflashInkField.ts
//
// 文闪的「纸面墨场」：文字下方的一层环境，不是背景图，也不是装饰字。
// 它由纸纤维、半调晕、漂浮墨点、斜向光束和四边暗角组成，专门填满
// 裁切规矩线以内的负空间。所有粒子位置在建场期由 seed 解出；帧期只做
// 正弦漂移与 alpha 呼吸，所以拖动进度条、切歌、重播都不会换一套随机。

export interface WenflashInkPalette {
    ink: number;
    accent: number;
    paper: number;
}

export interface WenflashInkMote {
    x: number;
    y: number;
    radius: number;
    phase: number;
    speed: number;
    amplitude: number;
    alpha: number;
    kind: 0 | 1 | 2;
}

export interface WenflashInkField {
    container: import('pixi.js').Container;
    update: (
        time: number,
        progress: number,
        enter: number,
        exit: number,
        impact: number,
        density: number,
        intensity: number,
        speed: number,
    ) => void;
    resize: (width: number, height: number) => void;
    setPalette: (palette: WenflashInkPalette) => void;
    destroy: () => void;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => {
    const t = clamp01(value);
    return t * t * (3 - 2 * t);
};

/** 密度 0..1 → 漂浮墨点数量；密度低时保留少量“呼吸点”，不会整层消失。 */
export const wenflashInkMoteCount = (density: number): number => {
    const d = clamp01(density);
    return Math.round(10 + d * 34);
};

/**
 * 纯函数：把 seed 解成一组围绕版心的墨点。中心留空，避免压字；
 * 半径在 0.32..0.62 倍短边之间分布，形成一圈松散的“墨雾”。
 */
export const computeWenflashInkMotes = (
    width: number,
    height: number,
    density: number,
    seed: string | number,
): WenflashInkMote[] => {
    const w = Math.max(320, width);
    const h = Math.max(240, height);
    const cx = w / 2;
    const cy = h / 2;
    const count = wenflashInkMoteCount(density);
    const hash = hashTemperaSeed(String(seed));
    const motes: WenflashInkMote[] = [];
    for (let i = 0; i < count; i += 1) {
        const angle = temperaHash01(hash, i, 11) * Math.PI * 2;
        const ring = 0.32 + temperaHash01(hash, i, 23) * 0.30;
        const squash = 0.68 + temperaHash01(hash, i, 29) * 0.24;
        const x = cx + Math.cos(angle) * (w * 0.5) * ring;
        const y = cy + Math.sin(angle) * (h * 0.5) * ring * squash;
        const kindRoll = temperaHash01(hash, i, 31);
        motes.push({
            x,
            y,
            radius: 0.8 + temperaHash01(hash, i, 37) * 2.6,
            phase: temperaHash01(hash, i, 41) * Math.PI * 2,
            speed: 0.16 + temperaHash01(hash, i, 43) * 0.42,
            amplitude: 5 + temperaHash01(hash, i, 47) * 16,
            alpha: 0.10 + temperaHash01(hash, i, 53) * 0.30,
            kind: kindRoll < 0.56 ? 0 : kindRoll < 0.86 ? 1 : 2,
        });
    }
    return motes;
};

/**
 * 半调晕的半径序列。它不是实心圆，而是一圈大小交替的点；
 * 点径随 progress 从 1.35 收到 1.0，模仿印刷网点的“着墨—收干”。
 */
export const wenflashHalftoneRadii = (count: number, progress: number): number[] => {
    const n = Math.max(3, Math.round(count));
    const out: number[] = [];
    for (let i = 0; i < n; i += 1) {
        const wave = 0.5 + 0.5 * Math.sin((i / n) * Math.PI * 5 + clamp01(progress) * Math.PI * 2);
        out.push(1.1 + wave * 1.8);
    }
    return out;
};

const buildFibers = (layer: import('pixi.js').Graphics, w: number, h: number,
    palette: WenflashInkPalette, seed: number) => {
    layer.clear();
    const count = 90;
    for (let i = 0; i < count; i += 1) {
        const x = temperaHash01(seed, i, 61) * w;
        const y = temperaHash01(seed, i, 67) * h;
        const length = 4 + temperaHash01(seed, i, 71) * 26;
        const angle = temperaHash01(seed, i, 73) * Math.PI * 2;
        const alpha = 0.04 + temperaHash01(seed, i, 79) * 0.10;
        const color = temperaHash01(seed, i, 83) > 0.72 ? palette.accent : palette.paper;
        layer.moveTo(x, y)
            .lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length)
            .stroke({width: 0.7, color, alpha});
    }
    // 四边暗角：用多层窄矩形叠出近似渐变，避免依赖 canvas 纹理。
    for (let band = 0; band < 8; band += 1) {
        const t = band / 7;
        const alpha = 0.035 * (1 - t) * (1 - t);
        const inset = Math.min(w, h) * 0.004 * band;
        layer.rect(inset, 0, w - inset * 2, 10 + band * 4).fill({color: palette.ink, alpha});
        layer.rect(inset, h - 10 - band * 4, w - inset * 2, 10 + band * 4).fill({color: palette.ink, alpha});
        layer.rect(0, inset, 10 + band * 4, h - inset * 2).fill({color: palette.ink, alpha});
        layer.rect(w - 10 - band * 4, inset, 10 + band * 4, h - inset * 2).fill({color: palette.ink, alpha});
    }
};

const buildHalftone = (layer: import('pixi.js').Graphics, w: number, h: number,
    palette: WenflashInkPalette, seed: number) => {
    layer.clear();
    const cx = w / 2;
    const cy = h / 2;
    const rx = Math.min(w * 0.22, 270);
    const ry = Math.min(h * 0.16, 190);
    const dots: {x: number; y: number; r: number; alpha: number}[] = [];
    for (let ring = 0; ring < 5; ring += 1) {
        const count = 9 + ring * 5;
        for (let i = 0; i < count; i += 1) {
            const angle = (i / count) * Math.PI * 2 + ring * 0.23;
            const squash = 1 - ring * 0.035;
            dots.push({
                x: cx + Math.cos(angle) * rx * (0.62 + ring * 0.11) * squash,
                y: cy + Math.sin(angle) * ry * (0.62 + ring * 0.11) * squash,
                r: 0.7 + temperaHash01(seed, ring * 31 + i, 89) * 1.8,
                alpha: 0.10 + (4 - ring) * 0.025,
            });
        }
    }
    for (const dot of dots) {
        layer.circle(dot.x, dot.y, dot.r).fill({color: palette.accent, alpha: dot.alpha});
    }
};

const buildShafts = (layer: import('pixi.js').Graphics, w: number, h: number,
    palette: WenflashInkPalette) => {
    layer.clear();
    // 三条从左上斜向右下的柔光，宽度和角度错开，避免像 UI 斜纹。
    const specs = [
        {x: w * 0.12, top: 0.4, width: w * 0.16, alpha: 0.045},
        {x: w * 0.30, top: 0.55, width: w * 0.09, alpha: 0.035},
        {x: w * 0.78, top: 0.32, width: w * 0.12, alpha: 0.028},
    ];
    for (const spec of specs) {
        const slant = h * 0.48;
        layer.moveTo(spec.x, -slant * 0.2)
            .lineTo(spec.x + spec.width, -slant * 0.2)
            .lineTo(spec.x + spec.width + slant, h + slant * 0.2)
            .lineTo(spec.x + slant, h + slant * 0.2)
            .closePath()
            .fill({color: palette.paper, alpha: spec.alpha});
    }
};

export const createWenflashInkField = (
    pixi: PixiModule,
    width: number,
    height: number,
    palette: WenflashInkPalette,
    seed: string | number,
): WenflashInkField => {
    let viewWidth = Math.max(320, width);
    let viewHeight = Math.max(240, height);
    let colors = {...palette};
    const hash = hashTemperaSeed(String(seed));
    const container = new pixi.Container();
    container.eventMode = 'none';
    const fiberLayer = new pixi.Graphics();
    const shaftLayer = new pixi.Graphics();
    const halftoneLayer = new pixi.Graphics();
    const moteLayer = new pixi.Graphics();
    const flashLayer = new pixi.Graphics();
    container.addChild(fiberLayer, shaftLayer, halftoneLayer, moteLayer, flashLayer);
    let moteDensity = 0.55;
    let motes = computeWenflashInkMotes(viewWidth, viewHeight, moteDensity, hash);

    const rebuildStatic = () => {
        buildFibers(fiberLayer, viewWidth, viewHeight, colors, hash);
        buildShafts(shaftLayer, viewWidth, viewHeight, colors);
        buildHalftone(halftoneLayer, viewWidth, viewHeight, colors, hash);
    };
    rebuildStatic();

    return {
        container,
        update: (time, progress, enter, exit, impact, density, intensity, speed) => {
            const enterFade = smooth(enter);
            const exitFade = 1 - smooth(exit);
            const power = clamp01(intensity);
            container.alpha = enterFade * exitFade * (0.35 + power * 0.65);
            container.visible = container.alpha > 0.004;
            if (!container.visible) return;
            const driftSpeed = Math.max(0.2, speed);
            // 密度变化时重建墨点集合；按 0.05 量化，避免每帧哈希。
            const quantized = Math.round(clamp01(density) * 20) / 20;
            if (Math.abs(quantized - moteDensity) > 0.04) {
                moteDensity = quantized;
                motes = computeWenflashInkMotes(viewWidth, viewHeight, quantized, hash);
            }
            const active = Math.min(motes.length, wenflashInkMoteCount(quantized));
            moteLayer.clear();
            for (let i = 0; i < active; i += 1) {
                const mote = motes[i];
                const phase = time * driftSpeed * mote.speed + mote.phase;
                const x = mote.x + Math.sin(phase) * mote.amplitude;
                const y = mote.y + Math.cos(phase * 0.83) * mote.amplitude * 0.62;
                const alpha = mote.alpha * (0.62 + 0.38 * Math.sin(phase * 1.7 + hash * 0.01));
                if (mote.kind === 0) {
                    moteLayer.circle(x, y, mote.radius).fill({color: colors.paper, alpha});
                } else if (mote.kind === 1) {
                    moteLayer.circle(x, y, mote.radius * 0.7).fill({color: colors.accent, alpha});
                } else {
                    moteLayer.moveTo(x - mote.radius, y).lineTo(x + mote.radius, y)
                        .stroke({width: 0.8, color: colors.ink, alpha});
                }
            }
            // 半调晕随演唱进度轻微“开网—收网”。
            const pulse = 0.82 + 0.18 * Math.sin(time * 0.9 + hash * 0.02);
            halftoneLayer.alpha = (0.45 + power * 0.55) * pulse;
            halftoneLayer.scale.set(0.97 + clamp01(progress) * 0.06);
            halftoneLayer.position.set(viewWidth / 2, viewHeight / 2);
            halftoneLayer.pivot.set(viewWidth / 2, viewHeight / 2);
            shaftLayer.alpha = 0.55 + 0.45 * Math.sin(time * 0.33 + hash * 0.03);
            if (impact > 0.01) {
                flashLayer.clear();
                const r = Math.min(viewWidth, viewHeight) * (0.30 + impact * 0.10);
                flashLayer.circle(viewWidth / 2, viewHeight / 2, r)
                    .stroke({width: 2 + impact * 8, color: colors.accent, alpha: 0.10 * impact});
                flashLayer.alpha = 1;
            } else {
                flashLayer.clear();
            }
        },
        resize: (nextWidth, nextHeight) => {
            viewWidth = Math.max(320, nextWidth);
            viewHeight = Math.max(240, nextHeight);
            motes = computeWenflashInkMotes(viewWidth, viewHeight, moteDensity, hash);
            rebuildStatic();
        },
        setPalette: (next) => {
            colors = {...next};
            rebuildStatic();
        },
        destroy: () => {
            container.destroy({children: true});
        },
    };
};
