import type * as pixi from 'pixi.js';
import type { TemperaTuning } from '../../../types';
import { createSonnetPostProcessFilters } from '../sonnet/sonnetPostProcess';
import { resolveTemperaPassResolution } from './temperaSceneFilters';

// src/components/visualizer/tempera/temperaOverlapPrint.ts
// 重合 owns the camera, so the scene container itself travels, turns and scales. A per-scene
// print pass would inherit that transform and drag the vignette and lens bend across the frame
// with the lyric - exactly what a real lens does not do. This builds the same sonnet chain the
// flow stage uses, once, for an untransformed screen-space parent: the paper stays still while
// the type moves across it.
export const createTemperaOverlapPrintFilters = (
    pixiNamespace: typeof import('pixi.js'),
    tuning: TemperaTuning,
    seed: number,
    renderResolution: number,
): import('pixi.js').Filter[] => {
    const filters = createSonnetPostProcessFilters(pixiNamespace, {
        lensDistortion: tuning.postProcessLensDistortion,
        lensDispersion: 0,
        noise: tuning.postProcessGrain * 0.35,
        contrast: tuning.postProcessContrast * 0.5,
        printEffects: {
            rgbShift: tuning.postProcessRgbShift,
            halftone: 0,
            vignette: tuning.postProcessVignette,
        },
    }, seed);
    const resolution = resolveTemperaPassResolution(tuning, renderResolution);
    filters.forEach(filter => {
        filter.resolution = resolution;
    });
    return filters;
};

void (0 as unknown as typeof pixi);
