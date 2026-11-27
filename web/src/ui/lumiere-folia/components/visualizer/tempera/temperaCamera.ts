import type { TemperaCameraKey, TemperaShot } from './types';
import { overlapFx } from '../../../../overlapSettings';

// @note Version Control: Project Folia version 0.6.13-750617

// src/components/visualizer/tempera/temperaCamera.ts
// Shot-level camera: interpolates the compiled start/end keyframes of a shot and layers
// a deterministic breathing float. It never tracks individual glyphs.
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const easeInOut = (value: number) => {
    const t = clamp01(value);
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};

const lerp = (from: number, to: number, amount: number) => from + (to - from) * amount;

export interface TemperaCameraFrame {
    x: number;
    y: number;
    scale: number;
    rotation: number;
}

// Resolves the shot camera path at a progress; progress may exceed 1 slightly during
// inter-line gaps so the frame keeps drifting instead of freezing.
export const resolveTemperaCameraFrame = (shot: TemperaShot, progress: number): TemperaCameraFrame => {
    const clamped = clamp01(progress);
    // Blend constant velocity into the ease so the middle of the shot never stalls.
    const eased = clamped * 0.5 + easeInOut(clamped) * 0.5;
    const overshoot = Math.max(0, progress - 1) * 0.35;
    const amount = eased + overshoot;
    const { camera: start, cameraEnd: end } = shot;
    return {
        x: lerp(start.x, end.x, amount),
        y: lerp(start.y, end.y, amount),
        scale: lerp(start.zoom, end.zoom, amount),
        rotation: lerp(start.rotation, end.rotation, amount),
    };
};

export const TEMPERA_CAMERA_BREATH_MAX_OFFSET = 0.006;
export const TEMPERA_CAMERA_BREATH_MAX_SCALE = 0.002;
export const TEMPERA_CAMERA_BREATH_MAX_ROTATION = 0.0015;

// Deterministic hand-held breathing float: layered incommensurate sines keep the drift
// organic, and absolute-time evaluation keeps direct seeks identical to playback.
export const resolveTemperaCameraBreath = (time: number, phase = 0): TemperaCameraFrame => {
    const tau = time * Math.PI * 2;
    return {
        x: (Math.sin(tau * 0.13 + phase) * 0.65 + Math.sin(tau * 0.31 + phase * 1.7) * 0.35)
            * TEMPERA_CAMERA_BREATH_MAX_OFFSET,
        y: (Math.cos(tau * 0.11 + phase * 2.3) * 0.65 + Math.sin(tau * 0.29 + phase * 0.9) * 0.35)
            * TEMPERA_CAMERA_BREATH_MAX_OFFSET,
        scale: Math.sin(tau * 0.09 + phase * 1.3) * TEMPERA_CAMERA_BREATH_MAX_SCALE,
        rotation: Math.sin(tau * 0.07 + phase * 2.9) * TEMPERA_CAMERA_BREATH_MAX_ROTATION,
    };
};

// Ramps the breathing float in after the lyric reveal completes so it never pops in mid-line.
export const resolveTemperaBreathWeight = (time: number, revealDoneTime: number, rampDuration = 1.2) => {
    if (rampDuration <= 0) return time >= revealDoneTime ? 1 : 0;
    return easeInOut(clamp01((time - revealDoneTime) / rampDuration));
};

export type { TemperaCameraKey };

/** The push breathes with the line instead of sitting at one focal length: it rests slightly
 * wider at the first character, swells through the middle, and settles again on the last one.
 * While a finished line is left holding through an instrumental gap it relaxes further, so the
 * next line's push-in lands as a fresh breath rather than a constant magnification. All of it is
 * read from the overlap settings so the panel can retune the breath without rebuilding. */
const FOLLOW_GAP_SECONDS = 2.4;
// Lines are written at a seeded spot up to ~15% off centre and a shot's own camera can pan the
// plate by another ~0.1, so the clamp only has to stop a pathological layout from throwing the
// stage; it is deliberately loose so a real line is always centred outright rather than being
// cut short of the middle (which read as the camera aiming at the pivot, not the type).
const FOLLOW_MAX_SHIFT_X = 0.5;
const FOLLOW_MAX_SHIFT_Y = 0.5;
/** One line as the follow camera sees it: the glyph layout anchor plus the drift the shot's own
 * plate has accumulated this frame (its camera path and breathing), in viewport pixels.
 *
 * The plate offset matters: the glyphs are laid out once and stay put inside the shot, but the
 * shot camera pans that whole plate by up to ~16% of the frame while the line is sung. Aiming
 * only at the layout anchor left the line sliding off centre as it played. */
export interface TemperaFollowSource {
    glyphs: readonly {
        baseX: number; baseY: number;
        /** Text node, when the caller has one: used to measure the line's footprint. */
        display?: {width: number; height: number; scale: {x: number; y: number}};
        motion: {startTime: number; settleTime?: number; enterRotation?: number; lineRotation?: number};
    }[];
    offsetX?: number;
    offsetY?: number;
    /** Shot camera zoom applied about the viewport centre. */
    scale?: number;
    /** Quarter turns the line was written at; the camera rolls by the negative of this. */
    orientation?: number;
    /** 文闪：整句共享的出场角，镜头先跟着它倾斜，再回正到水平。 */
    roll?: number;
    rollStart?: number;
    rollEnd?: number;
}

/** 文闪的链式排版会一路向下/向右延伸，镜头必须能跟着走出第一屏，不能再套重合的
 * 半屏防呆钳制，也不吃重合的「常驻推近」缩放。 */
export interface TemperaFollowOptions {
    /** 把当前字拉到画面中央的力度；文闪用 1 精确居中。 */
    gain?: number;
    /** false 时不钳制平移量，允许镜头跟出画面。 */
    clamp?: boolean;
    /** 覆盖呼吸缩放；文闪固定 1，只做平移。 */
    zoom?: number;
}

/** Where the camera should be looking: a point that travels along the line as it is sung.
 *
 * A Gaussian kernel over the glyph onsets keeps the target on the character currently being
 * sung without stepping from word to word: it glides continuously from the first character to
 * the last, so a long line slides left-to-right through the frame while it plays. The weights
 * are normalised against the nearest glyph, so an instrumental tail cannot underflow to zero
 * (which used to snap the camera back to dead centre mid-gap) - the target simply rests on the
 * last character that was sung.
 *
 * The shot's own plate drift and zoom are folded in afterwards: the glyphs are laid out once,
 * but the shot camera pans the whole plate while the line plays, and the follow has to aim at
 * where the type actually is this frame.
 */
export function resolveLyricAnchor(
    source: TemperaFollowSource,
    time: number,
    width: number, height: number,
    options?: TemperaFollowOptions,
) {
    const { glyphs } = source;
    if (!glyphs.length) return {x: 0, y: 0};
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    let nearest = Number.POSITIVE_INFINITY;
    for (const glyph of glyphs) {
        const startTime = glyph.motion.startTime;
        if (startTime < first) first = startTime;
        if (startTime > last) last = startTime;
        const distance = time - startTime;
        const squared = distance * distance;
        if (squared < nearest) nearest = squared;
    }
    // A fast line needs a wider kernel or the target jumps between characters; a slow one can
    // sit tight on the character being sung.
    const sigma = Math.max(0.55, (last - first) * 0.22);
    const falloff = 2 * sigma * sigma;
    let weight = 0;
    let x = 0;
    let y = 0;
    for (const glyph of glyphs) {
        const distance = time - glyph.motion.startTime;
        const sample = Math.exp(-(distance * distance - nearest) / falloff);
        weight += sample;
        x += glyph.baseX * sample;
        y += glyph.baseY * sample;
    }
    x /= weight;
    y /= weight;
    // The plate offset is added after the layout centre, so the camera tracks the type where it
    // actually is on screen this frame. The shot zoom scales glyph offsets about the viewport
    // centre, so it is applied first.
    const shotScale = source.scale ?? 1;
    x = (x - width / 2) * shotScale + width / 2 + (source.offsetX ?? 0);
    y = (y - height / 2) * shotScale + height / 2 + (source.offsetY ?? 0);
    // Pull the tracked point all the way to the middle. The clamp only stops a pathological
    // layout from throwing the stage.
    const gain = options?.gain ?? overlapFx().followGain;
    const shiftX = (width * .5 - x) * gain;
    const shiftY = (height * .5 - y) * gain;
    if (options?.clamp === false) return {x: shiftX, y: shiftY};
    return {
        x: Math.max(-width * FOLLOW_MAX_SHIFT_X, Math.min(width * FOLLOW_MAX_SHIFT_X, shiftX)),
        y: Math.max(-height * FOLLOW_MAX_SHIFT_Y, Math.min(height * FOLLOW_MAX_SHIFT_Y, shiftY)),
    };
}

/** When the line's type actually starts appearing: the first glyph's onset, not the shot's
 * clock. Bridging and tiling can open a shot well before its first character is sung, and a
 * blend anchored on the shot start would be over before anything was on screen - that is why
 * the quarter turn only seemed to happen on some lines. */
export function resolveFollowStart(
    source: TemperaFollowSource,
    fallback: number,
) {
    let first = Number.POSITIVE_INFINITY;
    for (const glyph of source.glyphs) {
        if (glyph.motion.startTime < first) first = glyph.motion.startTime;
    }
    return Number.isFinite(first) ? first : fallback;
}

/** 文闪的入场旋转是一个瞬态：文字落位后转正，镜头也应跟着回正。
 * 逐字随机角不能直接取整句平均，否则正负会互相抵消；按当前正在唱的字做高斯加权，
 * 每个字再乘自己的入场衰减，镜头就会跟着这一笔的倾斜滚过去，字转正时回正。 */
/** Whole-line entrance roll, damped to zero as the line settles.
 *
 * 文闪 gives every glyph on a line one shared `lineRotation`; the camera counters that single
 * angle so the sentence reads level while it rotates. It deliberately does not chase each
 * glyph's own entrance tilt, so the horizon does not wobble per character. This stays a pure
 * function of `time` for seeking. */
export function resolveFollowRoll(source: TemperaFollowSource, time: number): number {
    const glyphs = source.glyphs;
    if (!glyphs.length) return 0;
    const start = source.rollStart ?? Math.min(...glyphs.map(glyph => glyph.motion.startTime));
    const end = source.rollEnd ?? Math.max(...glyphs.map(glyph => glyph.motion.settleTime ?? glyph.motion.startTime + 0.5));
    const span = Math.max(0.08, end - start);
    const progress = clamp01((time - start) / span);
    const envelope = 1 - progress * progress * (3 - 2 * progress);
    return (source.roll ?? 0) * envelope;
}

/** Breathing focal length for one line, 0..1 in playback time.
 *
 * The swell is a half sine over the sung span, so it is widest exactly at the line's first and
 * last character and deepest in the middle; the tail then relaxes toward the gap focal length.
 * Everything is a function of `time`, so seeking and rebuilding land on the same frame. */
const resolveFollowZoom = (
    glyphs: readonly {motion: {startTime: number}}[],
    time: number, start: number,
) => {
    let last = start;
    for (const glyph of glyphs) {
        const startTime = glyph.motion.startTime;
        if (startTime > last) last = startTime;
    }
    const span = Math.max(last - start, 0.35);
    const progress = clamp01((time - start) / span);
    const bell = Math.sin(Math.PI * progress) ** 2;
    const tail = clamp01((time - last) / FOLLOW_GAP_SECONDS);
    const relax = tail * tail * (3 - 2 * tail);
    const fx = overlapFx();
    const rest = fx.zoomRest - 1;
    return 1 + rest + fx.zoomSwell * bell - fx.zoomRelax * relax;
};

/** Focal length for a line that is too small or too large in frame.
 *
 * 文闪的链式排版会让句子在画面里忽长忽短：短句只占一小块，长句会一路伸出屏幕。镜头除了
 * 跟着唱字平移，还要按这一句当前占画面的比例推拉：占得少就推近，占得多就拉远，让每一句
 * 都落在差不多的视觉分量上。只统计已经出现的字，所以句子越长镜头越往后退，是连续推拉，
 * 不是等整句排完再跳一下。平移目标仍由 resolveLyricAnchor 决定。 */
const FOLLOW_TARGET_FILL = 0.62;
export const TEMPERA_COVERAGE_ZOOM_MIN = 0.55;
export const TEMPERA_COVERAGE_ZOOM_MAX = 1.25;
export function resolveLyricCoverageZoom(
    source: TemperaFollowSource,
    time: number,
    width: number,
    height: number,
) {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let counted = 0;
    for (const glyph of source.glyphs) {
        if (glyph.motion.startTime > time + 0.35) continue;
        const display = glyph.display;
        if (!display) continue;
        const scaleX = Math.abs(display.scale.x) || 1;
        const scaleY = Math.abs(display.scale.y) || 1;
        const halfWidth = (display.width / scaleX) * 0.5;
        const halfHeight = (display.height / scaleY) * 0.5;
        if (!Number.isFinite(halfWidth) || !Number.isFinite(halfHeight)) continue;
        minX = Math.min(minX, glyph.baseX - halfWidth);
        maxX = Math.max(maxX, glyph.baseX + halfWidth);
        minY = Math.min(minY, glyph.baseY - halfHeight);
        maxY = Math.max(maxY, glyph.baseY + halfHeight);
        counted += 1;
    }
    if (!counted) return 1;
    const shotScale = source.scale ?? 1;
    const coverage = Math.max(
        ((maxX - minX) * shotScale) / Math.max(1, width),
        ((maxY - minY) * shotScale) / Math.max(1, height),
    );
    if (!Number.isFinite(coverage) || coverage < 0.001) return 1;
    const zoom = FOLLOW_TARGET_FILL / coverage;
    return Math.max(TEMPERA_COVERAGE_ZOOM_MIN, Math.min(TEMPERA_COVERAGE_ZOOM_MAX, zoom));
}

/** Follow frame for a line: the point the camera should be looking at right now, plus the
 * breathing focal length. The runtime springs its live position toward this every frame, so the
 * move along a line and the move onto the next line come out of the same smooth motion. */
export function resolveLyricFollow(
    current: TemperaFollowSource,
    time: number, start: number, width: number, height: number,
    options?: TemperaFollowOptions,
) {
    const target = resolveLyricAnchor(current, time, width, height, options);
    return {
        x: target.x,
        y: target.y,
        zoom: options?.zoom ?? resolveFollowZoom(current.glyphs, time, start),
    };
}
