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

// @note Version Control: Project Folia version 0.6.13-750617

// src/components/visualizer/tempera/temperaShotFrame.ts
// 单个 shot 的逐帧姿态：镜头位移与呼吸、shot 之间的推入推出交接、图形与图片层时间、逐字运动。
// 只按绝对播放时间写 view，不持有状态。

const resolveAnimationScale = (theme: Theme) => (
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
    const drive = blow;
    const distance = height * (drift * 0.5 + rand(53) * drift) * drive
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
        alpha: style === 4
            ? (() => {
                // One blink step is a fixed 50ms, so the rate never depends on the exit length:
                // a longer 退场 keeps blinking at the same speed, just for more steps.
                const steps = Math.max(2, Math.floor(exitDuration / 0.05));
                const step = Math.min(steps - 1, Math.floor(exit * steps));
                const coolAt = Math.floor(steps * 0.5);
                // 前半段满亮闪，收尾只留两次半亮的余闪（亮 灭 亮 灭），然后就黑掉。
                if (step < coolAt) return step % 2 === 0 ? 1 : 0;
                const coolStep = step - coolAt;
                if (coolStep < 4) return coolStep % 2 === 0 ? 0.5 : 0;
                return 0;
            })()
            : 1 - blow,
        ...(style === 5 ? {scaleY: 1 - 0.95 * blow} : {}),
        depart: blow,
    };
};

const focusHold = 0.55;

export const updateTemperaShot = (
    view: TemperaShotView,
    time: number,
    width: number,
    height: number,
    tuning: TemperaTuning,
    theme: Theme,
    follow: {x: number; y: number} = {x: 0, y: 0},
    rackFocus = false,
) => {
    const duration = Math.max(view.shot.endTime - view.shot.startTime, 0.001);
    const rawProgress = (time - view.shot.startTime) / duration;
    const animationScale = resolveAnimationScale(theme);
    const camera = tuning.cameraIntensity * animationScale;
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
    const exitTravel = held || rotationOnly ? 0 : exit * span * 0.55 * camera;
    // Where the plate itself sits this frame, before the entrance/exit/parallax offsets. The
    // follow camera adds this to the line's anchor: the glyph layout is fixed, but the shot's
    // own camera path and breathing keep moving the type inside the plate, so without this
    // term a line that pans while it is sung slides away from the centre of the frame.
    view.frameX = frame.x * width * camera;
    view.frameY = frame.y * height * camera;
    // A retained line sits behind the live one: when the shared camera slides, it travels a
    // quarter of the distance, which reads as depth instead of one flat plate moving.
    const parallaxX = held ? -follow.x * 0.25 : 0;
    const parallaxY = held ? -follow.y * 0.25 : 0;
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
    view.container.alpha = held
        ? 1 - overlapFx().holdFade * waitFade
        : 1 - exit;
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

    // Sung words start to soften as soon as they are sung, and keep softening while the line
    // waits. Slow ramp on purpose: it should read as ink drying, not as a focus pull.
    const blurFrom = view.shot.lyricEndTime;
    const blurProgress = clamp01((time - blurFrom) / 1.6);
    const lineBlur = blurProgress * blurProgress * (3 - 2 * blurProgress);
    const ghostCenter = {x: 0, y: 0};
    const ghostSeed = held ? hashTemperaSeed(view.shot.id) : 0;
    if (held && view.glyphs.length > 0) {
        for (const glyph of view.glyphs) {
            ghostCenter.x += glyph.baseX;
            ghostCenter.y += glyph.baseY;
        }
        ghostCenter.x /= view.glyphs.length;
        ghostCenter.y /= view.glyphs.length;
    }
    view.specks?.clear();
    view.glyphs.forEach((glyph, index) => {
        const glyphFrame = resolveTemperaGlyphMotion(glyph.motion, time, motion);
        const order = view.glyphs.length > 1 ? index / (view.glyphs.length - 1) : 0;
        const ghost = held
            ? resolveGhostDrift(
                ghostSeed, ghostCenter.x, ghostCenter.y, glyph, index, order,
                time, view.shot.lyricEndTime, height, exitProgress,
                held ? resolveHeldExitDuration(view) : resolveShotHandoff(view),
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
        const ghostAlpha = ghost?.alpha ?? 1;
        const ghostScale = ghost?.scale ?? 1;
        const ghostScaleY = ghost?.scaleY ?? ghostScale;
        // Each character lands as wet ink: it blooms in slightly out of focus and sharpens
        // over 0.42s, then the sung-line blur takes over. One pulse at the onset makes the
        // reveal read as a stroke being written rather than opacity being switched on.
        const revealProgress = clamp01((time - glyph.motion.startTime) / 0.42);
        const revealBlur = 1 - revealProgress * revealProgress * (3 - 2 * revealProgress);
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
        glyph.display.visible = glyphFrame.visible;
        glyph.display.position.set(x, y);
        glyph.display.scale.set(scaleX, scaleY);
        glyph.display.rotation = rotation;
        if (glyph.sungBlur) {
            const fade = clamp01((time - glyph.motion.endTime) / 1.2);
            glyph.display.alpha = glyphFrame.alpha * ghostAlpha
                * (1 - overlapFx().ghostBlur * fade * fade * (3 - 2 * fade));
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
            const rack = rackFocus ? Math.max(incoming, outgoing) : 0;
            const strength = maximum * Math.max(lineBlur, revealBlur, rack * overlapFx().rackFocus);
            if (strength > 0 && !sung.filter) sung.filter = sung.create();
            const filter = sung.filter;
            if (filter && filter.strength !== strength) {
                const wasClear = filter.strength === 0;
                filter.strength = strength;
                if (strength === 0) glyph.display.filters = null;
                else if (wasClear) glyph.display.filters = [filter];
            }
        }
        if (glyph.glow) {
            // The halo ramps with the word itself: silent until the first stroke, then up over
            // 0.7s with a slow breathing pulse, so a keyword arrives as a light being turned on
            // rather than a colour swap.
            const rise = held ? Math.min(0.32, Math.max(0.08, glyph.motion.endTime - glyph.motion.startTime)) : 0.7;
            const ramp = clamp01((time - glyph.motion.startTime) / rise);
            const eased = ramp * ramp * (3 - 2 * ramp);
            const breathe = 1 + 0.07 * Math.sin((time - glyph.motion.startTime) * 3.1);
            const gain = overlapFx().keywordGlow;
            const halo = glyph.glow;
            const release = held ? clamp01((time - Math.max(glyph.motion.endTime, glyph.motion.startTime + rise)) / 0.55) : 0;
            const light = eased * (1 - release * release * (3 - 2 * release)) * gain;
            if (held) glyph.display.tint = mixColors(glyph.fill, '#ffffff', clamp01(light * 1.4));
            const alpha = (held ? 1 : 0.72) * light * breathe * glyph.display.alpha * (glyphFrame.visible ? 1 : 0);
            halo.display.visible = alpha > 0.004 && !glyph.masked;
            if (halo.display.visible) {
                halo.display.alpha = Math.min(1, alpha);
                halo.display.position.set(x, y);
                halo.display.scale.set(scaleX * 1.015, scaleY * 1.015);
                halo.display.rotation = rotation;
                if (!halo.filter) {
                    halo.filter = halo.create();
                    halo.display.filters = [halo.filter];
                }
                const strength = halo.maximum * (0.25 + 0.75 * eased);
                if (halo.filter.strength !== strength) halo.filter.strength = strength;
            }
        }
        if (glyph.shadow) {
            glyph.shadow.alpha = glyphFrame.alpha * ghostAlpha * 0.34;
            glyph.shadow.visible = glyphFrame.visible && !glyph.masked;
            glyph.shadow.position.set(x + glyph.shadowDX, y + glyph.shadowDY);
            glyph.shadow.scale.set(scaleX, scaleY);
            glyph.shadow.rotation = rotation;
        }
        // Echoes trail further back along the entrance vector the deeper they sit; once the
        // line is retained the same echoes carry the wet-ink trail instead.
        const echoVisible = glyphFrame.visible && !glyph.masked
            && (glyphFrame.echoAlpha > 0.004 || trailInk > 0.004);
        glyph.echoes.forEach((echo, echoIndex) => {
            echo.visible = echoVisible;
            if (!echoVisible) return;
            const depth = 1 + echoIndex * 0.85;
            echo.alpha = Math.max(
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
};
