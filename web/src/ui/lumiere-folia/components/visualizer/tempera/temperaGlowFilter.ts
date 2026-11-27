import { PIXI_FILTER_VERTEX as vertex } from '../pixiFilterVertex';
import { parseColorChannels } from '../colorMix';

// src/ui/lumiere-folia/components/visualizer/tempera/temperaGlowFilter.ts
// A keyword halo keeps the blurred alpha of its glyph and gets its colour from a moving
// three-stop ramp. Doing it in a filter avoids re-rasterising the Text every frame: the
// gradient only changes uniforms, so a flowing highlight costs no texture uploads.
type PixiModule = typeof import('pixi.js');

const fragment = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
uniform float uTime;
uniform float uFlowScale;

void main(void) {
    vec4 src = texture(uTexture, vTextureCoord);
    // Three-stop ramp that wraps C -> A instead of jumping back to A at the seam.
    float phase = fract(uFlowScale * (vTextureCoord.x * 1.18 - vTextureCoord.y * 0.22) - uTime);
    float cycle = phase * 3.0;
    float index = floor(cycle);
    float edge = fract(cycle);
    edge = edge * edge * (3.0 - 2.0 * edge);
    vec3 from = index < 0.5 ? uColorA : (index < 1.5 ? uColorB : uColorC);
    vec3 to = index < 0.5 ? uColorB : (index < 1.5 ? uColorC : uColorA);
    vec3 color = mix(from, to, edge);
    finalColor = vec4(color * src.a, src.a);
}
`;

const rgb = (color: string, fallback: string) => {
    const channels = parseColorChannels(color) ?? parseColorChannels(fallback);
    return new Float32Array([
        (channels?.r ?? 255) / 255,
        (channels?.g ?? 255) / 255,
        (channels?.b ?? 255) / 255,
    ]);
};

export interface TemperaGlowFilter {
    filter: import('pixi.js').Filter;
    setTime: (time: number) => void;
    setScale: (scale: number) => void;
    setColors: (colors: readonly [string, string, string]) => void;
}

export const createTemperaGlowFilter = (
    pixi: PixiModule,
    colors: readonly [string, string, string],
    fallback = '#ffffff',
): TemperaGlowFilter => {
    const uniforms = new pixi.UniformGroup({
        uColorA: { value: rgb(colors[0], fallback), type: 'vec3<f32>' },
        uColorB: { value: rgb(colors[1], fallback), type: 'vec3<f32>' },
        uColorC: { value: rgb(colors[2], fallback), type: 'vec3<f32>' },
        uTime: { value: 0, type: 'f32' },
        uFlowScale: { value: 1, type: 'f32' },
    });
    const filter = new pixi.Filter({
        glProgram: pixi.GlProgram.from({
            vertex,
            fragment,
            name: 'tempera-keyword-glow-gradient',
        }),
        resources: { glowUniforms: uniforms },
        resolution: 'inherit',
    });
    return {
        filter,
        setTime: (time: number) => {
            uniforms.uniforms.uTime = time;
        },
        setScale: (scale: number) => {
            uniforms.uniforms.uFlowScale = scale;
        },
        setColors: (next: readonly [string, string, string]) => {
            uniforms.uniforms.uColorA = rgb(next[0], fallback);
            uniforms.uniforms.uColorB = rgb(next[1], fallback);
            uniforms.uniforms.uColorC = rgb(next[2], fallback);
        },
    };
};
