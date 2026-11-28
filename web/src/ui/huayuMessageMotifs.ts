import type { HuayuShape } from './huayuSettings';

export const lineMotifs = new Set<HuayuShape>(['circuit', 'comet', 'needle', 'stitch', 'staff', 'ruler', 'braid', 'morse']);
const cardMotifs = new Set<HuayuShape>(['postage', 'bookmark', 'film', 'scroll', 'cloud', 'folder', 'awning']);

export function drawMessageMotif(
  c: CanvasRenderingContext2D, shape: HuayuShape, x: number, y: number, w: number, h: number,
  right: boolean, u: number, base: string, ink: string, alpha: number, avatarGap: number,
): boolean {
  if (!lineMotifs.has(shape) && !cardMotifs.has(shape)) return false;
  c.save();
  c.translate(right ? x + w : x, y);
  c.scale(right ? -1 : 1, 1);
  c.globalAlpha = alpha;
  c.lineWidth = 1.3;
  c.lineCap = c.lineJoin = 'round';
  c.fillStyle = c.strokeStyle = ink;
  const foot = h - 2;
  const reach = Math.max(0, avatarGap - 3);
  const dot = (px: number, py: number, radius: number) => {
    c.beginPath();
    c.arc(px, py, radius, 0, Math.PI * 2);
    c.fill();
  };
  const line = (...points: number[]) => {
    c.beginPath();
    c.moveTo(points[0]!, points[1]!);
    for (let i = 2; i < points.length; i += 2) c.lineTo(points[i]!, points[i + 1]!);
    c.stroke();
  };
  switch (shape) {
    case 'circuit':
      line(-reach, u*.7, -reach*.5, u*.7, 1, u*1.2, 1, foot-4, 5, foot, w*.62, foot);
      dot(-reach, u*.7, 2.3);
      dot(w*.62, foot, 2.3);
      break;
    case 'comet':
      for (let i = 0; i < 3; i++) line(i*5-reach, foot-i*3, u*.65, foot);
      dot(u*.9, foot, 2.8);
      break;
    case 'needle':
      dot(-reach*.7, u*.65, 3.5);
      line(-reach*.7, u*.65, -reach*.45, foot-3, u*.65, foot);
      line(u*.42, foot-3, u*.75, foot-1, u*.64, foot+2);
      break;
    case 'stitch':
      for (let px = 3; px < w-3; px += 8) {
        line(px, 3, px+3, 1);
        line(px, h-1, px+3, h-3);
      }
      break;
    case 'staff':
      c.lineWidth = .65;
      for (let i = 0; i < 5; i++) line(1, h-5+i*1.6, w-1, h-5+i*1.6);
      dot(w*.22, foot, 2.3);
      line(w*.22+2, foot, w*.22+2, foot-7);
      break;
    case 'ruler':
      line(0, foot, w, foot);
      for (let px = 0; px <= w; px += 5) line(px, foot, px, foot-(px%20 === 0 ? 5 : 2));
      break;
    case 'braid':
      for (const sign of [-1, 1]) {
        c.beginPath();
        c.moveTo(0, foot);
        for (let px = 1; px <= w; px++) c.lineTo(px, foot+sign*2.2*Math.sin(px*.23));
        c.stroke();
      }
      break;
    case 'morse':
      for (let px = 2; px < w-3; px += 18) {
        dot(px, foot, 1.5);
        line(px+5, foot, Math.min(w-1, px+12), foot);
      }
      break;
    default: {
      c.fillStyle = base;
      c.beginPath();
      if (shape === 'cloud') {
        const n = Math.max(3, Math.round(w/u));
        c.moveTo(0, 3);
        for (let i = 0; i < n; i++) c.quadraticCurveTo((i+.5)*w/n, -5, (i+1)*w/n, 3);
        c.quadraticCurveTo(w+4, h/2, w, h-3);
        for (let i = n; i > 0; i--) c.quadraticCurveTo((i-.5)*w/n, h+5, (i-1)*w/n, h-3);
        c.quadraticCurveTo(-4, h/2, 0, 3);
      } else {
        c.roundRect(0, 0, w, h, shape === 'scroll' ? 4 : 2);
        // 内轮廓用奇偶填充直接镂空，透出真实背景。
        if (shape === 'postage') {
          for (let px = 5; px < w-3; px += 9) {
            for (const py of [0, h]) {
              c.moveTo(px+2.2, py);
              c.arc(px, py, 2.2, 0, Math.PI*2);
            }
          }
          for (let py = 6; py < h-3; py += 9) {
            c.rect(0, py, 2, 3);
            c.rect(w-2, py, 2, 3);
          }
        } else if (shape === 'film') {
          for (let px = 4; px < w-5; px += 10) {
            c.rect(px, 2, 5, 3);
            c.rect(px, h-5, 5, 3);
          }
        }
      }
      c.fill('evenodd');
      c.strokeStyle = 'rgb(54 43 62 / .22)';
      c.stroke();
      c.fillStyle = ink;
      if (shape === 'bookmark') {
        const bx = w-u*.65;
        c.beginPath();
        c.moveTo(bx, -2); c.lineTo(bx+6, -2); c.lineTo(bx+6, 10);
        c.lineTo(bx+3, 7); c.lineTo(bx, 10); c.closePath(); c.fill();
      } else if (shape === 'scroll') {
        for (const px of [0, w-4]) {
          c.fillRect(px, -2, 4, h+4);
          c.fillRect(px-1, -2, 6, 2);
          c.fillRect(px-1, h, 6, 2);
        }
      } else if (shape === 'folder') {
        line(0, 1, w*.5, Math.min(6, h*.15), w, 1);
        line(1, h-1, u*.6, h-6);
        line(w-1, h-1, w-u*.6, h-6);
      } else if (shape === 'awning') {
        const n = Math.max(3, Math.round(w/9));
        for (let i = 0; i < n; i++) {
          c.fillStyle = i%2 ? ink : base;
          c.beginPath();
          c.roundRect(i*w/n, -2, w/n, 7, [0,0,3,3]);
          c.fill(); c.stroke();
        }
      }
    }
  }
  c.restore();
  return true;
}
