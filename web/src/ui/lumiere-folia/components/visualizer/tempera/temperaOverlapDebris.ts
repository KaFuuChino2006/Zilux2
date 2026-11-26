import * as pixi from 'pixi.js';
import { overlapFx } from '../../../../overlapSettings';

/**
 * 画面运动时散落的小东西：镜头越快，纸面上被带起来的墨尘越多；撞击时甩出墨点；
 * 换句时旧句的位置崩下几块字屑。全部只活在屏幕空间，不参与镜头变换。
 */
type DebrisKind = 'dust' | 'splash' | 'shard';

interface DebrisBit {
    kind: DebrisKind;
    x: number;
    y: number;
    vx: number;
    vy: number;
    gravity: number;
    drag: number;
    life: number;
    age: number;
    size: number;
    stretch: number;
    rotation: number;
    spin: number;
    color: number;
    alpha: number;
}

export interface TemperaOverlapDebris {
    container: pixi.Container;
    update(state: {time: number; dt: number; speed: number; panX: number; panY: number}, dt: number): void;
    splash(x: number, y: number, angle: number, strength: number): void;
    shards(x: number, y: number, color: string): void;
    resize(width: number, height: number): void;
    setPalette(ink: string, accent: string): void;
    destroy(): void;
}

const MAX_BITS = 180;
const DUST_LIFE = [0.7, 1.5] as const;

const hex = (value: string): number => {
    const text = value.replace('#', '');
    return Number.parseInt(text.length === 3
        ? text.split('').map(char => char + char).join('')
        : text.slice(0, 6), 16);
};
const rand = (min: number, max: number) => min + Math.random() * (max - min);

export const createTemperaOverlapDebris = (
    pixiNamespace: typeof pixi,
    width: number,
    height: number,
    ink: string,
    accent: string,
): TemperaOverlapDebris => {
    const container = new pixiNamespace.Container();
    const graphics = new pixiNamespace.Graphics();
    container.addChild(graphics);
    let inkHex = hex(ink);
    let accentHex = hex(accent);
    let boxWidth = width;
    let boxHeight = height;
    const bits: DebrisBit[] = [];
    let dustCarry = 0;

    const push = (bit: DebrisBit) => {
        if (bits.length >= MAX_BITS) bits.shift();
        bits.push(bit);
    };

    const spawnDust = (state: {time: number; speed: number; panX: number; panY: number}) => {
        const gain = overlapFx().dustGain;
        if (gain <= 0) return;
        // 速度越快，单位时间被带起的墨尘越多；静止时完全不出现。
        dustCarry += Math.min(2400, state.speed) * gain * 0.012 * (1 / 60);
        while (dustCarry >= 1) {
            dustCarry -= 1;
            const direction = Math.atan2(-state.panY || rand(-1, 1), -state.panX || rand(-1, 1));
            const speed = rand(18, 62) * (0.5 + Math.min(1.6, state.speed / 420));
            push({
                kind: 'dust',
                x: rand(0, boxWidth),
                y: rand(0, boxHeight),
                vx: Math.cos(direction) * speed + rand(-16, 16),
                vy: Math.sin(direction) * speed + rand(-16, 16),
                gravity: 0,
                drag: 1.6,
                life: rand(DUST_LIFE[0], DUST_LIFE[1]),
                age: 0,
                size: rand(0.9, 2.1),
                stretch: rand(0, 3.4),
                rotation: direction,
                spin: 0,
                color: Math.random() < 0.24 ? accentHex : inkHex,
                alpha: rand(0.18, 0.4),
            });
        }
    };

    return {
        container,
        update(state, dt) {
            if (!overlapFx().showDebris) {
                if (bits.length) bits.length = 0;
                graphics.clear();
                container.visible = false;
                return;
            }
            container.visible = true;
            spawnDust(state);
            graphics.clear();
            const step = Math.min(0.05, Math.max(0, dt));
            for (let index = bits.length - 1; index >= 0; index -= 1) {
                const bit = bits[index]!;
                bit.age += step;
                if (bit.age >= bit.life) {
                    bits.splice(index, 1);
                    continue;
                }
                const damping = Math.exp(-bit.drag * step);
                bit.vx *= damping;
                bit.vy = bit.vy * damping + bit.gravity * step;
                bit.x += bit.vx * step;
                bit.y += bit.vy * step;
                bit.rotation += bit.spin * step;
                // Ink has to bloom and dry, not blink: a short smooth entrance, a longer exit.
                const smooth = (value: number) => {
                    const t = Math.min(1, Math.max(0, value));
                    return t * t * (3 - 2 * t);
                };
                const fade = smooth(bit.age / 0.2) * smooth((bit.life - bit.age) / 0.45);
                const alpha = bit.alpha * fade * overlapFx().decorAlpha;
                if (bit.kind === 'shard') {
                    const cos = Math.cos(bit.rotation);
                    const sin = Math.sin(bit.rotation);
                    const halfW = bit.size * 0.5;
                    const halfH = bit.size * 0.34;
                    const corner = (dx: number, dy: number) => ({
                        x: bit.x + dx * cos - dy * sin,
                        y: bit.y + dx * sin + dy * cos,
                    });
                    const a = corner(-halfW, -halfH);
                    const b = corner(halfW, -halfH);
                    const c = corner(halfW, halfH);
                    const d = corner(-halfW, halfH);
                    graphics.poly([a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y])
                        .fill({color: bit.color, alpha});
                } else if (bit.kind === 'splash') {
                    const length = bit.size + bit.stretch * fade;
                    graphics.circle(bit.x, bit.y, bit.size * fade)
                        .fill({color: bit.color, alpha});
                    graphics.moveTo(bit.x, bit.y)
                        .lineTo(bit.x - Math.cos(bit.rotation) * length, bit.y - Math.sin(bit.rotation) * length)
                        .stroke({width: Math.max(0.6, bit.size * 0.6), color: bit.color, alpha: alpha * 0.5, cap: 'round'});
                } else {
                    if (bit.stretch > 0.6) {
                        graphics.moveTo(bit.x, bit.y)
                            .lineTo(bit.x - Math.cos(bit.rotation) * bit.stretch, bit.y - Math.sin(bit.rotation) * bit.stretch)
                            .stroke({width: bit.size, color: bit.color, alpha, cap: 'round'});
                    } else {
                        graphics.circle(bit.x, bit.y, bit.size)
                            .fill({color: bit.color, alpha});
                    }
                }
            }
        },
        splash(x, y, angle, strength) {
            const gain = overlapFx().splashGain;
            if (!overlapFx().showDebris || gain <= 0) return;
            const count = Math.round(rand(4, 8) * Math.min(2, gain));
            for (let index = 0; index < count; index += 1) {
                const spread = rand(-0.85, 0.85);
                const speed = rand(60, 240) * Math.min(2.2, strength);
                push({
                    kind: 'splash',
                    x: x + Math.cos(angle + Math.PI) * rand(0, 8),
                    y: y + Math.sin(angle + Math.PI) * rand(0, 8),
                    vx: Math.cos(angle + spread) * speed,
                    vy: Math.sin(angle + spread) * speed,
                    gravity: 320,
                    drag: 2.4,
                    life: rand(0.55, 1.1),
                    age: 0,
                    size: rand(1.2, 2.8) * Math.min(1.6, gain),
                    stretch: rand(2, 9),
                    rotation: angle + spread,
                    spin: rand(-2, 2),
                    color: Math.random() < 0.35 ? accentHex : inkHex,
                    alpha: rand(0.45, 0.8),
                });
            }
        },
        shards(x, y, color) {
            const gain = overlapFx().shardGain;
            if (!overlapFx().showDebris || gain <= 0) return;
            const count = Math.max(1, Math.round(rand(2, 4) * Math.min(2, gain)));
            for (let index = 0; index < count; index += 1) {
                push({
                    kind: 'shard',
                    x: x + rand(-14, 14),
                    y: y + rand(-10, 10),
                    vx: rand(-26, 26),
                    vy: rand(-64, -18),
                    gravity: 120,
                    drag: 1.1,
                    life: rand(1.4, 2.3),
                    age: 0,
                    size: rand(2.6, 6.4) * Math.min(1.6, gain),
                    stretch: 0,
                    rotation: rand(0, Math.PI * 2),
                    spin: rand(-3.4, 3.4),
                    color: hex(color),
                    alpha: rand(0.35, 0.62),
                });
            }
        },
        resize(nextWidth, nextHeight) {
            boxWidth = nextWidth;
            boxHeight = nextHeight;
        },
        setPalette(nextInk, nextAccent) {
            inkHex = hex(nextInk);
            accentHex = hex(nextAccent);
        },
        destroy() {
            bits.length = 0;
            graphics.destroy();
            container.destroy();
        },
    };
};
