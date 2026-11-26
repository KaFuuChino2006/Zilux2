import { overlapFx } from '../../../../overlapSettings';
type PixiModule = typeof import('pixi.js');

// src/components/visualizer/tempera/temperaOverlapWave.ts
// A continuous trace along the foot of the frame. Its amplitude rides the density of the line
// being sung: dense runs lift it, an instrumental stretch lets it settle flat. It is a reading
// of the voice, not a second lyric, so it never takes the type's colour.

export interface OverlapWaveState {
    time: number;
    /** 0..1, how many characters are landing per second under the playhead. */
    energy: number;
}

export interface TemperaOverlapWave {
    container: import('pixi.js').Container;
    update: (state: OverlapWaveState, dt: number) => void;
    resize: (width: number, height: number) => void;
    setAccent: (accent: string) => void;
    destroy: () => void;
}

export const createTemperaOverlapWave = (
    pixi: PixiModule,
    width: number,
    height: number,
    accent: string,
): TemperaOverlapWave => {
    const container = new pixi.Container();
    const graphics = new pixi.Graphics();
    container.addChild(graphics);
    container.eventMode = 'none';

    let viewWidth = width;
    let viewHeight = height;
    let accentHex = accent;
    let smoothed = 0;

    return {
        container,
        update: (state, dt) => {
            const fx = overlapFx();
            container.visible = fx.showWave && fx.decorAlpha > 0.005;
            if (!container.visible) {
                smoothed = 0;
                return;
            }
            const target = Math.min(1, Math.max(0, state.energy)) * fx.waveGain;
            const step = 1 - Math.exp(-Math.max(0, dt) / 0.22);
            smoothed += (target - smoothed) * step;
            graphics.clear();
            const baseY = viewHeight - 22;
            const amplitude = 2 + 26 * smoothed;
            const alpha = (0.16 + 0.34 * smoothed) * fx.decorAlpha;
            const stepX = 8;
            for (let x = 0; x <= viewWidth; x += stepX) {
                const phase = x * 0.011 + state.time * 2.1;
                const ripple = Math.sin(phase) * 0.62 + Math.sin(x * 0.029 - state.time * 1.55) * 0.38;
                const y = baseY + ripple * amplitude;
                if (x === 0) graphics.moveTo(x, y);
                else graphics.lineTo(x, y);
            }
            graphics.stroke({width: 1.3, color: accentHex, alpha});
        },
        resize: (nextWidth, nextHeight) => {
            viewWidth = nextWidth;
            viewHeight = nextHeight;
        },
        setAccent: (next) => {
            accentHex = next;
        },
        destroy: () => {
            graphics.destroy();
            container.destroy();
        },
    };
};
