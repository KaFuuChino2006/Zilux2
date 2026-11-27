import type { Graphics } from 'pixi.js';
import type { TemperaGlyphView } from './temperaTextView';
import { clamp01 } from './temperaMotion';

interface ScoreCell {
    start: number;
    end: number;
    color: string;
}

/** A small proof mark in the phrase margin. Its cells advance on real lyric onsets. */
export interface PhraseScore {
    pen: Graphics;
    cells: ScoreCell[];
    unit: number;
    length: number;
    color: string;
}

export function buildPhraseScore(
    pen: Graphics, glyphs: TemperaGlyphView[],
    rect: {x: number; y: number; width: number; height: number},
    fontSize: number, vertical: boolean,
): PhraseScore {
    const ordered = [...glyphs].sort((a, b) => a.motion.startTime - b.motion.startTime);
    const count = Math.min(8, ordered.length);
    const cells: ScoreCell[] = [];
    for (let i = 0; i < count; i++) {
        const first = ordered[Math.floor(i * ordered.length / count)];
        const last = ordered[Math.floor((i + 1) * ordered.length / count) - 1];
        cells.push({start: first.motion.startTime, end: last.motion.endTime, color: first.fill});
    }
    const unit = Math.max(1.4, Math.min(6, fontSize * 0.045));
    const length = Math.max(16 * unit, Math.min(39 * unit, vertical ? rect.height : rect.width));
    // The horizontal tag sits above the last part of the phrase. Turn the same mark
    // into the right margin of a vertical phrase, in the direction the words are read.
    if (vertical) {
        pen.position.set(rect.x + rect.width + 7 * unit, rect.y);
        pen.rotation = Math.PI / 2;
    } else {
        pen.position.set(rect.x + rect.width - length, rect.y - 7 * unit);
    }
    pen.visible = false;
    return {pen, cells, unit, length, color: ordered[0].fill};
}

export function drawPhraseScore(
    score: PhraseScore, time: number, exitAt: number, flashWindow: number, intensity: number,
    flashCount = 4, flashDark = 0.45, flashDim = 0.05,
) {
    const {pen, cells, unit, length, color} = score;
    const start = cells[0].start;
    const entryAge = time - start;
    const exitAge = time - exitAt;
    const t = clamp01(entryAge / 0.25);
    const reveal = t * t * (3 - 2 * t);
    // The score mark shares the lyric flash rhythm: the same number of beats in the same
    // window, dark beats dimmed to the same level. It flashes in on the first onset and
    // flashes out from the phrase's real exit time, then disappears at the end of the window.
    const flashPhase = (age: number) => age * Math.max(1, flashCount) / Math.max(0.05, flashWindow);
    const entryLit = flashPhase(entryAge) % 1 >= flashDark;
    const exitLit = flashPhase(exitAge) % 1 >= flashDark;
    const entryFlash = entryAge < 0 ? 0 : entryAge < flashWindow ? (entryLit ? 1 : flashDim) : 1;
    const exitFlash = exitAge < 0 ? 1 : exitAge < flashWindow ? (exitLit ? 1 : flashDim) : 0;
    pen.visible = intensity > 0.001 && entryAge >= 0 && reveal > 0.002 && exitFlash > 0.001;
    if (!pen.visible) return;
    pen.alpha = intensity * reveal * entryFlash * exitFlash;
    pen.clear();
    const tip = length * reveal;
    const cap = Math.min(3 * unit, tip);
    // A clipped ink tab registers the start. An open rail and its timing cells read
    // as one mark; the trailing bevel closes backwards over them at phrase end.
    pen.poly([0,0, cap,0, Math.max(0,cap-unit),3*unit, 0,3*unit]).fill({color});
    pen.moveTo(0, -1.25 * unit).lineTo(tip, -1.25 * unit)
        .stroke({color, width: Math.max(1, unit * 0.32), alpha: 0.72});
    const offset = 4.5 * unit;
    const stride = (length - offset) / cells.length;
    for (let i = 0; i < cells.length; i++) {
        const x = offset + i * stride;
        const width = Math.min(stride * 0.82, tip - x);
        if (width <= 0) break;
        const cell = cells[i];
        const progress = clamp01((time - cell.start) / Math.max(0.06, cell.end - cell.start));
        pen.rect(x, 0, width, 2.4 * unit).fill({color: cell.color, alpha: 0.2});
        if (progress > 0) {
            pen.rect(x, 0, Math.min(width, stride * 0.82 * progress), 2.4 * unit)
                .fill({color: cell.color, alpha: 0.88});
        }
    }
}
