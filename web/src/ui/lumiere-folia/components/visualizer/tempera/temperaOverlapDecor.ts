import { overlapFx } from '../../../../overlapSettings';

type PixiModule = typeof import('pixi.js');

// src/components/visualizer/tempera/temperaOverlapDecor.ts
// Stage furniture for 重合: a trail joining where the last few lines were written, and a pen
// stroke joining one line's last character to the next line's first. It lives inside the shared
// follow camera's container, so it travels, turns and zooms with the type instead of sitting on
// the glass. All of it is thin and low-alpha - the lyric has to stay the loudest thing on screen.

export interface OverlapDecorLine {
    /** Identity of the line the point belongs to; a change starts a new point and a new stroke. */
    key: string;
    /** Stage-space centre of the line, for the trail. */
    x: number;
    y: number;
    /** Stage-space first and last character, for the stroke between lines. */
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    /** 当前句自身的时长；弧头写完后的余辉按它的一半慢慢退掉。 */
    duration: number;
    /** 本句首字/末字的颜色，引导线两端靠它们做渐变。 */
    startColor?: string;
    endColor?: string;
    /** 本句重点词在舞台上的位置与颜色，引导线的支线指向它。 */
    keywordX?: number;
    keywordY?: number;
    keywordColor?: string;
}

interface TrailSegment {
    key: string;
    fromX: number; fromY: number; toX: number; toY: number;
    fromColor: string; toColor: string;
    keywordX?: number; keywordY?: number; keywordColor?: string;
    flip: boolean;
    born: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export interface OverlapDecorState {
    time: number;
    line: OverlapDecorLine | null;
}

export interface TemperaOverlapDecor {
    container: import('pixi.js').Container;
    /** 换歌或换主题后把纸面与字色重新交给装饰，弧线不会停在上一首的颜色上。 */
    setPalette: (ink: string, accent: string) => void;
    update: (state: OverlapDecorState, dt: number) => void;
    resize: (width: number, height: number) => void;
    destroy: () => void;
}

/** Seconds for the one path the trail keeps to fade out. */
const TRAIL_LIFE = 5;
/** Seconds for the segment towards a new point to draw itself in. */
const SEGMENT_GROW = 0.55;
/** 终点十字在线到位后再落下。 */
const DOT_GROW = 0.3;
/** The stroke between lines draws itself, then dries out. */
const ARC_LIFE = 7;
const ARC_STEPS = 28;
/** 同屏最多几笔弧线（引导弧 + 随机补笔）。 */
const ARC_MAX = 9;
/** 随机补笔的间隔区间（秒）：这个范围里随机挑一个，让弧线不是每句才出现一根。 */
const AMBIENT_ARC_GAP: readonly [number, number] = [0.9, 2.4];

const easeOut = (value: number) => 1 - (1 - value) * (1 - value);

/** Stable 0..1 coin per line key, so the same song leaves the same traces on every play. */
const hashLineKey = (key: string, salt: number) => {
    let hash = 2166136261 ^ salt;
    for (let index = 0; index < key.length; index += 1) {
        hash ^= key.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return ((hash >>> 0) % 100000) / 100000;
};

export const createTemperaOverlapDecor = (
    pixi: PixiModule,
    _width: number,
    _height: number,
    ink: string,
    accent: string,
): TemperaOverlapDecor => {
    const container = new pixi.Container();
    // Above every paragraph scene. Each scene paints its own paper ground over the whole
    // viewport, so anything sitting under the scenes is simply covered - the marks have to be
    // drawn over the page, not under it.
    container.zIndex = 1_000_000;
    // Fades in on the first update, so the furniture arrives with the stage rather than popping.
    container.alpha = 0;
    const graphics = new pixi.Graphics();
    container.addChild(graphics);
    // The lit part is drawn additively on its own layer: on a near-black page an alpha blend
    // tops out at the accent colour, while add lets the core climb past it into white.
    const hotGraphics = new pixi.Graphics();
    hotGraphics.blendMode = 'add';
    container.addChild(hotGraphics);
    // The stroke is written in the page's own two inks: the cooled tail takes the lyric colour,
    // the hot head takes the accent, so the pen changes colour with the song.
    let inkHex = ink;
    let accentHex = accent;
    const mixHex = (from: string, to: string, amount: number) => {
        const parse = (hex: string) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
        const a = parse(from);
        const b = parse(to);
        return '#' + a.map((value, index) => Math.round(value + (b[index]! - value) * amount).toString(16).padStart(2, '0')).join('');
    };
    const setPalette = (nextInk: string, nextAccent: string) => {
        inkHex = nextInk;
        accentHex = nextAccent;
    };

    // Only the newest hop is drawn: a chain of five marks read as a chart of the song rather
    // than a trace of the pen. The previous landing is still remembered as the tail of the next
    // path, but it is never drawn on its own.
    let previousNode: {x: number; y: number; color: string} | null = null;
    let segment: TrailSegment | null = null;
    // Strokes that have been replaced by a newer hop: they retract towards their start instead
    // of blinking out, so the pen reads as lifting rather than the line being erased.
    const retiring: {segment: TrailSegment; at: number}[] = [];
    const arcs: {
        /** Set when the stage is full and this stroke has to give way to a newer one. */
        retireAt?: number;
        key: string;
        fromX: number; fromY: number;
        toX: number; toY: number;
        bow: number;
        born: number;
        /** Seconds the landed head keeps glowing: half of the line it points at. */
        hold: number;
    }[] = [];
    let lastKey: string | null = null;
    let lastEnd: {x: number; y: number} | null = null;
    // Break marks: a short vertical rule left where a line ended, so the page reads as typeset
    // rather than as one continuous ribbon. They live in stage space, like the rest of the furniture.
    const ticks: {x: number; y: number; born: number}[] = [];
    let arcCount = 0;
    // 随机补笔：独立于换句，隔一会儿自己描一笔，画面上的弧线密度就不再被「一句一根」绑住。
    let ambientSeq = 0;
    let ambientNext = 0;

    const quad = (
        t: number,
        fromX: number, fromY: number,
        controlX: number, controlY: number,
        toX: number, toY: number,
    ) => {
        const u = 1 - t;
        return {
            x: u * u * fromX + 2 * u * t * controlX + t * t * toX,
            y: u * u * fromY + 2 * u * t * controlY + t * t * toY,
        };
    };

    const smoothstep = (value: number) => value * value * (3 - 2 * value);

    /** 在上一句/当前句附近随手描一笔：起点、长度、弯度都由序号哈希决定，重播同一首歌走势一致。 */
    const spawnAmbientArc = (time: number, anchor: OverlapDecorLine | null) => {
        const seed = `ambient-${ambientSeq}`;
        ambientSeq += 1;
        const pick = (salt: number, from: number, to: number) => from + (to - from) * hashLineKey(seed, salt);
        const baseX = anchor ? (anchor.startX + anchor.endX) / 2 : 0;
        const baseY = anchor ? (anchor.startY + anchor.endY) / 2 : 0;
        const span = anchor ? Math.max(220, Math.hypot(anchor.endX - anchor.startX, anchor.endY - anchor.startY)) : 320;
        const angle = pick(211, 0, Math.PI * 2);
        // 补笔是「书上随手划的一道」，不是贯穿画面的划痕：长度压在 140–380，别跟着整行宽度放大。
        const length = pick(223, 140, Math.min(380, Math.max(200, span * 0.7)));
        const tail = pick(227, 0.35, 1.1);
        const fromX = baseX + Math.cos(angle) * span * 0.5 * (pick(229, -1, 1));
        const fromY = baseY + Math.sin(angle) * span * 0.34 * (pick(233, -1, 1));
        arcs.push({
            key: seed,
            fromX,
            fromY,
            toX: fromX + Math.cos(angle) * length * tail,
            toY: fromY + Math.sin(angle) * length * tail,
            bow: Math.min(64, length * 0.22) * (pick(239, 0, 1) < 0.5 ? 1 : -1),
            born: time,
            hold: pick(241, 0.8, 1.6),
        });
    };

    const drawArcs = (time: number) => {
        if (!overlapFx().showArc) return;
        const decorAlpha = overlapFx().decorAlpha;
        for (const arc of arcs) {
            const age = time - arc.born;
            if (age <= 0) continue;
            const lifeLeft = ARC_LIFE - age;
            if (lifeLeft <= 0) continue;
            const fadeIn = smoothstep(Math.min(1, age / 0.25));
            const fadeOut = smoothstep(Math.min(1, Math.max(0, lifeLeft / 1.5)));
            // A stroke that has to make room for a newer one is retired, not cut: it keeps its
            // own fade but is shortened to a quick dry-out, so nothing ever pops off the stage.
            const retiring = arc.retireAt === undefined
                ? 1
                : 1 - Math.min(1, Math.max(0, (time - arc.retireAt) / 0.6));
            const retireFade = retiring * retiring * (3 - 2 * retiring);
            const fade = fadeIn * fadeOut * retireFade;
            if (fade <= 0.004) continue;
            // The pen lands a moment after the line does, then draws quickly and eases off; a
            // linear sweep at constant speed is what made the stroke read as a wipe.
            const grow = easeOut(Math.min(1, Math.max(0, (age - 0.16) / 0.5)));
            // On the way out the stroke is lifted from the tail: it retracts towards the pen
            // instead of fading flat, so the erase has a direction and a body to it.
            const retract = smoothstep(Math.min(1, Math.max(0, (age - (ARC_LIFE - 1.8)) / 1.8))) * 0.94;
            if (grow <= 0 || grow <= retract + 0.002) continue;
            const dx = arc.toX - arc.fromX;
            const dy = arc.toY - arc.fromY;
            const length = Math.hypot(dx, dy) || 1;
            const nx = -dy / length;
            const ny = dx / length;
            const controlX = (arc.fromX + arc.toX) / 2 + nx * arc.bow;
            const controlY = (arc.fromY + arc.toY) / 2 + ny * arc.bow;
            // The wobble is zero at both ends, so the stroke stays welded to the last character
            // of one line and the first of the next, and only breathes in the middle.
            const point = (t: number) => {
                const base = quad(t, arc.fromX, arc.fromY, controlX, controlY, arc.toX, arc.toY);
                const ripple = Math.sin(t * Math.PI * 3) * 1.2 * Math.sin(t * Math.PI);
                return {x: base.x + nx * ripple, y: base.y + ny * ripple};
            };
            // Sample to the exact tip rather than a whole number of steps: the head then glides
            // instead of hopping a segment per frame.
            const steps = Math.max(2, Math.ceil(ARC_STEPS * (grow - retract)));
            const head = point(retract);
            graphics.moveTo(head.x, head.y);
            for (let step = 1; step < steps; step += 1) {
                const sample = point(retract + (grow - retract) * (step / steps));
                graphics.lineTo(sample.x, sample.y);
            }
            const tip = point(grow);
            graphics.lineTo(tip.x, tip.y);
            // Wet ink: a wider, fainter pass under the line gives it the weight of a real nib
            // without turning it into a bar.
            // Round caps on every pass: a butt end reads as a cut wire, and the tail would show a
            // square notch where it retracts.
            graphics.stroke({width: 3.8, color: inkHex, alpha: 0.16 * fade * decorAlpha, cap: 'round', join: 'round'});
            graphics.stroke({width: 2.0, color: inkHex, alpha: 0.34 * fade * decorAlpha, cap: 'round', join: 'round'});
            // Meteor trail: the stroke is not evenly wet. A short hot span right behind the head
            // carries most of the light, the rest of the arc stays as the cooled tail.
            // The head is not a dot: it is the last stretch of the stroke, written in the deepened
            // accent and much brighter than the tail. Once the pen lifts, that stretch keeps its
            // light and then takes half the line's length to dim away.
            const landed = grow >= 0.999;
            const sinceLand = Math.max(0, age - 0.66);
            const holdFade = landed
                ? 1 - smoothstep(Math.min(1, sinceLand / Math.max(0.8, arc.hold)))
                : 1;
            // Short hot stretch: long enough to read as a lit nib, short enough that the stroke is
            // still a stroke rather than a glowing bar.
            const hotSpan = Math.min(0.16, 0.05 + Math.max(0, grow - retract) * 0.16);
            const hot = Math.max(retract, grow - hotSpan);
            graphics.moveTo(point(hot).x, point(hot).y);
            const hotSteps = Math.max(2, Math.ceil(steps * ((grow - hot) / Math.max(0.001, grow - retract))));
            for (let step = 1; step <= hotSteps; step += 1) {
                const sample = point(hot + (grow - hot) * (step / hotSteps));
                graphics.lineTo(sample.x, sample.y);
            }
            const hotFade = holdFade * fade * decorAlpha;
            // Pure white head: the halo keeps the accent so it still belongs to the song, but the
            // written stretch and its core are white, which on the additive layer is as bright as
            // the page allows.
            hotGraphics.stroke({width: 14, color: accentHex, alpha: 0.30 * hotFade, cap: 'round', join: 'round'});
            hotGraphics.stroke({width: 7.2, color: mixHex(accentHex, '#ffffff', 0.55), alpha: 0.9 * hotFade, cap: 'round', join: 'round'});
            hotGraphics.stroke({width: 3.0, color: '#ffffff', alpha: 1 * hotFade, cap: 'round', join: 'round'});
            // Touch-down bloom: the nib meets the page before it starts to travel.
            const land = Math.min(1, Math.max(0, age / 0.35));
            if (land < 1) {
                graphics.circle(arc.fromX, arc.fromY, 2 + 5 * easeOut(land))
                    .fill({color: accent, alpha: 0.3 * (1 - land) * fadeIn * decorAlpha});
            }
            // While the pen is still moving the very tip gets a small white core; no bloom is
            // drawn at the moment it lifts, because that point-flash read as a cartoon sparkle.
            if (!landed) {
                hotGraphics.circle(tip.x, tip.y, 2.2)
                    .fill({color: 0xffffff, alpha: 0.9 * fade * decorAlpha});
            }
        }
    };

    /** 引导线先横后竖或先竖后横，拐角切一个小圆角——排版稿上的定位线，不是一条斜杠。 */
    type GuidePoint = {x: number; y: number};
    const buildGuide = (
        fromX: number, fromY: number, toX: number, toY: number, flip: boolean, corner = 7,
    ): GuidePoint[] => {
        const dx = toX - fromX;
        const dy = toY - fromY;
        if (Math.abs(dx) < 2 || Math.abs(dy) < 2) return [{x: fromX, y: fromY}, {x: toX, y: toY}];
        const radius = Math.min(corner, Math.abs(dx) * 0.5, Math.abs(dy) * 0.5);
        const cornerX = flip ? fromX : toX;
        const cornerY = flip ? toY : fromY;
        const beforeX = cornerX - Math.sign(cornerX - fromX) * radius;
        const beforeY = cornerY - Math.sign(cornerY - fromY) * radius;
        const afterX = cornerX + Math.sign(toX - cornerX) * radius;
        const afterY = cornerY + Math.sign(toY - cornerY) * radius;
        return [
            {x: fromX, y: fromY},
            {x: beforeX, y: beforeY},
            {x: cornerX, y: cornerY},
            {x: afterX, y: afterY},
            {x: toX, y: toY},
        ];
    };
    const guideLength = (points: GuidePoint[]) => {
        let total = 0;
        for (let index = 1; index < points.length; index += 1) {
            total += Math.hypot(points[index]!.x - points[index - 1]!.x, points[index]!.y - points[index - 1]!.y);
        }
        return total || 1;
    };
    const guideAt = (points: GuidePoint[], t: number): GuidePoint => {
        const total = guideLength(points);
        let remain = Math.min(1, Math.max(0, t)) * total;
        for (let index = 1; index < points.length; index += 1) {
            const a = points[index - 1]!;
            const b = points[index]!;
            const length = Math.hypot(b.x - a.x, b.y - a.y);
            if (remain <= length || index === points.length - 1) {
                const k = length > 0 ? Math.min(1, remain / length) : 0;
                return {x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k};
            }
            remain -= length;
        }
        return points[points.length - 1]!;
    };
    const lerpColor = (from: string, to: string, t: number) => mixHex(from, to, Math.min(1, Math.max(0, t)));

    const drawTrail = (time: number) => {
        if (!overlapFx().showTrail) return;
        const decorAlpha = overlapFx().decorAlpha;
        // Older strokes withdraw before the newest one is drawn on top of them.
        for (let index = retiring.length - 1; index >= 0; index -= 1) {
            const entry = retiring[index];
            const t = clamp01((time - entry.at) / 0.55);
            if (t >= 1) {
                retiring.splice(index, 1);
                continue;
            }
            const keep = 1 - t;
            const points = buildGuide(entry.segment.fromX, entry.segment.fromY, entry.segment.toX, entry.segment.toY, entry.segment.flip);
            const tailColor = entry.segment.fromColor;
            const headColor = entry.segment.toColor;
            for (let slice = 0; slice < 8; slice += 1) {
                const a = guideAt(points, (keep * slice) / 8);
                const b = guideAt(points, (keep * (slice + 1)) / 8);
                graphics.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({
                    width: 1.6,
                    color: lerpColor(tailColor, headColor, (slice + 0.5) / 8),
                    alpha: 0.42 * (1 - t) * (1 - t) * decorAlpha,
                    cap: 'round',
                    join: 'round',
                });
            }
        }
        if (!segment) return;
        const age = time - segment.born;
        if (age <= 0) return;
        const grow = Math.min(1, Math.max(0, age / SEGMENT_GROW));
        const fade = Math.max(0, 1 - age / TRAIL_LIFE);
        if (fade <= 0) return;
        const eased = easeOut(grow);
        const points = buildGuide(segment.fromX, segment.fromY, segment.toX, segment.toY, segment.flip);
        const tip = guideAt(points, eased);
        const tail = lerpColor(segment.fromColor, segment.toColor, 0);
        const head = lerpColor(segment.fromColor, segment.toColor, 1);
        // 线身按「从头到尾」的颜色采样分段描：两端各取所在字的颜色，中间自然过渡。
        const slices = 10;
        for (let index = 0; index < slices; index += 1) {
            const a = guideAt(points, (eased * index) / slices);
            const b = guideAt(points, (eased * (index + 1)) / slices);
            const color = lerpColor(tail, head, (index + 0.5) / slices);
            graphics.moveTo(a.x, a.y).lineTo(b.x, b.y)
                .stroke({width: 1.6, color, alpha: 0.42 * fade * decorAlpha, cap: 'round', join: 'round'});
        }
        // 笔尖：生长时线头带一个小亮点，像笔正被拉着走。
        graphics.circle(tip.x, tip.y, 1.8)
            .fill({color: head, alpha: 0.5 * fade * (1 - eased * 0.45) * decorAlpha});
        // 等距刻度：线走到哪一格，哪一格亮起来，像尺子量到下一个落点。
        const tickCount = 7;
        for (let index = 1; index < tickCount; index += 1) {
            const at = index / tickCount;
            if (eased + 0.02 < at) continue;
            const point = guideAt(points, at);
            const near = guideAt(points, Math.min(1, at + 0.01));
            const angle = Math.atan2(near.y - point.y, near.x - point.x) + Math.PI / 2;
            const reach = 2.4;
            graphics.moveTo(point.x - Math.cos(angle) * reach, point.y - Math.sin(angle) * reach)
                .lineTo(point.x + Math.cos(angle) * reach, point.y + Math.sin(angle) * reach)
                .stroke({width: 0.9, color: inkHex, alpha: 0.5 * fade * decorAlpha, cap: 'round'});
        }
        // 起点：空心小圆；终点：等线到位后再落一个十字，说明这条线「停在这儿」。
        graphics.circle(segment.fromX, segment.fromY, 2.2)
            .stroke({width: 1, color: segment.fromColor, alpha: 0.55 * fade * decorAlpha});
        const landed = Math.min(1, Math.max(0, (age - SEGMENT_GROW) / DOT_GROW));
        if (landed > 0) {
            const arm = 3.2 * easeOut(landed);
            graphics.moveTo(segment.toX - arm, segment.toY).lineTo(segment.toX + arm, segment.toY)
                .moveTo(segment.toX, segment.toY - arm).lineTo(segment.toX, segment.toY + arm)
                .stroke({width: 1.1, color: segment.toColor, alpha: 0.6 * fade * landed * decorAlpha, cap: 'round'});
        }
        // 支线：主线到位后，从终点伸一小段去指这一句的重点词。
        if (segment.keywordX !== undefined && segment.keywordY !== undefined && landed > 0) {
            const dx = segment.keywordX - segment.toX;
            const dy = segment.keywordY - segment.toY;
            const length = Math.hypot(dx, dy);
            if (length > 10) {
                const k = Math.min(1, 26 / length);
                const targetX = segment.toX + dx * k;
                const targetY = segment.toY + dy * k;
                graphics.moveTo(segment.toX, segment.toY).lineTo(targetX, targetY)
                    .stroke({width: 1.1, color: segment.keywordColor ?? accentHex, alpha: 0.4 * fade * landed * decorAlpha, cap: 'round'});
                graphics.circle(targetX, targetY, 1.6)
                    .fill({color: segment.keywordColor ?? accentHex, alpha: 0.6 * fade * landed * decorAlpha});
            }
        }
        // 扫光：线成形后，一段 18% 长度的亮头沿线走一趟，然后整条线继续按原节奏淡掉。
        if (grow >= 1) {
            const sweep = Math.min(1, Math.max(0, (age - SEGMENT_GROW) / 0.9));
            if (sweep < 1) {
                const window = 0.18;
                const from = Math.max(0, sweep - window);
                const a = guideAt(points, from);
                const b = guideAt(points, sweep);
                hotGraphics.moveTo(a.x, a.y).lineTo(b.x, b.y)
                    .stroke({width: 2.6, color: mixHex(segment.toColor, '#ffffff', 0.5), alpha: 0.55 * (1 - sweep) * decorAlpha, cap: 'round'});
                hotGraphics.circle(b.x, b.y, 2.4)
                    .fill({color: 0xffffff, alpha: 0.7 * (1 - sweep) * decorAlpha});
            }
        }
    };

    const drawBreaks = (time: number) => {
        if (!overlapFx().showBreak) return;
        const decorAlpha = overlapFx().decorAlpha;
        for (const tick of ticks) {
            const age = time - tick.born;
            if (age < 0) continue;
            const fade = Math.max(0, 1 - Math.max(0, age - 0.45) / 1.1);
            if (fade <= 0) continue;
            const half = 9 * easeOut(Math.min(1, age / 0.22));
            graphics.moveTo(tick.x, tick.y - half).lineTo(tick.x, tick.y + half)
                .stroke({width: 1.2, color: inkHex, alpha: 0.42 * fade * decorAlpha, cap: 'round'});
        }
    };

    const update = (state: OverlapDecorState, dt: number) => {
        const step = Math.max(0, Math.min(0.1, dt));
        for (let index = ticks.length - 1; index >= 0; index -= 1) {
            if (state.time - ticks[index]!.born > 1.8) ticks.splice(index, 1);
        }
        // Drop only strokes that have finished their own life or their retirement fade.
        for (let index = arcs.length - 1; index >= 0; index -= 1) {
            const arc = arcs[index]!;
            const expired = state.time - arc.born > ARC_LIFE + 0.1;
            const retired = arc.retireAt !== undefined && state.time - arc.retireAt > 0.7;
            if (expired || retired) arcs.splice(index, 1);
        }
        const line = state.line;
        if (line && line.key !== lastKey) {
            // The mark belongs to the line that just ended, so it is laid down before the key moves.
            if (lastKey && lastEnd && hashLineKey(lastKey, 353) < overlapFx().breakChance) {
                ticks.push({x: lastEnd.x + 9, y: lastEnd.y, born: state.time});
            }
            lastKey = line.key;
            // The path only appears for some lines, and the coin is cast on the line's own key
            // so a replay shows the same traces. Unlike the turn it is not an accent on the
            // stage, it is a mark left on the page: it either happened or it did not.
            const coin = hashLineKey(line.key, 131);
            if (previousNode && coin < overlapFx().trailChance) {
                if (segment) {
                    retiring.push({segment, at: state.time});
                    if (retiring.length > 2) retiring.shift();
                }
                segment = {
                    key: line.key,
                    fromX: previousNode.x, fromY: previousNode.y,
                    toX: line.x, toY: line.y,
                    fromColor: previousNode.color,
                    toColor: line.startColor ?? accentHex,
                    keywordX: line.keywordX, keywordY: line.keywordY, keywordColor: line.keywordColor,
                    flip: hashLineKey(line.key, 331) < 0.5,
                    born: state.time + overlapFx().stagger * hashLineKey(line.key, 317),
                };
            }
            previousNode = {x: line.x, y: line.y, color: line.endColor ?? inkHex};
            if (lastEnd && hashLineKey(line.key, 287) < overlapFx().arcChance) {
                const dx = line.startX - lastEnd.x;
                const dy = line.startY - lastEnd.y;
                const length = Math.hypot(dx, dy) || 1;
                // Bow out of the straight path, alternating sides so consecutive strokes do not
                // stack into a ladder; scaled to the chord so short hops stay almost straight.
                const bow = Math.min(70, length * 0.2) * (arcCount % 2 === 0 ? 1 : -1);
                const baseBorn = state.time + overlapFx().stagger * hashLineKey(line.key, 319);
                // 一笔太孤零零：换句时常常再补一笔（甚至两笔）并排的同向弧，像手写时描的第二遍。
                const extra = hashLineKey(line.key, 347) < 0.62 ? (hashLineKey(line.key, 349) < 0.35 ? 2 : 1) : 0;
                for (let stroke = 0; stroke <= extra; stroke += 1) {
                    const fan = stroke === 0 ? 0 : (stroke === 1 ? 1 : -1);
                    arcs.push({
                        key: line.key,
                        fromX: lastEnd.x + (stroke === 0 ? 0 : fan * 5),
                        fromY: lastEnd.y + (stroke === 0 ? 0 : fan * 4),
                        toX: line.startX + (stroke === 0 ? 0 : fan * 6),
                        toY: line.startY + (stroke === 0 ? 0 : fan * 5),
                        bow: stroke === 0 ? bow : bow * 0.62 + fan * 9,
                        // 后一笔晚一点点落笔，读起来才是重复描，而不是一次画了两根。
                        born: baseBorn + stroke * (0.12 + 0.1 * hashLineKey(line.key, 353 + stroke)),
                        hold: Math.max(0.8, line.duration * 0.5),
                    });
                }
                arcCount += 1;
                // 同屏最多 ARC_MAX 笔；超了就让最老的一笔收干，而不是直接删掉。
                while (arcs.length >= ARC_MAX) {
                    const oldest = arcs.find(arc => arc.retireAt === undefined);
                    if (!oldest) break;
                    oldest.retireAt = state.time;
                }
            }
            lastEnd = {x: line.endX, y: line.endY};
        }
        // 随机补笔：每隔 AMBIENT_ARC_GAP 里的某个时间自己多描一笔，让弧线出现得不那么规整。
        if (overlapFx().showArc && arcs.length < ARC_MAX) {
            if (ambientNext <= 0) {
                ambientNext = state.time + AMBIENT_ARC_GAP[0] + (AMBIENT_ARC_GAP[1] - AMBIENT_ARC_GAP[0]) * hashLineKey(`ambient-gap-${ambientSeq}`, 251);
            } else if (state.time >= ambientNext) {
                spawnAmbientArc(state.time, line ?? null);
                ambientNext = state.time + AMBIENT_ARC_GAP[0] + (AMBIENT_ARC_GAP[1] - AMBIENT_ARC_GAP[0]) * hashLineKey(`ambient-gap-${ambientSeq}`, 257);
            }
        }
        // The tip follows the first character of the line it points at: the shot keeps drifting
        // under its own camera, and a tip frozen at the moment of the change would peel away.
        if (line) {
            // 随机补笔也可能是最新一笔，所以从后往前找这一句自己的引导弧。
            for (let index = arcs.length - 1; index >= 0; index -= 1) {
                const arc = arcs[index]!;
                if (arc.key !== line.key) continue;
                arc.toX = line.startX;
                arc.toY = line.startY;
                break;
            }
        }
        container.alpha += (1 - container.alpha) * (1 - Math.exp(-step / 0.45));
        graphics.clear();
        hotGraphics.clear();
        drawArcs(state.time);
        drawTrail(state.time);
        drawBreaks(state.time);
    };

    const resize = (_width: number, _height: number) => {
        // Everything is stored in stage space; points stay where they were written. Kept on the
        // interface so the runtime can call it from one resize path.
    };

    const destroy = () => {
        container.destroy({children: true});
    };

    return {container, setPalette, update, resize, destroy};
};
