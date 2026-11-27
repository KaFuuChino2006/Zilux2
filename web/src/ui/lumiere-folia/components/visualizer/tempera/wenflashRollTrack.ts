import { isTemperaLayoutSegment, resolveLineEntranceRotation } from './temperaLayout';
import { hashTemperaSeed } from './temperaRandom';
import type { TemperaProgram } from './types';

interface Key { time: number; angle: number; start?: number; earliestStart?: number }

export function buildWenflashRollTrack(program: TemperaProgram, strength: number, overlap = 0): Key[] {
    const keys: Key[] = [{time: 0, angle: 0}];
    let end = 0;
    for (const paragraph of program.paragraphs) {
        const seed = hashTemperaSeed(`${program.seed}:${paragraph.id}`);
        const lines = new Map(paragraph.lines.map(line => [line.sourceIndex, line]));
        paragraph.shots.forEach((shot, index) => {
            let localLine = 0;
            for (const slice of shot.slices) {
                const segments = lines.get(slice.lineIndex)?.segments.slice(slice.segmentStart, slice.segmentEnd);
                const sung = segments?.filter(isTemperaLayoutSegment);
                if (!sung?.length) continue;
                const start = sung[0].startTime;
                const finish = Math.max(start, ...sung.map(segment => segment.endTime));
                const angle = resolveLineEntranceRotation(seed + index*97, localLine, Math.abs(strength)) * Math.sign(strength);
                const lead = keys.length > 1 ? overlap : 0;
                keys.push({start: Math.max(0, start-lead), time: start + (finish-start)*.9, angle});
                localLine++;
                end = Math.max(end, finish);
            }
        });
    }
    if (end > 0) keys.push({start: end, time: end + .5, angle: 0});
    keys.sort((a,b) => a.time-b.time);
    const track: Key[] = [];
    for (const key of keys) {
        if (track.at(-1)?.time === key.time) track.pop();
        const previous = track.at(-1)?.angle ?? 0;
        const delta = key.angle-previous;
        track.push({...key, angle: previous + .5*Math.atan2(Math.sin(2*delta), Math.cos(2*delta))});
    }
    // End times are sorted; nested or overlapping lines can have unordered starts.
    let earliest = Infinity;
    for (let i = track.length-1; i >= 0; i--) {
        earliest = Math.min(earliest, track[i].start ?? track[i].time);
        track[i].earliestStart = earliest;
    }
    return track;
}

export function sampleWenflashRoll(track: Key[], time: number): number {
    let lo = 0, hi = track.length-1;
    while (lo < hi) {
        const mid = Math.ceil((lo+hi)/2);
        if (track[mid].time <= time) lo = mid;
        else hi = mid-1;
    }
    // Finished turns collapse to one angle. Each ongoing turn contributes its
    // eased displacement independently, including turns that start before it ends.
    let angle = track[lo].angle;
    for (let i = lo+1; i < track.length; i++) {
        const key = track[i];
        if ((key.earliestStart ?? key.time) >= time) break;
        const start = key.start ?? key.time;
        if (time <= start) continue;
        const t = (time-start)/(key.time-start);
        angle += (key.angle-track[i-1].angle)*t*t*(3-2*t);
    }
    return angle;
}
