export type Brush = CanvasRenderingContext2D;
export type Point = readonly [number,number];
export type Random = () => number;

export function seeded(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state,1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function stroke(g: Brush, points: readonly Point[], color: string, width: number) {
  g.beginPath();
  points.forEach(([x,y],i) => i ? g.lineTo(x,y) : g.moveTo(x,y));
  g.lineWidth = width;
  g.strokeStyle = color;
  g.stroke();
}

export function shape(g: Brush, points: readonly Point[], color: string) {
  g.beginPath();
  points.forEach(([x,y],i) => i ? g.lineTo(x,y) : g.moveTo(x,y));
  g.closePath();
  g.fillStyle = color;
  g.fill();
}

export function dot(g: Brush,x: number,y: number,r: number,color: string) {
  g.beginPath();
  g.arc(x,y,r,0,Math.PI*2);
  g.fillStyle=color;
  g.fill();
}

export function lamp(g: Brush,x: number,y: number,r: number,color: string) {
  const glow = g.createRadialGradient(x,y,0,x,y,r);
  glow.addColorStop(0,color+'d4');
  glow.addColorStop(.14,color+'65');
  glow.addColorStop(.45,color+'23');
  glow.addColorStop(1,color+'00');
  g.fillStyle=glow;
  g.fillRect(x-r,y-r,r*2,r*2);
  dot(g,x,y,Math.max(.75,r*.068),'#ffe6be');
}

export function girder(g: Brush,a: Point,b: Point,thickness: number,bays: number,color: string) {
  const [x,y]=a,dx=b[0]-x,dy=b[1]-y;
  const length=Math.hypot(dx,dy);
  g.save();
  g.translate(x,y);
  g.rotate(Math.atan2(dy,dx));
  stroke(g,[[0,0],[length,0]],color,2);
  stroke(g,[[0,thickness],[length,thickness]],color,2);
  for(let i=0;i<bays;i++){
    const left=length*i/bays,right=length*(i+1)/bays;
    stroke(g,[[left,0],[(left+right)/2,thickness],[right,0]],color,1.45);
  }
  g.restore();
}
