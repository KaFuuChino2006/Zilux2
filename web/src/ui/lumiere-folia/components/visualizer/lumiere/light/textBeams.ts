// Zilux2 自研：纯字档的背景光柱与大气。
//
// 纯字档（textOnly）不再使用 folia 光位目录里的光束——那是为绘光舞台的星空、线稿、运镜与竖排/交叉
// 排版设计的，搬到「只有大字」的纯字舞台上，光柱的落点与摆动都对不上。这里自己布置几套固定的光柱构图
// （「文字设置 → 光柱效果」里选）：静光 / 缓息 / 流幕 / 聚光，每套最多与光场上限同量（MAX_BEAMS）根。
//
// 动画全部走一条 32 秒的无缝循环：所有摆动、明暗呼吸的周期都是循环时长的整数分之一，循环接缝看不出来；
// 时钟用墙钟而不是播放进度，所以拖动进度、重播、换歌都不会让光柱跳变（也就不会再看到「头尾的变化」）。
// 雾（大气）同样改成一个固定光位 + 42 秒来回漂移的无缝循环，不再跟着 folia 镜头切换变参数。
//
// 返回的是光场与字照明共用的 ResolvedBeam（与 folia 的 resolveBeams 同一套公式），所以光柱扫到哪里，
// 哪里的字就亮，与绘光其它画面对齐。
import type { Rgb } from '../color';
import type { TextBeamStyle } from '../types';
import { MAX_BEAMS, resolveBeams, type BeamSpec, type LightRig, type ResolvedBeam } from './rig';

/** 纯字档一次显示的光柱根数上限：与光场上限一致（迁移前每套光位最多也画这么多）。 */
export const TEXT_BEAM_COUNT = MAX_BEAMS;

/** 光柱动画的无缝循环长度（秒）。 */
const LOOP = 32;
const TAU = Math.PI * 2;
const DOWN = Math.PI / 2;

/** 循环时钟：墙钟而不是播放进度，拖动进度 / 重播 / 换歌都不会让光柱跳变。 */
export const textClock = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now()) / 1000;

/** 循环内的相位 0..2π。 */
const loopPhase = (time: number, harmonic = 1): number => ((time % LOOP) / LOOP) * TAU * harmonic;

/** 周期必须是 LOOP 的整数分之一，这样 sin 在 LOOP 处正好走完整数圈。 */
const loopPeriod = (harmonic: number): number => LOOP / harmonic;

/** 光柱样式选择项（面板用）。 */
export const TEXT_BEAM_STYLES: Array<{ id: TextBeamStyle; label: string }> = [
    { id: 'calm', label: '静光' },
    { id: 'breathe', label: '缓息' },
    { id: 'curtain', label: '流幕' },
    { id: 'focus', label: '聚光' },
];

/** 静光：六根固定构图，垂直落字，轻微摆动——最接近迁移前的观感，但位置是重新排过的。 */
const CALM: BeamSpec[] = [
    // 1. 主光柱：正中、最亮，轻微呼吸
    {
        x: 0.5, y: -0.06, angle: DOWN, spread: 0.05, width: 0.075, length: 1.35, softness: 0.8,
        intensity: 0.95, streaks: 0.28, streakFreq: 4, streakSpeed: 0.05, core: 0.72,
        sway: { amplitude: 0.012, period: loopPeriod(2), phase: 0 },
        pulse: { amplitude: 0.06, period: loopPeriod(5), phase: 0.1 },
    },
    // 2. 左内柱：略向右收，落在文字区左侧
    {
        x: 0.365, y: -0.06, angle: DOWN + 0.06, spread: 0.045, width: 0.055, length: 1.3, softness: 0.85,
        intensity: 0.6, streaks: 0.34, streakFreq: 4.6, streakSpeed: 0.04, core: 0.6,
        sway: { amplitude: 0.02, period: loopPeriod(3), phase: 0.35 },
        pulse: { amplitude: 0.05, period: loopPeriod(6), phase: 0.4 },
    },
    // 3. 右内柱：与左内柱对称
    {
        x: 0.635, y: -0.06, angle: DOWN - 0.06, spread: 0.045, width: 0.055, length: 1.3, softness: 0.85,
        intensity: 0.56, streaks: 0.34, streakFreq: 4.6, streakSpeed: 0.04, core: 0.6,
        sway: { amplitude: 0.018, period: loopPeriod(4), phase: 0.7 },
        pulse: { amplitude: 0.05, period: loopPeriod(7), phase: 0.15 },
    },
    // 4. 左翼柔光扇：大张角、很软，只撑气氛
    {
        x: 0.17, y: -0.08, angle: DOWN + 0.17, spread: 0.24, width: 0.02, length: 1.45, softness: 0.95,
        intensity: 0.26, streaks: 0.55, streakFreq: 7.5, streakSpeed: 0.03, core: 0.35,
        sway: { amplitude: 0.03, period: loopPeriod(2), phase: 0.2 },
        pulse: { amplitude: 0.08, period: loopPeriod(5), phase: 0.6 },
    },
    // 5. 右翼柔光扇：与左翼对称
    {
        x: 0.83, y: -0.08, angle: DOWN - 0.17, spread: 0.24, width: 0.02, length: 1.45, softness: 0.95,
        intensity: 0.24, streaks: 0.55, streakFreq: 7.5, streakSpeed: 0.03, core: 0.35,
        sway: { amplitude: 0.03, period: loopPeriod(3), phase: 0.55 },
        pulse: { amplitude: 0.08, period: loopPeriod(4), phase: 0.25 },
    },
    // 6. 宽幅顶光：短而宽，只提亮画面上缘，不落到字上
    {
        x: 0.5, y: -0.1, angle: DOWN, spread: 0.78, width: 0.3, length: 0.8, softness: 1,
        intensity: 0.2, streaks: 0.75, streakFreq: 12, streakSpeed: 0.02, core: 0.25,
        sway: { amplitude: 0.006, period: loopPeriod(1), phase: 0.1 },
        pulse: { amplitude: 0.05, period: loopPeriod(6), phase: 0.5 },
    },
];

/** 缓息：光更少更柔，整组一起做很慢的明暗呼吸，像光在跟着呼吸。 */
const BREATHE: BeamSpec[] = [
    {
        x: 0.5, y: -0.08, angle: DOWN, spread: 0.09, width: 0.13, length: 1.4, softness: 0.9,
        intensity: 0.85, streaks: 0.2, streakFreq: 3.2, streakSpeed: 0.03, core: 0.55,
        sway: { amplitude: 0.008, period: loopPeriod(1), phase: 0 },
        pulse: { amplitude: 0.22, period: loopPeriod(1), phase: 0 },
    },
    {
        x: 0.31, y: -0.07, angle: DOWN + 0.09, spread: 0.06, width: 0.07, length: 1.32, softness: 0.9,
        intensity: 0.5, streaks: 0.25, streakFreq: 3.6, streakSpeed: 0.02, core: 0.45,
        sway: { amplitude: 0.012, period: loopPeriod(1), phase: 0.1 },
        pulse: { amplitude: 0.22, period: loopPeriod(1), phase: 0.02 },
    },
    {
        x: 0.69, y: -0.07, angle: DOWN - 0.09, spread: 0.06, width: 0.07, length: 1.32, softness: 0.9,
        intensity: 0.46, streaks: 0.25, streakFreq: 3.6, streakSpeed: 0.02, core: 0.45,
        sway: { amplitude: 0.012, period: loopPeriod(1), phase: 0.5 },
        pulse: { amplitude: 0.22, period: loopPeriod(1), phase: 0.05 },
    },
    {
        x: 0.5, y: -0.12, angle: DOWN, spread: 0.62, width: 0.34, length: 0.9, softness: 1,
        intensity: 0.22, streaks: 0.6, streakFreq: 10, streakSpeed: 0.01, core: 0.2,
        sway: { amplitude: 0.004, period: loopPeriod(1), phase: 0.3 },
        pulse: { amplitude: 0.18, period: loopPeriod(1), phase: 0.03 },
    },
];

/** 流幕：几幅大光幕缓慢左右扫，像极光/幕布，比光柱更宽更淡。 */
const CURTAIN: BeamSpec[] = [
    {
        x: 0.16, y: -0.1, angle: DOWN + 0.12, spread: 0.5, width: 0.16, length: 1.55, softness: 1,
        intensity: 0.22, streaks: 0.5, streakFreq: 8, streakSpeed: 0.02, core: 0.3,
        sway: { amplitude: 0.05, period: loopPeriod(1), phase: 0 },
        pulse: { amplitude: 0.08, period: loopPeriod(2), phase: 0.2 },
    },
    {
        x: 0.38, y: -0.1, angle: DOWN + 0.04, spread: 0.55, width: 0.2, length: 1.5, softness: 1,
        intensity: 0.26, streaks: 0.5, streakFreq: 8.5, streakSpeed: 0.02, core: 0.3,
        sway: { amplitude: 0.05, period: loopPeriod(1), phase: 0.25 },
        pulse: { amplitude: 0.08, period: loopPeriod(2), phase: 0.45 },
    },
    {
        x: 0.62, y: -0.1, angle: DOWN - 0.04, spread: 0.55, width: 0.2, length: 1.5, softness: 1,
        intensity: 0.26, streaks: 0.5, streakFreq: 8.5, streakSpeed: 0.02, core: 0.3,
        sway: { amplitude: 0.05, period: loopPeriod(1), phase: 0.5 },
        pulse: { amplitude: 0.08, period: loopPeriod(2), phase: 0.1 },
    },
    {
        x: 0.84, y: -0.1, angle: DOWN - 0.12, spread: 0.5, width: 0.16, length: 1.55, softness: 1,
        intensity: 0.22, streaks: 0.5, streakFreq: 8, streakSpeed: 0.02, core: 0.3,
        sway: { amplitude: 0.05, period: loopPeriod(1), phase: 0.75 },
        pulse: { amplitude: 0.08, period: loopPeriod(2), phase: 0.35 },
    },
    {
        x: 0.5, y: -0.13, angle: DOWN, spread: 0.72, width: 0.4, length: 0.7, softness: 1,
        intensity: 0.16, streaks: 0.65, streakFreq: 12, streakSpeed: 0.01, core: 0.2,
        sway: { amplitude: 0.02, period: loopPeriod(1), phase: 0.6 },
        pulse: { amplitude: 0.06, period: loopPeriod(3), phase: 0.5 },
    },
];

/** 聚光：中间一束很实的追光，两侧细光收边，几乎不动——静态、干净、焦点明确。 */
const FOCUS: BeamSpec[] = [
    {
        x: 0.5, y: -0.05, angle: DOWN, spread: 0.03, width: 0.1, length: 1.45, softness: 0.55,
        intensity: 1.05, streaks: 0.12, streakFreq: 2.6, streakSpeed: 0.02, core: 0.85,
        sway: { amplitude: 0.006, period: loopPeriod(1), phase: 0 },
        pulse: { amplitude: 0.05, period: loopPeriod(4), phase: 0 },
    },
    {
        x: 0.365, y: -0.06, angle: DOWN + 0.11, spread: 0.03, width: 0.028, length: 1.3, softness: 0.7,
        intensity: 0.5, streaks: 0.2, streakFreq: 4, streakSpeed: 0.02, core: 0.6,
        sway: { amplitude: 0.01, period: loopPeriod(2), phase: 0.15 },
        pulse: { amplitude: 0.05, period: loopPeriod(6), phase: 0.3 },
    },
    {
        x: 0.635, y: -0.06, angle: DOWN - 0.11, spread: 0.03, width: 0.028, length: 1.3, softness: 0.7,
        intensity: 0.46, streaks: 0.2, streakFreq: 4, streakSpeed: 0.02, core: 0.6,
        sway: { amplitude: 0.01, period: loopPeriod(2), phase: 0.65 },
        pulse: { amplitude: 0.05, period: loopPeriod(6), phase: 0.45 },
    },
    {
        x: 0.5, y: -0.12, angle: DOWN, spread: 0.5, width: 0.18, length: 0.85, softness: 1,
        intensity: 0.18, streaks: 0.55, streakFreq: 9, streakSpeed: 0.01, core: 0.2,
        sway: { amplitude: 0.004, period: loopPeriod(1), phase: 0.4 },
        pulse: { amplitude: 0.04, period: loopPeriod(3), phase: 0.2 },
    },
];

const STYLE_BEAMS: Record<TextBeamStyle, BeamSpec[]> = {
    calm: CALM,
    breathe: BREATHE,
    curtain: CURTAIN,
    focus: FOCUS,
};

/** 只借用光束解析的空光位：纯字档的雾由下面的 TEXT_FOG_RIG 提供。 */
const SHELL: LightRig = {
    beams: [],
    fog: { density: 0, tyndallBase: 0, scale: 1, driftX: 0, driftY: 0, warp: 0, ambient: 0 },
    glare: null,
};

/** 纯字档固定的大气（雾）光位：不再跟随 folia 镜头切换换参数（那会让雾出现明显的「头尾」突变）。 */
export const TEXT_FOG_RIG: LightRig = {
    beams: [],
    fog: { density: 0.95, tyndallBase: 0.35, scale: 2.0, driftX: 0, driftY: 0, warp: 0.3, ambient: 0.42 },
    glare: null,
};

/**
 * 纯字档雾的无缝循环：42 秒一轮。漂移不是单向平移，而是来回摆动（sin/cos），
 * 光场着色器里的雾漂移在循环模式下也走同样的正弦相位，所以接缝看不出来。
 */
export const TEXT_FOG_LOOP: { period: number; driftX: number; driftY: number } = {
    period: 42,
    driftX: 0.06,
    driftY: 0.075,
};

/** 光柱条纹在一个循环里走过的「噪声格数」：整数 → 循环首尾的条纹相位对得上（valueNoise 的周期是 1）。 */
const STREAK_LOOP_CYCLES = 2;

export interface TextBeamFrame {
    /** 循环时钟（秒）——见 textClock()。 */
    clock: number;
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
    /** 光柱样式（默认静光）。 */
    style?: TextBeamStyle;
}

/** 解析某一时刻的纯字光柱（构图按样式，运动全部落在 32 秒无缝循环里）。 */
export const resolveTextBeams = (frame: TextBeamFrame): ResolvedBeam[] => {
    const style = frame.style ?? 'calm';
    const beams = resolveBeams({ ...SHELL, beams: STYLE_BEAMS[style] ?? CALM }, frame.clock, frame.aspect, {
        intensity: frame.intensity,
        // 低频稍微放大：纯字档没有别的画面在动，重拍时让光柱更明显地抬一下。
        bass: Math.min(1, frame.bass * 1.35),
        color: frame.color,
    });
    const scale = Math.max(0.2, frame.scale);
    const shiftX = frame.offsetX * frame.aspect;
    const shiftY = frame.offsetY;
    // 条纹相位也跟着循环走（整数格数），否则条纹是按播放时间线性推进的，每 32 秒会露出「头尾」。
    const cycle = (frame.clock % LOOP) / LOOP;
    return beams.map((beam, index) => {
        // 长度呼吸：每根光柱以各自的相位轻微伸缩（±3%），两个完整循环 = 无缝。
        const breath = 1 + 0.03 * Math.sin(loopPhase(frame.clock, 2) + index * 1.37);
        return {
            ...beam,
            ox: beam.ox + shiftX,
            oy: beam.oy + shiftY,
            halfWidth: beam.halfWidth * scale,
            tanSpread: beam.tanSpread * scale,
            length: beam.length * scale * breath,
            streakPhase: cycle * STREAK_LOOP_CYCLES,
            goboPhase: 0,
        };
    });
};
