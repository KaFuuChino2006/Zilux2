import { PIXI_FILTER_VERTEX } from '../pixiFilterVertex';

// The input is the transparent lyric artwork after its own colour pass, before the shared print pass.
// Composite the screen-space matte beneath that artwork and invert only its covered ink.
export function createWenflashLetterbox(pixi: typeof import('pixi.js')) {
    const params = new pixi.UniformGroup({
        uViewWidth: {value: 1, type: 'f32'},
        uAngle: {value: 0, type: 'f32'},
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
                uniform float uViewWidth;
                uniform float uAngle;
                uniform float uViewHeight;
                uniform float uThickness;
                void main() {
                    vec4 ink = texture(uTexture, vTextureCoord);
                    vec2 centre = 0.5 * vec2(uViewWidth, uViewHeight);
                    vec2 offset = vTextureCoord * uInputSize.xy - centre;
                    float edge = centre.y - abs(dot(offset, vec2(-sin(uAngle), cos(uAngle))));
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
