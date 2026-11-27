import type { Graphics } from 'pixi.js';
import { temperaHash01 } from './temperaRandom';
import {
    artBrackets,
    artComet,
    artDashedFrame,
    artDots,
    artPath,
    artPoint,
    artScan,
    artTicks,
    artWave,
    type WenflashArtContext,
    type WenflashArtRect,
    type WenflashLineStyle,
} from './wenflashLineArt';

const spanOf = (c: WenflashArtContext) => Math.max(0.03, Math.min(0.8, c.span || 0.22));

const lineRect = (c: WenflashArtContext): WenflashArtRect => ({
    x: c.rect.x,
    y: c.lineY - 0.5,
    width: Math.max(1, c.rect.width),
    height: 1,
});

const ringDots = (rect: WenflashArtRect, count: number, offset: number) => {
    const perimeter = (rect.width + rect.height) * 2;
    const points: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < count; i += 1) points.push(artPoint(rect, offset + (perimeter * i) / count));
    return points;
};

const waveFrame = (g: Graphics, c: WenflashArtContext, amp: number, waves: number, alpha: number) => {
    artWave(g, c.box.x, c.box.x + c.box.width, c.box.y, amp, waves, c.phase, c.width, c.color, alpha);
    artWave(g, c.box.x, c.box.x + c.box.width, c.box.y + c.box.height, amp, waves, c.phase + 0.5, c.width, c.color, alpha);
};

const wavesLine = (g: Graphics, c: WenflashArtContext, amp: number, waves: number, alpha: number, phaseShift = 0) => {
    artWave(g, c.rect.x, c.rect.x + c.rect.width, c.lineY, amp, waves, c.phase + phaseShift, c.width, c.color, alpha);
};

const dashesLine = (g: Graphics, c: WenflashArtContext, dash: number, gap: number, alpha: number) => {
    const stride = Math.max(2, dash + gap);
    let drew = false;
    for (let x = c.rect.x + (((c.phase * stride) % stride) + stride) % stride; x < c.rect.x + c.rect.width; x += stride) {
        const end = Math.min(c.rect.x + c.rect.width, x + dash);
        g.moveTo(x, c.lineY).lineTo(end, c.lineY);
        drew = true;
    }
    if (drew) g.stroke({width: c.width, color: c.color, alpha, cap: 'round'});
};

const dotsLine = (g: Graphics, c: WenflashArtContext, count: number, radius: number, alpha: number) => {
    const points: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < count; i += 1) {
        const t = (i / count + c.phase) % 1;
        points.push({ x: c.rect.x + c.rect.width * t, y: c.lineY });
    }
    artDots(g, points, Math.max(0.6, radius), c.color, alpha);
};

const bracketsLine = (g: Graphics, c: WenflashArtContext, len: number, alpha: number) => {
    const x0 = c.rect.x;
    const x1 = c.rect.x + c.rect.width;
    artPath(g, [{ x: x0, y: c.lineY }, { x: x0 + len, y: c.lineY }], c.width, c.color, alpha);
    artPath(g, [{ x: x1 - len, y: c.lineY }, { x: x1, y: c.lineY }], c.width, c.color, alpha);
};

const tickFrame = (g: Graphics, c: WenflashArtContext, stride: number, len: number, alpha: number) => {
    artTicks(g, c.box, stride, len, c.phase * stride, c.width, c.color, alpha);
};

const tickLine = (g: Graphics, c: WenflashArtContext, stride: number, len: number, alpha: number) => {
    const start = c.rect.x + ((c.phase * stride) % stride);
    let drew = false;
    for (let x = start; x < c.rect.x + c.rect.width; x += stride) {
        g.moveTo(x, c.lineY - len / 2).lineTo(x, c.lineY + len / 2);
        drew = true;
    }
    if (drew) g.stroke({width: c.width, color: c.color, alpha, cap: 'round'});
};

const scanFrame = (g: Graphics, c: WenflashArtContext, alpha: number) => {
    artScan(g, c.box, c.phase, Math.max(1, c.width * 0.8), c.color, alpha, false);
};

const scanLine = (g: Graphics, c: WenflashArtContext, alpha: number) => {
    const x = c.rect.x + c.rect.width * c.phase;
    const trail = Math.max(6, c.rect.width * 0.2);
    const segments = 8;
    for (let i = 0; i < segments; i += 1) {
        const k = 1 - i / segments;
        g.rect(x - trail * (i / segments), c.lineY - c.width, trail / segments, c.width * 2)
            .fill({ color: c.color, alpha: alpha * 0.22 * k });
    }
    g.rect(x, c.lineY - c.width * 1.6, Math.max(1, c.width), c.width * 3.2)
        .fill({ color: c.color, alpha });
};

const echoFrame = (g: Graphics, c: WenflashArtContext, alpha: number) => {
    for (let i = 0; i < 3; i += 1) {
        const grow = i * (3 + c.width);
        artDashedFrame(g, {
            x: c.box.x - grow, y: c.box.y - grow,
            width: c.box.width + grow * 2, height: c.box.height + grow * 2,
        }, 12, 10, c.phase * 22, c.width * (1 - i * 0.25), c.color, alpha * (1 - i * 0.32));
    }
};

const echoLine = (g: Graphics, c: WenflashArtContext, alpha: number) => {
    for (let i = 0; i < 3; i += 1) {
        const off = (i + 1) * (2 + c.width * 0.6);
        artPath(g, [{ x: c.rect.x, y: c.lineY - off }, { x: c.rect.x + c.rect.width, y: c.lineY - off }],
            c.width * (1 - i * 0.25), c.color, alpha * (1 - i * 0.32));
    }
};

const emberPoints = (c: WenflashArtContext, count: number, rise: number) => {
    const points: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < count; i += 1) {
        const seed = temperaHash01(1, i, 9101);
        const x = c.rect.x + c.rect.width * (0.04 + seed * 0.92);
        const t = (c.cycles * (0.35 + seed * 0.4) + seed) % 1;
        points.push({ x, y: c.lineY - t * rise });
    }
    return points;
};

const zigzagPath = (x0: number, x1: number, y: number, amp: number, teeth: number, phase: number) => {
    const points: Array<{ x: number; y: number }> = [];
    const step = (x1 - x0) / teeth;
    for (let i = 0; i <= teeth; i += 1) {
        const t = i / teeth;
        points.push({ x: x0 + (x1 - x0) * t, y: y + (i % 2 === 0 ? amp : -amp) });
    }
    if (points.length > 1) {
        const shift = phase * step * 2;
        for (const p of points) p.x += shift;
    }
    return points;
};

const style = (
    id: string,
    name: string,
    family: string,
    frame: WenflashLineStyle['frame'],
    line: WenflashLineStyle['line'],
): WenflashLineStyle => ({ id, name, family, frame, line });

export const WENFLASH_LINE_STYLES: WenflashLineStyle[] = [
    style('twin-comet', '双彗巡边', '轨道', (g, c) => {
        const p = c.perimeter;
        const span = p * spanOf(c);
        artComet(g, c.box, c.phase * p, span, c.width, c.color, c.alpha);
        artComet(g, c.box, c.phase * p + p / 2, span, c.width, c.color, c.alpha);
    }, (g, c) => {
        const r = lineRect(c);
        const p = (r.width + r.height) * 2;
        artComet(g, r, c.phase * p, r.width * spanOf(c), c.width, c.color, c.alpha);
    }),
    style('star-dust', '星屑轨道', '轨道', (g, c) => {
        artDots(g, ringDots(c.box, 28, c.phase * c.perimeter), Math.max(0.7, c.width * 0.5), c.color, c.alpha);
    }, (g, c) => {
        dotsLine(g, c, 24, c.width * 0.55, c.alpha);
    }),
    style('long-dash', '长划缓行', '虚线', (g, c) => {
        artDashedFrame(g, c.box, Math.max(14, c.perimeter * spanOf(c) * 0.5), 22, c.phase * 76, c.width, c.color, c.alpha);
    }, (g, c) => {
        dashesLine(g, c, Math.max(18, c.rect.width * 0.12), 12, c.alpha);
    }),
    style('fine-dots', '细密虚线', '虚线', (g, c) => {
        artDashedFrame(g, c.box, 3, 7, c.phase * 10, Math.max(0.8, c.width * 0.7), c.color, c.alpha);
    }, (g, c) => {
        dashesLine(g, c, 3, 7, c.alpha);
    }),
    style('breathing-dash', '呼吸短划', '虚线', (g, c) => {
        const dash = 8 + 8 * Math.sin(c.phase * Math.PI * 2);
        artDashedFrame(g, c.box, Math.max(3, dash), 12, 0, c.width, c.color, c.alpha);
    }, (g, c) => {
        const dash = 8 + 8 * Math.sin(c.phase * Math.PI * 2);
        dashesLine(g, c, Math.max(3, dash), 12, c.alpha);
    }),
    style('corner-frame', '四角轻框', '角标', (g, c) => {
        artBrackets(g, c.box, Math.min(c.box.width, c.box.height) * spanOf(c), c.width, c.color, c.alpha);
    }, (g, c) => {
        bracketsLine(g, c, Math.min(28, c.rect.width * 0.12), c.alpha);
    }),
    style('corner-pulse', '角标脉冲', '角标', (g, c) => {
        const len = Math.min(c.box.width, c.box.height) * spanOf(c) * (0.75 + 0.35 * Math.sin(c.phase * Math.PI * 2));
        artBrackets(g, c.box, len, c.width, c.color, c.alpha);
    }, (g, c) => {
        const len = Math.min(40, c.rect.width * (0.1 + 0.05 * Math.sin(c.phase * Math.PI * 2)));
        bracketsLine(g, c, len, c.alpha);
    }),
    style('edge-ticks', '边中刻度', '刻度', (g, c) => {
        tickFrame(g, c, 18, 8, c.alpha);
    }, (g, c) => {
        tickLine(g, c, 16, 8, c.alpha);
    }),
    style('vernier', '游标卡尺', '刻度', (g, c) => {
        tickFrame(g, c, 22, 7, c.alpha * 0.7);
        const p = artPoint(c.box, c.phase * c.perimeter);
        artPath(g, [{ x: p.x, y: p.y }, { x: p.x, y: p.y + 18 }], c.width * 1.4, c.color, c.alpha);
    }, (g, c) => {
        tickLine(g, c, 20, 6, c.alpha * 0.7);
        const x = c.rect.x + c.rect.width * c.phase;
        artPath(g, [{ x, y: c.lineY - 12 }, { x, y: c.lineY + 12 }], c.width * 1.6, c.color, c.alpha);
    }),
    style('sine-ribbon', '正弦光带', '波带', (g, c) => {
        waveFrame(g, c, c.fontSize * 0.16, 3, c.alpha);
    }, (g, c) => {
        wavesLine(g, c, Math.min(c.fontSize * 0.5, 18), 3, c.alpha);
    }),
    style('twin-sine', '双股波纹', '波带', (g, c) => {
        artWave(g, c.box.x, c.box.x + c.box.width, c.box.y + c.box.height * 0.25, c.fontSize * 0.12, 2, c.phase, c.width, c.color, c.alpha);
        artWave(g, c.box.x, c.box.x + c.box.width, c.box.y + c.box.height * 0.75, c.fontSize * 0.12, 2, c.phase + 0.5, c.width, c.color, c.alpha);
    }, (g, c) => {
        wavesLine(g, c, c.fontSize * 0.3, 2, c.alpha, 0);
        wavesLine(g, c, c.fontSize * 0.3, 2, c.alpha * 0.6, 0.5);
    }),
    style('standing-wave', '水波驻留', '波带', (g, c) => {
        const amp = c.fontSize * 0.18 * Math.sin(c.phase * Math.PI);
        artWave(g, c.box.x, c.box.x + c.box.width, c.box.y + c.box.height, Math.abs(amp), 4, c.phase, c.width, c.color, c.alpha);
    }, (g, c) => {
        const amp = c.fontSize * 0.42 * Math.abs(Math.sin(c.phase * Math.PI));
        wavesLine(g, c, Math.max(1, amp), 4, c.alpha);
    }),
    style('helix', '螺旋缠绕', '波带', (g, c) => {
        artWave(g, c.box.x, c.box.x + c.box.width, c.box.y, c.fontSize * 0.1, 3, c.phase, c.width, c.color, c.alpha * 0.85);
        artWave(g, c.box.x, c.box.x + c.box.width, c.box.y + c.box.height, c.fontSize * 0.1, 3, c.phase + 0.5, c.width, c.color, c.alpha * 0.85);
    }, (g, c) => {
        wavesLine(g, c, c.fontSize * 0.35, 3, c.alpha * 0.9);
        wavesLine(g, c, c.fontSize * 0.35, 3, c.alpha * 0.55, 0.5);
    }),
    style('scan-beam', '扫描光幕', '扫描', (g, c) => {
        scanFrame(g, c, c.alpha);
    }, (g, c) => {
        scanLine(g, c, c.alpha);
    }),
    style('double-scan', '双扫对开', '扫描', (g, c) => {
        artScan(g, c.box, c.phase, c.width, c.color, c.alpha * 0.8, false);
        artScan(g, c.box, 1 - c.phase, c.width * 0.8, c.color, c.alpha * 0.65, false);
    }, (g, c) => {
        scanLine(g, c, c.alpha);
        const x = c.rect.x + c.rect.width * (1 - c.phase);
        g.rect(x, c.lineY - c.width * 1.6, Math.max(1, c.width), c.width * 3.2).fill({ color: c.color, alpha: c.alpha * 0.8 });
    }),
    style('radar', '雷达回波', '扫描', (g, c) => {
        const grow = (1 - c.phase) * c.fontSize * 0.5;
        artDashedFrame(g, {
            x: c.box.x - grow, y: c.box.y - grow,
            width: c.box.width + grow * 2, height: c.box.height + grow * 2,
        }, 10, 12, 0, c.width, c.color, c.alpha * Math.max(0.30, c.phase));
    }, (g, c) => {
        const grow = (1 - c.phase) * 20;
        artPath(g, [{ x: c.rect.x - grow, y: c.lineY }, { x: c.rect.x + c.rect.width + grow, y: c.lineY }],
            c.width, c.color, c.alpha * Math.max(0.30, c.phase));
    }),
    style('echo', '回声残影', '残影', (g, c) => {
        echoFrame(g, c, c.alpha);
    }, (g, c) => {
        echoLine(g, c, c.alpha);
    }),
    style('mirror-frame', '镜像半框', '残影', (g, c) => {
        artPath(g, [{ x: c.box.x, y: c.box.y }, { x: c.box.x + c.box.width, y: c.box.y }], c.width, c.color, c.alpha);
        artPath(g, [{ x: c.box.x, y: c.box.y + c.box.height }, { x: c.box.x + c.box.width, y: c.box.y + c.box.height }], c.width, c.color, c.alpha * 0.3);
    }, (g, c) => {
        const mid = c.rect.x + c.rect.width / 2;
        artPath(g, [{ x: c.rect.x, y: c.lineY }, { x: mid, y: c.lineY }], c.width, c.color, c.alpha);
        artPath(g, [{ x: mid, y: c.lineY }, { x: c.rect.x + c.rect.width, y: c.lineY }], c.width, c.color, c.alpha * 0.3);
    }),
    style('comet-dust', '彗尾拖尘', '粒子', (g, c) => {
        const p = c.perimeter;
        artComet(g, c.box, c.phase * p, p * spanOf(c) * 0.8, c.width, c.color, c.alpha);
        for (let i = 0; i < 14; i += 1) {
            const q = artPoint(c.box, c.phase * p - i * 6);
            g.circle(q.x, q.y, Math.max(0.6, c.width * 0.4 * (1 - i / 14))).fill({ color: c.color, alpha: c.alpha * (0.5 - i * 0.03) });
        }
    }, (g, c) => {
        const r = lineRect(c);
        const p = (r.width + r.height) * 2;
        artComet(g, r, c.phase * p, r.width * spanOf(c) * 0.8, c.width, c.color, c.alpha);
        for (let i = 0; i < 12; i += 1) {
            const q = artPoint(r, c.phase * p - i * 6);
            g.circle(q.x, q.y, Math.max(0.5, c.width * 0.35 * (1 - i / 12))).fill({ color: c.color, alpha: c.alpha * (0.45 - i * 0.03) });
        }
    }),
    style('embers', '火星浮升', '粒子', (g, c) => {
        artDots(g, emberPoints(c, 16, c.fontSize * 1.4), Math.max(0.8, c.width * 0.5), c.color, c.alpha * 0.9);
    }, (g, c) => {
        artDots(g, emberPoints(c, 22, 34), Math.max(0.7, c.width * 0.5), c.color, c.alpha * 0.9);
    }),
    style('constellation', '星座连线', '粒子', (g, c) => {
        const pts: Array<{ x: number; y: number }> = [];
        for (let i = 0; i < 9; i += 1) {
            pts.push({
                x: c.box.x + c.box.width * temperaHash01(7, i, 313),
                y: c.box.y + c.box.height * temperaHash01(7, i, 617),
            });
        }
        for (let i = 1; i < pts.length; i += 1) artPath(g, [pts[i - 1], pts[i]], c.width * 0.6, c.color, c.alpha * 0.4);
        artDots(g, pts, Math.max(0.9, c.width * 0.55), c.color, c.alpha);
    }, (g, c) => {
        const pts: Array<{ x: number; y: number }> = [];
        for (let i = 0; i < 10; i += 1) pts.push({ x: c.rect.x + c.rect.width * temperaHash01(3, i, 811), y: c.lineY - 10 + temperaHash01(3, i, 823) * 12 });
        for (let i = 1; i < pts.length; i += 1) artPath(g, [pts[i - 1], pts[i]], c.width * 0.5, c.color, c.alpha * 0.35);
        artDots(g, pts, Math.max(0.7, c.width * 0.5), c.color, c.alpha);
    }),
    style('march-dots', '光点列队', '粒子', (g, c) => {
        artDots(g, ringDots(c.box, 20, c.phase * 24), Math.max(0.8, c.width * 0.6), c.color, c.alpha);
    }, (g, c) => {
        dotsLine(g, c, 18, c.width * 0.6, c.alpha);
    }),
    style('ladder', '阶梯刻度', '刻度', (g, c) => {
        artTicks(g, c.box, 26, 14, c.phase * 26, c.width, c.color, c.alpha);
    }, (g, c) => {
        tickLine(g, c, 12, 14, c.alpha);
    }),
    style('morse', '莫尔斯脉冲', '节奏', (g, c) => {
        const pattern = [40, 16, 16, 16, 40, 16, 16];
        let at = c.phase * 120;
        for (const len of pattern) {
            if (len > 20) artPath(g, framePointsSafe(c.box, at, len), c.width, c.color, c.alpha);
            at += len + 10;
        }
    }, (g, c) => {
        let x = c.rect.x + ((c.phase * 120) % 40);
        let i = 0;
        while (x < c.rect.x + c.rect.width) {
            const len = i % 3 === 0 ? 20 : 6;
            artPath(g, [{ x, y: c.lineY }, { x: Math.min(x + len, c.rect.x + c.rect.width), y: c.lineY }], c.width, c.color, c.alpha);
            x += len + 10;
            i += 1;
        }
    }),
    style('gradient-dash', '断续渐变', '虚线', (g, c) => {
        const perimeter = c.perimeter;
        for (let i = 0; i < 16; i += 1) {
            const start = c.phase * perimeter + (perimeter * i) / 16;
            artPath(g, framePointsSafe(c.box, start, perimeter / 32), c.width, c.color, c.alpha * (0.25 + 0.75 * (i / 16)));
        }
    }, (g, c) => {
        const step = c.rect.width / 14;
        for (let i = 0; i < 14; i += 1) {
            const x = c.rect.x + step * i + ((c.phase * step) % step);
            artPath(g, [{ x, y: c.lineY }, { x: x + step * 0.55, y: c.lineY }], c.width, c.color, c.alpha * (0.2 + 0.8 * (i / 14)));
        }
    }),
    style('parallel', '双线并行', '结构', (g, c) => {
        artPath(g, [{ x: c.box.x, y: c.box.y }, { x: c.box.x + c.box.width, y: c.box.y }], c.width, c.color, c.alpha);
        artPath(g, [{ x: c.box.x, y: c.box.y + c.box.height }, { x: c.box.x + c.box.width, y: c.box.y + c.box.height }], c.width, c.color, c.alpha * 0.55);
    }, (g, c) => {
        artPath(g, [{ x: c.rect.x, y: c.lineY - 2 - c.width }, { x: c.rect.x + c.rect.width, y: c.lineY - 2 - c.width }], c.width, c.color, c.alpha);
        artPath(g, [{ x: c.rect.x, y: c.lineY + 2 + c.width }, { x: c.rect.x + c.rect.width, y: c.lineY + 2 + c.width }], c.width, c.color, c.alpha * 0.55);
    }),
    style('braid', '交叉织带', '结构', (g, c) => {
        artWave(g, c.box.x, c.box.x + c.box.width, c.box.y + c.box.height * 0.5, c.fontSize * 0.2, 3, c.phase, c.width, c.color, c.alpha);
        artWave(g, c.box.x, c.box.x + c.box.width, c.box.y + c.box.height * 0.5, c.fontSize * 0.2, 3, c.phase + 0.5, c.width, c.color, c.alpha * 0.55);
    }, (g, c) => {
        wavesLine(g, c, c.fontSize * 0.45, 3, c.alpha);
        wavesLine(g, c, c.fontSize * 0.45, 3, c.alpha * 0.55, 0.5);
    }),
    style('halo', '呼吸光晕', '结构', (g, c) => {
        const breathe = 0.5 + 0.5 * Math.sin(c.phase * Math.PI * 2);
        artDashedFrame(g, c.box, 8, 4, 0, c.width * (3 + breathe * 2), c.color, c.alpha * 0.16);
        artDashedFrame(g, c.box, 8, 4, 0, c.width * 0.7, c.color, c.alpha);
    }, (g, c) => {
        const breathe = 0.5 + 0.5 * Math.sin(c.phase * Math.PI * 2);
        artPath(g, [{ x: c.rect.x, y: c.lineY }, { x: c.rect.x + c.rect.width, y: c.lineY }], c.width * (3 + breathe * 2), c.color, c.alpha * 0.16);
        artPath(g, [{ x: c.rect.x, y: c.lineY }, { x: c.rect.x + c.rect.width, y: c.lineY }], c.width * 0.7, c.color, c.alpha);
    }),
    style('zigzag', '折角回廊', '结构', (g, c) => {
        for (const y of [c.box.y, c.box.y + c.box.height]) {
            const pts = zigzagPath(c.box.x, c.box.x + c.box.width, y, Math.min(6, c.box.height * 0.06), 16, c.phase);
            artPath(g, pts, c.width, c.color, c.alpha);
        }
    }, (g, c) => {
        artPath(g, zigzagPath(c.rect.x - 8, c.rect.x + c.rect.width + 8, c.lineY, 4, 18, c.phase), c.width, c.color, c.alpha);
    }),
    style('taper', '落笔收锋', '结构', (g, c) => {
        const p = c.perimeter;
        const span = p * spanOf(c);
        artComet(g, c.box, c.phase * p, span, c.width, c.color, c.alpha, 1.4);
        artComet(g, c.box, c.phase * p + p / 2, span * 0.65, c.width * 0.7, c.color, c.alpha * 0.6, 1.4);
    }, (g, c) => {
        const r = lineRect(c);
        const p = (r.width + r.height) * 2;
        artComet(g, r, c.phase * p, r.width * spanOf(c), c.width, c.color, c.alpha, 1.6);
    }),
];

const framePointsSafe = (rect: WenflashArtRect, from: number, length: number) => {
    const points: Array<{ x: number; y: number }> = [];
    const steps = Math.max(2, Math.ceil(length / 6));
    for (let i = 0; i <= steps; i += 1) points.push(artPoint(rect, from + (length * i) / steps));
    return points;
};

export const pickWenflashLineStyle = (seed: number, ordinal: number): WenflashLineStyle => {
    const count = WENFLASH_LINE_STYLES.length;
    const roll = Math.min(count - 1, Math.floor(temperaHash01(seed, ordinal, 99173) * count));
    // 30 与 7 互质：相邻句的 ordinal 每加一，样式就前进 7 格，避免连续重复。
    return WENFLASH_LINE_STYLES[(roll + ordinal * 7) % count];
};
