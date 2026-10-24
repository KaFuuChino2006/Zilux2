// Zilux2 自研：纯字档的背景光柱。
//
// 纯字档（textOnly）不再使用 folia 光位目录里的光束——那是为绘光舞台的星空、线稿、运镜与竖排/交叉
// 排版设计的，搬到「只有大字」的纯字舞台上，光柱的落点与摆动都对不上。这里自己布置一份固定的光柱构图：
//   - 六根（与光场一次能画的上限 MAX_BEAMS 同量）：中间三根主光柱从上方落到字后，两翼各一根大张角的
//     柔光扇，最后一道宽幅顶光铺在画面顶部；
//   - 位置固定，只由时间做缓慢摆动与呼吸（各根的周期互不相等，看不出循环），低频把光柱抬亮；
//   - 「文字设置 → 背景光柱」里的粗细 / 左右 / 上下微调仍在这里乘进去。
// 返回的是光场与字照明共用的 ResolvedBeam（与 folia 的 resolveBeams 同一套公式），所以光柱扫到哪里，
// 哪里的字就亮，与绘光其它画面对齐。
import type { Rgb } from '../color';
import { MAX_BEAMS, resolveBeams, type BeamSpec, type LightRig, type ResolvedBeam } from './rig';

/** 纯字档一次显示的光柱根数：与光场上限一致（迁移前每套光位最多也画这么多）。 */
export const TEXT_BEAM_COUNT = MAX_BEAMS;

const DOWN = Math.PI / 2;

/**
 * 光柱构图（画面比例：x 占宽、y 占高，y 向下为正；角度 π/2 = 竖直向下）。
 * 中间三根略向内收，让光落在文字区里；两翼的柔光扇向外张开，撑开画面的气氛；
 * 最后一道宽幅顶光短而宽，只提亮画面上缘。
 */
const COMPOSITION: BeamSpec[] = [
    // 1. 主光柱：正中、最亮，轻微呼吸
    {
        x: 0.5, y: -0.06, angle: DOWN, spread: 0.05, width: 0.075, length: 1.35, softness: 0.8,
        intensity: 0.95, streaks: 0.28, streakFreq: 4, streakSpeed: 0.05, core: 0.72,
        sway: { amplitude: 0.012, period: 15.7, phase: 0 },
        pulse: { amplitude: 0.06, period: 5.6, phase: 0.1 },
    },
    // 2. 左内柱：略向右收，落在文字区左侧
    {
        x: 0.365, y: -0.06, angle: DOWN + 0.06, spread: 0.045, width: 0.055, length: 1.3, softness: 0.85,
        intensity: 0.6, streaks: 0.34, streakFreq: 4.6, streakSpeed: 0.04, core: 0.6,
        sway: { amplitude: 0.02, period: 11.3, phase: 0.35 },
        pulse: { amplitude: 0.05, period: 6.7, phase: 0.4 },
    },
    // 3. 右内柱：与左内柱对称
    {
        x: 0.635, y: -0.06, angle: DOWN - 0.06, spread: 0.045, width: 0.055, length: 1.3, softness: 0.85,
        intensity: 0.56, streaks: 0.34, streakFreq: 4.6, streakSpeed: 0.04, core: 0.6,
        sway: { amplitude: 0.018, period: 13.1, phase: 0.7 },
        pulse: { amplitude: 0.05, period: 7.4, phase: 0.15 },
    },
    // 4. 左翼柔光扇：大张角、很软，只撑气氛
    {
        x: 0.17, y: -0.08, angle: DOWN + 0.17, spread: 0.24, width: 0.02, length: 1.45, softness: 0.95,
        intensity: 0.26, streaks: 0.55, streakFreq: 7.5, streakSpeed: 0.03, core: 0.35,
        sway: { amplitude: 0.03, period: 19.1, phase: 0.2 },
        pulse: { amplitude: 0.08, period: 9.3, phase: 0.6 },
    },
    // 5. 右翼柔光扇：与左翼对称
    {
        x: 0.83, y: -0.08, angle: DOWN - 0.17, spread: 0.24, width: 0.02, length: 1.45, softness: 0.95,
        intensity: 0.24, streaks: 0.55, streakFreq: 7.5, streakSpeed: 0.03, core: 0.35,
        sway: { amplitude: 0.03, period: 17.3, phase: 0.55 },
        pulse: { amplitude: 0.08, period: 8.7, phase: 0.25 },
    },
    // 6. 宽幅顶光：短而宽，只提亮画面上缘，不落到字上
    {
        x: 0.5, y: -0.1, angle: DOWN, spread: 0.78, width: 0.3, length: 0.8, softness: 1,
        intensity: 0.2, streaks: 0.75, streakFreq: 12, streakSpeed: 0.02, core: 0.25,
        sway: { amplitude: 0.006, period: 23.1, phase: 0.1 },
        pulse: { amplitude: 0.05, period: 11.7, phase: 0.5 },
    },
];

/** 只借用光束解析的空光位：纯字档的雾与眩光另有来处，不从这里取。 */
const SHELL: LightRig = {
    beams: COMPOSITION,
    fog: { density: 0, tyndallBase: 0, scale: 1, driftX: 0, driftY: 0, warp: 0, ambient: 0 },
    glare: null,
};

export interface TextBeamFrame {
    /** 单元内的秒数。 */
    time: number;
    /** 画面宽高比（宽 / 高）。 */
    aspect: number;
    /** 光色（主题解出的光色，0..1）。 */
    color: Rgb;
    /** 整体亮度（进场 / 退场、光强倍率）。 */
    intensity: number;
    /** 低频 0..1（已乘过音频响应）。 */
    bass: number;
    /** 「背景光柱」的粗细倍数。 */
    scale: number;
    /** 左右偏移（按画面宽的比例）。 */
    offsetX: number;
    /** 上下偏移（按画面高的比例）。 */
    offsetY: number;
}

/** 解析某一时刻的纯字光柱（做长度呼吸与粗细/位置微调）。 */
export const resolveTextBeams = (frame: TextBeamFrame): ResolvedBeam[] => {
    const beams = resolveBeams(SHELL, frame.time, frame.aspect, {
        intensity: frame.intensity,
        // 低频稍微放大：纯字档没有别的画面在动，重拍时让光柱更明显地抬一下。
        bass: Math.min(1, frame.bass * 1.35),
        color: frame.color,
    });
    const scale = Math.max(0.2, frame.scale);
    const shiftX = frame.offsetX * frame.aspect;
    const shiftY = frame.offsetY;
    return beams.map((beam, index) => {
        // 长度呼吸：每根光柱以各自的相位轻微伸缩（±3%），看起来像光在缓慢流动。
        const breath = 1 + 0.03 * Math.sin(frame.time * 0.62 + index * 1.37);
        return {
            ...beam,
            ox: beam.ox + shiftX,
            oy: beam.oy + shiftY,
            halfWidth: beam.halfWidth * scale,
            tanSpread: beam.tanSpread * scale,
            length: beam.length * scale * breath,
        };
    });
};
