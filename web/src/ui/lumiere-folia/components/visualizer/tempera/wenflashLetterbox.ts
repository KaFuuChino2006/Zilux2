import { PIXI_FILTER_VERTEX } from '../pixiFilterVertex';

// The input is the transparent lyric artwork after its own colour and print passes.
// Composite the screen-space matte beneath that artwork and invert only its covered ink.
export function createWenflashLetterbox(pixi: typeof import('pixi.js')) {
    const params = new pixi.UniformGroup({
        uViewHeight: {value: 1, type: 'f32'},
        uThickness: {value: 0, type: 'f32'},
    });
    const filter = new pixi.Filter({
        glProgram: pixi.GlProgram.from({
            name: 'wenflash-letterbox-ink',
            vertex: PIXI_FILTER_VERTEX,
            fragment: `
                in vec2 vTextureCoord;
                out vec4 finalColor;
                uniform sampler2D uTexture;
                uniform vec4 uInputSize;
                uniform float uViewHeight;
                uniform float uThickness;
                void main() {
                    vec4 ink = texture(uTexture, vTextureCoord);
                    float y = vTextureCoord.y * uInputSize.y;
                    float edge = min(y, uViewHeight-y);
                    float feather = min(3.0, uThickness);
                    float coverage = smoothstep(0.0, max(feather, 0.001), uThickness-edge);
                    // In premultiplied alpha, inverted RGB is alpha minus RGB.
                    vec3 colour = mix(ink.rgb, max(vec3(0.0), vec3(ink.a)-ink.rgb), coverage);
                    finalColor = vec4(colour, ink.a + coverage*(1.0-ink.a));
                }`,
        }),
        resources: {letterboxParams: params},
        resolution: 'inherit',
    });
    return {filter, params: params.uniforms};
}
