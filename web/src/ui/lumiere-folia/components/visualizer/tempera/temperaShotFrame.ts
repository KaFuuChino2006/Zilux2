import { updatePhraseArt } from './wenflashPhraseArt';
import {
    wenflashBlurAmount,
    wenflashPhraseArtRun,
    wenflashPhraseArtBrake,
    wenflashDecorIntensity,
    wenflashBlurDelay,
    wenflashGlowFlowScale,
    wenflashGlowFlowSpeed,
    wenflashGlowColorMode,
    wenflashGlowColors,
    wenflashGlowPlain,
    wenflashGlowRadius,
    wenflashGlowStrength,
    wenflashBlockAlpha,
    wenflashBlockPadding,
    wenflashBottomLine,
    wenflashBottomLineBrake,
    wenflashBottomLineChance,
    wenflashBottomLineFade,
    wenflashBottomLineGlow,
    wenflashBottomLineLength,
    wenflashBottomLineOffset,
    wenflashBottomLineRun,
    wenflashBottomLineSpeed,
    wenflashBottomLineWidth,
    wenflashEntryChance,
    wenflashEntryDelay,
    wenflashEntryBlurAmount,
    wenflashEntryBlurChance,
    wenflashEntryBlurDuration,
    wenflashEntrySize,
    wenflashEntryStyle,
    wenflashEntryTime,
    wenflashEntryZoom,
    wenflashFlashCount,
    wenflashFlashDark,
    wenflashFlashDim,
    wenflashFlashWindow,
    wenflashGhostAlpha,
    wenflashGhostLayers,
    wenflashGhostOffset,
    wenflashGlyphDecor,
    wenflashGlyphDecorChance,
    wenflashGlyphDecorSize,
    wenflashGlyphDecorSpeed,
    wenflashGlyphDecorStyle,
    wenflashHollowLinger,
    wenflashHollowLingerChance,
    wenflashHollowLingerDuration,
    wenflashKineticDecor,
    wenflashKineticDensity,
    wenflashKineticChance,
    wenflashKineticSpeed,
    wenflashLineBlockAlpha,
    wenflashLineBlockChance,
    wenflashLineBlockPadding,
    wenflashLineBlockSweep,
    wenflashMarquee,
    wenflashMarqueeBrake,
    wenflashMarqueeChance,
    wenflashMarqueeDuration,
    wenflashMarqueeEntryDelay,
    wenflashMarqueeEntryFade,
    wenflashMarqueeEntryScale,
    wenflashMarqueeGlow,
    wenflashMarqueeLength,
    wenflashMarqueePadding,
    wenflashMarqueeRun,
    wenflashMarqueeWidth,
    wenflashOutlineChance,
    wenflashOutlineWidth,
    wenflashInvertDark,
    wenflashInvertEveryMax,
    wenflashInvertEveryMin,
    wenflashInvertFlash,
    wenflashInvertFlashWindow,
    wenflashInvertKeyword,
    wenflashInvertLight,
    wenflashTextColorMode,
    wenflashPostZoomChance,
    wenflashPostZoomWaveChance,
    wenflashPostZoomDuration,
    wenflashPostZoomScale,
    wenflashPostZoomSteps,
    wenflashRevision,
    wenflashSolidChance,
    wenflashStretchAmount,
    wenflashStretchDuration,
    wenflashStretchSteps,
} from '../../../../wenflashSettings';
import { wenflashEasedCycles } from '../../../../wenflashPhase';
import { pickWenflashLineStyle } from './wenflashLineStyles';
import type { TemperaTuning, Theme } from '../../../types';
import { overlapFx } from '../../../../overlapSettings';
import { hashTemperaSeed, temperaHash01 } from './temperaRandom';
import { mixColors } from '../colorMix';
import {
    resolveTemperaBreathWeight,
    resolveTemperaCameraBreath,
    resolveTemperaCameraFrame,
} from './temperaCamera';
import type { TemperaShotView } from './temperaSceneBuilder';
import {
    clamp01,
    easeTemperaEnter,
    easeTemperaInOut,
    resolveShotPacedDuration,
    resolveTemperaGlyphMotion,
} from './temperaMotion';
import { resolveTemperaEnterFrame } from './temperaEnterStyles';
import { drawPhraseScore } from './temperaPhraseScore';

// @note Version Control: Project Folia version 0.6.13-750617

// src/components/visualizer/tempera/temperaShotFrame.ts
// 单个 shot 的逐帧姿态：镜头位移与呼吸、shot 之间的推入推出交接、图形与图片层时间、逐字运动。
// 只按绝对播放时间写 view，不持有状态。

export const resolveAnimationScale = (theme: Theme) => (
    theme.animationIntensity === 'calm' ? 0.65 : theme.animationIntensity === 'chaotic' ? 1.35 : 1
);

/**
 * How long a finished shot keeps sliding out while the next one is already sliding in.
 * The overlap is the whole point: two compositions share the frame and the outgoing one
 * carries the eye into the incoming one instead of being cut away.
 */
const resolveShotHandoff = (view: TemperaShotView) => (
    resolveShotPacedDuration(view.shot.endTime - view.shot.startTime, 0.3, 0.4, 1.1)
);

/** A retained line is already a ghost; dissolving it on the normal 0.3–1.1s hand-off clock
 * read as a cut. It gets a longer runway, floored so even a two-second line takes its time. */
const resolveHeldExitDuration = (view: TemperaShotView) => (
    Math.max(overlapFx().exitSeconds, resolveShotHandoff(view) * 1.2)
);

/** How long after `holdUntil` a retained scene can still be on screen. The runtime keeps it in
 * the scene cache for this long; it must stay above the slowest held exit above. */
export const heldExitSeconds = () => Math.max(overlapFx().exitSeconds, 1.1 * 1.2);

export const resolveTemperaShotExit = (view: TemperaShotView, time: number) => {
    const held = view.shot.holdUntil !== undefined;
    const duration = held ? resolveHeldExitDuration(view) : resolveShotHandoff(view);
    return clamp01((time - (view.shot.holdUntil ?? view.shot.endTime)) / duration);
};

/**
 * A retained line does not leave as one rigid block. The shot seed picks the direction of the
 * gesture, every grapheme bends it, picks its own delay, spin and shrink, drifts outward from
 * the line's own centre, and keeps floating slightly while it is held. The type therefore
 * breaks apart and disperses instead of sliding upward in lockstep, and no two lines repeat
 * the same gesture. Everything is derived from the shot seed and playback time, so a seek and
 * a rebuild land on exactly the same frame.
 */
const resolveGhostDrift = (
    seed: number,
    centerX: number,
    centerY: number,
    glyph: {baseX: number; baseY: number},
    index: number,
    order: number,
    time: number,
    lyricEndTime: number,
    height: number,
    exit: number,
    exitDuration: number,
    scatter: number,
) => {
    const rand = (salt: number) => temperaHash01(seed, index + 1, salt);
    // Four ways of letting go, chosen per line: the same song will always use the same one for
    // the same line, so replays match, but consecutive lines stop feeling like one gesture.
    const style = Math.floor(temperaHash01(seed, 0, 101) * 6) % 6;
    const rx = glyph.baseX - centerX;
    const ry = glyph.baseY - centerY;
    const radius = Math.hypot(rx, ry);
    let dx = 0;
    let dy = -1;
    let spin = 0;
    let shrink = 0;
    let fall = 0;
    if (style === 1) {
        // Rain: the words give way downward, with a little sideways sway.
        dx = (temperaHash01(seed, index + 1, 41) - 0.5) * 0.7;
        dy = 1;
        fall = 1;
    } else if (style === 2) {
        // Implosion: the line folds back into its own centre and shrinks away.
        dx = radius > 0.001 ? -rx / radius : 0;
        dy = radius > 0.001 ? -ry / radius : -0.3;
        shrink = 0.5;
    } else if (style === 4) {
        // Strobe: the glyph blinks out in place, like a failing sign.
        dx = (temperaHash01(seed, index + 1, 41) - 0.5) * 0.15;
        dy = -0.12;
    } else if (style === 5) {
        // CRT collapse: the glyph squeezes to a line and vanishes, barely moving.
        dx = 0;
        dy = 0;
        shrink = 0;
    } else if (style === 3) {
        // Swirl: each glyph peels off along the tangent, turning as it goes.
        dx = radius > 0.001 ? -ry / radius : 0.4;
        dy = radius > 0.001 ? rx / radius : 0.4;
        spin = 1.1;
    } else {
        // Drift: mostly upward, opening outward from the line's centre.
        const angle = -Math.PI / 2 + (temperaHash01(seed, 0, 37) - 0.5) * Math.PI * 1.5
            + (rand(41) - 0.5) * Math.PI * 0.5;
        dx = Math.cos(angle);
        dy = Math.sin(angle);
        if (radius > 0.001) {
            dx += rx / radius * 0.6;
            dy += ry / radius * 0.6;
        }
    }
    const length = Math.hypot(dx, dy) || 1;
    dx /= length;
    dy /= length;
    const delay = 0.12 + rand(43) * 0.4;
    const run = clamp01((time - lyricEndTime - delay) / (1.0 + rand(47) * 0.6));
    const rise = easeTemperaInOut(run);
    // Leaving is staggered in sung order: the first character starts to go as soon as the exit
    // begins, the last one waits ~45% of the hand-off. The line therefore dissolves like a
    // brush being lifted from the paper instead of fading out as one rigid plate.
    const depart = clamp01((exit - order * 0.45) / 0.55);
    const blow = easeTemperaInOut(depart);
    const drift = overlapFx().ghostDrift;
    // The gesture belongs to the exit, not to the wait: while the line is merely held it only
    // breathes a little; the scatter starts when it is actually dismissed.
    // Before the dismissal starts this is exactly 0: the glyph keeps its normal playback pose.
    // 位移要在「还看得见」的那段就到位：blow 只在 exit=1 的瞬间才是 1，而那一刻场景正好隐藏，
    // 所以按 blow 线性给量等于永远看不到峰值。这里把曲线提前（×1.45 封顶 1），并把基准距离
    // 从 0.5–1.5 倍 drift 提到 0.9–2.4 倍，散开的观感才是「真的散开」而不是轻轻挪一下。
    // 距离跟「散开」进度走，而不是跟淡出进度：下一句一进来就开始散，散到位后停住，
    // 等下下句进来再由 alpha 把它带走。
    // scatter 已经做过 EaseInOut，这里不再二次放大（放大后的封顶会带来一次速度突变）。
    const drive = Math.max(blow, scatter) * (0.82 + 0.18 * rand(53));
    // 每个字的距离差不要拉太开：1.05~1.8 倍 drift，整行读起来才是一起散开，
    // 而不是几个字各飞各的（那种会显得抖、显得乱）。
    const distance = height * (drift * 1.05 + rand(53) * drift * 0.75) * drive
        * (style === 1 ? 1.35 : style === 2 ? 0.8 : 1);
    // A slow float keeps the held type alive rather than frozen between two impulses.
    const phase = rand(59) * Math.PI * 2;
    const float = height * 0.0045 * rise;
    return {
        x: dx * distance + Math.sin(time * (0.62 + rand(61) * 0.3) + phase) * float,
        y: dy * distance + Math.cos(time * (0.53 + rand(67) * 0.3) + phase * 1.3) * float
            + fall * height * 0.05 * blow,
        rotation: (rand(71) - 0.5) * 0.5 * rise * 0.08 + (rand(79) - 0.5) * 0.4 * blow
            + spin * blow,
        scale: (1 - (0.04 + rand(73) * 0.1) * rise * 0.08 - shrink * blow)
            * (1 - blow * 0.12),
        // Strobe: the whole line blinks in step, keyed on the line's own exit progress rather
        // than each glyph's staggered departure - a per-glyph phase made the flash read as a
        // soft wave instead of a dead sign.
        // Strobe: four clean blinks inside a fixed 0.3s window, then gone for the rest of the
        // exit. Timing is absolute (not normalised over the exit length) so a long 退场 does not
        // stretch the blinking itself.
        alpha: style === 4
            ? (() => {
                const window = 0.3;
                const elapsed = clamp01(exit) * exitDuration;
                if (elapsed >= window) return 0;
                const phase = (elapsed / window) * 4;
                // 每次闪烁亮 55%、暗 45%；四次之后（0.3s）直接黑掉。
                return phase % 1 < 0.55 ? 1 : 0.05;
            })()
            : 1 - blow,
        ...(style === 5 ? {scaleY: 1 - 0.95 * blow} : {}),
        depart: blow,
    };
};

const focusHold = 0.55;

export interface WenflashInvertTrigger {
    /** Absolute song time of the next toggle; null means this shot has no trigger. */
    at: number | null;
    /** The steady text colour; the inverted state paints the screen with this colour. */
    base: string;
    /** The inverted text colour held after the toggle. */
    flash: string;
    /** How long the toggle blinks before it settles. */
    duration: number;
    /** Stable identity of this trigger, so one line only toggles once. */
    key: string;
}

/**
 * Resolve when the background-invert state should toggle for this shot. The state is held by
 * the runtime: each trigger flips it, and the next trigger flips it back.
 */
export function resolveWenflashInvertTrigger(
    view: TemperaShotView,
): WenflashInvertTrigger | null {
    if (wenflashTextColorMode() !== 'invert' || !wenflashInvertFlash()) return null;
    const firstGlyph = view.glyphs[0];
    if (!firstGlyph) return null;
    const flashSeed = hashTemperaSeed(view.shot.id);
    const duration = wenflashInvertFlashWindow();
    const min = wenflashInvertEveryMin();
    const max = Math.max(min, wenflashInvertEveryMax());
    const interval = min + Math.floor(temperaHash01(flashSeed, 0, 811) * (max - min + 1));
    const line = view.shot.slices?.[0]?.lineIndex ?? 0;
    const lineFirst = (view.shot.slices?.[0]?.segmentStart ?? 0) === 0;
    const randomDue = lineFirst && line >= 0 && line % Math.max(1, interval) === 0;
    const keywordAt = view.invertKeywordAt;
    const keywordDue = wenflashInvertKeyword() && typeof keywordAt === 'number';
    const at = keywordDue
        ? keywordAt
        : randomDue ? view.shot.startTime : null;
    const base = firstGlyph.fill ?? wenflashInvertDark();
    const flash = base.toLowerCase() === wenflashInvertDark().toLowerCase()
        ? wenflashInvertLight()
        : wenflashInvertDark();
    return {
        at,
        base,
        flash,
        duration,
        key: at !== null ? `${view.shot.id}:${at.toFixed(3)}` : '',
    };
}

export const updateTemperaShot = (
    view: TemperaShotView,
    time: number,
    width: number,
    height: number,
    tuning: TemperaTuning,
    theme: Theme,
    follow: {x: number; y: number} = {x: 0, y: 0},
    rackFocus = false,
    fixedCamera = false,
) => {
    const duration = Math.max(view.shot.endTime - view.shot.startTime, 0.001);
    const rawProgress = (time - view.shot.startTime) / duration;
    const animationScale = resolveAnimationScale(theme);
    const camera = fixedCamera ? 0 : tuning.cameraIntensity * animationScale;
    const motion = tuning.glyphMotion * animationScale;
    const rotationOnly = view.shot.cameraMotion === 'rotation';
    const frame = resolveTemperaCameraFrame(view.shot, view.shot.holdUntil === undefined ? rawProgress : Math.min(1,rawProgress));

    const breathWeight = resolveTemperaBreathWeight(time, view.revealDoneTime);
    if (breathWeight > 0) {
        const breathPhase = (hashTemperaSeed(view.shot.id) % 1024) / 1024 * Math.PI * 2;
        const breath = resolveTemperaCameraBreath(time, breathPhase);
        if (!rotationOnly) {
            frame.x += breath.x * breathWeight;
            frame.y += breath.y * breathWeight;
            frame.rotation += breath.rotation * breathWeight;
            frame.scale += breath.scale * breathWeight;
        }
    }

    // Hand-off: the shot arrives from upstream on its own flow vector and, once it is
    // over, keeps travelling downstream out of frame. Both shots run this at the same
    // time during the overlap, so the outgoing composition visibly pushes past the
    // incoming one rather than being cut away.
    const handoff = resolveShotHandoff(view);
    const span = Math.max(width, height);
    // The arrival is front-loaded on purpose: the glyphs start revealing on the shot's
    // own timeline, so a slow entrance would expose type that is still off frame.
    const enter = easeTemperaEnter(clamp01((time - view.shot.startTime) / (handoff * 0.8)));
    const exitProgress = resolveTemperaShotExit(view, time);
    const exit = easeTemperaInOut(exitProgress);
    const held = view.shot.holdUntil !== undefined;
    // A retained line appears where it will be sung. The entrance push used to start it up to
    // a third of the frame off its anchor and slide it in; in 重合 that read as the type
    // "landing somewhere random" while the follow camera was already aimed at the anchor. The
    // per-glyph ink reveal (blur + pulse) still gives the line its arrival.
    const push = held || rotationOnly ? 0 : (1 - enter) * span * 0.32 * camera;
    // A retained line is the "重合" ghost. It is not translated as a plate any more: each
    // grapheme drifts on its own (resolveGhostDrift), so the shot keeps only its entrance
    // push and fades in place on the way out.
    const exitTravel = fixedCamera || held || rotationOnly ? 0 : exit * span * 0.55 * camera;
    // Where the plate itself sits this frame, before the entrance/exit/parallax offsets. The
    // follow camera adds this to the line's anchor: the glyph layout is fixed, but the shot's
    // own camera path and breathing keep moving the type inside the plate, so without this
    // term a line that pans while it is sung slides away from the centre of the frame.
    view.frameX = frame.x * width * camera;
    view.frameY = frame.y * height * camera;
    // A retained line sits behind the live one: when the shared camera slides, it travels a
    // quarter of the distance, which reads as depth instead of one flat plate moving.
    // 文闪的镜头是跟着链式排版走的，旧句必须留在自己的链位上，不能再反向漂移。
    const parallaxX = held && !fixedCamera ? -follow.x * 0.25 : 0;
    const parallaxY = held && !fixedCamera ? -follow.y * 0.25 : 0;
    view.container.position.set(
        view.baseX + view.frameX
            - Math.cos(view.shot.flowAngle) * push + Math.cos(view.shot.flowAngle) * exitTravel
            + parallaxX,
        view.baseY + view.frameY
            - Math.sin(view.shot.flowAngle) * push + Math.sin(view.shot.flowAngle) * exitTravel
            + parallaxY,
    );
    // A retained line does not sit at full strength while the next one is sung: the moment its
    // own words are done it starts to withdraw, so the wait reads as ink drying rather than a
    // frozen layer. The per-glyph scatter still finishes the job at exit.
    const holdSpan = held && Number.isFinite(view.shot.holdUntil)
        ? Math.max(0.9, Math.min(6, (view.shot.holdUntil as number) - view.shot.lyricEndTime))
        : 4.5;
    const wait = held ? clamp01((time - view.shot.lyricEndTime) / holdSpan) : 0;
    const waitFade = wait * wait * (3 - 2 * wait);
    // 文闪的旧句在模糊开始前保持满不透明；否则 holdFade 会在延迟结束前先把字压暗，
    // 看起来仍像「唱完就淡出」，而不是「落位后过一会儿再模糊」。
    const holdFade = fixedCamera ? 0 : overlapFx().holdFade * waitFade;
    view.container.alpha = held ? 1 - holdFade : 1 - exit;
    const shotScale = (1 + (frame.scale - 1) * camera) * (1 - exit * 0.08);
    // Exposed for the follow camera: the plate zoom is applied about the viewport centre, so the
    // camera has to widen the glyph offsets by the same factor when it re-centres the line.
    view.frameScale = shotScale;
    view.container.scale.set(shotScale);
    // Rotation is a whole-shot entrance/exit, including short and sparse compositions.
    // A small full-duration drift alone was barely visible once a late-built shot appeared.
    const turn = rotationOnly ? (view.shot.rotationSign ?? 1) * (-(1 - enter) * 0.48 + exit * 0.36) : 0;
    view.container.rotation = (frame.rotation + turn) * camera;

    // The sentence's frame is drawn as the sentence is sung: the opening end holds at the start
    // of the line, the closing end walks outwards with the words, so the frame reads the lyric's
    // progress instead of switching on whole (and never waits for the last character to appear).
    if (view.bracket) {
        const firstStart = view.glyphs.length ? view.glyphs[0].motion.startTime : view.shot.startTime;
        const lastStart = view.glyphs.length
            ? view.glyphs[view.glyphs.length - 1].motion.startTime
            : view.shot.endTime;
        const singSpan = Math.max(0.35, lastStart - firstStart);
        const opened = time - firstStart - view.bracket.delay;
        const progress = clamp01(opened / singSpan);
        const eased = progress * progress * (3 - 2 * progress);
        const appear = clamp01(opened / 0.3);
        // The frame is ink on the same paper as the type, so it has to let go when the type
        // does: the characters begin to scatter the moment the line is sung, not two lines
        // later when the shot is finally released. Take whichever of the two is further along.
        const settled = clamp01((time - view.shot.lyricEndTime) / 1.1);
        const ghostBlur = overlapFx().ghostBlur;
        const dissolve = Math.max(
            settled * settled * (3 - 2 * settled),
            exit * exit * (3 - 2 * exit),
        );
        const softness = (1.6 + view.bracket.half * 0.018) * ghostBlur;
        if (dissolve > 0.002) {
            view.bracket.blur.strength = softness * dissolve;
            if (!view.bracket.group.filters) view.bracket.group.filters = [view.bracket.blur];
        } else if (view.bracket.group.filters) {
            view.bracket.group.filters = null;
            view.bracket.blur.strength = 0;
        }
        view.bracket.group.alpha = 0.62 * appear * (1 - dissolve);
        // The frame opens a touch as it dries, the way a box drawn on wet paper spreads.
        view.bracket.group.scale.set(1 + dissolve * 0.07);
        if (view.bracket.style === 'cross' && view.bracket.horizontal && view.bracket.vertical) {
            // Two passes: the horizontal rules are ruled left to right, then the verticals
            // follow top to bottom. Both are clipped by their own progress, so the frame
            // assembles instead of switching on whole.
            const left = -view.bracket.half - view.bracket.overshoot;
            const width = 2 * (view.bracket.half + view.bracket.overshoot);
            const topEdge = view.bracket.top - view.bracket.overshoot;
            const height = view.bracket.bottom - view.bracket.top + view.bracket.overshoot * 2;
            const firstPass = clamp01(eased / 0.55);
            const secondPass = clamp01((eased - 0.42) / 0.58);
            const horizontalInk = firstPass * firstPass * (3 - 2 * firstPass);
            const verticalInk = secondPass * secondPass * (3 - 2 * secondPass);
            view.bracket.horizontal.clear()
                .moveTo(left, view.bracket.top).lineTo(left + width * horizontalInk, view.bracket.top)
                .moveTo(left, view.bracket.bottom).lineTo(left + width * horizontalInk, view.bracket.bottom)
                .stroke({width: 1.25, color: view.speckColor, alpha: 1, cap: 'round'});
            view.bracket.vertical.clear()
                .moveTo(-view.bracket.half, topEdge).lineTo(-view.bracket.half, topEdge + height * verticalInk)
                .moveTo(view.bracket.half, topEdge).lineTo(view.bracket.half, topEdge + height * verticalInk)
                .stroke({width: 1.25, color: view.speckColor, alpha: 1, cap: 'round'});
        } else if (view.bracket.right) {
            view.bracket.right.x = -view.bracket.half + 2 * view.bracket.half * eased;
        }
    }

    if (view.underline) {
        const underline = view.underline;
        const firstStart = view.glyphs.length ? view.glyphs[0].motion.startTime : view.shot.startTime;
        const lastStart = view.glyphs.length
            ? view.glyphs[view.glyphs.length - 1].motion.startTime
            : view.shot.endTime;
        const lastEnd = view.glyphs.length
            ? Math.max(...view.glyphs.map(glyph => glyph.motion.endTime))
            : view.shot.endTime;
        const singSpan = Math.max(0.4, lastStart - firstStart);
        const opened = time - firstStart - underline.delay;
        const progress = clamp01(opened / singSpan);
        const sweep = progress * progress * (3 - 2 * progress);
        const appear = clamp01((opened + 0.18) / 0.5);
        const rise = appear * appear * (3 - 2 * appear);
        // Two entrances, picked per sentence: the rule slides up from under the line, or it is
        // simply written from the left as the first word lands. The writing is the same either
        // way - only the first half second differs.
        const variant = Math.abs(hashTemperaSeed(view.shot.id)) % 2;
        const lift = variant === 0 ? 9 * (1 - rise) : 0;
        // It leaves the way the frame does: once the line is sung it dries out with a soft
        // blur rather than being cut.
        const out = clamp01((time - lastEnd) / 0.9);
        const dissolve = out * out * (3 - 2 * out);
        underline.group.position.set(underline.x, underline.y + lift);
        underline.group.alpha = 0.62 * rise * (1 - dissolve);
        underline.rail.scale.x = Math.max(0.0001, sweep);
        underline.head.position.x = -underline.half + underline.half * 2 * sweep;
        underline.head.visible = sweep > 0.01 && sweep < 0.995 && dissolve < 0.4;
        underline.group.visible = underline.group.alpha > 0.002;
        if (dissolve > 0.002) {
            underline.blur.strength = 1.3 * dissolve;
            if (!underline.group.filters) underline.group.filters = [underline.blur];
        } else if (underline.group.filters) {
            underline.group.filters = null;
            underline.blur.strength = 0;
        }
    }

    // The mask plate has four seeded entrances timed to the word it covers. It never animates
    // out: once the covered word is sung it simply fades, so the plate reads as something being
    // laid down and then dissolving rather than a second performance competing with the line.
    if (view.mask) {
        const mask = view.mask;
        const enterSpan = 0.58;
        const exitSpan = 0.85;
        // Half see-through: the plate tints the line it marks instead of covering the frame.
        const PLATE_ALPHA = 0.55;
        const trigger = mask.start - 0.26;
        // The paragraph's first frames can be hidden behind a retained line, which used to make
        // the plate pop in already finished. Anchor the entrance on the frame the plate is first
        // drawn instead: normal playback starts at the trigger, a late first frame still plays
        // the whole entrance. Seeking backwards clears it so the entrance runs again.
        if (time < trigger - 0.5) mask.shownAt = undefined;
        if (mask.shownAt === undefined && time >= trigger) mask.shownAt = time;
        const begin = mask.shownAt ?? trigger;
        const inT = clamp01((time - begin) / enterSpan);
        const outT = clamp01((time - mask.end) / exitSpan);
        const shown = inT > 0 && outT < 1;
        mask.bar.visible = shown;
        if (shown) {
            const enter = inT * inT * (3 - 2 * inT);
            const leave = outT * outT * (3 - 2 * outT);
            const horizontal = mask.direction < 2;
            const sign = mask.direction === 0 || mask.direction === 2 ? -1 : 1;
            let dx = 0;
            let dy = 0;
            let sx = 1;
            let sy = 1;
            let spin = 0;
            let alpha = (1 - leave) * PLATE_ALPHA;
            if (mask.variant === 0) {
                // Slide in from one side while fading up.
                const offset = (1 - enter) * mask.travel;
                if (horizontal) dx = sign * offset;
                else dy = sign * offset;
                alpha *= clamp01(inT * 2.2);
            } else if (mask.variant === 1) {
                // Unfold from the end it comes from; the far end stays put while the near one
                // runs out to full length.
                const grow = Math.max(0.02, enter);
                if (horizontal) {
                    sx = grow;
                    dx = sign * (1 - grow) * mask.width / 2;
                } else {
                    sy = grow;
                    dy = sign * (1 - grow) * mask.height / 2;
                }
                alpha *= clamp01(inT * 3);
            } else if (mask.variant === 2) {
                // Bloom: opens from just under full size with a small overshoot.
                const back = 1 + 2.70158 * Math.pow(enter - 1, 3) + 1.70158 * Math.pow(enter - 1, 2);
                const scale = 0.62 + 0.38 * back;
                sx = scale;
                sy = scale;
                alpha *= clamp01(inT * 1.8);
                spin = (1 - enter) * 0.05 * sign;
            } else {
                // Stamp: drops onto the word from above, flattening as it lands.
                sy = 0.66 + 0.34 * enter;
                dy = -(1 - enter) * mask.height * 0.35;
                alpha *= clamp01(inT * 2.6);
            }
            // Offsets are authored along the plate's own axes (long edge, short edge) and then
            // turned into shot space, so a plate on a vertical line still slides across its
            // short side rather than drifting diagonally.
            const cosR = Math.cos(mask.orientation);
            const sinR = Math.sin(mask.orientation);
            const barX = mask.x + dx * cosR - dy * sinR;
            const barY = mask.y + dx * sinR + dy * cosR;
            mask.bar.position.set(barX, barY);
            mask.bar.scale.set(sx, sy);
            mask.bar.rotation = mask.orientation + spin;
            mask.bar.alpha = alpha;
            // Knockout, applied to the type only: a glyph whose centre the band has reached is
            // repainted in the paper tone, everything else under the band (arcs, trails, specks,
            // ruler) is merely tinted by the band's own translucency. Keyword glyphs are skipped
            // so the highlighted word keeps its colour.
            const reachX = (mask.width * Math.abs(sx)) / 2;
            const reachY = (mask.height * mask.slice * Math.abs(sy)) / 2;
            for (const glyph of mask.covered) {
                let coverage = 0;
                if (!glyph.keyword) {
                    const gx = glyph.baseX - barX;
                    const gy = glyph.baseY - barY;
                    const lx = gx * cosR + gy * sinR;
                    const ly = -gx * sinR + gy * cosR;
                    const marginX = glyph.display.width * 0.5;
                    const marginY = glyph.display.height * 0.5;
                    const x = mask.shape === 3 ? lx - ly * mask.slant : lx;
                    coverage = clamp01(Math.min(
                        (reachX + marginX - Math.abs(x)) / Math.max(1, marginX),
                        (reachY + marginY - Math.abs(ly)) / Math.max(1, marginY),
                    )) * enter * alpha / PLATE_ALPHA;
                }
                const step = Math.round(48 * coverage * coverage * (3 - 2 * coverage));
                if (step !== (glyph.maskStep ?? 0)) {
                    glyph.maskStep = step;
                    glyph.masked = step > 24;
                    glyph.display.style.fill = step ? mixColors(glyph.fill, mask.paper, step / 48) : glyph.fill;
                }
            }
        } else {
            for (const glyph of mask.covered) {
                if (glyph.maskStep) {
                    glyph.maskStep = 0;
                    glyph.masked = false;
                    glyph.display.style.fill = glyph.fill;
                }
            }
        }
    }

    // Two ends on purpose. The graphics' entrance stagger is paced against the lyric this
    // shot carries; the steady flow creep runs for the shot's whole visible life, which is
    // tiled up to the next shot's start and can be seconds longer.
    view.blocks.updateTime(time, view.shot.startTime, view.shot.endTime, view.shot.lyricEndTime);
    view.images.updateTime(time, view.shot.startTime, view.shot.endTime, view.shot.lyricEndTime);

    // 文闪等整句完全落位后再开始模糊；延迟与强度由文闪设置控制。重合的旧句仍在唱完后
    // 立刻开始失焦，保持它原本的「墨迹晾干」节奏。模糊强度是字号推导上限的百分比，0 即关闭。
    const blurFrom = fixedCamera ? view.revealDoneTime + wenflashBlurDelay() : view.shot.lyricEndTime;
    const blurProgress = clamp01((time - blurFrom) / (fixedCamera ? 1.1 : 1.6));
    const blurEase = blurProgress * blurProgress * (3 - 2 * blurProgress);
    const lineBlur = fixedCamera ? blurEase * wenflashBlurAmount() : blurEase;
    const ghostCenter = {x: 0, y: 0};
    const ghostSeed = held ? hashTemperaSeed(view.shot.id) : 0;
    // 文闪的镜头种子必须每句独立：ghostSeed 在非停留句上是 0，只适合散开残影，
    // 拿它抽闪烁概率会让所有新句得到同一个结果，也会让逐字倍率每句重复。
    const flashSeed = hashTemperaSeed(view.shot.id);
    if (held && view.glyphs.length > 0) {
        for (const glyph of view.glyphs) {
            ghostCenter.x += glyph.baseX;
            ghostCenter.y += glyph.baseY;
        }
        ghostCenter.x /= view.glyphs.length;
        ghostCenter.y /= view.glyphs.length;
    }
    // 散开是第一段：下一句进来时就开始往外散，并在下下句到来前停住（这段时间 alpha 仍是 1）；
    // 消散是第二段：holdUntil（下下句）之后才真正淡出。没有 scatterAt 的普通流程沿用旧行为。
    const scatterAt = view.shot.scatterAt;
    // 散开要一直「在动」：把行程铺满到 holdUntil 之后再 25% 才走完，这样下下句的淡出开始时
    // 位移还在缓慢增长，不会出现「先弹一下 → 冻住 → 过会儿才淡掉」的停顿感。
    const scatterSpan = Math.max(
        0.5,
        (scatterAt !== undefined && Number.isFinite(view.shot.holdUntil)
            ? Math.max(0.5, (view.shot.holdUntil as number) - scatterAt)
            : 0.9) * 1.25,
    );
    const scatterProgress = scatterAt === undefined
        ? exitProgress
        : clamp01((time - scatterAt) / scatterSpan);
    const flashOnEntry = fixedCamera && temperaHash01(flashSeed, 0, 853) < wenflashEntryChance();
    const flashCount = wenflashFlashCount();
    const flashWindow = wenflashFlashWindow();
    const flashDark = wenflashFlashDark();
    const flashDim = wenflashFlashDim();
    const solidChance = wenflashSolidChance();
    const outlineChance = wenflashOutlineChance();
    const blockPadding = wenflashBlockPadding();
    const blockAlpha = wenflashBlockAlpha();
    const outlineWidth = wenflashOutlineWidth();
    const appearanceRevision = wenflashRevision();
    const entryBlurChance = fixedCamera ? wenflashEntryBlurChance() : 0;
    const entryBlurAmount = fixedCamera ? wenflashEntryBlurAmount() : 0;
    const entryBlurDuration = fixedCamera ? wenflashEntryBlurDuration() : 0.42;
    const lineBlockOn = fixedCamera && temperaHash01(flashSeed, 0, 1913) < wenflashLineBlockChance();
    // 与背景反色：状态由 runtime 持有。每次触发翻一次面，保持到下一次触发再翻回来。
    // 文闪退场：不散开、不放大。当前句唱完后先等下一句出现 0.5 秒（flowScene 写入
    // shot.exitAt），再从那一刻重放同一套闪烁节奏，并沿用入场的亮拍外观（纯色块/镂空）；
    // 闪烁窗口一结束立刻切到全透明，不做淡出。
    const exitAt = view.shot.exitAt ?? view.shot.lyricEndTime;
    const exitAge = time - exitAt;
    const exitPhase = exitAge * (flashCount / flashWindow);
    // 退场闪烁沿用这个镜头是否被入场闪烁抽中；没抽中时退场只做硬切，不再补一套
    // 100% 触发的闪烁，否则调低「触发概率」也挡不住退场一直闪。
    const exitFlashOn = fixedCamera && flashOnEntry;
    const inExitFlash = exitFlashOn && exitAge >= 0 && exitAge < flashWindow;
    const exitLit = inExitFlash && exitPhase % 1 >= flashDark;
    // 闪烁窗口播完就硬切到 0：不再补一段淡出，否则最后一下亮拍之后会看到渐隐。
    // 没抽中闪烁的镜头保留原字到同一个窗口结束再硬切，避免变成「无闪但一直不消失」。
    const exitAlpha = fixedCamera
        ? (exitAge < 0 ? 1 : exitAge < flashWindow ? (exitFlashOn ? (exitLit ? 1 : flashDim) : 1) : 0)
        : 1;
    view.specks?.clear();
    const entryStyleMode = wenflashEntryStyle();
    const originalEntrance = entryStyleMode === 'overlap';
    const entryDelay = wenflashEntryDelay();
    const entryZoom = wenflashEntryZoom();
    const entryRampEnd = entryDelay + entryZoom;
    // 退场运动窗：把入场那套位移/缩放/拉伸/抽帧放大原路放回去，但必须在退场闪烁
    // 结束前收完，否则字已经透明了，运动还没走完。窗长与闪烁窗口对齐，短句也能看见。
    const exitMotionWindow = Math.max(0.08, Math.min(flashWindow, entryRampEnd));
    const exitMotionProgress = clamp01(exitAge / exitMotionWindow);
    const exitMotionOn = fixedCamera && exitAge >= 0 && exitAge < exitMotionWindow;
    // 入场落定后的抽帧放大：按字独立抽取，每个字在自己的落定时间之后触发一次，
    // 离散台阶先放大再收回，不改变字的位置和布局。
    const postZoomDuration = wenflashPostZoomDuration();
    const postZoomPeak = wenflashPostZoomScale();
    const postZoomSteps = wenflashPostZoomSteps();
    // 同一套抽帧放大有两种走法：按字随机，或整句从左到右过一道波浪。
    // 波浪按镜头种子抽取，抽中时所有字都参与，不再逐字随机。
    const postZoomWaveOn = fixedCamera
        && wenflashPostZoomChance() > 0
        && temperaHash01(flashSeed, 0, 4791) < wenflashPostZoomWaveChance();
    const postZoomWaveAge = time - view.revealDoneTime;
    const postZoomWavePeak = 1 + (postZoomPeak - 1) * temperaHash01(flashSeed, 0, 3571);
    const postZoomWaveRect = view.lineFlashBoxRect;
    const accents = view.glyphAccents;
    accents?.clear();
    view.glyphs.forEach((glyph, index) => {
        const glyphFrame = resolveTemperaGlyphMotion(
            glyph.motion, time, motion,
            fixedCamera && !originalEntrance ? wenflashEntryTime : undefined,
            fixedCamera && entryStyleMode === 'wenflash' ? 'stamp' : undefined,
            fixedCamera && entryStyleMode !== 'wenflash'
                ? {delay: entryDelay, duration: entryZoom}
                : undefined,
        );
        const entryAge = time - glyph.motion.startTime;
        if (fixedCamera && !originalEntrance && entryAge >= 0 && entryAge < entryRampEnd) {
            const zoomProgress = entryAge <= entryDelay ? 0 : Math.min(1, (entryAge - entryDelay) / entryZoom);
            const size = wenflashEntrySize(temperaHash01(flashSeed, index, 317), zoomProgress);
            glyphFrame.scaleX *= size;
            glyphFrame.scaleY *= size;
        }
        const postZoomOn = fixedCamera
            && temperaHash01(flashSeed, index, 2731) < wenflashPostZoomChance();
        const postZoomAge = time - glyph.motion.settleTime;
        // 上限倍率只是区间上界：每个字在 1× 到上限之间独立取一个峰值，避免所有抽中的字一样大。
        const postZoomPeakForGlyph = 1 + (postZoomPeak - 1) * temperaHash01(flashSeed, index, 3571);
        let postZoom = 1;
        if (postZoomWaveOn) {
            if (Number.isFinite(postZoomWaveAge) && postZoomWaveAge >= 0 && postZoomWaveAge < postZoomDuration) {
                const ink = glyph.flashBoxRect;
                const glyphX = glyph.baseX + (ink ? ink.x + ink.width / 2 : 0);
                const glyphY = glyph.baseY + (ink ? ink.y + ink.height / 2 : 0);
                const progress = postZoomWaveRect && postZoomWaveRect.width > 0 && !view.lineFlashVertical
                    ? clamp01((glyphX - postZoomWaveRect.x) / postZoomWaveRect.width)
                    : postZoomWaveRect && postZoomWaveRect.height > 0 && view.lineFlashVertical
                        ? clamp01((glyphY - postZoomWaveRect.y) / postZoomWaveRect.height)
                        : view.glyphs.length > 1 ? index / (view.glyphs.length - 1) : 0;
                const u = clamp01(postZoomWaveAge / postZoomDuration);
                const head = -0.15 + u * 1.3;
                const distance = progress - head;
                const pulse = Math.exp(-(distance * distance) / (2 * 0.14 * 0.14));
                const envelope = Math.sin(Math.PI * u);
                postZoom = 1 + (postZoomWavePeak - 1) * pulse * envelope;
            }
        } else if (postZoomOn && Number.isFinite(postZoomAge) && postZoomAge >= 0 && postZoomAge < postZoomDuration) {
            const raw = postZoomAge / postZoomDuration;
            const stepped = Math.min(1, Math.round(raw * postZoomSteps) / postZoomSteps);
            const shape = stepped < 0.5 ? stepped * 2 : (1 - stepped) * 2;
            postZoom = 1 + (postZoomPeakForGlyph - 1) * shape;
        }
        glyphFrame.scaleX *= postZoom;
        glyphFrame.scaleY *= postZoom;
        // 抽帧放大触发时，镂空字不能因为停留计时到点就在放大过程中回填：
        // 放大把镂空与实心的差异放大，回填会像「镂空突然消失」，辉光也会同时跳回满亮。
        // 一旦放大落在这个镂空字上，就把镂空锁到本句结束；纯色块亮拍仍可短暂盖住。
        if (fixedCamera && postZoom > 1.0001 && glyph.hollowSeen === true) {
            glyph.hollowLocked = true;
        }
        // 独立的入场拉伸：不并入七种入场，也不参与位移，只在字出现后沿排版方向拉长，
        // 再按设定时长收回到 1 倍。横排拉左右、竖排拉上下，落位后的字形不受影响。
        const stretchAmount = fixedCamera ? wenflashStretchAmount() : 1;
        const stretchDuration = fixedCamera ? wenflashStretchDuration() : 0;
        const stretchSteps = fixedCamera ? wenflashStretchSteps() : 0;
        if (stretchAmount > 1 && stretchDuration > 0) {
            const stretchAge = time - glyph.motion.startTime;
            if (stretchAge >= 0 && stretchAge < stretchDuration) {
                const rawDecay = 1 - stretchAge / stretchDuration;
                const decay = stretchSteps > 1
                    ? Math.max(0, Math.min(1, Math.round(rawDecay * stretchSteps) / stretchSteps))
                    : rawDecay;
                const smear = 1 + (stretchAmount - 1) * decay * decay;
                if (view.lineFlashVertical) glyphFrame.scaleY = Math.max(glyphFrame.scaleY, smear);
                else glyphFrame.scaleX = Math.max(glyphFrame.scaleX, smear);
            }
        }
        if (exitMotionOn) {
            // 入场动作的反向播放：位移、旋转、缩放沿原入场轨迹退回起笔位置。
            // 只回放入场实际用到的部分：纯缩放入场不额外加位移，纯重合逐字不带倍率。
            if (entryStyleMode !== 'wenflash') {
                const exitEnter = resolveTemperaEnterFrame(
                    glyph.motion.enterStyle, glyph.motion, exitMotionProgress, exitMotionProgress, 1 - exitMotionProgress,
                );
                glyphFrame.x += exitEnter.x * motion;
                glyphFrame.y += exitEnter.y * motion;
                glyphFrame.rotation += exitEnter.rotation * motion;
                glyphFrame.scaleX *= exitEnter.scaleX;
                glyphFrame.scaleY *= exitEnter.scaleY;
            }
            if (entryStyleMode !== 'overlap') {
                const size = wenflashEntrySize(
                    temperaHash01(flashSeed, index, 317), exitMotionProgress,
                );
                glyphFrame.scaleX *= size;
                glyphFrame.scaleY *= size;
            }
            // 入场后的抽帧放大同样反向：退场时从 1 倍逐级涨到自己的峰值，
            // 波形模式也把波浪重新走一遍，最后和文字一起消失。
            if (postZoomOn || postZoomWaveOn) {
                const stepped = Math.min(1, Math.round(exitMotionProgress * postZoomSteps) / postZoomSteps);
                const shape = postZoomWaveOn ? Math.sin(Math.PI * exitMotionProgress) : stepped;
                const exitZoom = 1 + (postZoomPeakForGlyph - 1) * shape;
                glyphFrame.scaleX *= exitZoom;
                glyphFrame.scaleY *= exitZoom;
            }
        }
        const entryPhase = entryAge * (flashCount / flashWindow);
        const inFlash = flashOnEntry && entryAge >= 0 && entryAge < flashWindow;
        const entryLit = inFlash && entryPhase % 1 >= flashDark;
        // 入场用逐字起唱相位，退场用整句退场相位；两者共用同一套闪烁参数与亮拍外观。
        // 退场一旦开始就一直走 exitAlpha（窗口结束后为 0），不能回落到入场/默认的 1，
        // 否则闪烁播完那一帧会把原字重新显出来，直到舞台真正卸载才消失。
        const inExit = fixedCamera && exitAge >= 0;
        const flashLit = inExit ? exitLit : entryLit;
        const flashPhase = inExit ? exitPhase : entryPhase;
        const flashAlpha = inExit
            ? exitAlpha
            : (inFlash && !entryLit ? flashDim : 1);
        const flashRoll = flashLit ? temperaHash01(flashSeed, index, 947 + Math.floor(flashPhase)) : 1;
        const paint = flashRoll < solidChance ? 'solid'
            : flashRoll < Math.min(1, solidChance + outlineChance) ? 'outline' : undefined;
        // 镂空停留：某个字第一次被镂空亮拍选中时掷一次骰子；中了就继续保留描边，
        // 直到设定时长结束或本句退场。之后的纯色块亮拍仍会短暂盖住它，亮拍结束再恢复镂空。
        const hollowLingerOn = fixedCamera && wenflashHollowLinger();
        let hollowLingering = hollowLingerOn && glyph.hollowUntil !== undefined
            && time < glyph.hollowUntil;
        if (hollowLingerOn && !glyph.hollowRolled && paint === 'outline' && glyphFrame.visible) {
            glyph.hollowRolled = true;
            if (temperaHash01(flashSeed, index, 6151) < wenflashHollowLingerChance()) {
                const hold = wenflashHollowLingerDuration();
                const lineEnd = view.shot.lyricEndTime;
                glyph.hollowUntil = hold > 0
                    ? time + hold
                    : (Number.isFinite(lineEnd) ? lineEnd : time + 2);
                hollowLingering = time < glyph.hollowUntil;
            }
        }
        // 停留期间描边副本单独承担字形，阴影/残影/辉光必须一起让位；
        // 否则它们仍是填充字，放大时会露在描边后面，看起来像「镂空又回填」。
        const hollowBase = paint === 'outline'
            || (hollowLingering && paint !== 'solid')
            || (glyph.hollowLocked === true && paint !== 'solid');
        if (hollowBase) glyph.hollowSeen = true;
        // 退场开始的那一帧记住这个字是否处于镂空；随后整段退场都沿用，不能因为
        // 闪烁暗拍时 paint 暂时为空就退回填充字，否则会看到「一退场就回填」。
        if (fixedCamera && exitAge >= 0 && glyph.exitHollow === undefined) {
            glyph.exitHollow = hollowBase || glyph.hollowSeen === true
                || glyph.hollowLocked === true
                || glyph.flashPaint === 'outline' || glyph.hollowUntil !== undefined;
        }
        // 退场期间纯色块亮拍仍然可以短暂盖住镂空，暗拍和描边亮拍继续保留描边。
        const hollowLook = fixedCamera && exitAge >= 0 && glyph.exitHollow === true
            ? paint !== 'solid'
            : hollowBase;
        if (glyph.flashPaint !== paint) {
            glyph.flashPaint = paint;
        }
        const order = view.glyphs.length > 1 ? index / (view.glyphs.length - 1) : 0;
        // 散开要「起笔慢、落定慢」：先按唱序让每个字错峰出发（最后一个字晚 32% 行程），
        // 再用 smoothstep 收两头，否则整行会像一块板子被匀速推开，一看就假。
        const stagger = 0.32;
        const scatterLocal = clamp01((scatterProgress * (1 + stagger) - order * stagger));
        const scatterEase = easeTemperaInOut(scatterLocal);
        const ghost = held && !fixedCamera
            ? resolveGhostDrift(
                ghostSeed, ghostCenter.x, ghostCenter.y, glyph, index, order,
                time, view.shot.lyricEndTime, height, exitProgress,
                held ? resolveHeldExitDuration(view) : resolveShotHandoff(view),
                scatterEase,
            )
            : null;
        // A retained line keeps a wet edge: one faint echo slides back toward where the glyph
        // was written and dries out over ~2.6s. It reuses the entrance echoes, so no extra
        // textures or filters are created for it.
        const sungFor = time - glyph.motion.endTime;
        const trailRise = held ? clamp01(sungFor / 0.35) : 0;
        const trailDry = clamp01(sungFor / 2.6);
        const trailInk = overlapFx().trailInk * (trailRise * trailRise * (3 - 2 * trailRise))
            * (1 - trailDry * trailDry * (3 - 2 * trailDry))
            * (1 - (ghost?.depart ?? 0));
        const trailX = -(ghost?.x ?? 0) * 0.35;
        const trailY = -(ghost?.y ?? 0) * 0.35;
        const ghostAlpha = (ghost?.alpha ?? 1) * flashAlpha;
        const ghostScale = ghost?.scale ?? 1;
        const ghostScaleY = ghost?.scaleY ?? ghostScale;
        // Each character lands as wet ink: it blooms in slightly out of focus and sharpens
        // over 0.42s, then the sung-line blur takes over. One pulse at the onset makes the
        // reveal read as a stroke being written rather than opacity being switched on.
        const revealProgress = clamp01((time - glyph.motion.startTime) / 0.42);
        const revealBase = 1 - revealProgress * revealProgress * (3 - 2 * revealProgress);
        // 文闪的随机入场模糊：每个字独立掷骰，命中后按自己的时长从虚焦收到清晰。
        // 原有的湿墨底模糊保留；随机模糊叠在它上面，只让命中的字更虚。
        const entryBlurOn = entryBlurChance > 0 && temperaHash01(flashSeed, index, 4093) < entryBlurChance;
        const entryBlurPeak = entryBlurOn
            ? entryBlurAmount * (1.15 + 0.35 * temperaHash01(flashSeed, index, 4099))
            : 0;
        const entryBlurSeconds = entryBlurDuration * (0.65 + 0.7 * temperaHash01(flashSeed, index, 4111));
        const entryBlurProgress = clamp01((time - glyph.motion.startTime) / Math.max(0.05, entryBlurSeconds));
        const entryBlurEase = 1 - entryBlurProgress * entryBlurProgress * (3 - 2 * entryBlurProgress);
        const entryBlur = entryBlurOn ? entryBlurEase * entryBlurPeak : 0;
        const revealBlur = revealBase;
        const pulseDistance = (time - glyph.motion.startTime) / 0.18;
        const pulse = Math.exp(-pulseDistance * pulseDistance);
        const x = glyph.baseX + glyphFrame.x + (ghost?.x ?? 0);
        const y = glyph.baseY + glyphFrame.y + (ghost?.y ?? 0) - 1.4 * pulse;
        const scaleX = glyphFrame.scaleX * ghostScale * (1 + 0.02 * pulse);
        const scaleY = glyphFrame.scaleY * ghostScaleY * (1 + 0.02 * pulse);
        const rotation = glyphFrame.rotation + (ghost?.rotation ?? 0);
        // A landing character flicks a few grains of ink off the nib. Deterministic per glyph
        // and per grain, so a replay writes the same spray; the whole life is derived from the
        // onset time, which keeps the frame writer stateless like the rest of this file.
        if (view.specks) {
            const age = time - glyph.motion.startTime;
            if (age > 0 && age < 0.6) {
                const progress = age / 0.6;
                const spread = 1 - (1 - progress) * (1 - progress);
                const seed = hashTemperaSeed(view.shot.id) + index * 131;
                const grains = Math.round(overlapFx().specks);
                for (let grain = 0; grain < grains; grain += 1) {
                    const angle = temperaHash01(seed, grain, 151) * Math.PI * 2;
                    const reach = (7 + temperaHash01(seed, grain, 157) * 24) * spread;
                    const size = 3.4 * (1 - progress * 0.85)
                        * (0.7 + temperaHash01(seed, grain, 163) * 0.9);
                    view.specks
                        .circle(
                            x + Math.cos(angle) * reach,
                            y + Math.sin(angle) * reach - 4 * progress,
                            size,
                        )
                        .fill({color: (glyph.fill ?? view.speckColor), alpha: 0.8 * (1 - progress)});
                }
            }
        }
        glyph.display.alpha = glyphFrame.alpha * ghostAlpha;
        glyph.display.visible = glyphFrame.visible && ghostAlpha > 0.001;
        glyph.display.position.set(x, y);
        glyph.display.scale.set(scaleX, scaleY);
        glyph.display.rotation = rotation;
        if (glyph.sungBlur) {
            const fade = clamp01((time - glyph.motion.endTime) / 1.2);
            glyph.display.alpha = glyphFrame.alpha * ghostAlpha
                * (fixedCamera ? 1 : 1 - overlapFx().ghostBlur * fade * fade * (3 - 2 * fade));
            const sung = glyph.sungBlur;
            const maximum = sung.maximum;
            // Reading and writing share one filter: the max keeps the wet-ink reveal and the
            // post-sung fade from fighting when a short line's tail overlaps the next glyph.
            // Rack focus: the line that just finished stays a touch soft for a moment while
            // the new one pulls in from slightly blurred to sharp, so the whole paragraph reads
            // as one continuous focus change instead of a cut.
            const incoming = (1 - clamp01((time - view.shot.startTime) / 0.42)) * 0.5;
            const outgoing = held && Number.isFinite(view.shot.holdUntil)
                ? clamp01((time - view.shot.lyricEndTime) / 0.45) * (1 - clamp01((time - view.shot.lyricEndTime - focusHold) / 0.6))
                : 0;
            const rack = rackFocus && !fixedCamera ? Math.max(incoming, outgoing) : 0;
            const strength = maximum * Math.max(lineBlur, revealBlur, entryBlur, rack * overlapFx().rackFocus);
            if (strength > 0 && !sung.filter) sung.filter = sung.create();
            const filter = sung.filter;
            if (filter && filter.strength !== strength) {
                const wasClear = filter.strength === 0;
                filter.strength = strength;
                if (strength === 0) glyph.display.filters = null;
                else if (wasClear) glyph.display.filters = [filter];
            }
        }
        // 镂空用独立描边副本显隐，基字形的 fill/stroke 永远不动。
        // 这样即使闪烁停在某一亮拍、或某一帧没来得及重建纹理，也不会留下透明填充。
        if (glyph.outline) {
            const outlineOn = hollowLook
                && glyphFrame.visible && ghostAlpha > 0.001 && !glyph.masked;
            const outline = glyph.outline;
            outline.visible = outlineOn;
            if (outlineOn) {
                outline.position.copyFrom(glyph.display.position);
                outline.scale.copyFrom(glyph.display.scale);
                outline.rotation = glyph.display.rotation;
                outline.alpha = glyph.display.alpha;
                if (glyph.flashOutlineWidth !== outlineWidth) {
                    glyph.flashOutlineWidth = outlineWidth;
                    outline.style.stroke = {
                        color: glyph.fill,
                        width: Math.max(1, Number(outline.style.fontSize) * outlineWidth),
                        join: 'round',
                    };
                }
            } else {
                glyph.flashOutlineWidth = undefined;
            }
            glyph.display.visible = glyph.display.visible && !outlineOn;
        }
        // The solid block shares the glyph's final transform and alpha so it reads as one
        // printed unit while it flashes; it is hidden on every non-solid beat and after entry.
        if (glyph.flashBox) {
            const boxVisible = paint === 'solid' && glyphFrame.visible && !glyph.masked && ghostAlpha > 0.001;
            glyph.flashBox.visible = boxVisible;
            if (boxVisible) {
                const rect = glyph.flashBoxRect;
                if (rect) {
                    const pad = Number(glyph.display.style.fontSize) * blockPadding;
                    // 色块跟随这个字自己的文字颜色，而不是主题里的强调色/墨色。
                    const color = glyph.fill ?? theme.primaryColor;
                    const signature = `${appearanceRevision}:${color}:${pad.toFixed(2)}`;
                    if (glyph.flashBoxSignature !== signature) {
                        glyph.flashBox.clear()
                            .rect(rect.x - pad, rect.y - pad, rect.width + pad * 2, rect.height + pad * 2)
                            .fill({color, alpha: 1});
                        glyph.flashBoxSignature = signature;
                    }
                }
                glyph.flashBox.position.set(x, y);
                glyph.flashBox.scale.set(scaleX, scaleY);
                glyph.flashBox.rotation = rotation;
                glyph.flashBox.alpha = glyph.display.alpha * blockAlpha;
            }
        }
        if (glyph.glow) {
            const halo = glyph.glow;
            const glowStrength = fixedCamera ? wenflashGlowStrength() : 1;
            const plainRatio = fixedCamera ? wenflashGlowPlain() : 0.7;
            const gain = overlapFx().keywordGlow * glowStrength;
            const rise = held ? Math.min(0.32, Math.max(0.08, glyph.motion.endTime - glyph.motion.startTime)) : 0.7;
            const ramp = clamp01((time - glyph.motion.startTime) / rise);
            const eased = ramp * ramp * (3 - 2 * ramp);
            const breathe = fixedCamera ? 1 : 1 + 0.07 * Math.sin((time - glyph.motion.startTime) * 3.1);
            const release = held ? clamp01((time - Math.max(glyph.motion.endTime, glyph.motion.startTime + rise)) / 0.55) : 0;
            const light = gain * (fixedCamera
                ? 1 - clamp01(exitAge / Math.max(0.18, flashWindow))
                : eased * (1 - release * release * (3 - 2 * release)));
            if (!fixedCamera && held && !hollowLook && halo.keyword) glyph.display.tint = mixColors(glyph.fill, '#ffffff', clamp01(light * 1.4));
            const strength = halo.maximum * (fixedCamera ? wenflashGlowRadius() : 0.25 + 0.75 * eased);
            const alpha = (fixedCamera ? 1 : (held ? 1 : 0.72)) * light * breathe * glyph.display.alpha * (glyphFrame.visible ? 1 : 0) * (halo.keyword ? 1 : plainRatio);
            const exitHollowGlow = fixedCamera && exitAge >= 0 && glyph.exitHollow === true;
            halo.display.visible = alpha > 0.004 && !glyph.masked && !hollowLook && !exitHollowGlow;
            if (halo.display.visible) {
                halo.display.alpha = Math.min(1, alpha);
                halo.display.position.set(x, y);
                halo.display.scale.set(scaleX * 1.015, scaleY * 1.015);
                halo.display.rotation = rotation;
                if (!halo.filter) halo.filter = halo.create();
                if (halo.gradient && (!fixedCamera || wenflashGlowColorMode() === 'custom')) {
                    const flowSpeed = fixedCamera ? wenflashGlowFlowSpeed() : 1;
                    halo.gradient.setTime(time * 0.55 * flowSpeed + glyph.baseX * 0.0025 + glyph.baseY * 0.001);
                    if (fixedCamera) halo.gradient.setScale(wenflashGlowFlowScale());
                    halo.gradient.setColors(fixedCamera && wenflashGlowColorMode() === 'custom'
                        ? wenflashGlowColors()
                        : halo.colors);
                    if (halo.display.filters?.length !== 2) {
                        halo.display.filters = [halo.filter, halo.gradient.filter];
                    }
                } else if (halo.display.filters?.length !== 1) {
                    halo.display.filters = [halo.filter];
                }
                if (halo.filter.strength !== strength) halo.filter.strength = strength;
            }
        }
        if (glyph.posterEcho) {
            const echo = glyph.posterEcho;
            const onset = glyph.motion.startTime + 0.08;
            const end = Math.min(exitAt, Math.max(onset + 0.62, Math.min(onset + 1.5, glyph.motion.endTime + 0.48)));
            const phase = easeTemperaInOut(clamp01(Math.min((time - onset) / 0.24, (end - time) / 0.36)));
            const alpha = phase * wenflashDecorIntensity() * 0.28;
            echo.visible = alpha > 0.002;
            if (echo.visible) {
                const side = glyph.baseY < height * 0.45 ? 1 : -1;
                const font = Number(echo.style.fontSize);
                const spread = phase * font;
                echo.position.set(glyph.baseX + spread * 0.45, glyph.baseY + side * spread * 0.85);
                echo.rotation = glyph.motion.rotation - side * phase * 0.06;
                echo.scale.set(1 + 2.1 * phase);
                echo.alpha = alpha;
            }
        }
        if (accents && entryAge >= 0 && entryAge < 0.72 && glyph.display.visible && !glyph.flashBox?.visible) {
            const pick = temperaHash01(flashSeed, index, 1409);
            if (pick < (glyph.keyword ? 0.7 : 0.2)) {
                const phase = easeTemperaInOut(clamp01(Math.min(entryAge / 0.22, (0.72 - entryAge) / 0.34)));
                const font = Number(glyph.display.style.fontSize) || 32;
                const size = font * Math.min(1.6, Math.abs(scaleY));
                const angle = rotation - Math.PI * 0.25;
                const distance = size * (0.65 + 0.12 * phase);
                const cx = x + Math.cos(angle) * distance, cy = y + Math.sin(angle) * distance;
                const r = size * 0.14 * phase;
                const alpha = Math.min(0.85, glyph.display.alpha) * phase;
                if (pick < (glyph.keyword ? 0.4 : 0.1)) {
                    // A tapered four-point glint opens and folds around the same centre.
                    const neck = r * 0.18;
                    accents.poly([cx,cy-r, cx+neck,cy-neck, cx+r*0.75,cy,
                        cx+neck,cy+neck, cx,cy+r, cx-neck,cy+neck,
                        cx-r*0.75,cy, cx-neck,cy-neck]).fill({color:glyph.fill, alpha});
                } else {
                    // Two broken registration corners briefly frame this glyph.
                    const dx = cx-x, dy = cy-y;
                    for (const side of [-1,1]) {
                        const ax = x+side*dx, ay = y+side*dy;
                        const ux = Math.cos(rotation)*r*side, uy = Math.sin(rotation)*r*side;
                        accents.moveTo(ax-ux,ay-uy).lineTo(ax,ay).lineTo(ax-uy,ay+ux);
                    }
                    accents.stroke({width:Math.max(1,font*0.018),color:glyph.fill,alpha});
                }
            }
        }
        // 字形装饰：每个字独立抽取一种小装饰，落定后浮现，随闪烁/退场收走。
        // 只画在 accents 这一张每帧清空的 Graphics 上，不新增节点；抽不中的字完全干净。
        const glyphFont = Number(glyph.display.style.fontSize) || 32;
        const decorOn = fixedCamera && wenflashGlyphDecor() && wenflashDecorIntensity() > 0.001
            && !glyph.masked && !hollowLook && paint !== 'solid'
            && /[\p{L}\p{N}]/u.test(glyph.display.text);
        if (accents && decorOn && entryAge > 0.24) {
            const decorRoll = temperaHash01(flashSeed, index, 1301);
            if (decorRoll < wenflashGlyphDecorChance()) {
                const mode = wenflashGlyphDecorStyle();
                const styleIndex = mode === 'random'
                    ? Math.floor(temperaHash01(flashSeed, index, 1307) * 4)
                    : mode === 'sparkle' ? 0 : mode === 'bracket' ? 1 : mode === 'orbit' ? 2 : 3;
                const size = glyphFont * 0.16 * wenflashGlyphDecorSize()
                    * (Math.abs(scaleX) + Math.abs(scaleY)) * 0.5;
                const speed = wenflashGlyphDecorSpeed();
                const phase = (time - glyph.motion.startTime) * 2.2 * speed
                    + temperaHash01(flashSeed, index, 1319) * Math.PI * 2;
                const fadeIn = clamp01((entryAge - 0.24) / 0.5);
                const decorAlpha = fadeIn * Math.max(0, Math.min(1, exitAlpha))
                    * wenflashDecorIntensity() * 0.9;
                if (decorAlpha > 0.005 && size > 0.5) {
                    const accent = glyph.flashBoxColors?.accent ?? glyph.fill;
                    const point = (dx: number, dy: number): [number, number] => [
                        x + Math.cos(rotation) * dx - Math.sin(rotation) * dy,
                        y + Math.sin(rotation) * dx + Math.cos(rotation) * dy,
                    ];
                    if (styleIndex === 0) {
                        // 星芒：在字的右上角缓慢自转，两次呼吸一大一小。
                        const [cx, cy] = point(size * 1.25, -size * 1.1);
                        const r = size * (0.28 + 0.16 * Math.sin(phase * 1.7));
                        const turn = phase * 0.35;
                        const arm = (a: number, length: number): [number, number] => [
                            cx + Math.cos(a + turn) * length, cy + Math.sin(a + turn) * length,
                        ];
                        const [ax, ay] = arm(0, r);
                        const [bx, by] = arm(Math.PI / 2, r);
                        const [cx2, cy2] = arm(Math.PI, r);
                        const [dx2, dy2] = arm(-Math.PI / 2, r);
                        const neck = r * 0.18;
                        accents.poly([
                            ax, ay, cx + neck, cy - neck, bx, by, cx + neck, cy + neck,
                            cx2, cy2, cx - neck, cy + neck, dx2, dy2, cx - neck, cy - neck,
                        ]).fill({color: accent, alpha: decorAlpha * 0.8});
                    } else if (styleIndex === 1) {
                        // 角标：左上/右下两段 L 形短线，长度随呼吸伸缩。
                        const w = size * (1.5 + 0.12 * Math.sin(phase * 1.2));
                        const h = size * (1.7 + 0.12 * Math.cos(phase * 1.2));
                        const corner = size * 0.55;
                        const stroke = Math.max(1, size * 0.11);
                        const [lx, ty] = point(-w / 2, -h / 2);
                        const [rx, by] = point(w / 2, h / 2);
                        const [lx2, ty2] = point(-w / 2, -h / 2 + corner);
                        const [lx3, ty3] = point(-w / 2 + corner, -h / 2);
                        const [rx2, by2] = point(w / 2, h / 2 - corner);
                        const [rx3, by3] = point(w / 2 - corner, h / 2);
                        accents.moveTo(lx2, ty2).lineTo(lx, ty).lineTo(lx3, ty3)
                            .stroke({width: stroke, color: accent, alpha: decorAlpha * 0.75});
                        accents.moveTo(rx2, by2).lineTo(rx, by).lineTo(rx3, by3)
                            .stroke({width: stroke, color: accent, alpha: decorAlpha * 0.75});
                    } else if (styleIndex === 2) {
                        // 环绕：三颗小墨点沿椭圆轨道绕字运行。
                        const radius = size * 1.5;
                        for (let dot = 0; dot < 3; dot += 1) {
                            const angle = phase * (0.8 + dot * 0.12) + dot * Math.PI * 2 / 3;
                            const [px, py] = point(Math.cos(angle) * radius, Math.sin(angle) * radius * 0.55);
                            accents.circle(px, py, size * (0.1 + 0.04 * Math.sin(phase + dot)))
                                .fill({color: dot === 0 ? accent : glyph.fill, alpha: decorAlpha * 0.7});
                        }
                    } else {
                        // 划线：字下/字侧一段短线，两端随呼吸伸缩。
                        const length = size * (1.9 + 0.35 * Math.sin(phase * 1.4));
                        const vertical = view.lineFlashVertical;
                        const [ax, ay] = vertical
                            ? point(size * 1.15, -length / 2)
                            : point(-length / 2, size * 1.15);
                        const [bx, by] = vertical
                            ? point(size * 1.15, length / 2)
                            : point(length / 2, size * 1.15);
                        accents.moveTo(ax, ay).lineTo(bx, by)
                            .stroke({width: Math.max(1, size * 0.09), color: accent, alpha: decorAlpha * 0.7});
                    }
                }
            }
        }
        if (glyph.shadow) {
            glyph.shadow.alpha = glyphFrame.alpha * ghostAlpha * 0.34;
            glyph.shadow.visible = glyphFrame.visible && !glyph.masked && !hollowLook && ghostAlpha > 0.001;
            glyph.shadow.position.set(x + glyph.shadowDX, y + glyph.shadowDY);
            glyph.shadow.scale.set(scaleX, scaleY);
            glyph.shadow.rotation = rotation;
        }
        // 层叠色版：几张固定在基字后方的错位副本，跟随同样的运动/闪烁/退场透明度。
        // 只在亮拍不是纯色块、且没有镂空时露出，避免把实心块和描边弄脏。
        const ghostOffset = wenflashGhostOffset();
        const ghostBaseAlpha = wenflashGhostAlpha();
        glyph.ghosts.forEach((ghost, ghostIndex) => {
            const layers = Math.max(1, wenflashGhostLayers());
            const spread = ghostOffset * (ghostIndex + 1);
            const layerAlpha = flashAlpha * Math.max(0, glyphFrame.alpha) * ghostBaseAlpha
                * Math.max(0.12, 1 - ghostIndex / (layers + 1));
            ghost.visible = glyphFrame.visible && !glyph.masked && !hollowLook && paint !== 'solid'
                && layerAlpha > 0.001;
            if (!ghost.visible) return;
            const angle = rotation + Math.PI * 0.25;
            ghost.position.set(x + Math.cos(angle) * spread, y + Math.sin(angle) * spread);
            ghost.rotation = rotation;
            ghost.scale.set(scaleX, scaleY);
            ghost.alpha = Math.min(1, layerAlpha);
        });
        // Echoes trail further back along the entrance vector the deeper they sit; once the
        // line is retained the same echoes carry the wet-ink trail instead.
        const echoVisible = glyphFrame.visible && !glyph.masked && !hollowLook
            && ghostAlpha > 0.001
            && (glyphFrame.echoAlpha > 0.004 || trailInk > 0.004);
        glyph.echoes.forEach((echo, echoIndex) => {
            echo.visible = echoVisible;
            if (!echoVisible) return;
            const depth = 1 + echoIndex * 0.85;
            echo.alpha = flashAlpha * Math.max(
                glyphFrame.echoAlpha / (echoIndex + 1.4),
                trailInk / (echoIndex + 1.2),
            );
            echo.position.set(
                glyph.baseX + glyphFrame.echoX * depth + (ghost?.x ?? 0) + trailX,
                glyph.baseY + glyphFrame.echoY * depth + (ghost?.y ?? 0) + trailY,
            );
            echo.scale.set(scaleX, scaleY);
            echo.rotation = rotation;
        });
    });

    // The whole-phrase plate: one block across the line, entering on the same flash cadence
    // as the type, then swept off in one quick pass. The sweep runs on its own clock instead
    // of the karaoke clock: horizontal lines wipe left to right, vertical lines top to bottom.
    if (view.lineFlashBox && view.lineFlashBoxRect) {
        const rect = view.lineFlashBoxRect;
        const pad = view.lineFlashBoxFontSize * wenflashLineBlockPadding();
        let lineStart = Infinity;
        for (const glyph of view.lineFlashOrder) lineStart = Math.min(lineStart, glyph.motion.startTime);
        const entryAge = time - lineStart;
        const sweep = wenflashLineBlockSweep();
        const progress = clamp01(entryAge / sweep);
        const phase = entryAge * (flashCount / flashWindow);
        const entryLineAlpha = entryAge >= 0 && entryAge < flashWindow && phase % 1 < flashDark ? flashDim : 1;
        const lineAlpha = entryLineAlpha * exitAlpha;
        const vertical = view.lineFlashVertical;
        const left = rect.x - pad;
        const top = rect.y - pad;
        const spanW = rect.width + pad * 2;
        const spanH = rect.height + pad * 2;
        const boundary = vertical ? top + spanH * progress : left + spanW * progress;
        const remain = vertical ? top + spanH - boundary : left + spanW - boundary;
        const visible = lineBlockOn && Number.isFinite(lineStart) && entryAge >= 0 && progress < 1
            && remain > 0.5 && lineAlpha > 0.001;
        view.lineFlashBox.visible = visible;
        if (visible) {
            // 整句色块同样跟随这一句文字自身的颜色，取句中第一个有颜色的字。
            const color = view.glyphs.find(glyph => glyph.fill)?.fill ?? theme.primaryColor;
            const signature = `${appearanceRevision}:${color}:${vertical ? 1 : 0}:${boundary.toFixed(2)}:${remain.toFixed(2)}:${pad.toFixed(2)}`;
            if (view.lineFlashBoxSignature !== signature) {
                view.lineFlashBox.clear();
                if (vertical) view.lineFlashBox.rect(left, boundary, spanW, remain);
                else view.lineFlashBox.rect(boundary, top, remain, spanH);
                view.lineFlashBox.fill({color, alpha: 1});
                view.lineFlashBoxSignature = signature;
            }
            const settle = Math.max(0.08, Math.min(0.6, view.revealDoneTime - lineStart));
            const entryScale = wenflashEntrySize(temperaHash01(flashSeed, 0, 619), clamp01(entryAge / settle));
            // 整句色块也补退场：沿入场的收束方向反向涨回起始倍率，再随闪烁消失。
            const exitScale = exitAge >= 0
                ? wenflashEntrySize(
                    temperaHash01(flashSeed, 0, 619),
                    clamp01(exitAge / Math.max(0.08, exitMotionWindow)),
                )
                : 1;
            const scale = entryScale * exitScale;
            const cx = rect.x + rect.width / 2;
            const cy = rect.y + rect.height / 2;
            view.lineFlashBox.pivot.set(cx, cy);
            view.lineFlashBox.position.set(cx, cy);
            view.lineFlashBox.scale.set(scale);
            view.lineFlashBox.alpha = lineAlpha * wenflashLineBlockAlpha();
        }
    }

    if (view.phraseArt) {
        updatePhraseArt(view.phraseArt, time, exitAt, flashWindow, wenflashDecorIntensity(), wenflashPhraseArtRun(), wenflashPhraseArtBrake());
    }
    if (view.phraseScore) {
        drawPhraseScore(
            view.phraseScore, time, exitAt, flashWindow, wenflashDecorIntensity(),
            flashCount, flashDark, flashDim,
        );
    }

    // 跑马框：两条辉光线沿整句外框追逐，各自相隔半圈。它有自己的环绕时钟，
    // 从这一句第一个字起唱开始跑，随整句入场淡入、随退场闪烁一起消失。
    if (view.marquee && fixedCamera) {
        const rect = view.marquee.rect;
        const pad = view.marquee.fontSize * wenflashMarqueePadding();
        const box = {x: rect.x - pad, y: rect.y - pad, width: rect.width + pad * 2, height: rect.height + pad * 2};
        let lineStart = Infinity;
        for (const glyph of view.lineFlashOrder) lineStart = Math.min(lineStart, glyph.motion.startTime);
        const entryAge = time - lineStart;
        const delay = wenflashMarqueeEntryDelay();
        const fade = wenflashMarqueeEntryFade();
        const rolled = temperaHash01(flashSeed, 0, 7331) < wenflashMarqueeChance();
        const reveal = clamp01((entryAge - delay) / fade);
        const eased = reveal * reveal * (3 - 2 * reveal);
        // 退场也走一遍入场淡入的相反方向：框线先缩回起始倍率，再随闪烁归零。
        const exitFade = exitAge >= 0 ? 1 - clamp01(exitAge / Math.max(0.08, fade)) : 1;
        const alpha = wenflashMarquee() && rolled && Number.isFinite(lineStart) && entryAge >= delay
            ? eased * exitAlpha * exitFade
            : 0;
        if (alpha > 0.002) {
            const perimeter = (box.width + box.height) * 2;
            const width = Math.max(0.6, view.marquee.fontSize * wenflashMarqueeWidth());
            const glow = wenflashMarqueeGlow();
            const color = view.glyphs.find(glyph => glyph.fill)?.fill ?? theme.primaryColor;
            const orbitAge = Math.max(0, entryAge - delay);
            const cycles = wenflashEasedCycles(orbitAge, wenflashMarqueeDuration(), wenflashMarqueeRun(), wenflashMarqueeBrake());
            const phase = ((cycles % 1) + 1) % 1;
            const lineStyle = pickWenflashLineStyle(hashTemperaSeed(`${view.shot.id}:${view.glyphs.map(glyph => glyph.display.text).join('')}`), Math.round(view.shot.startTime * 1000));
            const art = {
                rect, box, perimeter, phase, cycles, alpha, color, width, glow,
                span: wenflashMarqueeLength(),
                fontSize: view.marquee.fontSize, lineY: box.y + box.height,
            };
            view.marquee.glow.clear();
            view.marquee.core.clear();
            if (glow > 0.01) {
                lineStyle.frame(view.marquee.glow, {...art, width: width * 4.5, alpha: alpha * 0.22 * glow});
            }
            lineStyle.frame(view.marquee.core, art);
            view.marquee.blur.strength = Math.max(0, width * 2.4 * glow);
            view.marquee.blur.padding = Math.ceil(width * 6 + 8);
            const entryScale = wenflashMarqueeEntryScale();
            const retract = exitAge >= 0 ? 1 - exitFade : 0;
            const scale = (1 + (entryScale - 1) * (1 - eased)) * (1 + (entryScale - 1) * retract);
            const cx = box.x + box.width / 2;
            const cy = box.y + box.height / 2;
            for (const line of [view.marquee.glow, view.marquee.core]) {
                line.pivot.set(cx, cy);
                line.position.set(cx, cy);
                line.scale.set(scale);
            }
            view.marquee.glow.visible = glow > 0.01;
            view.marquee.core.visible = true;
        } else {
            view.marquee.glow.visible = false;
            view.marquee.core.visible = false;
        }
    }

    // 底部光线：一条同色辉光线画在整句下方，从本句起唱开始淡入，随退场闪烁一起消失。
    if (view.bottomLine && fixedCamera) {
        const rect = view.bottomLine.rect;
        const fontSize = view.bottomLine.fontSize;
        let lineStart = Infinity;
        for (const glyph of view.lineFlashOrder) lineStart = Math.min(lineStart, glyph.motion.startTime);
        const entryAge = time - lineStart;
        const rolled = temperaHash01(flashSeed, 0, 8419) < wenflashBottomLineChance();
        const fade = Math.max(0.06, wenflashBottomLineFade());
        const reveal = clamp01(entryAge / fade);
        // 底部光线也补上退场：沿入场淡入的反方向收回，不再只靠 exitAlpha 硬消失。
        const exitFade = exitAge >= 0 ? 1 - clamp01(exitAge / fade) : 1;
        const alpha = wenflashBottomLine() && rolled && Number.isFinite(lineStart) && entryAge >= 0
            ? reveal * exitAlpha * exitFade
            : 0;
        if (alpha > 0.002) {
            const y = rect.y + rect.height + fontSize * wenflashBottomLineOffset();
            const length = Math.max(4, rect.width * wenflashBottomLineLength());
            const width = Math.max(0.5, fontSize * wenflashBottomLineWidth());
            const glow = wenflashBottomLineGlow();
            const color = view.glyphs.find(glyph => glyph.fill)?.fill ?? theme.primaryColor;
            const speed = Math.max(0.1, wenflashBottomLineSpeed());
            const cycles = wenflashEasedCycles(entryAge, speed, wenflashBottomLineRun(), wenflashBottomLineBrake());
            const travel = 0.5 - 0.5 * Math.cos(cycles * Math.PI * 2);
            const cx = rect.x + length / 2 + Math.max(0, rect.width - length) * travel;
            const x0 = cx - length / 2;
            const lineStyle = pickWenflashLineStyle(hashTemperaSeed(`${view.shot.id}:${view.glyphs.map(glyph => glyph.display.text).join('')}`), Math.round(view.shot.startTime * 1000));
            const art = {
                rect: {x: x0, y: rect.y, width: length, height: rect.height},
                box: {x: x0, y: rect.y, width: length, height: rect.height},
                perimeter: (length + rect.height) * 2,
                phase: ((cycles % 1) + 1) % 1,
                cycles,
                alpha,
                color,
                width,
                glow,
                span: wenflashBottomLineLength() / 100,
                fontSize,
                lineY: y,
            };
            view.bottomLine.glow.clear();
            view.bottomLine.core.clear();
            if (glow > 0.01) {
                lineStyle.line(view.bottomLine.glow, {...art, width: width * 4.5, alpha: alpha * 0.22 * glow});
            }
            lineStyle.line(view.bottomLine.core, art);
            view.bottomLine.blur.strength = Math.max(0, width * 2.4 * glow);
            view.bottomLine.blur.padding = Math.ceil(width * 6 + 8);
            view.bottomLine.glow.visible = glow > 0.01;
            view.bottomLine.core.visible = true;
        } else {
            view.bottomLine.glow.visible = false;
            view.bottomLine.core.visible = false;
        }
    }

    // The forme: a hairline block under each character, growing from the middle as the glyph
    // lands and shrinking away with it. It is drawn from the character's rendered box, so the
    // block follows the glyph's turn and scale without a second layout pass.
    if (view.moulds) {
        view.moulds.clear();
        for (const index of view.mouldGlyphs) {
            const glyph = view.glyphs[index];
            if (!glyph || glyph.masked || glyph.display.alpha <= 0.01) continue;
            const reveal = clamp01((time - glyph.motion.startTime) / 0.32);
            if (reveal <= 0) continue;
            const grow = 0.7 + 0.3 * (reveal * reveal * (3 - 2 * reveal));
            const pad = Math.max(2, glyph.display.height * 0.08);
            const halfW = (glyph.display.width / 2 + pad) * grow;
            const halfH = (glyph.display.height / 2 + pad) * grow;
            const cosR = Math.cos(glyph.display.rotation);
            const sinR = Math.sin(glyph.display.rotation);
            const cx = glyph.display.x;
            const cy = glyph.display.y;
            const cornerX = (dx: number, dy: number) => cx + dx * cosR - dy * sinR;
            const cornerY = (dx: number, dy: number) => cy + dx * sinR + dy * cosR;
            view.moulds
                .moveTo(cornerX(-halfW, -halfH), cornerY(-halfW, -halfH))
                .lineTo(cornerX(halfW, -halfH), cornerY(halfW, -halfH))
                .lineTo(cornerX(halfW, halfH), cornerY(halfW, halfH))
                .lineTo(cornerX(-halfW, halfH), cornerY(-halfW, halfH))
                .closePath()
                .stroke({
                    width: 0.9,
                    color: view.speckColor,
                    alpha: 0.3 * reveal * clamp01(glyph.display.alpha),
                    join: 'round',
                });
        }
    }

    // The chop: a small square pressed onto the page once the last character has landed,
    // slightly overshooting then settling, and drying out with the line. Strokes only, so it
    // needs no glyph and keeps its edge at any size.
    if (view.seal) {
        const age = time - view.sealStart;
        const appear = clamp01(age / 0.16);
        const dry = clamp01((time - view.shot.lyricEndTime) / 1.1);
        const alpha = 0.62 * appear * (1 - dry);
        if (appear > 0 && alpha > 0.004) {
            const pop = 1.5 - 0.5 * (appear * appear * (3 - 2 * appear));
            const size = view.sealSize;
            // Each phrase leaves its own engraved motif inside the double rule.
            const seed = hashTemperaSeed(view.shot.id);
            view.seal.clear()
                .rect(-size / 2, -size / 2, size, size)
                .stroke({width: 2, color: view.sealColor, alpha, join: 'miter'})
                .rect(-size / 2 + 3, -size / 2 + 3, size - 6, size - 6)
                .stroke({width: 0.9, color: view.sealColor, alpha: alpha * 0.8});
            const cell = (size - 9) / 5;
            for (let column = 0; column < 3; column++) {
                const x = (column - 1) * 1.7 * cell;
                const sign = temperaHash01(seed, column, 419) < 0.5 ? -1 : 1;
                const notch = (temperaHash01(seed, column, 421) - 0.5) * cell;
                view.seal.moveTo(x - 0.55 * cell, -2 * cell * sign)
                    .lineTo(x + 0.45 * cell, -2 * cell * sign)
                    .lineTo(x + 0.45 * cell, notch)
                    .lineTo(x - 0.45 * cell, notch)
                    .lineTo(x - 0.45 * cell, 2 * cell * sign);
            }
            view.seal.stroke({width: Math.max(0.85, cell * 0.38), color: view.sealColor, alpha});
            // Four short registration corners settle against the stamp, then lift back out.
            const press = clamp01(Math.min(age / 0.2, (0.72 - age) / 0.36));
            if (press > 0) {
                const edge = size * (0.92 - 0.24 * press);
                const arm = size * 0.19 * press;
                for (const dx of [-1, 1]) for (const dy of [-1, 1]) {
                    view.seal.moveTo(dx * (edge - arm), dy * edge)
                        .lineTo(dx * edge, dy * edge).lineTo(dx * edge, dy * (edge - arm));
                }
                view.seal.stroke({width: 1, color: view.sealColor, alpha: alpha * press});
            }
            view.seal.position.set(view.sealX, view.sealY);
            view.seal.rotation = view.sealRotation;
            view.seal.scale.set(pop);
        } else {
            view.seal.clear();
        }
    }

    const marks = view.lyricMarks;
    if (marks) {
        const first = view.glyphs[0];
        const last = view.glyphs[view.glyphs.length - 1];
        const duration = Math.max(0.12, view.shot.lyricEndTime - first.motion.startTime);
        const progress = clamp01((time - first.motion.startTime) / duration);
        const open = clamp01(Math.min((time - first.motion.startTime) / 0.36,
            (view.shot.lyricEndTime + 0.4 - time) / 0.4));
        const eased = open * open * (3 - 2 * open);
        const size = Number(last.display.style.fontSize) || 32;
        const normal = size * 0.72 + marks.scale.x * 1.35;
        const travel = marks.scale.x * (0.22 * progress - 0.4 * (1 - eased));
        marks.position.set(last.baseX - Math.sin(view.orientation) * normal + Math.cos(marks.rotation) * travel,
            last.baseY + Math.cos(view.orientation) * normal + Math.sin(marks.rotation) * travel);
        marks.visible = open > 0;
        marks.alpha = eased * (0.48 + 0.28 * progress) * overlapFx().decorAlpha;
        marks.children.forEach((piece, i) => {
            const delay = i * Math.min(0.09, duration / 6);
            const phase = clamp01(Math.min(time - first.motion.startTime - delay,
                view.shot.lyricEndTime + 0.4 - time - delay) / Math.min(0.32, duration));
            const settled = phase * phase * (3 - 2 * phase);
            piece.position.set((settled - 1) * 0.58, (1 - settled) * (i - 1) * 0.22);
            piece.alpha = settled;
        });
    }
    const arc = view.progressArc;
    const halo = view.progressHalo;
    halo?.clear();
    if (halo) halo.visible = false;
    const interGlyph = view.interGlyph;
    interGlyph?.clear();
    if (arc || interGlyph) {
        arc?.clear();
        const glyphs = view.glyphs;
        const coastDuration = 0.72;
        glyphs.forEach((glyph, index) => {
            if (time < glyph.motion.startTime) return;
            const next = glyphs[index + 1];
            const rowEnds = next?.rowIndex !== glyph.rowIndex;
            const end = rowEnds
                ? Math.min(glyph.motion.endTime, next?.motion.startTime ?? view.shot.lyricEndTime)
                : next.motion.startTime;
            if (time >= (rowEnds ? end + coastDuration : next.motion.startTime)) return;
            const span = Math.max(0.001, end - glyph.motion.startTime);
            const t = clamp01((time - glyph.motion.startTime) / span);
            const prev = glyphs[index - 1];
            const prevSpan = prev?.rowIndex === glyph.rowIndex
                ? Math.max(0.001, glyph.motion.startTime - prev.motion.startTime) : span;
            const following = glyphs[index + 2];
            const nextEnd = following?.rowIndex === glyph.rowIndex
                ? following.motion.startTime : Math.min(next?.motion.endTime ?? end, following?.motion.startTime ?? view.shot.lyricEndTime);
            const nextSpan = rowEnds ? span : Math.max(0.001, nextEnd - end);
            // Hermite tangents share the same velocity on both sides of each lyric cue.
            const entry = 2 * span / (prevSpan + span);
            const exit = rowEnds ? Math.min(1, 5 * span) : 2 * span / (span + nextSpan);
            const fraction = t + t * (1 - t) * ((entry - 1) * (1 - t) + (1 - exit) * t);
            const blend = clamp01((fraction - 0.5) * 2);
            const ink = next?.rowIndex === glyph.rowIndex && next.fill !== glyph.fill
                ? mixColors(glyph.fill, next.fill, blend * blend * (3 - 2 * blend))
                : glyph.fill;
            const dry = rowEnds ? clamp01((time - end) / coastDuration) : 0;
            const speed = exit / span;
            const head = index + fraction + speed * coastDuration * dry * (1 - 0.4 * dry);
            let rowStart = index;
            while (rowStart > 0 && glyphs[rowStart - 1].rowIndex === glyph.rowIndex) rowStart--;
            const rowSize = Number(glyphs[rowStart].display.style.fontSize) || 32;
            const seed = hashTemperaSeed(view.shot.id);
            const strandCount = 2 + Math.floor(temperaHash01(seed, rowStart, 487) * 7);
            const cos = Math.cos(view.orientation);
            const sin = Math.sin(view.orientation);
            // Sample one fixed path through the row. The pen reveals its leading edge
            // while older ink disappears behind it, even when playback is scrubbed.
            const point = (position: number, strand: number) => {
                const j = Math.min(index, Math.floor(position));
                const g = glyphs[j];
                const prev = glyphs[j - 1];
                const after = glyphs[j + 1];
                const size = Number(g.display.style.fontSize) || 32;
                const x0 = prev?.rowIndex === g.rowIndex ? (prev.baseX + g.baseX) / 2 : g.baseX - cos * size / 2;
                const y0 = prev?.rowIndex === g.rowIndex ? (prev.baseY + g.baseY) / 2 : g.baseY - sin * size / 2;
                const x1 = after?.rowIndex === g.rowIndex ? (after.baseX + g.baseX) / 2 : g.baseX + cos * size / 2;
                const y1 = after?.rowIndex === g.rowIndex ? (after.baseY + g.baseY) / 2 : g.baseY + sin * size / 2;
                const t = position - j;
                const phase = (position - rowStart) * (1.35 + strand * 0.08) + strand * 2.4;
                const bend = rowSize * ((strand - (strandCount - 1) / 2) * 0.085 + Math.sin(phase) * 0.23);
                return {x: x0 + (x1 - x0) * t - sin * bend, y: y0 + (y1 - y0) * t + cos * bend};
            };
            const opacity = overlapFx().decorAlpha * clamp01((time - glyphs[rowStart].motion.startTime) / 0.18);
            for (const style of view.interGlyphStyles) {
                if (!interGlyph) break;
                // Place marks on the row itself. The sung head reveals them and the tail
                // retracts each mark on the same axes, including after a seek or line wrap.
                const density = style === 'beads' ? 6 : 4;
                const reach = 1.35;
                const first = Math.max(rowStart * density, Math.ceil((head - reach) * density));
                for (let mark = first; mark <= Math.floor(head * density); mark++) {
                    const position = mark / density;
                    const behind = head - position;
                    const amount = easeTemperaInOut(clamp01(Math.min(behind / 0.22, (reach - behind) / 0.55))) * (1 - dry);
                    if (amount <= 0.001) continue;
                    const lane = style === 'rings' || style === 'stitch' ? 2 : style === 'chevron' || style === 'beads' ? 1 : 0;
                    const p = point(position, lane + mark % 2);
                    const alpha = opacity * amount;
                    if (style === 'beads') {
                        const radius = rowSize * (mark % 3 === 0 ? 0.064 : 0.032) * amount;
                        interGlyph.circle(p.x, p.y, radius).fill({color: ink, alpha});
                        continue;
                    }
                    const long = rowSize * amount;
                    if (style === 'rings') {
                        interGlyph.circle(p.x, p.y, long * 0.12)
                            .stroke({color: ink, width: 1.1, alpha});
                        continue;
                    }
                    if (style === 'chevron' || style === 'diamond') {
                        const w = long * 0.13, h = long * 0.09;
                        interGlyph.moveTo(p.x - sin * h, p.y + cos * h)
                            .lineTo(p.x + cos * w, p.y + sin * w)
                            .lineTo(p.x + sin * h, p.y - cos * h);
                        if (style === 'diamond') interGlyph.lineTo(p.x - cos * w, p.y - sin * w).closePath();
                        interGlyph.stroke({color: ink, width: 1.3, alpha});
                        continue;
                    }
                    const across = style === 'stitch' ? long * 0.13 : 0;
                    const lift = style === 'stitch' ? long * 0.12 : long * (mark % 3 === 0 ? 0.17 : 0.08);
                    const dx = cos * across - sin * lift, dy = sin * across + cos * lift;
                    interGlyph.moveTo(p.x - dx, p.y - dy).lineTo(p.x + dx, p.y + dy);
                    if (style === 'stitch') {
                        const bx = cos * across + sin * lift, by = sin * across - cos * lift;
                        interGlyph.moveTo(p.x - bx, p.y - by).lineTo(p.x + bx, p.y + by);
                    }
                    interGlyph.stroke({color: ink, width: 1.35, alpha, cap: 'round'});
                }
            }
            if (!arc) return;
            for (let strand = 0; strand < strandCount; strand++) {
                const life = 1.6 + 1.2 * temperaHash01(seed, rowStart, 501 + strand);
                const delay = strand === 0 ? 0 : (strand + 0.5) / strandCount * 0.48;
                const clock = time - glyphs[rowStart].motion.startTime - delay;
                if (clock <= 0) continue;
                const cycle = Math.floor(clock / life);
                const age = clock - cycle * life;
                if (rowEnds && time - age >= end) continue;
                const grow = clamp01(age / 0.32);
                const fade = clamp01((age - life + 0.55) / 0.55);
                const offset = temperaHash01(seed, rowStart + cycle, 537 + strand) * 0.42;
                const tip = head - offset;
                if (tip <= rowStart) continue;
                const tail = Math.max(rowStart, tip - grow * (0.95 + (strand % 3) * 0.28));
                // Pick once per row and pen, so a glowing stroke never flickers on seek.
                const roll = Math.sin(seed % 997 + rowStart * 19.3 + strand * 37.7) * 43758.5453;
                const glow = roll - Math.floor(roll) < 0.25;
                let previous = point(tail, strand);
                const upper = [previous.x, previous.y];
                const lower: number[] = [];
                // One tapered silhouette avoids overlapping translucent caps at each sample.
                for (let i = 1; i <= 12; i++) {
                    const along = i / 12;
                    const sample = point(tail + (tip - tail) * along, strand);
                    const wet = 1 - clamp01((Math.max(dry, fade) - along * 0.7) / 0.3);
                    const alpha = opacity * grow * wet * along;
                    const dx = sample.x - previous.x;
                    const dy = sample.y - previous.y;
                    const length = Math.hypot(dx, dy) || 1;
                    const radius = wet * Math.sqrt(along) * 0.9;
                    upper.push(sample.x - dy / length * radius, sample.y + dx / length * radius);
                    lower.push(sample.x + dy / length * radius, sample.y - dx / length * radius);
                    if (glow && halo && alpha > 0.001) {
                        halo.visible = true;
                        halo.moveTo(previous.x, previous.y).lineTo(sample.x, sample.y)
                            .stroke({width: 7, color: ink, alpha, cap: 'butt'});
                    }
                    previous = sample;
                }
                for (let j = lower.length - 2; j >= 0; j -= 2) upper.push(lower[j], lower[j + 1]);
                arc.poly(upper).fill({color: glow ? 0xffffff : ink,
                    alpha: opacity * grow * (1 - clamp01((Math.max(dry, fade) - 0.7) / 0.3))});
            }
        });
    }
    // The disturbance field: each character flicks a few hairlines outward as it lands. The
    // strokes are computed from the glyph's own clock rather than simulated, so scrubbing back
    // replays exactly the same field and the cost is one Graphics clear per frame.
    const field = view.field;
    if (field) {
        field.graphics.clear();
        const seed = hashTemperaSeed(view.shot.id);
        const rand = (glyphIndex: number, salt: number) => {
            const value = Math.sin((glyphIndex + 1) * 127.1 + salt * 311.7 + (seed % 997) * 0.618) * 43758.5453;
            return value - Math.floor(value);
        };
        const fx = overlapFx();
        const line = view.shot.slices[0]?.lineIndex ?? 0;
        const ticks = fx.fieldStyle === 'ticks'
            || (fx.fieldStyle === 'mixed' && temperaHash01(line, 0, 397) < 0.5);
        view.glyphs.forEach((glyph, glyphIndex) => {
            const age = time - glyph.motion.startTime;
            if (ticks) {
                const duration = Math.max(0.12, glyph.motion.endTime - glyph.motion.startTime);
                const release = 0.28 * Math.sqrt(160 / fx.fieldSpeed);
                if (age < 0 || age > duration + release + 0.08) return;
                const angle = glyph.display.rotation;
                const ux = Math.cos(angle), uy = Math.sin(angle);
                const size = Math.max(8, glyph.display.height);
                for (let i = 0; i < 4; i++) {
                    const delay = i * 0.025;
                    const amount = easeTemperaInOut(clamp01(Math.min(
                        (age - delay) / 0.12, (duration + delay + release - age) / release,
                    )));
                    if (amount <= 0) continue;
                    const across = (i - 1.5) * size * 0.14;
                    const lift = size * 0.6;
                    const x = glyph.display.x + ux * across + uy * lift;
                    const y = glyph.display.y + uy * across - ux * lift;
                    const lean = -across * amount * fx.fieldStrength * 0.65;
                    const length = fx.fieldLength * (i % 2 ? 0.75 : 1.15);
                    field.graphics.moveTo(x, y)
                        .lineTo(x + ux * lean + uy * length, y + uy * lean - ux * length)
                        .stroke({width: 1.3, color: glyph.fill, alpha: amount * glyph.display.alpha * 0.8, cap: 'round'});
                }
                return;
            }
            if (age < 0 || age > 0.62) return;
            const size = Math.max(glyph.display.width, glyph.display.height, 8);
            // Wind, not sparks: every character is combed by a gust that enters at its left
            // and leaves to the right. Three hairs per character, each with its own small
            // delay, height and tilt, so the line reads as air moving across it rather than
            // as a burst around each glyph.
            const strength = overlapFx().fieldStrength;
            // Two open arcs briefly cradle the first and last glyph of a wind-swept line.
            // Both directions use the same path, sampled directly from playback time.
            if (glyphIndex === 0 || glyphIndex === view.glyphs.length - 1) {
                const phase = clamp01(Math.min(age / 0.18, (0.62 - age) / 0.24));
                const sweep = phase * (2 - phase) * 0.86;
                const radius = size * 0.61 + 3;
                for (const side of [-1, 1]) {
                    const angle = glyph.display.rotation + side * Math.PI / 2;
                    field.graphics.moveTo(glyph.display.x + radius * Math.cos(angle - sweep),
                        glyph.display.y + radius * Math.sin(angle - sweep))
                        .arc(glyph.display.x, glyph.display.y, radius, angle - sweep, angle + sweep)
                        .stroke({width: 1.4, color: glyph.fill,
                            alpha: Math.min(0.7, strength * 0.58) * phase * glyph.display.alpha, cap: 'round'});
                }
            }
            const hairs = Math.max(1, Math.round(3 * strength));
            const speedScale = overlapFx().fieldSpeed / 160;
            const lengthScale = overlapFx().fieldLength / 9;
            const alphaScale = Math.min(1.5, 0.9 * strength);
            for (let k = 0; k < hairs; k += 1) {
                const delay = rand(glyphIndex, 61 + k) * 0.16;
                const gust = age - delay;
                if (gust < 0 || gust > 0.46) continue;
                const progress = clamp01(gust / 0.46);
                const fade = (1 - progress) * (1 - progress);
                const appear = clamp01(gust / 0.045);
                const speed = (95 + rand(glyphIndex, 71 + k) * 130) * speedScale;
                const startX = glyph.display.x - size * 0.62 - 4;
                const lift = (rand(glyphIndex, 81 + k) - 0.5) * size * 0.95;
                const flutter = Math.sin(gust * 15 + rand(glyphIndex, 91 + k) * 6.28) * 1.3;
                const x = startX + speed * gust;
                const y = glyph.display.y + lift + flutter;
                const tilt = (rand(glyphIndex, 101 + k) - 0.5) * 0.5;
                const length = (5 + rand(glyphIndex, 111 + k) * 11) * lengthScale;
                const alpha = alphaScale * fade * appear * clamp01(glyph.display.alpha);
                if (alpha <= 0.004) continue;
                field.graphics
                    .moveTo(x, y)
                    .lineTo(x + Math.cos(tilt) * length, y + Math.sin(tilt) * length)
                    .stroke({
                        width: 1.2,
                        color: glyph.fill,
                        alpha,
                        cap: 'round',
                    });
            }
        });
    }

    if (fixedCamera && view.kinetic) {
        const shotSpan = Math.max(0.01, view.shot.endTime - view.shot.startTime);
        const stageProgress = clamp01((time - view.shot.startTime) / shotSpan);
        const impactPulse = time >= view.shot.startTime
            ? Math.pow(Math.max(0, 1 - (time - view.shot.startTime) / 0.55), 2)
            : 0;
        const kineticGlyphs = view.glyphs.map((glyph, index) => {
            const scaleX = glyph.display.scale.x;
            const scaleY = glyph.display.scale.y;
            const ink = glyph.flashBoxRect;
            return {
                x: glyph.display.x,
                y: glyph.display.y,
                width: ink?.width ?? (Math.abs(scaleX) > 0.001 ? glyph.display.width / Math.abs(scaleX) : glyph.display.width),
                height: ink?.height ?? (Math.abs(scaleY) > 0.001 ? glyph.display.height / Math.abs(scaleY) : glyph.display.height),
                alpha: glyph.display.alpha,
                scaleX,
                scaleY,
                color: glyph.fill,
                rotation: glyph.motion.rotation + glyph.motion.enterRotation,
                finalX: glyph.baseX,
                finalY: glyph.baseY,
                finalRotation: glyph.motion.rotation,
                startTime: glyph.motion.startTime,
                endTime: glyph.motion.endTime,
                settleTime: glyph.motion.settleTime,
                enterX: glyph.motion.enterX,
                enterY: glyph.motion.enterY,
                keyword: !!glyph.keyword,
                rowIndex: glyph.rowIndex,
                index,
            };
        });
        // 几何层自己的出现概率：每句独立抽取，不再借用文字入场闪烁的抽取结果。
        const kineticOn = temperaHash01(flashSeed, 0, 1907) < wenflashKineticChance();
        // 出现后，出入场闪烁与文字共用同一组闪烁参数：次数/窗口/暗拍比例/暗拍亮度。
        const kineticEntryAge = time - view.shot.startTime;
        const kineticExitAge = time - exitAt;
        const kineticEntryPhase = kineticEntryAge * (flashCount / flashWindow);
        const kineticExitPhase = kineticExitAge * (flashCount / flashWindow);
        const kineticEntryOn = kineticOn && kineticEntryAge >= 0 && kineticEntryAge < flashWindow;
        const kineticExitOn = kineticOn && kineticExitAge >= 0 && kineticExitAge < flashWindow;
        const kineticEntryAlpha = kineticEntryOn ? (kineticEntryPhase % 1 >= flashDark ? 1 : flashDim) : 1;
        const kineticExitAlpha = kineticExitOn ? (kineticExitPhase % 1 >= flashDark ? 1 : flashDim) : 1;
        view.kinetic.update(
            time,
            kineticGlyphs,
            stageProgress,
            enter,
            exit,
            impactPulse,
            wenflashKineticDecor() && kineticOn ? 0.78 : 0,
            wenflashKineticDensity(),
            wenflashKineticSpeed(),
            kineticEntryAlpha * kineticExitAlpha,
        );
    }
};
