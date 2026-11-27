import type { Motif } from './wenflashPhraseArt';

// Type plates borrow a character and typeface from the actual lyric. The remaining
// plates use the same two inks, with onsets supplied by the lyric clock.
export const pvMotifs: Motif[] = [
    { // Colour registration separates sharply on each onset, then snaps into focus.
        chance:.16, count:3, along:.12, side:-1, twist:.12, flash:[1,.12,.76,.18,1],
        lettering:()=>({x:0,y:0,size:42}),
        animate(g,i,_t,w,beat){g.x+=(i-1)*(2+14*beat)*w; g.alpha*=.70;},
    },
    { // A descending row of outline echoes springs away from the leading stamp.
        chance:.14, count:4, along:.84, side:1, twist:-.18, flash:[.4,1,.16,.84,1],
        lettering:i=>({x:i*9-15,y:i*4,size:37-i*4,outline:i!==0}),
        animate(g,i,t,w,beat){g.x+=i*(3*Math.sin(t)+5*beat)*w;},
    },
    { // Flipbook type turns edge-on, one tile after another.
        chance:.13, count:3, along:.56, side:-1, twist:0, flash:[.8,.25,1,.14,1],
        lettering:()=>({x:0,y:0,size:28}),
        animate(g,i,t,w){g.x+=(i-1)*25*w; g.scale.x*=1-w*(1-Math.abs(Math.cos(t-i*.7)))*.92;},
    },
    { // Oversized outline and a small solid counterprint cross on the downstroke.
        chance:.13, count:2, along:.03, side:1, twist:.25, flash:[1,.3,.12,.9,1],
        lettering:i=>({x:0,y:0,size:i?20:57,outline:!i}),
        animate(g,i,t,w,beat){g.x+=(i?1:-1)*Math.sin(t*.8)*11*w; g.y+=(i?8:-3)*beat*w;},
    },
    { // A vertical stack of repeated type drops through three fixed positions.
        chance:.12, count:3, along:1, side:-1, twist:-.14, flash:[.24,1,.32,.15,1],
        lettering:i=>({x:0,y:0,size:17,outline:i===2}),
        animate(g,i,t,w){const slot=(i+Math.floor(t*1.15))%3; g.y+=(slot-1)*18*w; g.alpha*=1-slot*.19;},
    },
    { // A pair of wide cinema mattes closes toward the cut on a syllable.
        chance:.15, count:2, along:.5, side:1, twist:0, flash:[1,.12,1,.24,1],
        draw(g,i,ink,accent){g.rect(-36,i?4:-9,72,i?3:6).fill(i?accent:ink);},
        animate(g,i,t,w,b){g.y+=(i?1:-1)*(6+3*Math.sin(t)-6*b)*w; g.scale.x*=1+.24*b*w;},
    },
    { // Four viewfinder corners converge to catch the word.
        chance:.15, count:4, along:.93, side:-1, twist:.18, flash:[.28,.94,.18,.72,1],
        draw(g,i,ink,accent){const x=i%2?1:-1,y=i<2?-1:1; g.moveTo(x*10,y*13).lineTo(x*21,y*13).lineTo(x*21,y*4).stroke({color:i%2?ink:accent,width:2.8});},
        animate(g,i,_t,w,b){g.x+=(i%2?1:-1)*10*(1-b)*w;g.y+=(i<2?-1:1)*5*(1-b)*w;},
    },
    { // Slices of a diagonal wipe travel at different speeds.
        chance:.15, count:4, along:.22, side:1, twist:-.12, flash:[1,.1,.6,.23,1],
        draw(g,i,ink,accent){const y=i*5;g.poly([-29,y,9+i*4,y,3+i*4,y+4,-35,y+4]).fill(i===1?accent:ink);},
        animate(g,i,t,w,b){g.x+=(10*Math.sin(t*1.3-i*.5)+(i-1.5)*10*b)*w;},
    },
    { // Alternating shutter leaves slide in from opposite sides.
        chance:.12, count:5, along:.66, side:-1, twist:0, flash:[.3,1,.18,1,.35,1],
        draw(g,i,ink,accent){g.rect(-22,i*4-10,44,3).fill(i===2?accent:ink);},
        animate(g,i,t,w){g.x+=(i%2?1:-1)*15*(.5+.5*Math.sin(t))*w;},
    },
    { // An edit cursor scrubs along an asymmetric strip of cue marks.
        chance:.13, count:2, along:.4, side:1, twist:0, flash:[.2,.85,.13,.68,1],
        draw(g,i,ink,accent){if(i){g.poly([-4,-14,4,-14,0,-8]).fill(accent);g.rect(-1,-8,2,17).fill(accent);}else{g.rect(-32,0,64,1.4).fill(ink);for(let j=0;j<9;j++)g.rect(j*8-32,1,1.5,j%3?4:8).fill(ink);}},
        animate(g,i,t,w){if(i)g.x+=Math.sin(t*.86)*29*w;},
    },
    { // A pair of angular subtitle brackets pulls apart on each attack.
        chance:.14, count:2, along:.15, side:-1, twist:-.16, flash:[1,.23,.8,.12,1],
        draw(g,i,ink,accent){const d=i?1:-1;g.moveTo(d*5,-12).lineTo(d*18,0).lineTo(d*5,12).stroke({color:i?accent:ink,width:4});},
        animate(g,i,t,w,b){g.x+=(i?1:-1)*(11*b+3*Math.sin(t))*w;},
    },
    { // Parallel speed lines stretch from a stationary leading edge.
        chance:.14, count:4, along:.91, side:1, twist:.08, flash:[.6,.2,1,.15,1],
        draw(g,i,ink,accent){g.poly([0,i*5,-39+i*6,i*5-1,0,i*5-3]).fill(i===0?accent:ink);},
        animate(g,i,t,w,b){g.scale.x*=1+w*(.6*b+.23*Math.sin(t*1.4-i));},
    },
    { // A moving exposure band traverses a ladder of neutral-density steps.
        chance:.12, count:5, along:.44, side:-1, twist:.05, flash:[1,.16,.5,.87,1],
        draw(g,i,ink,accent){g.rect(i*9-22,-8,8,16).fill(i%2?ink:accent);},
        animate(g,i,t,w){g.alpha*=1-w*.72*(.5+.5*Math.cos(t*2-i));},
    },
    { // Opposing trapezoids split a frame on its diagonal.
        chance:.13, count:2, along:.8, side:-1, twist:.22, flash:[.85,.12,.8,.32,1],
        draw(g,i,ink,accent){g.poly(i?[-18,12,20,-12,20,12]:[-20,-12,18,-12,-20,12]).fill(i?accent:ink);},
        animate(g,i,t,w,b){const split=(i?1:-1)*(5+4*Math.sin(t)+9*b)*w;g.x+=split;g.y+=split*.48;},
    },
    { // Draw a word balloon with a live three-dot ellipsis.
        chance:.10, count:4, along:.06, side:-1, twist:-.08, flash:[.2,.7,.14,1,.45,1],
        draw(g,i,ink,accent){if(!i)g.poly([-22,-12,22,-12,22,8,-4,8,-11,15,-10,8,-22,8]).stroke({color:ink,width:2});else g.circle((i-2)*9,-2,2.5).fill(accent);},
        animate(g,i,t,w){if(i){g.y-=Math.max(0,Math.sin(t*2-i))*5*w;}},
    },
    { // A jump-cut checker steps sideways in two interleaved rows.
        chance:.12, count:2, along:.68, side:1, twist:0, flash:[1,.11,.94,.28,1],
        draw(g,i,ink,accent){for(let j=0;j<4;j++)g.rect(-28+j*14+i*7,i*7,7,7).fill(i?ink:accent);},
        animate(g,i,t,w){g.x+=(i?1:-1)*Math.floor((1+Math.sin(t))*1.49)*7*w;},
    },
    { // A dashed splice opens at the seam; its two tape tabs peel back.
        chance:.11, count:3, along:.32, side:-1, twist:.22, flash:[.55,1,.12,.45,1],
        draw(g,i,ink,accent){if(!i){for(let j=0;j<5;j++)g.rect(-1,j*6-14,2,3).fill(ink);}else{const d=i===1?-1:1;g.poly([d*3,-3,d*24,-9,d*25,0,d*3,6]).fill(i===1?ink:accent);}},
        animate(g,i,t,w,b){if(i)g.rotation+=(i===1?-1:1)*(.28*Math.sin(t)+.38*b)*w;},
    },
    { // A stop-motion loading wheel advances by one spoke per exposure.
        chance:.10, count:6, along:.96, side:1, twist:.3, flash:[.3,1,.22,.85,1],
        draw(g,i,ink,accent){const a=i*Math.PI/3;g.moveTo(10*Math.cos(a),10*Math.sin(a)).lineTo(20*Math.cos(a),20*Math.sin(a)).stroke({color:i?ink:accent,width:i?2.5:5});},
        animate(g,_i,t,w){g.rotation+=Math.floor(t*1.8)*Math.PI/3*w;},
    },
    { // Stacked contour tunnels expand outward from a common vanishing point.
        chance:.13, count:3, along:.55, side:-1, twist:-.17, flash:[.75,.15,1,.36,1],
        draw(g,i,ink,accent){g.poly([-22,-14,22,-9,22,13,-22,9]).stroke({color:i===2?accent:ink,width:1.7});},
        animate(g,i,t,w){const depth=(t*.23+i/3)%1;const s=.3+.9*depth;g.scale.x*=1+(s-1)*w;g.scale.y*=1+(s-1)*w;g.alpha*=Math.sin(Math.PI*depth);},
    },
    { // Oscillating moiré grids slip across one another like misregistered screen tone.
        chance:.12, count:2, along:.29, side:1, twist:-.2, flash:[1,.18,.62,.2,1],
        draw(g,i,ink,accent){for(let j=0;j<8;j++)g.moveTo(j*5-23,-12).lineTo(j*5-16,12);g.stroke({color:i?accent:ink,width:1.5});},
        animate(g,i,t,w){g.rotation+=(i?1:-1)*(.14+.22*Math.sin(t*.84))*w;g.x+=(i?1:-1)*3*Math.cos(t)*w;},
    },
];
