import { wenflashEasedCycles } from '../../../../wenflashPhase';
import { pvMotifs } from './wenflashPvMotifs';
import type { Container, Graphics } from 'pixi.js';
import { temperaHash01 } from './temperaRandom';

type Pixi = typeof import('pixi.js');
type Draw = (g: Graphics, i: number, ink: string, accent: string) => void;

type Animate = (plate: Container, index: number, clock: number, weight: number, beat: number) => void;

export interface Motif {
    lettering?: (index: number) => {x: number; y: number; size: number; outline?: boolean};
    animate: Animate;
    chance: number;
    count: number;
    along: number;
    side: number;
    twist: number;
    flash: readonly number[];
    draw?: Draw;
}

// Each plate is drawn in 100-unit artwork coordinates. The origin is its fold or pivot.
const motifs: Motif[] = [
    { // Pleated fan, alternating solid and open leaves.
        chance: .15, count: 5, along: .03, side: -1, twist: -.9,
        flash: [.65, .15, .95, .32, 1],
        animate(g, i, t, w) {
            // Open and close the fan about the common hinge.
            g.rotation += (i-2)*.17*Math.sin(t)*w;
        },
        draw(g, i, ink, accent) {
            const a = -2.65 + i * .29;
            const r = 72 - Math.abs(i - 2) * 5;
            g.poly([0, 0, Math.cos(a)*r, Math.sin(a)*r, Math.cos(a+.24)*r, Math.sin(a+.24)*r]);
            if (i % 2) g.stroke({color: ink, width: 1.8});
            else g.fill({color: accent, alpha: .72});
        },
    },
    { // Halftone wedge, one strip of dots printed at a time.
        chance: .16, count: 5, along: .82, side: 1, twist: 0,
        flash: [1, .22, .75, .14, .85, 1],
        animate(g, i, t, w) {
            // A ripple travels across the printed rows.
            const wave = Math.sin(t*2-i*.85)*w;
            g.x += wave*5;
            g.scale.x *= 1+wave*.20;
        },
        draw(g, i, ink, accent) {
            for (let j = 0; j < 7-i; j++) {
                g.circle((j-3)*9+i*3, i*8, 1.6+(5-i)*.47).fill({color: i===0 ? accent : ink});
            }
        },
    },
    { // Broken concentric dial with a contrasting index.
        chance: .13, count: 3, along: 1, side: -1, twist: 1.2,
        flash: [.25, 1, .3, .35, 1],
        animate(g, i, t, w) {
            // Concentric rings turn in opposite directions.
            g.rotation += (i%2 ? -1 : 1)*t*(.48+i*.09)*w;
        },
        draw(g, i, ink, accent) {
            const r = 19 + i*9;
            const a = -2.7+i*.64;
            g.arc(0, 0, r, a, a+Math.PI*1.35).stroke({color: i===1 ? accent : ink, width: i===1 ? 5 : 1.6});
            g.circle(r*Math.cos(a), r*Math.sin(a), 2.4).fill({color: accent});
        },
    },
    { // Torn ribbon in three offset strips, with a cut-out notch at the tail.
        chance: .14, count: 3, along: .13, side: 1, twist: -.13,
        flash: [1, .08, .9, .9, .18, 1],
        animate(g, i, t, w) {
            // The three loose ends lift in succession.
            const flutter = Math.sin(t*2.3-i*.8)*w;
            g.y += flutter*(3+i*2);
            g.rotation += flutter*.12;
        },
        draw(g, i, ink, accent) {
            const x = -22+i*7, y = i*9, w = 70-i*12;
            g.poly([x,y,x+w,y-5,x+w-10,y,x+w-4,y+2,x+3,y+7])
                .fill({color: i===1 ? ink : accent, alpha: 1-i*.18});
        },
    },
    { // Isometric steps, each with its own shaded riser.
        chance: .12, count: 4, along: .95, side: 1, twist: .15,
        flash: [.22, .8, .35, .9, .55, 1],
        animate(g, i, t, w) {
            // Pass a single lift from tread to tread.
            const lift = Math.max(0, Math.cos(t*2-i*1.5))**3*w;
            g.y -= lift*11;
        },
        draw(g, i, ink, accent) {
            const x=i*11-20, y=-i*6;
            g.poly([x,y,x+11,y-5,x+23,y,x+12,y+5]).fill({color: accent});
            g.poly([x,y,x+12,y+5,x+12,y+12,x,y+7]).fill({color: ink, alpha: .72});
        },
    },
    { // A crooked constellation with one elongated four-point flare.
        chance: .14, count: 4, along: .48, side: -1, twist: -.36,
        flash: [.85, .15, .4, 1, .2, .6, 1],
        animate(g, _i, t, w) {
            // Let the constellation drift as one, leaving its line segments connected.
            g.x += Math.sin(t*.72)*8*w;
            g.y += Math.sin(t*1.44)*4*w;
            g.rotation += Math.sin(t*.72)*.15*w;
        },
        draw(g, i, ink, accent) {
            const xs=[-40,-16,9,37], ys=[-8,-23,-11,-29];
            const x=xs[i], y=ys[i], r=i===2 ? 11 : 3;
            if (i) g.moveTo(xs[i-1],ys[i-1]).lineTo(x,y).stroke({color: ink, width: 1.6});
            g.poly([x,y-r*1.35,x+r*.23,y-r*.24,x+r,y,x+r*.23,y+r*.24,x,y+r*1.35,x-r*.23,y+r*.24,x-r,y,x-r*.23,y-r*.24])
                .fill({color: accent});
        },
    },
    { // An iris closes around an empty centre.
        chance: .09, count: 6, along: .29, side: -1, twist: -.8,
        flash: [.4, 1, .12, .8, .35, 1],
        animate(g, i, t, w) {
            // Each blade turns about its outer mount to open the aperture.
            const angle = i*Math.PI/3;
            const turn = .46*Math.sin(t*1.25)*w;
            g.x += 28*(Math.cos(angle)-Math.cos(angle+turn));
            g.y += 28*(Math.sin(angle)-Math.sin(angle+turn));
            g.rotation += turn;
        },
        draw(g, i, ink, accent) {
            const a = i * Math.PI / 3;
            const xy = (r: number, offset: number) => [r*Math.cos(a+offset), r*Math.sin(a+offset)];
            g.poly([...xy(28, 0), ...xy(28, 1), ...xy(13, 1.42), ...xy(9, .62)])
                .fill({color: i % 3 === 0 ? accent : ink});
        },
    },
    { // Film frames threaded along a tilted strip, sprockets printed outside the frame.
        chance: .10, count: 3, along: .37, side: 1, twist: -.25,
        flash: [1, .14, .14, 1, .26, 1],
        animate(g, _i, t, w) {
            // Advance the strip one frame, dwell, then return.
            const step = Math.floor((1-Math.cos(t*1.5))*1.49);
            g.x -= step*8*w;
            g.y += step*1.4*w;
        },
        draw(g, i, ink, accent) {
            const x = (i-1)*23, y = i*-4;
            g.rect(x-10, y, 20, 16).stroke({color: ink, width: 2});
            g.moveTo(x-7, y+13).lineTo(x+7, y+3).stroke({color: accent, width: 2});
            for (const dx of [-8, 0, 7]) g.rect(x+dx, y-5, 3, 3).fill({color: ink});
        },
    },
    { // Oscilloscope trace with an asymmetric attack and undershoot.
        chance: .11, count: 4, along: .60, side: 1, twist: .1,
        flash: [.25, 1, .09, .9, .3, .8, 1],
        animate(g, i, t, w) {
            // The trace flexes about its baseline; segment endpoints stay joined.
            g.scale.y *= 1+.56*Math.sin(t*3-i*1.1)*w;
        },
        draw(g, i, ink, accent) {
            const x = i*18-36, h = [5, 20, 11, 4][i];
            g.moveTo(x, 0).lineTo(x+5, 0).lineTo(x+8, -h).lineTo(x+12, h*.6)
                .lineTo(x+15, 0).lineTo(x+18, 0).stroke({color: i===1 ? accent : ink, width: 2.4});
        },
    },
    { // Three folded paper planes of different sizes in a climbing formation.
        chance: .08, count: 3, along: .75, side: -1, twist: .48,
        flash: [.5, .12, 1, .42, 1],
        animate(g, i, t, w) {
            // Fly in formation, banking as the flight path changes direction.
            const flight = t*.95-i*.28;
            g.x += Math.sin(flight)*24*w;
            g.y += Math.sin(flight*2)*8*w;
            g.rotation += Math.cos(flight)*.25*w;
        },
        draw(g, i, ink, accent) {
            const x = i*20-25, y = -i*10, r = 17-i*3;
            g.poly([x-r,y, x+r,y-r, x,y+3]).fill({color: accent});
            g.poly([x,y+3, x+r,y-r, x+3,y+r*.65]).fill({color: ink});
        },
    },
    { // Offset fingerprints: broken ridges tighten toward the centre.
        chance: .09, count: 4, along: .02, side: 1, twist: -.5,
        flash: [.15, .7, .2, 1, .48, 1],
        animate(g, i, t, w) {
            // The ridges expand in a wave from the centre out.
            const swell = Math.sin(t*1.8+i*.64)*w;
            g.scale.x *= 1+swell*.18;
            g.scale.y *= 1+swell*.12;
        },
        draw(g, i, ink, accent) {
            const r = 23-i*4.5;
            g.moveTo(-r, 10).bezierCurveTo(-r*1.35,-r, r*.8,-r*1.4, r,0)
                .bezierCurveTo(r+2,r*.55, r-5,r, r-8,r+5)
                .stroke({color: i===2 ? accent : ink, width: 2.2});
        },
    },
    { // A staggered chain of lightning shards.
        chance: .10, count: 3, along: .99, side: -1, twist: .38,
        flash: [1, .08, 1, .12, .12, 1],
        animate(g, i, t, w) {
            // A short staggered discharge snaps each shard off register.
            const beat = (t*1.3+i*.12)%1;
            const jolt = beat<.12 ? 1 : beat<.23 ? -.45 : 0;
            g.x += jolt*10*w;
            g.y -= jolt*7*w;
        },
        draw(g, i, ink, accent) {
            const x = (i-1)*12, y = (i%2)*9;
            g.poly([x+3,y-17, x+12,y-17, x+3,y-3, x+10,y-4, x-7,y+19, x-2,y+2, x-8,y+3])
                .fill({color: i===1 ? accent : ink});
        },
    },
];

const allMotifs = [...motifs, ...pvMotifs];
// Preserve the previous expected number of marks as the repertoire grows.
const densityScale = 1.41 / allMotifs.reduce((total, m) => total+m.chance, 0);

export function buildPhraseArt(pixi: Pixi, parent: Container, text: Container, seed: number,
    rect: {x: number; y: number; width: number; height: number}, font: number, vertical: boolean,
    ink: string, accent: string, start: number, glyph: import('pixi.js').Text, onsets: number[]) {
    const plates: {g: Container; index: number; animate: Animate; rate: number; delay: number; twist: number; side: number; flash: readonly number[]}[] = [];
    const root = new pixi.Container();
    root.visible = false;
    allMotifs.forEach((m, k) => {
        if (temperaHash01(seed, k, 2401) >= m.chance * densityScale) return;
        const group = new pixi.Container();
        const pad = font*(.24 + .20*temperaHash01(seed,k,2407));
        if (vertical) {
            group.position.set(rect.x + (m.side<0 ? rect.width+pad : -pad), rect.y+rect.height*m.along);
            group.rotation = Math.PI/2;
        } else {
            group.position.set(rect.x+rect.width*m.along, rect.y+(m.side<0 ? -pad : rect.height+pad));
        }
        group.scale.set(Math.max(.24, Math.min(1.8, font/100)));
        root.addChild(group);
        const rate = 2.6 + 1.4*temperaHash01(seed, k, 2423);
        for (let i=0; i<m.count; i++) {
            let g: Container;
            const letter = m.lettering?.(i);
            if (letter) {
                const carrier = new pixi.Container();
                const stamp = new pixi.Text({text: glyph.text, style: {
                    fontFamily: glyph.style.fontFamily, fontWeight: glyph.style.fontWeight,
                    fontSize: letter.size, fill: letter.outline ? {color: ink, alpha: 0} : i%2 ? accent : ink,
                    stroke: letter.outline ? {color: i%2 ? accent : ink, width: 1.5} : undefined,
                }});
                stamp.anchor.set(.5);
                stamp.position.set(letter.x, letter.y);
                carrier.addChild(stamp);
                g = carrier;
            } else {
                const drawing = new pixi.Graphics();
                m.draw?.(drawing, i, ink, accent);
                g = drawing;
            }
            group.addChild(g);
            plates.push({g, index: i, animate: m.animate, rate, delay: i*.075, twist: m.twist, side: m.side, flash: m.flash});
        }
    });
    if (!plates.length) { root.destroy(); return null; }
    parent.addChildAt(root, parent.getChildIndex(text));
    return {root, plates, start, onsets};
}

export function updatePhraseArt(art: NonNullable<ReturnType<typeof buildPhraseArt>>, time: number,
    exitAt: number, exitDuration: number, intensity: number, run: number, brake: number) {
    const phase = Math.max(0, Math.min(1, (time-art.start)/.38, (exitAt+exitDuration-time)/Math.max(.001,exitDuration)));
    art.root.visible = phase>0 && intensity>0;
    if (!art.root.visible) return;
    art.root.alpha = intensity*.85;
    const age = wenflashEasedCycles(Math.min(time, exitAt)-art.start, 1, run, brake);
    const lyricTime = art.start+age;
    let lastOnset = art.start;
    for (const onset of art.onsets) {
        if (onset > lyricTime) break;
        lastOnset = onset;
    }
    const beat = Math.max(0, 1-(lyricTime-lastOnset)/.24)**2;
    for (const p of art.plates) {
        const t = Math.max(0,(phase-p.delay)/(1-p.delay));
        const open = t*t*(3-2*t);
        // Read the same stepped exposure backwards on exit. The last exposure is
        // always fully lit while the motif performs its own movement.
        const frame = Math.min(p.flash.length-1, Math.floor(t*p.flash.length));
        p.g.alpha = open*p.flash[frame];
        p.g.x = 0;
        p.g.y = (1-open)*p.side*18;
        p.g.rotation = (1-open)*p.twist;
        p.g.scale.set(.45+.55*open, .18+.82*open);
        p.animate(p.g, p.index, age*p.rate, open, beat);
    }
}
