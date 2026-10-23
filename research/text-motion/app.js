/* 纯字 · 文字动效试验台
 * 按 Zilux2「纯字」档（folia 绘光的文字层）的观感重做的 8 组文字动效，纯 Canvas 2D，独立网页。
 * 结构：文案时间轴 → 字形精灵缓存 → 8 种动效绘制 → 舞台/控件。
 */
(() => {
  'use strict';

  /* ───────────────────────── 基础 ───────────────────────── */

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const railEl = document.getElementById('rail');
  const badgeName = document.getElementById('badgeName');
  const badgeDesc = document.getElementById('badgeDesc');
  const stageLine = document.getElementById('stageLine');
  const stageFill = document.getElementById('stageFill');
  const clockEl = document.getElementById('clock');
  const playBtn = document.getElementById('playBtn');
  const playIcon = document.getElementById('playIcon');
  const replayBtn = document.getElementById('replayBtn');
  const speedEl = document.getElementById('speed');
  const speedOut = document.getElementById('speedOut');
  const glowEl = document.getElementById('glow');
  const glowOut = document.getElementById('glowOut');
  const spacingEl = document.getElementById('spacing');
  const spacingOut = document.getElementById('spacingOut');
  const keywordEl = document.getElementById('keyword');
  const echoEl = document.getElementById('echo');

  const DPR = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const FONT_STACK = '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, -apple-system, "Segoe UI", sans-serif';
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3);
  const easeOutBack = (p) => {
    const c = 1.70158;
    const u = p - 1;
    return 1 + (c + 1) * u * u * u + c * u * u;
  };
  const smoothstep = (p) => {
    const u = clamp01(p);
    return u * u * (3 - 2 * u);
  };
  const lerp = (a, b, p) => a + (b - a) * p;
  const hash = (n) => {
    let x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  };

  const COLORS = {
    gold: '#f3d39a',
    goldDeep: '#e0ae62',
    dim: '#8a919b',
    dimDeep: '#5f6670',
    keyword: '#ffb27d',
    ink: '#f6f1e7',
    neonA: '#6ee7ff',
    neonB: '#c084fc',
  };

  /* ───────────────────────── 文案与时间轴 ───────────────────────── */

  const TEXT_LINES = [
    { text: '光落下来，字就有了形状', keywords: ['光', '形状'], en: false },
    { text: 'Every word glows like light on water', keywords: ['glows', 'light'], en: true },
    { text: '把这句歌慢慢唱散', keywords: ['慢慢', '唱散'], en: false },
    { text: '让回声在夜里漂一会儿', keywords: ['回声', '夜里'], en: false },
    { text: '字在光里醒来，又在光里睡去', keywords: ['醒来', '睡去'], en: false },
    { text: 'We are made of light and dust', keywords: ['light', 'dust'], en: true },
    { text: '唱到最后一句也舍不得停', keywords: ['最后', '舍不得'], en: false },
    { text: '于是让每个字都亮一次', keywords: ['每个字', '亮'], en: false },
  ];

  const LEAD_MS = 280; // 行首留白
  const TAIL_MS = 980; // 行尾留白（用于崩解）
  const GAP_MS = 220; // 行间距时间
  const LINE_TARGET_MS = 3900; // 每句大致时长：长句按字均分，短句最多 190ms/字

  const LINES = [];
  let totalMs = 0;
  for (const src of TEXT_LINES) {
    const chars = Array.from(src.text);
    const start = totalMs;
    const charStart = start + LEAD_MS;
    const charMs = Math.max(74, Math.min(190, (LINE_TARGET_MS - LEAD_MS - TAIL_MS) / chars.length));
    const charEndBase = charStart + chars.length * charMs;
    const items = [];
    let keywordRanges = [];
    for (const kw of src.keywords ?? []) {
      const at = src.text.indexOf(kw);
      if (at >= 0) keywordRanges.push({ from: at, to: at + kw.length });
    }
    for (let i = 0; i < chars.length; i += 1) {
      const isSpace = chars[i] === ' ';
      const cStart = charStart + i * charMs;
      items.push({
        ch: chars[i],
        isSpace,
        index: i,
        start: cStart,
        end: cStart + charMs,
        keyword: keywordRanges.some((range) => i >= range.from && i < range.to),
      });
    }
    const end = charEndBase + TAIL_MS;
    LINES.push({ text: src.text, en: src.en, chars: items, start, charEnd: charEndBase, end });
    totalMs = end + GAP_MS;
  }
  totalMs += 400;

  /* ───────────────────────── 状态 ───────────────────────── */

  const view = {
    t: 0,
    playing: true,
    speed: 1,
    glow: 1,
    spacing: 0.62,
    keyword: true,
    echo: true,
    variant: 0,
    scene: 0,
    last: performance.now(),
  };

  const layout = {
    width: 0,
    height: 0,
    dpr: DPR,
    size: 64,
    lineGap: 132,
    centerY: 0,
    lines: [],
  };

  /* ───────────────────────── 字形精灵缓存 ───────────────────────── */

  const spriteCache = new Map();
  const SPRITE_LIMIT = 900;

  function makeSprite(ch, size, color, options = {}) {
    const glow = options.glow ?? 0;
    const blur = options.blur ?? 0;
    const stroke = options.stroke ?? false;
    const scale = options.scale ?? 1;
    const px = Math.max(10, Math.round(size * scale * DPR));
    const pad = Math.ceil(blur * DPR) + 6;
    const font = `${options.weight ?? 600} ${px}px ${FONT_STACK}`;
    const key = `${ch}|${px}|${color}|${glow}|${blur}|${stroke}|${options.weight ?? 600}`;
    const hit = spriteCache.get(key);
    if (hit) return hit;

    const probe = document.createElement('canvas').getContext('2d');
    probe.font = font;
    const metrics = probe.measureText(ch);
    const w = Math.ceil(metrics.width) + pad * 2;
    const h = Math.ceil(px * 1.36) + pad * 2;
    const cv = document.createElement('canvas');
    cv.width = Math.max(2, w);
    cv.height = Math.max(2, h);
    const g = cv.getContext('2d');
    g.font = font;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if (glow > 0) {
      g.shadowColor = color;
      g.shadowBlur = blur * DPR * glow;
    }
    if (stroke) {
      g.strokeStyle = color;
      g.lineWidth = Math.max(1, px * 0.035);
      for (let pass = 0; pass < (glow > 0 ? 2 : 1); pass += 1) {
        g.strokeText(ch, cv.width / 2, cv.height / 2);
      }
    } else {
      g.fillStyle = color;
      g.fillText(ch, cv.width / 2, cv.height / 2);
      if (glow > 0.4) {
        g.globalAlpha = 0.55;
        g.fillText(ch, cv.width / 2, cv.height / 2);
        g.globalAlpha = 1;
      }
    }
    const sprite = { canvas: cv, w: cv.width, h: cv.height, size: px };
    if (spriteCache.size > SPRITE_LIMIT) spriteCache.clear();
    spriteCache.set(key, sprite);
    return sprite;
  }

  /* ───────────────────────── 排版 ───────────────────────── */

  function measureLayout() {
    const rect = canvas.getBoundingClientRect();
    layout.width = Math.max(1, rect.width);
    layout.height = Math.max(1, rect.height);
    canvas.width = Math.round(layout.width * DPR);
    canvas.height = Math.round(layout.height * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    const baseSize = Math.min(layout.height * 0.185, layout.width * 0.115, 118);
    const probe = document.createElement('canvas').getContext('2d');
    layout.lines = LINES.map((line) => {
      // 先按基准字号量，超宽再整体缩
      probe.font = `600 ${baseSize}px ${FONT_STACK}`;
      let size = baseSize;
      let widths = line.chars.map((item) => (item.isSpace ? size * 0.34 : probe.measureText(item.ch).width));
      let total = widths.reduce((sum, value) => sum + value, 0) + size * view.spacing * Math.max(0, line.chars.length - 1);
      const maxW = layout.width * 0.86;
      if (total > maxW) {
        size *= maxW / total;
        probe.font = `600 ${size}px ${FONT_STACK}`;
        widths = line.chars.map((item) => (item.isSpace ? size * 0.34 : probe.measureText(item.ch).width));
        total = widths.reduce((sum, value) => sum + value, 0) + size * view.spacing * Math.max(0, line.chars.length - 1);
      }
      const gap = size * view.spacing;
      let cursor = -total / 2;
      const cells = [];
      for (let i = 0; i < line.chars.length; i += 1) {
        const width = widths[i];
        cells.push({ x: cursor + width / 2, width });
        cursor += width + gap;
      }
      return { size, total, cells, gap };
    });

    layout.size = layout.lines[0]?.size ?? 64;
    layout.lineGap = layout.size * 1.72;
    layout.centerY = layout.height * 0.535;
  }

  /* ───────────────────────── 特效池 ───────────────────────── */

  let sparkles = [];
  let ghosts = [];
  let motes = [];
  let lineSpawn = new Map();

  function resetEffects() {
    sparkles = [];
    ghosts = [];
    motes = [];
    lineSpawn.clear();
  }

  function spawnSparkle(x, y, size, color, strength) {
    sparkles.push({ x, y, size, color, life: 0, max: 520 + Math.random() * 260, strength });
  }

  function spawnGhost(ch, x, y, size, color, drift, alpha) {
    if (!view.echo && !color) return;
    if (ghosts.length > 90) ghosts.shift();
    ghosts.push({ ch, x, y, size, color, life: 0, max: 2600 + Math.random() * 2200, drift, alpha, rot: (Math.random() - 0.5) * 0.5 });
  }

  function spawnMotes(x, y, size, color, count, spread) {
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = (0.35 + Math.random() * 0.9) * spread;
      motes.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - spread * 0.25,
        size: 1 + Math.random() * 2.4,
        color,
        life: 0,
        max: 900 + Math.random() * 1100,
        alpha: 0.25 + Math.random() * 0.5,
      });
    }
    if (motes.length > 260) motes.splice(0, motes.length - 260);
  }

  function ageEffects(dt) {
    sparkles = sparkles.filter((item) => (item.life += dt) < item.max);
    ghosts = ghosts.filter((item) => (item.life += dt) < item.max);
    motes = motes.filter((item) => {
      item.life += dt;
      item.x += item.vx * dt * 0.06;
      item.y += item.vy * dt * 0.06;
      item.vy += 0.004 * dt * 0.06;
      return item.life < item.max;
    });
  }

  function drawEffects(activeColor) {
    // 残影（空心字）
    for (const ghost of ghosts) {
      const p = ghost.life / ghost.max;
      const alpha = ghost.alpha * (1 - p) * (1 - p);
      if (alpha <= 0.004) continue;
      const sprite = makeSprite(ghost.ch, ghost.size, ghost.color ?? COLORS.dim, { stroke: true, glow: 0.3, blur: 8, weight: 600 });
      ctx.save();
      ctx.translate(ghost.x + ghost.drift.x * p, ghost.y + ghost.drift.y * p);
      ctx.rotate(ghost.rot * p);
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(sprite.canvas, -sprite.w / 2, -sprite.h / 2, sprite.w, sprite.h);
      ctx.restore();
    }
    // 粒子
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const mote of motes) {
      const p = mote.life / mote.max;
      ctx.globalAlpha = mote.alpha * (1 - p);
      ctx.fillStyle = mote.color ?? activeColor;
      ctx.beginPath();
      ctx.arc(mote.x, mote.y, mote.size * (1 - p * 0.4), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    // 四芒星
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const star of sparkles) {
      const p = star.life / star.max;
      const alpha = Math.sin(Math.min(1, p) * Math.PI) * star.strength;
      if (alpha <= 0.01) continue;
      drawStar(star.x, star.y, star.size * (0.7 + p * 0.7), alpha, star.color);
    }
    ctx.restore();
  }

  function drawStar(x, y, radius, alpha, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(0.8, radius * 0.05);
    ctx.beginPath();
    ctx.moveTo(0, -radius);
    ctx.lineTo(0, radius);
    ctx.moveTo(-radius, 0);
    ctx.lineTo(radius, 0);
    ctx.stroke();
    ctx.globalAlpha = alpha * 0.8;
    ctx.beginPath();
    const diag = radius * 0.42;
    ctx.moveTo(-diag, -diag);
    ctx.lineTo(diag, diag);
    ctx.moveTo(diag, -diag);
    ctx.lineTo(-diag, diag);
    ctx.stroke();
    ctx.restore();
  }

  /* ───────────────────────── 公共绘制 ───────────────────────── */

  function drawSprite(ch, size, x, y, alpha, color, options = {}) {
    if (!ch || ch === ' ') return;
    const sprite = makeSprite(ch, size, color, options);
    const scale = options.drawScale ?? 1;
    const w = (sprite.w / DPR) * scale;
    const h = (sprite.h / DPR) * scale;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    if (options.blend) ctx.globalCompositeOperation = options.blend;
    if (options.scaleX !== undefined || options.scaleY !== undefined) {
      ctx.translate(x, y);
      ctx.scale(options.scaleX ?? 1, options.scaleY ?? 1);
      ctx.drawImage(sprite.canvas, -w / 2, -h / 2, w, h);
    } else if (options.rotate) {
      ctx.translate(x, y);
      ctx.rotate(options.rotate);
      ctx.drawImage(sprite.canvas, -w / 2, -h / 2, w, h);
    } else {
      ctx.drawImage(sprite.canvas, x - w / 2, y - h / 2, w, h);
    }
    ctx.restore();
  }

  function linePhase(line, t) {
    const inP = clamp01((t - line.start) / 420);
    const outAge = t - line.end;
    const outP = clamp01(outAge / 1100);
    return { inP, outAge, outP, visible: t >= line.start - 260 && t <= line.end + 1100 };
  }

  function charState(line, index, char, t) {
    const age = t - char.start;
    const reveal = clamp01((t - char.start) / 200);
    const lit = smoothstep((t - char.start) / 240);
    const flashAge = age;
    let flash = 0;
    if (flashAge >= 0 && flashAge < 160) flash = smoothstep(flashAge / 90);
    else if (flashAge >= 160) flash = Math.max(0, 1 - (flashAge - 160) / 420);
    const sung = t >= char.end;
    return { age, reveal, lit, flash, sung };
  }

  function baseY() {
    return layout.centerY;
  }

  function drawNeighborLine(lineIndex, t) {
    const line = LINES[lineIndex];
    if (!line) return;
    const phase = linePhase(line, t);
    if (!phase.visible) return;
    const offset = lineIndex * layout.lineGap;
    const cellData = layout.lines[lineIndex];
    const activeIndex = activeLineIndex(t);
    const y = baseY() + (lineIndex - activeIndex) * layout.lineGap;
    for (let i = 0; i < line.chars.length; i += 1) {
      const item = line.chars[i];
      if (item.isSpace) continue;
      const state = charState(line, i, item, t);
      const alpha = 0.16 + state.lit * 0.16;
      drawSprite(item.ch, cellData.size * 0.9, layout.width / 2 + cellData.cells[i].x, y, alpha * (1 - phase.outP), COLORS.dimDeep, {
        glow: 0.2,
        blur: 10 * view.glow,
      });
    }
  }

  function activeLineIndex(t) {
    for (let i = LINES.length - 1; i >= 0; i -= 1) {
      if (t >= LINES[i].start - 260) return i;
    }
    return 0;
  }

  /* ───────────────────────── 变体 1：经典绘光 ───────────────────────── */

  function drawClassic(line, t, phase) {
    const activeIndex = activeLineIndex(t);
    const cellData = layout.lines[activeIndex];
    const y = baseY();
    const centerX = layout.width / 2;
    for (let i = 0; i < line.chars.length; i += 1) {
      const item = line.chars[i];
      if (item.isSpace) continue;
      const state = charState(line, i, item, t);
      const cell = cellData.cells[i];
      const x = centerX + cell.x;
      const inLift = (1 - easeOutCubic(state.reveal)) * cellData.size * 0.38;
      const yy = y + inLift;
      const outDrift = phase.outP;
      const dir = i % 2 === 0 ? 1 : -1;
      const ox = dir * outDrift * cellData.size * 0.5 * (0.4 + hash(i + line.start) * 0.8);
      const oy = -outDrift * cellData.size * 0.5 * (0.5 + hash(i * 3 + line.start) * 0.8);
      const alpha = (0.34 + state.lit * 0.66) * (1 - outDrift);
      const keyword = view.keyword && item.keyword;
      const color = state.lit > 0.5 ? (keyword ? COLORS.keyword : COLORS.gold) : keyword ? '#a98a72' : COLORS.dim;
      const scale = (0.92 + 0.08 * easeOutCubic(state.reveal)) * (keyword ? 1.07 : 1);
      drawSprite(item.ch, cellData.size, x + ox, yy + oy, alpha, color, {
        glow: 0.35 + state.lit * 1.15 * view.glow,
        blur: (8 + state.lit * 26) * view.glow,
        drawScale: scale,
        weight: 600,
      });
      if (state.flash > 0.25 && state.lit > 0.2 && !item.isSpace) {
        spawnSparkle(x, yy - cellData.size * 0.12, cellData.size * 0.34, COLORS.gold, state.flash * 0.85);
      }
      if (state.reveal > 0.95 && view.echo && state.age > 0 && state.age < 16) {
        for (let g = 0; g < 1; g += 1) {
          spawnGhost(item.ch, x + (Math.random() - 0.5) * 14, yy - cellData.size * 0.15, cellData.size * 0.92, COLORS.goldDeep, {
            x: (Math.random() - 0.5) * 26,
            y: -18 - Math.random() * 26,
          }, 0.13);
        }
      }
      if (phase.outAge > 0 && phase.outAge < 40) {
        spawnMotes(x, yy, cellData.size, COLORS.goldDeep, 2, 0.9);
      }
    }
  }

  /* ───────────────────────── 变体 2：霓虹呼吸 ───────────────────────── */

  function drawNeon(line, t, phase) {
    const activeIndex = activeLineIndex(t);
    const cellData = layout.lines[activeIndex];
    const y = baseY();
    const centerX = layout.width / 2;
    const breathe = 1 + Math.sin(t * 0.0021) * 0.012;
    ctx.save();
    ctx.translate(centerX, y);
    ctx.scale(breathe, breathe);
    ctx.translate(-centerX, -y);
    for (let i = 0; i < line.chars.length; i += 1) {
      const item = line.chars[i];
      if (item.isSpace) continue;
      const state = charState(line, i, item, t);
      const cell = cellData.cells[i];
      const pulse = 1 + Math.sin(t * 0.0032 + i * 0.5) * 0.03;
      const hue = 196 + i * 4.2 + (t * 0.018) % 60;
      const litColor = state.lit > 0.45 ? `hsl(${hue}, 96%, ${68 + state.flash * 12}%)` : `hsl(${hue}, 30%, 44%)`;
      const x = centerX + cell.x + (1 - easeOutCubic(state.reveal)) * cellData.size * 0.12 * (i % 2 ? 1 : -1);
      const yy = y + (1 - easeOutCubic(state.reveal)) * cellData.size * 0.2;
      const alpha = (0.32 + state.lit * 0.68) * (1 - phase.outP);
      drawSprite(item.ch, cellData.size, x, yy, alpha, litColor, {
        glow: 0.5 + state.lit * 1.3 * view.glow,
        blur: (10 + state.lit * 30) * view.glow,
        drawScale: scaleOf(state, cellData.size) * pulse,
      });
      if (state.flash > 0.3) spawnSparkle(x, yy - cellData.size * 0.1, cellData.size * 0.26, COLORS.neonA, state.flash * 0.6);
      if (phase.outAge > 0 && phase.outAge < 46) spawnMotes(x, yy, cellData.size, COLORS.neonB, 1, 0.7);
    }
    ctx.restore();
  }

  function scaleOf(state, size) {
    return 0.9 + 0.1 * easeOutCubic(state.reveal) + state.flash * 0.04;
  }

  /* ───────────────────────── 变体 3：回响残影 ───────────────────────── */

  function drawEcho(line, t, phase) {
    const activeIndex = activeLineIndex(t);
    const cellData = layout.lines[activeIndex];
    const y = baseY();
    const centerX = layout.width / 2;
    for (let i = 0; i < line.chars.length; i += 1) {
      const item = line.chars[i];
      if (item.isSpace) continue;
      const state = charState(line, i, item, t);
      const cell = cellData.cells[i];
      const x = centerX + cell.x;
      const alpha = (0.32 + state.lit * 0.68) * (1 - phase.outP);
      const color = state.sung ? COLORS.gold : state.lit > 0.5 ? (view.keyword && item.keyword ? COLORS.keyword : COLORS.gold) : COLORS.dim;
      const drift = (t - item.end) * 0.02;
      // 唱过的字变成空心字，还留在原位慢慢漂——这一组和「经典绘光」的区别就在这里
      drawSprite(item.ch, cellData.size, x, y - (state.sung ? Math.min(6, drift) : 0), state.sung ? alpha * 0.92 : alpha, color, {
        glow: state.sung ? 1.1 * view.glow : 0.2,
        blur: state.sung ? 22 * view.glow : 8,
        drawScale: 0.94 + state.lit * 0.1,
        stroke: state.sung,
      });
      if (state.age > 0 && state.age < 18 && state.reveal > 0.6) {
        spawnGhost(item.ch, x + (Math.random() - 0.5) * 10, y - cellData.size * 0.6, cellData.size * 0.86, COLORS.gold, {
          x: (Math.random() - 0.5) * 40,
          y: -30 - Math.random() * 30,
        }, 0.34);
      }
      if (state.flash > 0.2) spawnSparkle(x, y - cellData.size * 0.5, cellData.size * 0.3, COLORS.gold, state.flash * 0.7);
    }
  }

  /* ───────────────────────── 变体 4：碎裂聚合 ───────────────────────── */

  function drawScatter(line, t, phase) {
    const activeIndex = activeLineIndex(t);
    const cellData = layout.lines[activeIndex];
    const y = baseY();
    const centerX = layout.width / 2;
    const stagger = 26;
    for (let i = 0; i < line.chars.length; i += 1) {
      const item = line.chars[i];
      if (item.isSpace) continue;
      const state = charState(line, i, item, t);
      const cell = cellData.cells[i];
      const seed = hash(i * 7 + line.start);
      const localP = easeOutBack(clamp01((t - line.start - i * stagger) / 520));
      const inX = (1 - localP) * cellData.size * (seed > 0.5 ? 6 : -6);
      const inY = (1 - localP) * cellData.size * (hash(i * 3 + line.start) * 8 - 4);
      const inRot = (1 - localP) * (seed - 0.5) * 2.2;
      const outP = phase.outP;
      const outSeed = hash(i * 11 + line.start);
      const ox = outP * cellData.size * (outSeed > 0.5 ? 5 : -5);
      const oy = -outP * cellData.size * (1.4 + outSeed * 3);
      const alpha = (0.34 + state.lit * 0.66) * (1 - outP);
      const color = state.lit > 0.5 ? (view.keyword && item.keyword ? COLORS.keyword : COLORS.gold) : COLORS.dim;
      drawSprite(item.ch, cellData.size, centerX + cell.x + inX + ox, y + inY + oy, alpha, color, {
        glow: 0.3 + state.lit * 1.1 * view.glow,
        blur: (8 + state.lit * 24) * view.glow,
        drawScale: 0.86 + 0.14 * localP,
        rotate: inRot + outP * (outSeed - 0.5) * 1.6,
      });
      if (phase.outAge > 0 && phase.outAge < 50) spawnMotes(centerX + cell.x, y, cellData.size, COLORS.goldDeep, 1, 1.1);
      if (state.flash > 0.3) spawnSparkle(centerX + cell.x, y - cellData.size * 0.1, cellData.size * 0.28, COLORS.gold, state.flash * 0.7);
    }
  }

  /* ───────────────────────── 变体 5：3D 翻转 ───────────────────────── */

  function drawFlip(line, t, phase) {
    const activeIndex = activeLineIndex(t);
    const cellData = layout.lines[activeIndex];
    const y = baseY();
    const centerX = layout.width / 2;
    for (let i = 0; i < line.chars.length; i += 1) {
      const item = line.chars[i];
      if (item.isSpace) continue;
      const state = charState(line, i, item, t);
      const cell = cellData.cells[i];
      const flipStart = item.start + i * 18;
      const flipP = clamp01((t - flipStart) / 420);
      // 翻满一整圈回到正面：0 → 360°，否则翻到 180° 后会一直停在背面
      const angle = flipP * Math.PI * 2;
      // 翻完之后继续做很轻的 Y 轴摆动（卡片一直在慢慢转），这样静帧也读得出 3D
      const sway = 0.16 * (0.5 + 0.5 * Math.sin(t * 0.0016 + i * 0.55));
      const scaleX = Math.cos(angle) * (1 - sway);
      const depth = Math.sin(angle);
      const front = scaleX >= 0;
      const flash = state.flash;
      const color = front ? (state.lit > 0.4 ? (view.keyword && item.keyword ? COLORS.keyword : COLORS.gold) : COLORS.dim) : COLORS.dimDeep;
      const alpha = (0.38 + (front ? state.lit * 0.62 : 0.2)) * (1 - phase.outP);
      // 翻面时用一层向后偏移的暗字当「厚度」，转起来像一张有厚度的卡片
      if (Math.abs(scaleX) < 0.985) {
        drawSprite(item.ch, cellData.size * 0.99, centerX + cell.x, y + Math.sign(depth || 1) * cellData.size * 0.05, alpha * 0.4, COLORS.dimDeep, {
          glow: 0.15,
          blur: 6,
          drawScale: 1,
          scaleX: Math.max(0.02, Math.abs(scaleX)),
        });
      }
      drawSprite(item.ch, cellData.size, centerX + cell.x, y, alpha, color, {
        glow: front ? 0.3 + state.lit * 1.1 * view.glow : 0.15,
        blur: front ? (8 + state.lit * 26) * view.glow : 8,
        drawScale: 1,
        scaleX: Math.max(0.02, Math.abs(scaleX)),
        rotate: 0,
      });
      if (flash > 0.3 && front) spawnSparkle(centerX + cell.x, y - cellData.size * 0.1, cellData.size * 0.24, COLORS.gold, flash * 0.7);
      if (phase.outAge > 0 && phase.outAge < 40) spawnMotes(centerX + cell.x, y, cellData.size, COLORS.goldDeep, 1, 0.8);
    }
  }

  /* ───────────────────────── 变体 6：波浪流 ───────────────────────── */

  function drawWave(line, t, phase) {
    const activeIndex = activeLineIndex(t);
    const cellData = layout.lines[activeIndex];
    const centerX = layout.width / 2;
    const y = baseY();
    for (let i = 0; i < line.chars.length; i += 1) {
      const item = line.chars[i];
      if (item.isSpace) continue;
      const state = charState(line, i, item, t);
      const cell = cellData.cells[i];
      const x = centerX + cell.x;
      const wave = Math.sin(x * 0.0042 - t * 0.0026) * cellData.size * 0.22;
      const wave2 = Math.cos(x * 0.0021 + t * 0.0018) * cellData.size * 0.08;
      const yy = y + wave + wave2 + (1 - easeOutCubic(state.reveal)) * cellData.size * 0.3;
      const alpha = (0.32 + state.lit * 0.68) * (1 - phase.outP);
      const color = state.lit > 0.45 ? (view.keyword && item.keyword ? COLORS.keyword : COLORS.gold) : COLORS.dim;
      drawSprite(item.ch, cellData.size, x, yy, alpha, color, {
        glow: 0.25 + state.lit * 1.05 * view.glow,
        blur: (8 + state.lit * 22) * view.glow,
        drawScale: 0.92 + 0.08 * state.lit + Math.sin(t * 0.002 + i * 0.3) * 0.015,
      });
      if (state.flash > 0.3) spawnSparkle(x, yy - cellData.size * 0.15, cellData.size * 0.22, COLORS.gold, state.flash * 0.6);
      if (phase.outAge > 0 && phase.outAge < 40) spawnMotes(x, yy, cellData.size, COLORS.goldDeep, 1, 0.9);
    }
  }

  /* ───────────────────────── 变体 7：打字机 ───────────────────────── */

  function drawType(line, t, phase) {
    const activeIndex = activeLineIndex(t);
    const cellData = layout.lines[activeIndex];
    const y = baseY();
    const centerX = layout.width / 2;
    const typed = line.chars.filter((item) => t >= item.start).length;
    let caretX = centerX - cellData.total / 2;
    for (let i = 0; i < line.chars.length; i += 1) {
      const item = line.chars[i];
      if (t < item.start) continue;
      const cell = cellData.cells[i];
      caretX = centerX + cell.x + cell.width * 0.62;
      if (item.isSpace) continue;
      const age = t - item.start;
      const jitter = age < 90 ? (hash(i * 5 + line.start) - 0.5) * cellData.size * 0.06 : 0;
      const lit = smoothstep(age / 160);
      const color = view.keyword && item.keyword ? COLORS.keyword : COLORS.gold;
      drawSprite(item.ch, cellData.size, centerX + cell.x + jitter, y + (1 - easeOutCubic(lit)) * cellData.size * 0.12, (0.5 + lit * 0.5) * (1 - phase.outP), color, {
        glow: 0.3 + lit * 0.9 * view.glow,
        blur: (8 + lit * 20) * view.glow,
        drawScale: 0.96 + lit * 0.04,
      });
      if (age < 120 && age > 0) spawnSparkle(centerX + cell.x, y - cellData.size * 0.2, cellData.size * 0.2, COLORS.gold, 0.5);
    }
    // 光标
    const typing = typed < line.chars.length;
    const blink = Math.sin(t * 0.012) > -0.2;
    if (blink || typing) {
      const alpha = typing ? 0.9 : 0.4 * (0.5 + 0.5 * Math.sin(t * 0.012));
      ctx.save();
      ctx.globalAlpha = Math.max(0, alpha * (1 - phase.outP));
      ctx.fillStyle = COLORS.gold;
      const h = cellData.size * 0.9;
      ctx.fillRect(caretX + cellData.size * 0.06, y - h / 2, Math.max(2, cellData.size * 0.045), h);
      ctx.restore();
    }
  }

  /* ───────────────────────── 变体 8：棱镜分光 ───────────────────────── */

  function drawPrism(line, t, phase) {
    const activeIndex = activeLineIndex(t);
    const cellData = layout.lines[activeIndex];
    const y = baseY();
    const centerX = layout.width / 2;
    const sep = (view.glow * 0.9 + 0.4) * (2.4 + Math.sin(t * 0.002) * 1.2);
    for (let i = 0; i < line.chars.length; i += 1) {
      const item = line.chars[i];
      if (item.isSpace) continue;
      const state = charState(line, i, item, t);
      const cell = cellData.cells[i];
      const x = centerX + cell.x;
      const alpha = (0.32 + state.lit * 0.68) * (1 - phase.outP);
      const scale = 0.92 + state.lit * 0.1;
      const offset = sep * (1 + state.flash * 0.7);
      const drawChannel = (color, dx) => {
        drawSprite(item.ch, cellData.size, x + dx, y, alpha * 0.55, color, {
          glow: 0.3,
          blur: 12 * view.glow,
          drawScale: scale,
          blend: 'lighter',
        });
      };
      drawChannel('rgba(255, 90, 90, 0.9)', -offset);
      drawChannel('rgba(90, 255, 160, 0.9)', 0);
      drawChannel('rgba(110, 150, 255, 0.9)', offset);
      const coreColor = state.lit > 0.4 ? (view.keyword && item.keyword ? COLORS.keyword : COLORS.ink) : COLORS.dim;
      drawSprite(item.ch, cellData.size, x, y, alpha, coreColor, {
        glow: 0.25 + state.lit * 0.7 * view.glow,
        blur: (6 + state.lit * 16) * view.glow,
        drawScale: scale,
      });
      if (state.flash > 0.35) spawnSparkle(x, y - cellData.size * 0.1, cellData.size * 0.3, '#ffffff', state.flash * 0.55);
      if (phase.outAge > 0 && phase.outAge < 40) spawnMotes(x, y, cellData.size, '#9fd0ff', 1, 0.8);
    }
  }

  /* ───────────────────────── 变体定义 ───────────────────────── */

  const VARIANTS = [
    {
      name: '经典绘光',
      desc: '逐字升起、金色点亮、四芒星与句末崩解',
      draw: drawClassic,
      accent: COLORS.gold,
    },
    {
      name: '霓虹呼吸',
      desc: '青紫流转、整句轻轻呼吸、字距微错',
      draw: drawNeon,
      accent: COLORS.neonA,
    },
    {
      name: '回响残影',
      desc: '唱过的字化成空心字，慢慢漂走',
      draw: drawEcho,
      accent: COLORS.gold,
    },
    {
      name: '碎裂聚合',
      desc: '字从四面八方飞来拼成一句，唱完再炸开',
      draw: drawScatter,
      accent: COLORS.gold,
    },
    {
      name: '3D 翻转',
      desc: '逐字翻牌点亮，明暗两面交替',
      draw: drawFlip,
      accent: COLORS.gold,
    },
    {
      name: '波浪流',
      desc: '整行沿波流动，点亮像浪一样推过去',
      draw: drawWave,
      accent: COLORS.gold,
    },
    {
      name: '打字机',
      desc: '一个字一个字敲出来，带光标与轻抖',
      draw: drawType,
      accent: COLORS.gold,
    },
    {
      name: '棱镜分光',
      desc: 'RGB 色散叠在字上，点亮时收拢成白光',
      draw: drawPrism,
      accent: '#cfe3ff',
    },
  ];

  /* ───────────────────────── 背景 ───────────────────────── */

  function drawBackdrop(t, accent) {
    const w = layout.width;
    const h = layout.height;
    ctx.clearRect(0, 0, w, h);

    const base = ctx.createRadialGradient(w * 0.5, h * 0.52, 40, w * 0.5, h * 0.52, Math.max(w, h) * 0.72);
    base.addColorStop(0, 'rgba(28, 27, 32, 0.9)');
    base.addColorStop(0.55, 'rgba(11, 12, 16, 0.95)');
    base.addColorStop(1, 'rgba(4, 5, 7, 1)');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);

    // 缓慢漂移的光晕
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const blobs = [
      { x: 0.32 + Math.sin(t * 0.00013) * 0.05, y: 0.36 + Math.cos(t * 0.00017) * 0.04, r: 0.5, a: 0.05, c: accent },
      { x: 0.74 + Math.cos(t * 0.00011) * 0.06, y: 0.62 + Math.sin(t * 0.00015) * 0.05, r: 0.42, a: 0.04, c: '#7f8fff' },
    ];
    for (const blob of blobs) {
      const grad = ctx.createRadialGradient(w * blob.x, h * blob.y, 0, w * blob.x, h * blob.y, Math.max(w, h) * blob.r);
      grad.addColorStop(0, hexToRgba(blob.c, blob.a));
      grad.addColorStop(1, hexToRgba(blob.c, 0));
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.restore();

    // 上下暗角
    const top = ctx.createLinearGradient(0, 0, 0, h * 0.3);
    top.addColorStop(0, 'rgba(0, 0, 0, 0.55)');
    top.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = top;
    ctx.fillRect(0, 0, w, h * 0.3);
    const bottom = ctx.createLinearGradient(0, h * 0.7, 0, h);
    bottom.addColorStop(0, 'rgba(0, 0, 0, 0)');
    bottom.addColorStop(1, 'rgba(0, 0, 0, 0.62)');
    ctx.fillStyle = bottom;
    ctx.fillRect(0, h * 0.7, w, h * 0.3);
  }

  function hexToRgba(hex, alpha) {
    const value = hex.replace('#', '');
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  /* ───────────────────────── 主循环 ───────────────────────── */

  function drawFrame(now) {
    const dt = Math.min(64, now - view.last);
    view.last = now;
    if (view.playing) {
      view.t += dt * view.speed;
      if (view.t > totalMs) {
        view.t = 0;
        resetEffects();
      }
    }
    const accent = VARIANTS[view.variant].accent;
    drawBackdrop(view.t, accent);

    const active = activeLineIndex(view.t);
    const line = LINES[active];
    const phase = linePhase(line, view.t);

    // 邻句（上下各一句，暗字）
    for (let offset = -1; offset <= 1; offset += 1) {
      if (offset === 0) continue;
      const index = active + offset;
      if (index < 0 || index >= LINES.length) continue;
      drawNeighborLine(index, view.t);
    }

    ctx.save();
    // 只画当前句
    if (phase.visible) {
      VARIANTS[view.variant].draw(line, view.t, phase);
    }
    ctx.restore();

    drawEffects(accent);
    ageEffects(dt);
    updateHud(active);
    requestAnimationFrame(drawFrame);
  }

  /* ───────────────────────── HUD / 控件 ───────────────────────── */

  let hudLast = '';
  function updateHud(active) {
    const line = LINES[active];
    const percent = clamp01((view.t - line.start) / Math.max(1, line.end - line.start));
    stageFill.style.width = `${(percent * 100).toFixed(1)}%`;
    const label = `第 ${active + 1} / ${LINES.length} 句 · ${line.text}`;
    if (label !== hudLast) {
      hudLast = label;
      stageLine.textContent = label;
    }
    clockEl.textContent = `${formatTime(view.t)} / ${formatTime(totalMs)}`;
    playIcon.textContent = view.playing ? '❚❚' : '▶';
  }

  function formatTime(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const mm = Math.floor(total / 60);
    const ss = total % 60;
    return `${mm}:${String(ss).padStart(2, '0')}`;
  }

  function selectVariant(index) {
    view.variant = ((index % VARIANTS.length) + VARIANTS.length) % VARIANTS.length;
    resetEffects();
    view.t = LINES[activeLineIndex(view.t)]?.start ?? 0;
    for (const [i, child] of [...railEl.children].entries()) {
      child.classList.toggle('is-on', i === view.variant);
    }
    badgeName.textContent = VARIANTS[view.variant].name;
    badgeDesc.textContent = VARIANTS[view.variant].desc;
  }

  function buildRail() {
    railEl.textContent = '';
    VARIANTS.forEach((variant, index) => {
      const button = document.createElement('button');
      button.className = 'item';
      button.type = 'button';
      const idx = document.createElement('span');
      idx.className = 'idx';
      idx.textContent = String(index + 1).padStart(2, '0');
      const body = document.createElement('span');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = variant.name;
      const desc = document.createElement('span');
      desc.className = 'desc';
      desc.textContent = variant.desc;
      body.append(name, desc);
      button.append(idx, body);
      button.addEventListener('click', () => selectVariant(index));
      railEl.append(button);
    });
  }

  /* ───────────────────────── 事件 ───────────────────────── */

  function bind() {
    playBtn.addEventListener('click', () => {
      view.playing = !view.playing;
      view.last = performance.now();
    });
    replayBtn.addEventListener('click', () => {
      view.t = 0;
      view.playing = true;
      resetEffects();
    });
    speedEl.addEventListener('input', () => {
      view.speed = Number(speedEl.value);
      speedOut.textContent = `${view.speed.toFixed(2)}×`;
    });
    glowEl.addEventListener('input', () => {
      view.glow = Number(glowEl.value);
      glowOut.textContent = view.glow.toFixed(2);
    });
    spacingEl.addEventListener('input', () => {
      view.spacing = Number(spacingEl.value);
      spacingOut.textContent = view.spacing.toFixed(2);
      measureLayout();
      resetEffects();
    });
    keywordEl.addEventListener('change', () => {
      view.keyword = keywordEl.checked;
    });
    echoEl.addEventListener('change', () => {
      view.echo = echoEl.checked;
      if (!view.echo) ghosts = [];
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === ' ') {
        event.preventDefault();
        view.playing = !view.playing;
        view.last = performance.now();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        selectVariant(view.variant + 1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        selectVariant(view.variant - 1);
      } else if (event.key === 'r' || event.key === 'R') {
        view.t = 0;
        view.playing = true;
        resetEffects();
      }
    });
    const observer = new ResizeObserver(() => {
      measureLayout();
      resetEffects();
    });
    observer.observe(canvas);
  }

  /* ───────────────────────── 启动 ───────────────────────── */

  buildRail();
  bind();
  measureLayout();
  selectVariant(0);

  // 方便截图 / 直达某一组：?v=3&t=5200&paused=1（v 从 1 开始）
  const params = new URLSearchParams(location.search);
  const wanted = Number(params.get('v') ?? '0');
  if (Number.isFinite(wanted) && wanted > 0) selectVariant(wanted - 1);
  const startAt = Number(params.get('t') ?? '0');
  if (Number.isFinite(startAt) && startAt > 0) view.t = startAt;
  if (params.get('paused') === '1') view.playing = false;

  view.last = performance.now();
  requestAnimationFrame(drawFrame);
})();
