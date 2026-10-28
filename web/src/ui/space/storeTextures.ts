import * as THREE from 'three';

/**
 * R2：唱片店程序化贴图库。
 * 全部用 Canvas 2D 生成，离线可用、无外部资源与许可风险；
 * 尺寸按 512/1024 分档，重复贴图统一用 RepeatWrapping。
 */

type TextureOptions = {
  repeat?: [number, number];
  anisotropy?: number;
  wrap?: boolean;
};

function canvasTexture(
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
  options: TextureOptions = {},
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) draw(ctx);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  if (options.wrap !== false) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
  }
  if (options.repeat) texture.repeat.set(options.repeat[0], options.repeat[1]);
  texture.anisotropy = options.anisotropy ?? 4;
  texture.needsUpdate = true;
  return texture;
}

function hashSeed(text: string): () => number {
  let seed = 0;
  for (const char of text) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return ((seed >>> 8) % 10000) / 10000;
  };
}

function rand(seed: () => number, min: number, max: number): number {
  return min + seed() * (max - min);
}

function rgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const int = Number.parseInt(full, 16);
  return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`;
}

function shade(hex: string, amount: number): string {
  const value = hex.replace('#', '');
  const int = Number.parseInt(value.length === 3 ? value.split('').map((c) => c + c).join('') : value, 16);
  const channel = (offset: number): number => {
    const base = (int >> offset) & 255;
    const next = amount >= 0 ? base + (255 - base) * amount : base * (1 + amount);
    return Math.max(0, Math.min(255, Math.round(next)));
  };
  return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
}

function addGrain(ctx: CanvasRenderingContext2D, width: number, height: number, amount: number): void {
  const data = ctx.getImageData(0, 0, width, height);
  const pixels = data.data;
  for (let i = 0; i < pixels.length; i += 4) {
    const noise = (Math.random() - 0.5) * amount;
    pixels[i] = Math.max(0, Math.min(255, pixels[i] + noise));
    pixels[i + 1] = Math.max(0, Math.min(255, pixels[i + 1] + noise));
    pixels[i + 2] = Math.max(0, Math.min(255, pixels[i + 2] + noise));
  }
  ctx.putImageData(data, 0, 0);
}

/** 木地板：宽板 + 木纹 + 磨损高光。 */
export function makeWoodFloorTexture(): THREE.CanvasTexture {
  return canvasTexture(
    1024,
    1024,
    (ctx) => {
      const rand01 = hashSeed('floor-planks');
      ctx.fillStyle = '#1c140e';
      ctx.fillRect(0, 0, 1024, 1024);
      const rows = 8;
      const rowHeight = 1024 / rows;
      for (let row = 0; row < rows; row += 1) {
        const offset = (row % 2 === 0 ? 0 : 0.5) * 260;
        const tone = rand(rand01, -0.12, 0.14);
        for (let seg = -1; seg < 4; seg += 1) {
          const x = seg * 340 + offset + rand(rand01, -18, 18);
          const width = 334 + rand(rand01, -14, 8);
          const y = row * rowHeight + 1.5;
          const grad = ctx.createLinearGradient(x, y, x + width, y + rowHeight);
          grad.addColorStop(0, shade('#4a3423', tone + 0.06));
          grad.addColorStop(0.45, shade('#3b2a1c', tone));
          grad.addColorStop(1, shade('#2b1e14', tone - 0.05));
          ctx.fillStyle = grad;
          ctx.fillRect(x, y, width, rowHeight - 3);
          // 木纹
          for (let line = 0; line < 16; line += 1) {
            const ly = y + rand(rand01, 2, rowHeight - 4);
            ctx.strokeStyle = rgba('#160f0a', rand(rand01, 0.05, 0.2));
            ctx.lineWidth = rand(rand01, 0.6, 1.8);
            ctx.beginPath();
            ctx.moveTo(x, ly);
            let px = x;
            let py = ly;
            while (px < x + width) {
              px += rand(rand01, 18, 60);
              py += rand(rand01, -2.2, 2.2);
              ctx.lineTo(px, py);
            }
            ctx.stroke();
          }
          // 磨损高光
          ctx.strokeStyle = rgba('#ffe2b0', rand(rand01, 0.02, 0.06));
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x + 6, y + 4);
          ctx.lineTo(x + width - 8, y + rand(rand01, 2, 6));
          ctx.stroke();
          // 板缝
          ctx.fillStyle = 'rgba(8, 5, 3, 0.8)';
          ctx.fillRect(x + width - 2, y, 2.5, rowHeight - 2);
        }
      }
      ctx.fillStyle = 'rgba(10, 7, 4, 0.5)';
      for (let i = 0; i < 6; i += 1) {
        ctx.fillRect(0, i * (1024 / 6), 1024, 1.2);
      }
      // 远处地板被灯光暖化的感觉
      const wash = ctx.createRadialGradient(700, 620, 40, 700, 620, 620);
      wash.addColorStop(0, 'rgba(255, 196, 132, 0.16)');
      wash.addColorStop(1, 'rgba(255, 196, 132, 0)');
      ctx.fillStyle = wash;
      ctx.fillRect(0, 0, 1024, 1024);
      addGrain(ctx, 1024, 1024, 7);
    },
    { repeat: [7, 7] },
  );
}

/** 深色灰泥墙：潮湿斑驳 + 顶部更暗。 */
export function makeWallPlasterTexture(): THREE.CanvasTexture {
  return canvasTexture(
    1024,
    1024,
    (ctx) => {
      const rand01 = hashSeed('wall-plaster');
      ctx.fillStyle = '#4a3728';
      ctx.fillRect(0, 0, 1024, 1024);
      for (let i = 0; i < 260; i += 1) {
        const x = rand(rand01, 0, 1024);
        const y = rand(rand01, 0, 1024);
        const r = rand(rand01, 12, 130);
        const dark = rand01() > 0.5;
        const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, dark ? rgba('#1b120b', rand(rand01, 0.03, 0.1)) : rgba('#ffdfae', rand(rand01, 0.02, 0.06)));
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      // 竖向刷痕
      for (let i = 0; i < 420; i += 1) {
        const x = rand(rand01, 0, 1024);
        ctx.strokeStyle = rgba('#1c130c', rand(rand01, 0.01, 0.05));
        ctx.lineWidth = rand(rand01, 0.5, 2);
        ctx.beginPath();
        ctx.moveTo(x, rand(rand01, 0, 600));
        ctx.lineTo(x + rand(rand01, -6, 6), rand(rand01, 500, 1024));
        ctx.stroke();
      }
      const top = ctx.createLinearGradient(0, 0, 0, 1024);
      top.addColorStop(0, 'rgba(8, 5, 3, 0.42)');
      top.addColorStop(0.45, 'rgba(8, 5, 3, 0.12)');
      top.addColorStop(1, 'rgba(8, 5, 3, 0.3)');
      ctx.fillStyle = top;
      ctx.fillRect(0, 0, 1024, 1024);
      addGrain(ctx, 1024, 1024, 6);
    },
    { repeat: [2, 1] },
  );
}

/** 胡桃木：货架与家具用，细直纹 + 轻微抛光。 */
export function makeWalnutTexture(): THREE.CanvasTexture {
  return canvasTexture(
    512,
    512,
    (ctx) => {
      const rand01 = hashSeed('walnut');
      const grad = ctx.createLinearGradient(0, 0, 512, 512);
      grad.addColorStop(0, '#4a3322');
      grad.addColorStop(0.5, '#3a2719');
      grad.addColorStop(1, '#2a1c12');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 90; i += 1) {
        const x = rand(rand01, 0, 512);
        ctx.strokeStyle = rgba(rand01() > 0.4 ? '#150e09' : '#6b4a2d', rand(rand01, 0.05, 0.22));
        ctx.lineWidth = rand(rand01, 0.8, 2.6);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        let px = x;
        while (px < 512 && px >= 0) {
          const step = rand(rand01, 20, 70);
          px += rand(rand01, -6, 6);
          ctx.lineTo(px, step * 2);
        }
        ctx.stroke();
      }
      const sheen = ctx.createLinearGradient(0, 0, 512, 0);
      sheen.addColorStop(0, 'rgba(255, 220, 170, 0.08)');
      sheen.addColorStop(0.5, 'rgba(255, 220, 170, 0.02)');
      sheen.addColorStop(1, 'rgba(255, 220, 170, 0.07)');
      ctx.fillStyle = sheen;
      ctx.fillRect(0, 0, 512, 512);
      addGrain(ctx, 512, 512, 6);
    },
    { repeat: [1, 1] },
  );
}

/** 地毯：酒红底 + 双层边饰 + 菱格纹。 */
export function makeRugTexture(): THREE.CanvasTexture {
  return canvasTexture(
    1024,
    1024,
    (ctx) => {
      const rand01 = hashSeed('rug');
      ctx.fillStyle = '#3a1d1a';
      ctx.fillRect(0, 0, 1024, 1024);
      for (let i = 0; i < 2400; i += 1) {
        ctx.fillStyle = rgba(rand01() > 0.5 ? '#5a2a24' : '#1e0f0d', rand(rand01, 0.05, 0.16));
        ctx.fillRect(rand(rand01, 0, 1024), rand(rand01, 0, 1024), rand(rand01, 1, 4), 1);
      }
      const border = (inset: number, color: string): void => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 8;
        ctx.strokeRect(inset, inset, 1024 - inset * 2, 1024 - inset * 2);
      };
      border(36, 'rgba(210, 160, 96, 0.5)');
      border(58, 'rgba(120, 60, 38, 0.65)');
      ctx.save();
      ctx.translate(512, 512);
      ctx.strokeStyle = 'rgba(210, 160, 96, 0.22)';
      ctx.lineWidth = 3;
      for (let ring = 0; ring < 4; ring += 1) {
        ctx.beginPath();
        ctx.ellipse(0, 0, 150 + ring * 95, 210 + ring * 120, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
      const vignette = ctx.createRadialGradient(512, 512, 250, 512, 512, 760);
      vignette.addColorStop(0, 'rgba(0,0,0,0)');
      vignette.addColorStop(1, 'rgba(0,0,0,0.45)');
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, 1024, 1024);
      addGrain(ctx, 1024, 1024, 8);
    },
    { repeat: [1, 1] },
  );
}

/** 牛皮纸板：唱片箱与纸箱。 */
export function makeCardboardTexture(): THREE.CanvasTexture {
  return canvasTexture(
    512,
    512,
    (ctx) => {
      const rand01 = hashSeed('cardboard');
      ctx.fillStyle = '#8a6945';
      ctx.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 2400; i += 1) {
        ctx.fillStyle = rgba(rand01() > 0.5 ? '#6d4f31' : '#a8835a', rand(rand01, 0.04, 0.16));
        ctx.fillRect(rand(rand01, 0, 512), rand(rand01, 0, 512), rand(rand01, 1, 6), 1);
      }
      for (let line = 0; line < 8; line += 1) {
        ctx.fillStyle = rgba('#4a331f', 0.12);
        ctx.fillRect(0, line * 64 + rand(rand01, -4, 4), 512, 1.4);
      }
      addGrain(ctx, 512, 512, 10);
    },
    { repeat: [1, 1] },
  );
}

/** 夜景窗：深蓝夜空 + 城市剪影 + 暖窗与路灯虚焦。 */
export function makeNightWindowTexture(): THREE.CanvasTexture {
  return canvasTexture(
    1024,
    640,
    (ctx) => {
      const rand01 = hashSeed('night-window');
      const sky = ctx.createLinearGradient(0, 0, 0, 640);
      sky.addColorStop(0, '#0a1020');
      sky.addColorStop(0.55, '#141d31');
      sky.addColorStop(1, '#241b1a');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, 1024, 640);
      // 月亮与光晕
      const moon = ctx.createRadialGradient(760, 130, 6, 760, 130, 130);
      moon.addColorStop(0, 'rgba(230, 238, 255, 0.95)');
      moon.addColorStop(0.12, 'rgba(200, 216, 255, 0.6)');
      moon.addColorStop(1, 'rgba(160, 190, 255, 0)');
      ctx.fillStyle = moon;
      ctx.fillRect(600, 0, 340, 320);
      ctx.beginPath();
      ctx.arc(760, 130, 26, 0, Math.PI * 2);
      ctx.fillStyle = '#e8eeff';
      ctx.fill();
      // 建筑剪影
      let x = -30;
      while (x < 1060) {
        const width = rand(rand01, 60, 150);
        const top = rand(rand01, 200, 430);
        ctx.fillStyle = shade('#0a0e18', rand(rand01, -0.05, 0.12));
        ctx.fillRect(x, top, width, 640 - top);
        // 亮窗
        for (let wy = top + 18; wy < 620; wy += 26) {
          for (let wx = x + 12; wx < x + width - 14; wx += 22) {
            if (rand01() < 0.34) {
              ctx.fillStyle = rgba('#ffcf8a', rand(rand01, 0.25, 0.85));
              ctx.fillRect(wx, wy, 8, 11);
            }
          }
        }
        x += width + rand(rand01, 6, 22);
      }
      // 街道与车灯
      ctx.fillStyle = 'rgba(6, 8, 14, 0.85)';
      ctx.fillRect(0, 540, 1024, 100);
      for (let i = 0; i < 46; i += 1) {
        const bx = rand(rand01, 0, 1024);
        const by = rand(rand01, 430, 610);
        const r = rand(rand01, 6, 26);
        const glow = ctx.createRadialGradient(bx, by, 0, bx, by, r);
        glow.addColorStop(0, rgba(rand01() > 0.3 ? '#ffc47a' : '#8fb6ff', rand(rand01, 0.3, 0.75)));
        glow.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(bx, by, r, 0, Math.PI * 2);
        ctx.fill();
      }
      // 窗框反光
      const sheen = ctx.createLinearGradient(0, 0, 1024, 640);
      sheen.addColorStop(0, 'rgba(180, 205, 255, 0.14)');
      sheen.addColorStop(0.4, 'rgba(180, 205, 255, 0)');
      sheen.addColorStop(1, 'rgba(255, 190, 120, 0.08)');
      ctx.fillStyle = sheen;
      ctx.fillRect(0, 0, 1024, 640);
      addGrain(ctx, 1024, 640, 5);
    },
    { repeat: [1, 1], wrap: false },
  );
}

/** 霓虹字：透明底 + 发光文字。 */
export function makeNeonTexture(text: string, color: string, width = 512, height = 192): THREE.CanvasTexture {
  return canvasTexture(
    width,
    height,
    (ctx) => {
      ctx.clearRect(0, 0, width, height);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `600 74px 'Zilux2 Sans SC', 'Microsoft YaHei', sans-serif`;
      ctx.shadowColor = color;
      for (const [blur, alpha] of [
        [42, 0.55],
        [22, 0.8],
        [10, 0.95],
      ] as Array<[number, number]>) {
        ctx.shadowBlur = blur;
        ctx.fillStyle = rgba(color, alpha);
        ctx.fillText(text, width / 2, height / 2);
      }
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#fff6e6';
      ctx.font = `500 70px 'Zilux2 Sans SC', 'Microsoft YaHei', sans-serif`;
      ctx.fillText(text, width / 2, height / 2);
    },
    { wrap: false },
  );
}

/** 竖版海报：几何构成 + 大标题 + 小字印刷。 */
export function makePosterArtTexture(options: {
  title: string;
  subtitle: string;
  accent: string;
  variant: number;
}): THREE.CanvasTexture {
  const { title, subtitle, accent, variant } = options;
  return canvasTexture(
    640,
    900,
    (ctx) => {
      const rand01 = hashSeed(`poster-${variant}-${title}`);
      ctx.fillStyle = '#161110';
      ctx.fillRect(0, 0, 640, 900);
      const accentDark = shade(accent, -0.42);
      const grad = ctx.createLinearGradient(0, 0, 640, 900);
      grad.addColorStop(0, shade(accent, -0.12));
      grad.addColorStop(0.55, accentDark);
      grad.addColorStop(1, '#0d0a08');
      ctx.fillStyle = grad;
      ctx.fillRect(46, 46, 548, 808);
      // 几何构成（按 variant 变化）
      ctx.save();
      ctx.beginPath();
      ctx.rect(46, 46, 548, 808);
      ctx.clip();
      if (variant % 3 === 0) {
        const sun = ctx.createRadialGradient(400, 300, 10, 400, 300, 260);
        sun.addColorStop(0, rgba('#ffe9c4', 0.85));
        sun.addColorStop(1, 'rgba(255, 233, 196, 0)');
        ctx.fillStyle = sun;
        ctx.fillRect(0, 0, 640, 900);
        ctx.fillStyle = 'rgba(255, 240, 210, 0.85)';
        ctx.beginPath();
        ctx.arc(400, 300, 92, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(18, 12, 9, 0.72)';
        for (let i = 0; i < 7; i += 1) {
          ctx.fillRect(46, 170 + i * 54, 548, 8 + i * 1.4);
        }
      } else if (variant % 3 === 1) {
        ctx.translate(320, 330);
        for (let ring = 0; ring < 9; ring += 1) {
          ctx.strokeStyle = rgba(ring % 2 === 0 ? '#f4dcae' : '#1a120c', 0.35);
          ctx.lineWidth = 10;
          ctx.beginPath();
          ctx.arc(0, 0, 40 + ring * 30, -0.6, Math.PI * 1.3);
          ctx.stroke();
        }
      } else {
        for (let i = 0; i < 15; i += 1) {
          ctx.fillStyle = rgba(rand01() > 0.5 ? '#f4dcae' : '#231812', rand(rand01, 0.12, 0.4));
          const w = rand(rand01, 30, 260);
          const h = rand(rand01, 6, 22);
          ctx.fillRect(rand(rand01, 60, 580), rand(rand01, 80, 560), w, h);
        }
        ctx.strokeStyle = 'rgba(244, 220, 174, 0.5)';
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(60, 620);
        ctx.bezierCurveTo(220, 420, 380, 760, 580, 500);
        ctx.stroke();
      }
      // 文案
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255, 244, 226, 0.92)';
      ctx.font = `600 62px 'Zilux2 Sans SC', 'Microsoft YaHei', sans-serif`;
      const words = title.split('');
      let line = '';
      let y = 690;
      for (const char of words) {
        const next = line + char;
        if (ctx.measureText(next).width > 470 && line) {
          ctx.fillText(line, 78, y);
          y += 70;
          line = char;
        } else {
          line = next;
        }
      }
      if (line) ctx.fillText(line, 78, y);
      ctx.fillStyle = 'rgba(255, 244, 226, 0.55)';
      ctx.font = `400 24px 'Zilux2 Sans SC', 'Microsoft YaHei', sans-serif`;
      ctx.fillText(subtitle, 80, y + 60);
      ctx.fillStyle = 'rgba(255, 244, 226, 0.3)';
      ctx.font = `400 18px 'Zilux2 Sans SC', 'Microsoft YaHei', sans-serif`;
      ctx.fillText('ZILUX2 RECORDS · EST. 2026', 80, 828);
      ctx.restore();
      ctx.strokeStyle = 'rgba(255, 232, 196, 0.3)';
      ctx.lineWidth = 4;
      ctx.strokeRect(46, 46, 548, 808);
      addGrain(ctx, 640, 900, 4);
    },
    { wrap: false },
  );
}

const COVER_ACCENT = ['#8a5a34', '#7a4a34', '#5a6a4a', '#45586a', '#6a4a5e', '#8a6a3a'];



/** 叶片：绿色渐变 + 中脉。 */
export function makeLeafTexture(): THREE.CanvasTexture {
  return canvasTexture(
    128,
    256,
    (ctx) => {
      ctx.clearRect(0, 0, 128, 256);
      const grad = ctx.createLinearGradient(0, 0, 0, 256);
      grad.addColorStop(0, '#5f7a52');
      grad.addColorStop(0.55, '#3f5a3e');
      grad.addColorStop(1, '#243527');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(64, 4);
      ctx.bezierCurveTo(118, 60, 110, 180, 64, 252);
      ctx.bezierCurveTo(18, 180, 10, 60, 64, 4);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(220, 236, 190, 0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(64, 12);
      ctx.lineTo(64, 244);
      ctx.stroke();
      for (let i = 0; i < 8; i += 1) {
        const y = 40 + i * 26;
        ctx.strokeStyle = 'rgba(220, 236, 190, 0.18)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(64, y);
        ctx.quadraticCurveTo(i % 2 === 0 ? 40 : 88, y + 12, i % 2 === 0 ? 26 : 102, y + 26);
        ctx.stroke();
      }
    },
    { wrap: false },
  );
}

/** 光柱：纵向渐变的柔光锥面贴图（体积光）。 */
export function makeShaftTexture(): THREE.CanvasTexture {
  return canvasTexture(
    64,
    256,
    (ctx) => {
      const grad = ctx.createLinearGradient(0, 0, 0, 256);
      grad.addColorStop(0, 'rgba(255, 226, 178, 0.55)');
      grad.addColorStop(0.35, 'rgba(255, 214, 158, 0.2)');
      grad.addColorStop(1, 'rgba(255, 205, 150, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 64, 256);
      // 两侧柔边
      const edge = ctx.createLinearGradient(0, 0, 64, 0);
      edge.addColorStop(0, 'rgba(0,0,0,1)');
      edge.addColorStop(0.25, 'rgba(0,0,0,0)');
      edge.addColorStop(0.75, 'rgba(0,0,0,0)');
      edge.addColorStop(1, 'rgba(0,0,0,1)');
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = edge;
      ctx.fillRect(0, 0, 64, 256);
      ctx.globalCompositeOperation = 'source-over';
    },
    { wrap: false },
  );
}

/** 唱片封面：六种构图 + 印刷质感，标题排版更接近实体唱片。 */
export function makeCoverArtTexture(
  song: { title: string; artist: string; color?: string } | null,
  index: number,
): THREE.CanvasTexture {
  return canvasTexture(
    512,
    512,
    (ctx) => {
      const rand01 = hashSeed(song ? `${song.title}-${song.artist}` : `empty-${index}`);
      const accent = song?.color ?? COVER_ACCENT[index % COVER_ACCENT.length];
      ctx.fillStyle = '#0d0a08';
      ctx.fillRect(0, 0, 512, 512);
      // 封套外框与纸面质感
      ctx.fillStyle = 'rgba(255, 236, 206, 0.05)';
      ctx.fillRect(12, 12, 488, 488);
      const base = ctx.createLinearGradient(0, 0, 512, 512);
      base.addColorStop(0, shade(accent, 0.12));
      base.addColorStop(0.5, shade(accent, -0.18));
      base.addColorStop(1, shade(accent, -0.62));
      ctx.fillStyle = base;
      ctx.fillRect(22, 22, 468, 468);
      // 封套边框阴影
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.lineWidth = 10;
      ctx.strokeRect(22, 22, 468, 468);
      ctx.strokeStyle = 'rgba(255, 244, 222, 0.14)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(18, 18, 476, 476);
      const variant = index % 6;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, 512, 512);
      ctx.clip();
      if (variant === 0) {
        // 落日
        const sun = ctx.createRadialGradient(340, 180, 8, 340, 180, 240);
        sun.addColorStop(0, rgba('#fff0cc', 0.95));
        sun.addColorStop(1, 'rgba(255,240,204,0)');
        ctx.fillStyle = sun;
        ctx.fillRect(0, 0, 512, 512);
        ctx.beginPath();
        ctx.arc(340, 180, 74, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 240, 204, 0.92)';
        ctx.fill();
        ctx.fillStyle = 'rgba(14, 10, 8, 0.32)';
        for (let i = 0; i < 6; i += 1) ctx.fillRect(0, 200 + i * 34, 512, 6 + i);
      } else if (variant === 1) {
        // 波形
        ctx.strokeStyle = 'rgba(255, 236, 200, 0.5)';
        ctx.lineWidth = 3;
        for (let line = 0; line < 26; line += 1) {
          ctx.beginPath();
          for (let x = 0; x <= 512; x += 16) {
            const y = 256 + Math.sin((x / 512) * Math.PI * 6 + line * 0.32) * (40 + line * 3) + (line - 13) * 9;
            if (x === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      } else if (variant === 2) {
        // 光斑
        for (let i = 0; i < 26; i += 1) {
          const x = rand(rand01, 40, 470);
          const y = rand(rand01, 40, 470);
          const r = rand(rand01, 10, 90);
          const glow = ctx.createRadialGradient(x, y, 0, x, y, r);
          glow.addColorStop(0, rgba(rand01() > 0.4 ? '#fff0cc' : '#1a120c', rand(rand01, 0.15, 0.5)));
          glow.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (variant === 3) {
        // 同心圆
        for (let ring = 0; ring < 12; ring += 1) {
          ctx.strokeStyle = rgba(ring % 2 === 0 ? '#f6e2c0' : '#1a120c', 0.4);
          ctx.lineWidth = 8;
          ctx.beginPath();
          ctx.arc(256, 256, 18 + ring * 22, 0, Math.PI * 2);
          ctx.stroke();
        }
      } else if (variant === 4) {
        // 山形
        ctx.fillStyle = 'rgba(12, 9, 7, 0.5)';
        ctx.beginPath();
        ctx.moveTo(0, 512);
        ctx.lineTo(0, 360);
        ctx.lineTo(120, 260);
        ctx.lineTo(230, 350);
        ctx.lineTo(340, 210);
        ctx.lineTo(512, 380);
        ctx.lineTo(512, 512);
        ctx.closePath();
        ctx.fill();
        const moon = ctx.createRadialGradient(380, 150, 4, 380, 150, 90);
        moon.addColorStop(0, 'rgba(255, 246, 224, 0.9)');
        moon.addColorStop(1, 'rgba(255, 246, 224, 0)');
        ctx.fillStyle = moon;
        ctx.fillRect(250, 20, 260, 260);
      } else {
        // 格栅
        for (let i = 0; i < 18; i += 1) {
          ctx.fillStyle = rgba(i % 2 === 0 ? '#1a120c' : '#f6e2c0', rand(rand01, 0.08, 0.3));
          ctx.fillRect(0, i * 30, 512, rand(rand01, 6, 20));
        }
        ctx.strokeStyle = 'rgba(255, 240, 210, 0.35)';
        ctx.lineWidth = 2;
        ctx.strokeRect(40, 40, 432, 432);
      }
      // 印刷颗粒与暗角
      addGrain(ctx, 512, 512, 6);
      const vig = ctx.createRadialGradient(256, 256, 150, 256, 256, 400);
      vig.addColorStop(0, 'rgba(0,0,0,0)');
      vig.addColorStop(1, 'rgba(0,0,0,0.45)');
      ctx.fillStyle = vig;
      ctx.fillRect(0, 0, 512, 512);
      ctx.fillStyle = 'rgba(12, 9, 6, 0.12)';
      ctx.fillRect(0, 0, 512, 512);
      ctx.restore();

      // 文字排版
      if (song) {
        const titleSize = song.title.length > 12 ? 40 : song.title.length > 8 ? 46 : 54;
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.55)';
        ctx.shadowBlur = 14;
        ctx.shadowOffsetY = 3;
        ctx.fillStyle = 'rgba(255, 248, 236, 0.95)';
        ctx.font = `600 ${titleSize}px 'Zilux2 Sans SC', 'Microsoft YaHei', sans-serif`;
        const maxWidth = 396;
        const lines: string[] = [];
        let current = '';
        for (const char of song.title) {
          const next = current + char;
          if (ctx.measureText(next).width > maxWidth && current) {
            lines.push(current);
            current = char;
          } else {
            current = next;
          }
        }
        if (current) lines.push(current);
        let lineY = 492;
        for (const line of lines.slice(0, 2)) {
          ctx.fillText(line, 44, lineY);
          lineY += titleSize * 1.1;
        }
        ctx.restore();
        ctx.fillStyle = 'rgba(255, 244, 226, 0.72)';
        ctx.font = `400 19px 'Zilux2 Sans SC', 'Microsoft YaHei', sans-serif`;
        ctx.fillText(song.artist.slice(0, 20), 46, 512 - 70);
        ctx.fillStyle = 'rgba(255, 244, 226, 0.4)';
        ctx.font = `400 13px 'Zilux2 Sans SC', 'Microsoft YaHei', sans-serif`;
        ctx.textAlign = 'right';
        ctx.fillText(`ZLX-${String(index + 1).padStart(3, '0')}`, 512 - 46, 512 - 44);
        ctx.textAlign = 'left';
        ctx.fillText('ZILUX2 RECORDS', 46, 512 - 44);
      } else {
        ctx.fillStyle = 'rgba(255, 246, 232, 0.86)';
        ctx.textAlign = 'center';
        ctx.font = `500 42px 'Zilux2 Sans SC', 'Microsoft YaHei', sans-serif`;
        ctx.fillText('待载入', 256, 270);
        ctx.fillStyle = 'rgba(255, 246, 232, 0.4)';
        ctx.font = `400 18px 'Zilux2 Sans SC', 'Microsoft YaHei', sans-serif`;
        ctx.fillText('ZILUX2 RECORDS', 256, 316);
      }
    },
    { wrap: false },
  );
}

/** 黑胶唱片：沟槽 + 中心标签。 */
export function makeVinylDiscTexture(): THREE.CanvasTexture {
  return canvasTexture(
    512,
    512,
    (ctx) => {
      ctx.fillStyle = '#0d0b0a';
      ctx.fillRect(0, 0, 512, 512);
      for (let ring = 0; ring < 90; ring += 1) {
        ctx.strokeStyle = rgba(ring % 9 === 0 ? '#3a332c' : '#1d1916', ring % 9 === 0 ? 0.5 : 0.35);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(256, 256, 236 - ring * 2.4, 0, Math.PI * 2);
        ctx.stroke();
      }
      const sheen = ctx.createLinearGradient(0, 0, 512, 512);
      sheen.addColorStop(0, 'rgba(255, 240, 210, 0.16)');
      sheen.addColorStop(0.45, 'rgba(255, 240, 210, 0.02)');
      sheen.addColorStop(1, 'rgba(255, 240, 210, 0.12)');
      ctx.fillStyle = sheen;
      ctx.fillRect(0, 0, 512, 512);
      const label = ctx.createRadialGradient(256, 256, 8, 256, 256, 64);
      label.addColorStop(0, '#d8b071');
      label.addColorStop(1, '#8a6134');
      ctx.fillStyle = label;
      ctx.beginPath();
      ctx.arc(256, 256, 64, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1a120c';
      ctx.beginPath();
      ctx.arc(256, 256, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(26, 18, 12, 0.75)';
      ctx.font = `500 22px 'Zilux2 Sans SC', 'Microsoft YaHei', sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('ZILUX2', 256, 238);
      ctx.font = `400 11px 'Zilux2 Sans SC', 'Microsoft YaHei', sans-serif`;
      ctx.fillText('33⅓ RPM', 256, 258);
    },
    { wrap: false },
  );
}

/**
 * R3：后墙「分类牌」贴图（今日推荐 / 我喜欢的音乐 / …）。
 * 深色纸面 + 铜色描边 + 黑胶图标，风格与店内一致。
 */
export function makeMenuBoardTexture(options: {
  title: string;
  subtitle?: string;
  count: number;
  index: number;
  decorative?: boolean;
}): THREE.CanvasTexture {
  const { title, subtitle = '', count, index, decorative = false } = options;
  const accents = ['#8fb3a6', '#c9a068', '#9a7fb0', '#7f9bb5', '#b58b7a', '#a8a06a'];
  const accent = accents[index % accents.length];
  return canvasTexture(
    512,
    384,
    (ctx) => {
      ctx.fillStyle = '#15100c';
      ctx.fillRect(0, 0, 512, 384);
      const bg = ctx.createLinearGradient(0, 0, 512, 384);
      bg.addColorStop(0, shade(accent, -0.6));
      bg.addColorStop(1, '#0d0a08');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, 512, 384);

      const rand01 = hashSeed(`${title}-${index}`);
      for (let i = 0; i < 260; i += 1) {
        ctx.fillStyle = `rgba(255, 238, 210, ${0.012 + rand01() * 0.02})`;
        ctx.fillRect(rand01() * 512, rand01() * 384, 1 + rand01() * 2, 1 + rand01() * 2);
      }

      ctx.strokeStyle = 'rgba(199, 162, 104, 0.5)';
      ctx.lineWidth = 3;
      ctx.strokeRect(18, 18, 476, 348);
      ctx.strokeStyle = 'rgba(255, 236, 200, 0.12)';
      ctx.lineWidth = 1;
      ctx.strokeRect(26, 26, 460, 332);

      if (decorative) {
        // 装饰牌：中间一张大黑胶 + 店名，不参与点击
        const dcx = 256;
        const dcy = 168;
        ctx.beginPath();
        ctx.arc(dcx, dcy, 96, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(8, 6, 5, 0.9)';
        ctx.fill();
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2;
        for (let i = 0; i < 4; i += 1) {
          ctx.beginPath();
          ctx.arc(dcx, dcy, 34 + i * 15, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(dcx, dcy, 13, 0, Math.PI * 2);
        ctx.fillStyle = accent;
        ctx.fill();
        ctx.textAlign = 'center';
        ctx.fillStyle = '#f3e6cf';
        ctx.font = '600 44px "Zilux2 Sans SC", "Microsoft YaHei", sans-serif';
        ctx.fillText(title, 256, 306);
        if (subtitle) {
          ctx.fillStyle = 'rgba(232, 214, 184, 0.56)';
          ctx.font = '20px "Zilux2 Sans SC", "Microsoft YaHei", sans-serif';
          ctx.fillText(subtitle, 256, 344);
        }
        return;
      }

      // 黑胶图标
      const cx = 92;
      const cy = 96;
      ctx.beginPath();
      ctx.arc(cx, cy, 34, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(10, 8, 6, 0.85)';
      ctx.fill();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2.5;
      for (let i = 0; i < 3; i += 1) {
        ctx.beginPath();
        ctx.arc(cx, cy, 12 + i * 7, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();

      ctx.fillStyle = '#f3e6cf';
      ctx.font = '600 46px "Zilux2 Sans SC", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(title, 158, 112);
      if (subtitle) {
        ctx.fillStyle = 'rgba(232, 214, 184, 0.6)';
        ctx.font = '22px "Zilux2 Sans SC", "Microsoft YaHei", sans-serif';
        ctx.fillText(subtitle, 160, 150);
      }

      ctx.fillStyle = 'rgba(240, 224, 196, 0.86)';
      ctx.font = '600 26px "Zilux2 Sans SC", "Microsoft YaHei", sans-serif';
      ctx.fillText(`${count} 张`, 40, 322);
      ctx.fillStyle = 'rgba(232, 214, 184, 0.4)';
      ctx.font = '20px "Zilux2 Sans SC", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText('点击进入 →', 472, 322);
    },
    { wrap: false },
  );
}

/** R3：右墙大唱片架的标题牌（歌单名 + 数量 + 页码）。 */
export function makeShelfHeaderTexture(title: string, count: number, page: number, pages: number): THREE.CanvasTexture {
  return canvasTexture(
    1024,
    144,
    (ctx) => {
      ctx.fillStyle = '#160f0b';
      ctx.fillRect(0, 0, 1024, 144);
      const g = ctx.createLinearGradient(0, 0, 1024, 0);
      g.addColorStop(0, 'rgba(201, 160, 104, 0.16)');
      g.addColorStop(0.55, 'rgba(201, 160, 104, 0.03)');
      g.addColorStop(1, 'rgba(201, 160, 104, 0.12)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 1024, 144);
      ctx.strokeStyle = 'rgba(199, 162, 104, 0.42)';
      ctx.lineWidth = 2;
      ctx.strokeRect(10, 10, 1004, 124);
      ctx.fillStyle = '#f2e3c8';
      ctx.font = '600 52px "Zilux2 Sans SC", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(title, 40, 74);
      ctx.fillStyle = 'rgba(236, 216, 184, 0.66)';
      ctx.font = '24px "Zilux2 Sans SC", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(`${count} 张 · 第 ${page + 1}/${pages} 页`, 984, 74);
    },
    { wrap: false },
  );
}
