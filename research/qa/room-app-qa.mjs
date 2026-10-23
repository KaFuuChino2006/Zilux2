#!/usr/bin/env node
/**
 * room-app-qa.mjs — 真实 app 内「歌词页 · 播放效果 = 房间」验收流水线
 *
 * 前提：Zilux2.exe 以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 启动
 *       （research/qa/room-app-qa.ps1 会负责构建/部署/启动）。
 *
 * 流程：
 *   1. 连 http://127.0.0.1:9223 找 page target（app 的 WebView2），Runtime/Log/Page.enable
 *   2. localStorage 'zilux2.lumiere'='room'，Page.reload，等首页与「最近播放」渲染
 *   3. 点最近播放里优先 "Warm (feat. Mia)"（找不到就第一行），最多等 20s 进入播放状态
 *   4. 点 .pb-btn-lyrics 打开歌词页，等 .lyrics-view / .lyrics-stage.is-room，最多 8s 等 is-painted
 *   5. 按时间点截图（默认 立即/+4s/+8s/+15s/+25s）到 research/shots/app-room-<序号>-<秒>s.png
 *   6. rAF 采样 1.5s 算 FPS；每张截图同时采 DOM 统计
 *   7. 收集 console / exception / Log.entryAdded；输出 research/tmp/room-app-qa.json 并打印摘要
 *
 * 退出码：0 = OK；1 = BLOCKED（reason 写进 JSON 与 stderr）。
 * 无第三方依赖（CDP 用与 research/qa/cdp.mjs 相同的手写 WebSocket）。
 *
 * 用法（参数均可选）：
 *   node room-app-qa.mjs
 *   node room-app-qa.mjs --times=0,4,8,15,25 --json=E:\...\room-app-qa.json --shots-dir=E:\...\research\shots
 *   node room-app-qa.mjs --endpoint=http://127.0.0.1:9223
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..');

/* ══════════════════════════════════════════════════════════════════════
 * 参数 / 基础工具
 * ══════════════════════════════════════════════════════════════════════ */

function defaultOptions() {
  return {
    endpoint: process.env.CDP_ENDPOINT || 'http://127.0.0.1:9223',
    times: [0, 4, 8, 15, 25],
    json: path.join(PROJECT_ROOT, 'research', 'tmp', 'room-app-qa.json'),
    shotsDir: path.join(PROJECT_ROOT, 'research', 'shots'),
    homeTimeoutMs: 35000,
    playTimeoutMs: 20000,
    lyricsTimeoutMs: 10000,
    paintTimeoutMs: 8000,
    fpsWindowMs: 1500,
    help: false,
  };
}

function parseTimes(raw) {
  const list = String(raw)
    .split(/[,;\s]+/)
    .map((part) => Number(part))
    .filter((num) => Number.isFinite(num) && num >= 0)
    .map((num) => Math.round(num));
  const unique = [...new Set(list)];
  return unique.length > 0 ? unique.sort((a, b) => a - b) : defaultOptions().times;
}

function parseArgs(argv) {
  const opts = defaultOptions();
  const numberArg = (name, value) => {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) throw new Error(`参数 ${name} 需要正数，收到: ${value}`);
    return num;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw || raw === '--') continue;
    const eq = raw.indexOf('=');
    const key = eq >= 0 ? raw.slice(0, eq) : raw;
    const inline = eq >= 0 ? raw.slice(eq + 1) : undefined;
    const takeValue = () => {
      if (inline !== undefined) return inline;
      const next = argv[(i += 1)];
      if (next === undefined) throw new Error(`参数 ${key} 缺少值`);
      return next;
    };
    switch (key) {
      case '--times':
        opts.times = parseTimes(takeValue());
        break;
      case '--endpoint':
        opts.endpoint = takeValue().replace(/\/+$/, '');
        break;
      case '--json':
        opts.json = path.resolve(takeValue());
        break;
      case '--shots-dir':
        opts.shotsDir = path.resolve(takeValue());
        break;
      case '--home-timeout':
        opts.homeTimeoutMs = numberArg(key, takeValue());
        break;
      case '--play-timeout':
        opts.playTimeoutMs = numberArg(key, takeValue());
        break;
      case '--lyrics-timeout':
        opts.lyricsTimeoutMs = numberArg(key, takeValue());
        break;
      case '--paint-timeout':
        opts.paintTimeoutMs = numberArg(key, takeValue());
        break;
      case '--fps-window':
        opts.fpsWindowMs = numberArg(key, takeValue());
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`未知参数: ${raw}（--help 看用法）`);
    }
  }
  return opts;
}

const log = (msg) => console.log(`[room-qa] ${msg}`);
const warn = (msg) => {
  console.warn(`[room-qa] WARN ${msg}`);
  report.warnings.push(`[${new Date().toISOString()}] ${msg}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const sleepUntil = async (deadline) => sleep(deadline - Date.now());

function fmtBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** PNG 只读 IHDR 里的宽高，不完整解码（避免引入依赖）。 */
function pngSize(buf) {
  if (!buf || buf.length < 24) return { width: null, height: null, pngHeaderOk: false };
  const signatureOk =
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a;
  if (!signatureOk) return { width: null, height: null, pngHeaderOk: false };
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), pngHeaderOk: true };
}

class FatalError extends Error {
  constructor(reason, message, extra = {}) {
    super(message);
    this.name = 'FatalError';
    this.reason = reason;
    this.extra = extra;
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 报告状态（全部写进 JSON）
 * ══════════════════════════════════════════════════════════════════════ */

const report = {
  schema: 'zilux2-room-app-qa/1',
  status: 'RUNNING',
  reason: null,
  message: null,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  durationMs: null,
  projectRoot: PROJECT_ROOT,
  node: process.version,
  endpoint: null,
  target: null,
  targetsSeen: [],
  options: null,
  steps: {},
  fps: {},
  samples: [],
  shots: [],
  console: [],
  errors: [],
  warnings: [],
  fatal: null,
};

let opts = defaultOptions();
let cdp = null;

/* ══════════════════════════════════════════════════════════════════════
 * 手写 CDP 客户端（同 research/qa/cdp.mjs 方案，无依赖）
 * ══════════════════════════════════════════════════════════════════════ */

class CDP {
  constructor(url, onEvent) {
    this.url = url;
    this.onEvent = onEvent;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = null;
    this.closed = false;
  }

  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP WebSocket 连接超时: ${this.url}`)), 10000);
      this.ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      this.ws.addEventListener(
        'error',
        (event) => {
          clearTimeout(timer);
          reject(new Error(`CDP WebSocket 错误: ${event.message || event.type || 'unknown'}`));
        },
        { once: true },
      );
    });
    this.ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'));
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`CDP ${msg.error.message || JSON.stringify(msg.error)}`));
        else resolve(msg.result);
        return;
      }
      if (msg.method && this.onEvent) {
        try {
          this.onEvent(msg);
        } catch {
          /* 事件解析失败不影响主流程 */
        }
      }
    });
    this.ws.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('CDP WebSocket 已关闭'));
      this.pending.clear();
    });
    return this;
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error(`CDP 已关闭，无法发送 ${method}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时(${timeoutMs}ms): ${method}`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  close() {
    try {
      this.ws && this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 页面内表达式
 * ══════════════════════════════════════════════════════════════════════ */

const HOME_EXPR = `(() => {
  const rows = [...document.querySelectorAll('.recent-item')];
  const app = document.querySelector('.app');
  const homeHost = document.querySelector('.home-host');
  const splash = document.querySelector('.splash');
  const bodyText = (document.body.innerText || '').slice(0, 4000);
  const items = rows.slice(0, 16).map((el, index) => {
    const nameEl = el.querySelector('.recent-name');
    const artistEl = el.querySelector('.recent-artist');
    return {
      index,
      title: el.getAttribute('title') || '',
      name: nameEl ? nameEl.textContent || '' : '',
      artist: artistEl ? artistEl.textContent || '' : '',
    };
  });
  return {
    ok: !!app && rows.length > 0,
    app: !!app,
    rows: rows.length,
    recentSection: !!document.querySelector('.home-recent'),
    homeHidden: homeHost ? homeHost.classList.contains('is-hidden') : null,
    splash: !!splash,
    bootFailed: /启动失败/.test(bodyText),
    bodyHead: bodyText.slice(0, 240),
    readyState: document.readyState,
    href: location.href,
    items,
  };
})()`;

const PLAYING_EXPR = `(() => {
  const main = document.querySelector('.pb-btn.is-main');
  const svg = main ? main.querySelector('svg') : null;
  const tags = svg ? [...svg.children].map((el) => el.tagName.toLowerCase()) : [];
  const bar = document.querySelector('.playerbar');
  const titleEl = document.querySelector('.pb-title');
  const artistEl = document.querySelector('.pb-artist');
  const times = [...document.querySelectorAll('.pb-progress .pb-time')].map((el) => (el.textContent || '').trim());
  const fill = document.querySelector('.pb-progress .track-fill');
  const toasts = [...document.querySelectorAll('.toast')].map((el) => (el.textContent || '').trim()).filter(Boolean).slice(-4);
  const playing = tags.filter((tag) => tag === 'rect').length >= 2;
  return {
    ok: playing,
    playing,
    mainSvgTags: tags,
    barClass: bar ? String(bar.className) : null,
    idle: bar ? bar.classList.contains('is-idle') : null,
    title: titleEl ? titleEl.textContent : null,
    artist: artistEl ? artistEl.textContent : null,
    time: times[0] || null,
    duration: times[1] || null,
    fillWidth: fill ? fill.style.width : null,
    toasts,
  };
})()`;

const CLICK_RECENT_EXPR = `(() => {
  const rows = [...document.querySelectorAll('.recent-item')];
  if (rows.length === 0) return { ok: false, reason: 'no-recent-rows' };
  const info = rows.slice(0, 16).map((el, index) => {
    const nameEl = el.querySelector('.recent-name');
    const artistEl = el.querySelector('.recent-artist');
    return {
      index,
      title: el.getAttribute('title') || '',
      name: nameEl ? nameEl.textContent || '' : '',
      artist: artistEl ? artistEl.textContent || '' : '',
    };
  });
  const isPreferred = (item) => {
    const hay = (item.title + ' ' + item.name).toLowerCase();
    return hay.includes('warm') && (hay.includes('mia') || hay.includes('feat'));
  };
  let index = info.findIndex(isPreferred);
  const matchedPreferred = index >= 0;
  if (index < 0) index = 0;
  const el = rows[index];
  const rect = el.getBoundingClientRect();
  el.click();
  return {
    ok: true,
    index,
    matchedPreferred,
    count: rows.length,
    chosen: info[index],
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    items: info,
  };
})()`;

const OPEN_LYRICS_EXPR = `(() => {
  const btn =
    document.querySelector('.pb-btn-lyrics') ||
    [...document.querySelectorAll('.pb-btn')].find((el) => /词/.test(el.textContent || ''));
  if (!btn) return { ok: false, reason: 'lyrics-button-missing' };
  const rect = btn.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
  btn.dispatchEvent(new PointerEvent('pointerdown', init));
  return {
    ok: true,
    buttonClass: String(btn.className),
    buttonText: (btn.textContent || '').trim(),
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    viewNow: !!document.querySelector('.lyrics-view'),
  };
})()`;

const ROOM_EXPR = `(() => {
  const rectOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      display: cs.display, opacity: cs.opacity, visibility: cs.visibility,
    };
  };
  const view = document.querySelector('.lyrics-view');
  const stages = [...document.querySelectorAll('.lyrics-stage')];
  const stageList = stages.map((el) => ({
    cls: String(el.className),
    rect: rectOf(el),
    canvas: el.querySelectorAll('canvas').length,
    painted: el.classList.contains('is-painted'),
    failed: el.classList.contains('is-failed'),
  }));
  let room = null;
  let fallback = null;
  if (view) {
    const inView = [...view.querySelectorAll('.lyrics-stage')];
    room = inView.find((el) => el.classList.contains('is-room')) || null;
    if (!room) {
      const candidates = inView.filter((el) => !el.classList.contains('is-pure'));
      if (candidates.length === 1) {
        room = candidates[0];
        fallback = 'single-non-pure-stage';
      } else if (candidates.length > 0) {
        fallback = 'multiple-non-pure-stages';
      }
    }
  }
  const painted = room ? room.classList.contains('is-painted') : false;
  const failed = room ? room.classList.contains('is-failed') : false;
  return {
    ok: !!view && !!room,
    viewExists: !!view,
    viewClass: view ? String(view.className) : null,
    room: room
      ? {
          cls: String(room.className),
          rect: rectOf(room),
          painted,
          failed,
          isOn: room.classList.contains('is-on'),
          isReady: room.classList.contains('is-ready'),
          isContent: room.classList.contains('is-content'),
          canvas: room.querySelectorAll('canvas').length,
          children: room.children.length,
        }
      : null,
    fallback,
    paintDone: painted || failed,
    stageList,
  };
})()`;

const STATS_EXPR = `(() => {
  const rectOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      display: cs.display, opacity: cs.opacity, visibility: cs.visibility, zIndex: cs.zIndex,
    };
  };
  const view = document.querySelector('.lyrics-view');
  const stages = [...document.querySelectorAll('.lyrics-stage')];
  const stageList = stages.map((el) => ({
    cls: String(el.className),
    rect: rectOf(el),
    canvas: el.querySelectorAll('canvas').length,
    painted: el.classList.contains('is-painted'),
    failed: el.classList.contains('is-failed'),
  }));
  let room = null;
  if (view) {
    const inView = [...view.querySelectorAll('.lyrics-stage')];
    room =
      inView.find((el) => el.classList.contains('is-room')) ||
      inView.find((el) => !el.classList.contains('is-pure')) ||
      null;
  }
  let canvasInfo = null;
  let glInfo = null;
  if (room) {
    const canvas = room.querySelector('canvas');
    if (canvas) {
      canvasInfo = {
        count: room.querySelectorAll('canvas').length,
        width: canvas.width,
        height: canvas.height,
        clientWidth: canvas.clientWidth,
        clientHeight: canvas.clientHeight,
        rect: rectOf(canvas),
        styleWidth: canvas.style.width,
        styleHeight: canvas.style.height,
      };
      try {
        const gl =
          canvas.getContext('webgl2') ||
          canvas.getContext('webgl') ||
          canvas.getContext('experimental-webgl');
        if (gl) {
          glInfo = {
            version: gl.getParameter(gl.VERSION),
            renderer: gl.getParameter(gl.RENDERER),
            contextLost: typeof gl.isContextLost === 'function' ? gl.isContextLost() : null,
          };
        }
      } catch (error) {
        glInfo = { error: String((error && error.message) || error) };
      }
    }
  }
  const main = document.querySelector('.pb-btn.is-main');
  const mainSvg = main ? main.querySelector('svg') : null;
  const mainTags = mainSvg ? [...mainSvg.children].map((el) => el.tagName.toLowerCase()) : [];
  const times = [...document.querySelectorAll('.pb-progress .pb-time')].map((el) => (el.textContent || '').trim());
  const fill = document.querySelector('.pb-progress .track-fill');
  const bar = document.querySelector('.playerbar');
  const titleEl = document.querySelector('.pb-title');
  const artistEl = document.querySelector('.pb-artist');
  const lyricsBtn = document.querySelector('.pb-btn-lyrics');
  const zlrWordEls = room ? [...room.querySelectorAll('.zlr-word')] : [];
  const zlrTitleEl =
    (room ? room.querySelector('.zlr-title') : null) ||
    document.querySelector('.lyrics-view .zlr-title') ||
    document.querySelector('.zlr-title');
  const words = room
    ? room.querySelectorAll('[data-word], .word, .room-word, .lumiere-word, .lyrics-word, .zlr-word').length
    : 0;
  const describeEl = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || ''),
      text: (el.textContent || '').trim().slice(0, 200),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      fontSize: cs.fontSize,
      fontFamily: cs.fontFamily,
      fontWeight: cs.fontWeight,
      color: cs.color,
      opacity: cs.opacity,
      display: cs.display,
      position: cs.position,
      zIndex: cs.zIndex,
      transform: cs.transform === 'none' ? 'none' : String(cs.transform).slice(0, 140),
      visibility: cs.visibility,
      overflow: cs.overflow,
    };
  };
  const barRect = bar ? bar.getBoundingClientRect() : null;
  const zlrTitleRect = zlrTitleEl ? zlrTitleEl.getBoundingClientRect() : null;
  let titleBarOverlap = null;
  if (zlrTitleRect && barRect) {
    const ix = Math.max(0, Math.min(zlrTitleRect.right, barRect.right) - Math.max(zlrTitleRect.left, barRect.left));
    const iy = Math.max(0, Math.min(zlrTitleRect.bottom, barRect.bottom) - Math.max(zlrTitleRect.top, barRect.top));
    titleBarOverlap = { w: Math.round(ix), h: Math.round(iy), area: Math.round(ix * iy) };
  }
  const domInfo = {
    zlrWordCount: zlrWordEls.length,
    zlrWordCountDoc: document.querySelectorAll('.zlr-word').length,
    zlrTitle: describeEl(zlrTitleEl),
    zlrWords: zlrWordEls.slice(0, 4).map(describeEl),
    lyricsFrame: describeEl(document.querySelector('.lyrics-frame')),
    playerbar: describeEl(bar),
    titleBarOverlap,
  };
  let mode = null;
  try {
    mode = localStorage.getItem('zilux2.lumiere');
  } catch (error) {
    mode = 'ERR:' + String(error);
  }
  return {
    at: Date.now(),
    href: location.href,
    readyState: document.readyState,
    visibilityState: document.visibilityState,
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio || 1 },
    mode,
    appClass: (() => {
      const app = document.querySelector('.app');
      return app ? String(app.className) : null;
    })(),
    view: view
      ? {
          cls: String(view.className),
          rect: rectOf(view),
          fresh: view.classList.contains('is-lumiere-fresh'),
          isRoom: view.classList.contains('is-room'),
          isLumiere: view.classList.contains('is-lumiere'),
          stageCount: view.querySelectorAll('.lyrics-stage').length,
        }
      : null,
    room: room
      ? {
          cls: String(room.className),
          rect: rectOf(room),
          children: room.children.length,
          painted: room.classList.contains('is-painted'),
          failed: room.classList.contains('is-failed'),
          isOn: room.classList.contains('is-on'),
          isReady: room.classList.contains('is-ready'),
          isContent: room.classList.contains('is-content'),
        }
      : null,
    stageList,
    canvas: canvasInfo,
    gl: glInfo,
    wordCount: words,
    lyric: {
      lines: view ? view.querySelectorAll('.lyric-line').length : 0,
      active: view ? view.querySelectorAll('.lyric-line.is-active, .lyric-line.is-now').length : 0,
      frame: !!document.querySelector('.lyrics-frame'),
    },
    dom: domInfo,
    player: {
      mainSvgTags: mainTags,
      playingByIcon: mainTags.filter((tag) => tag === 'rect').length >= 2,
      barClass: bar ? String(bar.className) : null,
      idle: bar ? bar.classList.contains('is-idle') : null,
      title: titleEl ? titleEl.textContent : null,
      artist: artistEl ? artistEl.textContent : null,
      time: times[0] || null,
      duration: times[1] || null,
      fillWidth: fill ? fill.style.width : null,
      lyricsButtonClass: lyricsBtn ? String(lyricsBtn.className) : null,
    },
    splash: !!document.querySelector('.splash'),
    bootFailed: /启动失败/.test((document.body.innerText || '').slice(0, 2000)),
    toasts: [...document.querySelectorAll('.toast')].map((el) => (el.textContent || '').trim()).filter(Boolean).slice(-4),
  };
})()`;

const FPS_EXPR = `new Promise((resolve) => {
  const windowMs = ${Number(opts.fpsWindowMs)} || 1500;
  const deltas = [];
  let frames = 0;
  let last = 0;
  const start = performance.now();
  const finish = () => {
    const n = deltas.length;
    const sorted = deltas.slice().sort((a, b) => a - b);
    const pct = (p) => (n === 0 ? null : Math.round(sorted[Math.min(n - 1, Math.floor(n * p))] * 10) / 10);
    const sum = sorted.reduce((acc, value) => acc + value, 0);
    const elapsed = performance.now() - start;
    resolve({
      frames,
      elapsedMs: Math.round(elapsed),
      fps: Math.round((frames / (elapsed / 1000)) * 10) / 10,
      avgFrameMs: n === 0 ? null : Math.round((sum / n) * 10) / 10,
      p50FrameMs: pct(0.5),
      p95FrameMs: pct(0.95),
      maxFrameMs: n === 0 ? null : Math.round(sorted[n - 1] * 10) / 10,
      longFrames: sorted.filter((value) => value > 33.4).length,
      visibilityState: document.visibilityState,
    });
  };
  const tick = (now) => {
    frames += 1;
    if (last > 0) deltas.push(now - last);
    last = now;
    if (now - start >= windowMs) {
      finish();
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  setTimeout(() => {
    if (frames === 0 || deltas.length === 0) finish();
  }, windowMs + 3000);
})`;

/* ══════════════════════════════════════════════════════════════════════
 * CDP 封装：连接 / evaluate / 截图 / 轮询
 * ══════════════════════════════════════════════════════════════════════ */

function argText(arg) {
  if (!arg) return '';
  if (arg.value !== undefined) {
    if (arg.type === 'string') return String(arg.value);
    try {
      return JSON.stringify(arg.value);
    } catch {
      return String(arg.value);
    }
  }
  if (arg.unserializableValue !== undefined) return String(arg.unserializableValue);
  return arg.description || arg.type || '';
}

function onCdpEvent(msg) {
  const method = msg.method;
  const params = msg.params || {};
  if (method === 'Runtime.consoleAPICalled') {
    const text = (params.args || []).map(argText).join(' ');
    const frame = params.stackTrace && params.stackTrace.callFrames && params.stackTrace.callFrames[0];
    report.console.push({
      ts: params.timestamp || Date.now(),
      kind: 'console',
      type: params.type,
      text,
      url: frame ? frame.url : null,
      line: frame ? frame.lineNumber : null,
    });
  } else if (method === 'Runtime.exceptionThrown') {
    const details = params.exceptionDetails || {};
    const exception = details.exception || {};
    report.console.push({
      ts: params.timestamp || Date.now(),
      kind: 'exception',
      type: 'exception',
      text: exception.description || details.text || '(unknown exception)',
      url: details.url || null,
      line: details.lineNumber != null ? details.lineNumber : null,
    });
  } else if (method === 'Log.entryAdded') {
    const entry = params.entry || {};
    report.console.push({
      ts: params.timestamp || Date.now(),
      kind: 'log',
      type: entry.source || 'log',
      level: entry.level || null,
      text: entry.text || '',
      url: entry.url || null,
      line: entry.lineNumber != null ? entry.lineNumber : null,
    });
  }
}

async function fetchJson(url, timeoutMs = 3000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.json();
}

async function findPageTarget(endpoint, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let reached = false;
  let seen = [];
  while (Date.now() < deadline) {
    try {
      const list = await fetchJson(`${endpoint}/json/list`, 3000);
      reached = true;
      const targets = Array.isArray(list) ? list : [];
      seen = targets.map((target) => ({ id: target.id, type: target.type, url: target.url, title: target.title }));
      const pages = targets.filter((target) => target.type === 'page');
      // WebView2 启动最初只有一个 about:blank target，必须等它导航到 app 文档再连，
      // 否则 Runtime.evaluate 会因 about:blank 的不透明源而报 localStorage SecurityError。
      const page =
        pages.find((target) => /zilux2\.local/i.test(String(target.url))) ||
        pages.find((target) => /index\.html/i.test(String(target.url))) ||
        null;
      if (page && page.webSocketDebuggerUrl) return { target: page, targets: seen };
      lastError = new Error('CDP 端点可达，但 app 页面 target 还没出现（当前只有 about:blank 之类的空白页）');
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  report.targetsSeen = seen;
  if (!reached) {
    throw new FatalError('no-cdp-endpoint', `连不上 CDP 端点 ${endpoint}（${lastError ? lastError.message : 'unknown'}）`, {
      endpoint,
      lastError: lastError ? String(lastError.message) : null,
      hint: '确认 app 以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 启动',
    });
  }
  throw new FatalError('no-page-target', `CDP 端点 ${endpoint} 可达，但没有可用的 page target`, {
    endpoint,
    targets: seen,
    lastError: lastError ? String(lastError.message) : null,
  });
}

async function evalPage(expression, timeoutMs = 30000) {
  const result = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    timeoutMs,
  );
  if (result && result.exceptionDetails) {
    const details = result.exceptionDetails;
    const description = (details.exception && details.exception.description) || details.text || 'unknown exception';
    const error = new Error(`页面内异常: ${description}`);
    error.evalException = true;
    throw error;
  }
  return result ? result.result && result.result.value : undefined;
}

async function pollPage(expression, { timeoutMs, intervalMs = 250, until = null, label = 'poll' }) {
  const startedAt = Date.now();
  const predicate = until || ((value) => !!(value && value.ok === true));
  let lastValue = null;
  let lastError = null;
  let attempts = 0;
  while (Date.now() - startedAt < timeoutMs) {
    attempts += 1;
    try {
      lastValue = await evalPage(expression);
      lastError = null;
      if (predicate(lastValue)) {
        return { ok: true, value: lastValue, elapsedMs: Date.now() - startedAt, attempts, label };
      }
    } catch (error) {
      lastError = error;
      lastValue = null;
    }
    await sleep(intervalMs);
  }
  return {
    ok: false,
    value: lastValue,
    error: lastError ? String(lastError.message || lastError) : null,
    elapsedMs: Date.now() - startedAt,
    attempts,
    label,
  };
}

async function captureShot(file, purpose) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await cdp.send(
        'Page.captureScreenshot',
        { format: 'png', fromSurface: true, captureBeyondViewport: false },
        30000,
      );
      if (!result || !result.data) throw new Error('截图返回空 data');
      const buffer = Buffer.from(result.data, 'base64');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buffer);
      return { file, purpose, bytes: buffer.length, ...pngSize(buffer) };
    } catch (error) {
      lastError = error;
      await sleep(300);
    }
  }
  throw new FatalError('screenshot-failed', `截图失败 ${path.basename(file)}: ${lastError ? lastError.message : 'unknown'}`, {
    file,
    lastError: lastError ? String(lastError.message) : null,
  });
}

function isBlankSuspicious(shot) {
  if (!shot) return false;
  const pixels = (shot.width || 0) * (shot.height || 0);
  if (shot.bytes < 20000) return true;
  if (pixels > 100000 && shot.bytes / pixels < 0.01) return true;
  return false;
}

/* ══════════════════════════════════════════════════════════════════════
 * 主流程
 * ══════════════════════════════════════════════════════════════════════ */

let shotsSeq = 0;

async function captureSample(sec, purpose, seqLabel = null) {
  let stats = null;
  let statsError = null;
  try {
    stats = await evalPage(STATS_EXPR);
  } catch (error) {
    statsError = String(error.message || error);
  }
  let seq;
  if (seqLabel) {
    seq = seqLabel;
  } else {
    shotsSeq += 1;
    seq = String(shotsSeq);
  }
  const fileName = seqLabel ? `app-room-${seqLabel}.png` : `app-room-${shotsSeq}-${sec}s.png`;
  const file = path.join(opts.shotsDir, fileName);
  const shot = await captureShot(file, purpose);
  const entry = {
    seq,
    tSec: sec,
    purpose,
    file,
    bytes: shot.bytes,
    width: shot.width,
    height: shot.height,
    blankSuspicion: isBlankSuspicious(shot),
    stats,
    statsError,
  };
  report.samples.push(entry);
  report.shots.push({ seq, tSec: sec, file, bytes: shot.bytes, width: shot.width, height: shot.height, blankSuspicion: entry.blankSuspicion });
  log(
    `截图 #${seq} t+${sec}s -> ${fmtBytes(shot.bytes)} (${shot.width}x${shot.height})` +
      ` painted=${stats && stats.room ? stats.room.painted : 'null'}` +
      ` room=${stats && stats.room ? JSON.stringify(stats.room.cls) : 'null'}`,
  );
  return entry;
}

async function failureShot(tag) {
  if (!cdp) return null;
  try {
    const file = path.join(opts.shotsDir, `app-room-fail-${tag || 'unknown'}.png`);
    const shot = await captureShot(file, `failure:${tag}`);
    report.shots.push({ seq: null, tSec: null, purpose: `failure:${tag}`, file: shot.file, bytes: shot.bytes, width: shot.width, height: shot.height, blankSuspicion: isBlankSuspicious(shot) });
    log(`失败现场截图 -> ${shot.file} (${fmtBytes(shot.bytes)})`);
    return shot;
  } catch (error) {
    warn(`失败现场截图也失败了: ${error.message || error}`);
    return null;
  }
}

async function runFps(label) {
  try {
    const result = await evalPage(FPS_EXPR, Math.max(15000, opts.fpsWindowMs + 8000));
    report.fps[label] = result;
    log(
      `FPS[${label}] ${result ? result.fps : 'null'} (frames=${result ? result.frames : '?'}/${result ? result.elapsedMs : '?'}ms, ` +
        `p95=${result ? result.p95FrameMs : '?'}ms, max=${result ? result.maxFrameMs : '?'}ms, long=${result ? result.longFrames : '?'})`,
    );
    return result;
  } catch (error) {
    const message = String(error.message || error);
    report.fps[label] = { error: message };
    warn(`FPS[${label}] 采样失败: ${message}`);
    return { error: message };
  }
}

async function waitBootAfterReload() {
  return pollPage(
    `(() => ({
      ok: document.readyState !== 'loading' && !!document.querySelector('.app'),
      readyState: document.readyState,
      app: !!document.querySelector('.app'),
      href: location.href,
    }))()`,
    { timeoutMs: 15000, intervalMs: 200, label: 'boot' },
  );
}

async function ensureHome() {
  const boot = await waitBootAfterReload();
  if (!boot.ok) throw new FatalError('home-not-ready', 'Page.reload 后 15s 内 app 首页没有挂载完成', { boot: boot.value, error: boot.error });

  let mode = await evalPage(`(() => { try { return localStorage.getItem('zilux2.lumiere'); } catch (error) { return 'ERR:' + String(error); } })()`);
  report.steps.mode.afterReload = mode;
  if (mode !== 'room') {
    warn(`reload 后 localStorage 模式是 ${JSON.stringify(mode)} 而不是 'room'，重设并再 reload 一次`);
    await evalPage(`(() => { localStorage.setItem('zilux2.lumiere', 'room'); return true; })()`);
    await cdp.send('Page.reload', { ignoreCache: false }, 20000);
    const secondBoot = await waitBootAfterReload();
    if (!secondBoot.ok) throw new FatalError('home-not-ready', '第二次 reload 后 app 首页没有挂载完成', { boot: secondBoot.value });
    mode = await evalPage(`(() => { try { return localStorage.getItem('zilux2.lumiere'); } catch (error) { return 'ERR:' + String(error); } })()`);
    report.steps.mode.afterReload = mode;
  }

  const home = await pollPage(HOME_EXPR, { timeoutMs: opts.homeTimeoutMs, intervalMs: 400, label: 'home' });
  report.steps.home = {
    ok: home.ok,
    elapsedMs: home.elapsedMs,
    attempts: home.attempts,
    value: home.value,
    error: home.error,
  };
  if (!home.ok) {
    const value = home.value || {};
    await failureShot('home');
    if (value.bootFailed) {
      throw new FatalError('boot-failed', `app 启动失败：「${String(value.bodyHead || '').replace(/\s+/g, ' ').slice(0, 120)}」`, { home: value });
    }
    if (!value.rows) {
      throw new FatalError(
        'home-no-recent',
        `首页 ${Math.round(opts.homeTimeoutMs / 1000)}s 内没有出现「最近播放」行（rows=0），无法点歌；body: ${String(value.bodyHead || '').replace(/\s+/g, ' ').slice(0, 160)}`,
        { home: value, consoleTail: report.console.slice(-20) },
      );
    }
    throw new FatalError('home-not-ready', '首页没有就绪', { home: value });
  }
  log(`首页就绪（${home.elapsedMs}ms），最近播放 ${home.value.rows} 行，模式=${JSON.stringify(mode)}`);
  return home.value;
}

async function main() {
  opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`用法: node room-app-qa.mjs [--times=0,4,8,15,25] [--endpoint=http://127.0.0.1:9223] [--json=<out.json>] [--shots-dir=<dir>]
可选超时: --home-timeout=35000 --play-timeout=20000 --lyrics-timeout=10000 --paint-timeout=8000 --fps-window=1500`);
    process.exitCode = 0;
    return;
  }
  report.options = {
    times: opts.times,
    endpoint: opts.endpoint,
    json: opts.json,
    shotsDir: opts.shotsDir,
    homeTimeoutMs: opts.homeTimeoutMs,
    playTimeoutMs: opts.playTimeoutMs,
    lyricsTimeoutMs: opts.lyricsTimeoutMs,
    paintTimeoutMs: opts.paintTimeoutMs,
    fpsWindowMs: opts.fpsWindowMs,
  };
  report.endpoint = opts.endpoint;
  fs.mkdirSync(path.dirname(opts.json), { recursive: true });
  fs.mkdirSync(opts.shotsDir, { recursive: true });
  log(`项目根目录: ${PROJECT_ROOT}`);
  log(`CDP 端点: ${opts.endpoint}；截图目录: ${opts.shotsDir}`);

  /* 1. 找 target 并连接 */
  const found = await findPageTarget(opts.endpoint, 15000);
  report.target = { id: found.target.id, type: found.target.type, url: found.target.url, title: found.target.title };
  report.targetsSeen = found.targets;
  log(`CDP target: ${found.target.url} (${found.target.title || 'no title'})`);
  cdp = await new CDP(found.target.webSocketDebuggerUrl, onCdpEvent).open();
  await Promise.all([cdp.send('Runtime.enable'), cdp.send('Log.enable'), cdp.send('Page.enable')]);
  log('Runtime/Log/Page 已启用');

  /* 1.5 再确认页面已经落在 app 文档上（不是启动瞬间的 about:blank），否则 localStorage 会 SecurityError */
  const pageReady = await pollPage(
    `(() => ({ ok: (/zilux2\\.local/i.test(location.href) || /index\\.html/i.test(location.href)) && document.readyState !== 'loading', href: location.href, readyState: document.readyState }))()`,
    { timeoutMs: 15000, label: 'wait-app-document' },
  );
  if (pageReady.ok) {
    log(`app 文档就绪: ${pageReady.value.href} (${pageReady.value.readyState}, ${pageReady.elapsedMs}ms)`);
  } else {
    warn(`等待 app 文档就绪超时: ${JSON.stringify(pageReady.value)}`);
  }

  /* 2. 切到 room 模式并 reload */
  const beforeReload = await evalPage(
    `(() => { let mode = null; try { mode = localStorage.getItem('zilux2.lumiere'); } catch (error) { mode = 'ERR:' + String(error); } return { mode, href: location.href, readyState: document.readyState }; })()`,
  );
  report.steps.mode = { before: beforeReload ? beforeReload.mode : null };
  await evalPage(`(() => { localStorage.setItem('zilux2.lumiere', 'room'); return localStorage.getItem('zilux2.lumiere'); })()`);
  log('已写入 localStorage zilux2.lumiere=room，Page.reload…');
  await cdp.send('Page.reload', { ignoreCache: false }, 20000);
  const home = await ensureHome();

  /* 2.5 等启动 splash 淡出移除：否则整页 splash 会盖住首页截图（阶段B首跑得到 15.5KB 的纯 splash 画面） */
  const splashGone = await pollPage(
    `(() => ({ ok: !document.querySelector('.splash'), splash: !!document.querySelector('.splash'), appClass: document.querySelector('.app') ? document.querySelector('.app').className : null }))()`,
    { timeoutMs: 6000, intervalMs: 150, label: 'splash-gone' },
  );
  report.steps.splash = { ok: splashGone.ok, elapsedMs: splashGone.elapsedMs, attempts: splashGone.attempts, value: splashGone.value };
  if (splashGone.ok) {
    log(`启动 splash 已移除（${splashGone.elapsedMs}ms），再截首页`);
  } else {
    warn(`启动 splash 6s 内未移除，首页截图可能仍被 splash 覆盖: ${JSON.stringify(splashGone.value)}`);
  }

  /* 3. 截一张首页（播放前证据，固定文件名 app-room-0-home.png，不占时间点序号） */
  await captureSample(0, 'home-before-play', '0-home');

  /* 4. 点最近播放，优先 Warm (feat. Mia) */
  const clicked = await evalPage(CLICK_RECENT_EXPR);
  if (!clicked || !clicked.ok) {
    await failureShot('no-recent');
    throw new FatalError('playback-not-started', `最近播放里没有可点歌曲: ${JSON.stringify(clicked)}`, { clicked, home });
  }
  report.steps.play = {
    clickedAt: new Date().toISOString(),
    index: clicked.index,
    matchedPreferred: clicked.matchedPreferred,
    count: clicked.count,
    chosen: clicked.chosen,
    rect: clicked.rect,
  };
  log(
    `点击最近播放 #${clicked.index}: ${clicked.chosen ? clicked.chosen.title || clicked.chosen.name : '(unknown)'}` +
      `（优先命中 Warm: ${clicked.matchedPreferred}）`,
  );

  const playing = await pollPage(PLAYING_EXPR, { timeoutMs: opts.playTimeoutMs, intervalMs: 400, label: 'playing' });
  report.steps.play.playing = playing.value;
  report.steps.play.waitMs = playing.elapsedMs;
  if (!playing.ok) {
    await failureShot('play');
    throw new FatalError(
      'playback-not-started',
      `点击最近播放后 ${Math.round(opts.playTimeoutMs / 1000)}s 内没有进入播放状态` +
        `（title=${JSON.stringify(playing.value && playing.value.title)}, toasts=${JSON.stringify((playing.value && playing.value.toasts) || [])}）`,
      { clicking: clicked, last: playing.value, error: playing.error },
    );
  }
  log(`播放已开始: ${JSON.stringify(playing.value.title)} / ${JSON.stringify(playing.value.artist)}，位置 ${playing.value.time} / ${playing.value.duration}`);
  await sleep(600);

  /* 5. 打开歌词页，等房间 root */
  const openLyrics = await evalPage(OPEN_LYRICS_EXPR);
  if (!openLyrics || !openLyrics.ok) {
    await failureShot('no-lyrics-button');
    throw new FatalError('lyrics-not-opened', `找不到歌词按钮 .pb-btn-lyrics: ${JSON.stringify(openLyrics)}`, { openLyrics });
  }
  const openLyricsAt = Date.now();
  report.steps.lyrics = { openLyricsAt: new Date().toISOString(), button: openLyrics, viewSeenImmediately: openLyrics.viewNow };
  log(`已派发歌词按钮 pointerdown（view 立即出现: ${openLyrics.viewNow}），等 .lyrics-view + 房间 root…`);

  const roomWait = await pollPage(ROOM_EXPR, {
    timeoutMs: opts.lyricsTimeoutMs,
    intervalMs: 150,
    until: (value) => !!(value && value.ok === true),
    label: 'room-root',
  });
  report.steps.lyrics.roomRootWaitMs = roomWait.elapsedMs;
  if (!roomWait.ok) {
    const value = roomWait.value || {};
    await failureShot('room-root');
    if (!value.viewExists) {
      throw new FatalError('lyrics-not-opened', `点击歌词按钮后 ${Math.round(opts.lyricsTimeoutMs / 1000)}s 内 .lyrics-view 没有出现`, {
        openLyrics,
        last: value,
        error: roomWait.error,
      });
    }
    throw new FatalError('room-root-missing', '歌词页已打开，但找不到房间舞台 root（.lyrics-stage.is-room）', {
      viewClass: value.viewClass,
      stages: value.stageList,
      last: value,
    });
  }
  let roomState = roomWait.value;
  report.steps.lyrics.roomRoot = roomState.room;
  report.steps.lyrics.stageList = roomState.stageList;
  if (roomState.fallback) warn(`房间 root 没有 .is-room class，按 fallback 识别：${roomState.fallback}（class=${roomState.room && roomState.room.cls}）`);
  if (roomState.room && roomState.room.failed) {
    await failureShot('webgl-failed');
    throw new FatalError('room-webgl-failed', `房间舞台挂上了 is-failed（WebGL 不可用），root class: ${roomState.room.cls}`, {
      room: roomState.room,
      stages: roomState.stageList,
    });
  }
  log(`房间 root 出现（${roomWait.elapsedMs}ms）: ${JSON.stringify(roomState.room && roomState.room.cls)}`);

  /* 6. 等 is-painted（最多 8s；超时只告警，不判失败） */
  const painted = await pollPage(ROOM_EXPR, {
    timeoutMs: opts.paintTimeoutMs,
    intervalMs: 200,
    until: (value) => !!(value && value.ok && value.room && (value.room.painted || value.room.failed)),
    label: 'painted',
  });
  report.steps.lyrics.timeToPaintedMs = painted.ok ? painted.elapsedMs : null;
  report.steps.lyrics.paint = painted.value;
  if (painted.ok) {
    roomState = painted.value;
    log(`房间舞台出像 is-painted（${painted.elapsedMs}ms），class=${JSON.stringify(roomState.room.cls)}`);
  } else {
    warn(
      `房间舞台 ${Math.round(opts.paintTimeoutMs / 1000)}s 内没有 is-painted（可能 class 名不同），继续截图。` +
        ` root class=${JSON.stringify((painted.value && painted.value.room && painted.value.room.cls) || null)}`,
    );
  }
  if (painted.value && painted.value.room && painted.value.room.failed) {
    await failureShot('webgl-failed-late');
    throw new FatalError('room-webgl-failed', `房间舞台 is-failed: ${painted.value.room.cls}`, { room: painted.value.room });
  }

  /* 7. 时间点截图 + FPS 采样 */
  const t0 = Date.now();
  report.steps.timeline = { t0: new Date(t0).toISOString(), times: opts.times };
  log(`开始时间点截图：t0=now，时间点 ${opts.times.map((sec) => `+${sec}s`).join(', ')}`);
  for (let index = 0; index < opts.times.length; index += 1) {
    const sec = opts.times[index];
    await sleepUntil(t0 + sec * 1000);
    await captureSample(sec, 'timeline');
    if (index === 0) await runFps('early');
    if (index === opts.times.length - 1) await runFps('late');
  }

  /* 8. 收尾统计与分析 */
  const finalSample = report.samples[report.samples.length - 1];
  const finalStats = finalSample ? finalSample.stats : null;
  report.steps.final = finalStats;

  const consoleErrors = report.console.filter(
    (entry) => entry.kind === 'exception' || (entry.kind === 'console' && entry.type === 'error') || (entry.kind === 'log' && entry.level === 'error'),
  );
  const consoleWarnings = report.console.filter(
    (entry) => entry.kind === 'console' && (entry.type === 'warning' || entry.type === 'warn') || (entry.kind === 'log' && entry.level === 'warning'),
  );
  report.errors = consoleErrors.map((entry) => `[${entry.kind}${entry.type ? '/' + entry.type : ''}] ${entry.text}`.slice(0, 400));
  report.warnings.push(...consoleWarnings.map((entry) => `[console] ${String(entry.text).slice(0, 300)}`));

  const canvasVisible =
    !!finalStats &&
    finalStats.visibilityState === 'visible' &&
    !!finalStats.room &&
    !!finalStats.canvas &&
    finalStats.room.rect &&
    finalStats.room.rect.w > 40 &&
    finalStats.room.rect.h > 40 &&
    finalStats.canvas.clientWidth > 40 &&
    finalStats.canvas.clientHeight > 40 &&
    finalStats.room.rect.display !== 'none' &&
    finalStats.room.rect.opacity !== '0' &&
    finalStats.room.rect.visibility !== 'hidden';

  const timelineShots = report.shots.filter((shot) => shot.purpose === 'timeline');
  const allSmall = timelineShots.length > 0 && timelineShots.every((shot) => shot.bytes < 20000);
  if (allSmall) {
    if (!canvasVisible) {
      await failureShot('black');
      throw new FatalError('screenshots-black', `时间点截图全部 < 20KB 且房间 canvas 不可见，疑似全黑（canvasVisible=false）`, {
        shots: timelineShots,
        finalStats,
      });
    }
    warn('时间点截图体积都 < 20KB，但房间 canvas 尺寸/可见性正常，可能是暗场景（非硬失败）');
  }
  if (finalStats && finalStats.room && finalStats.room.failed) {
    throw new FatalError('room-webgl-failed', '收尾时房间舞台 is-failed', { room: finalStats.room });
  }
  if (!finalStats || !finalStats.room) {
    throw new FatalError('room-root-missing', '收尾时歌词页里已经没有房间舞台 root（可能被关闭/卸载）', { finalStats });
  }

  report.status = 'OK';
  report.message = '房间效果在真实 app 里跑通：切模式、点歌、开歌词页、截图、FPS、日志均已采集';
  log('验收通过（status=OK）');
}

function printSummary() {
  console.log('');
  console.log('================ Zilux2 room-app-qa 摘要 ================');
  console.log(`状态: ${report.status}${report.reason ? `（reason=${report.reason}）` : ''}`);
  if (report.message) console.log(`说明: ${report.message}`);
  if (report.fatal && report.fatal.extra && Object.keys(report.fatal.extra).length) {
    console.log(`失败证据: ${JSON.stringify(report.fatal.extra).slice(0, 1200)}`);
  }
  if (report.target) console.log(`target: ${report.target.url}`);
  console.log(`耗时: ${report.durationMs}ms`);
  const mode = report.steps.mode || {};
  console.log(`模式: before=${JSON.stringify(mode.before)} afterReload=${JSON.stringify(mode.afterReload)}`);
  if (report.steps.home && report.steps.home.value) {
    const homeValue = report.steps.home.value;
    console.log(`首页: rows=${homeValue.rows}, 就绪耗时=${report.steps.home.elapsedMs}ms`);
  }
  if (report.steps.play) {
    const chosen = report.steps.play.chosen || {};
    console.log(`点歌: ${JSON.stringify(chosen.title || chosen.name)}（优先 Warm=${report.steps.play.matchedPreferred}），播放就绪 ${report.steps.play.waitMs}ms`);
  }
  const lyricsStep = report.steps.lyrics || {};
  console.log(`歌词页: view=${JSON.stringify(lyricsStep.roomRoot ? report.steps.final && report.steps.final.view && report.steps.final.view.cls : null)}`);
  if (lyricsStep.roomRoot) console.log(`房间 root class: ${JSON.stringify(lyricsStep.roomRoot.cls)}`);
  console.log(`is-painted: ${lyricsStep.timeToPaintedMs != null ? `${lyricsStep.timeToPaintedMs}ms 到位` : '未观察到（见 warnings）'}`);
  if (report.steps.final) {
    console.log(`最终 canvas: ${JSON.stringify(report.steps.final.canvas ? { w: report.steps.final.canvas.width, h: report.steps.final.canvas.height } : null)}`);
    console.log(`最终播放器: title=${JSON.stringify(report.steps.final.player && report.steps.final.player.title)} time=${JSON.stringify(report.steps.final.player && report.steps.final.player.time)} playing=${report.steps.final.player && report.steps.final.player.playingByIcon}`);
    console.log(`歌词 DOM 行数: ${report.steps.final.lyric ? report.steps.final.lyric.lines : '?'}, room 内 word 元素: ${report.steps.final.wordCount}`);
    if (report.steps.final.dom) {
      const dom = report.steps.final.dom;
      console.log(`房间 DOM: .zlr-word=${dom.zlrWordCount}（doc=${dom.zlrWordCountDoc}）, .zlr-title=${JSON.stringify(dom.zlrTitle && dom.zlrTitle.text)}`);
      if (dom.zlrTitle) console.log(`  title box=${JSON.stringify(dom.zlrTitle.rect)} font=${dom.zlrTitle.fontSize}/${dom.zlrTitle.fontWeight} color=${dom.zlrTitle.color} opacity=${dom.zlrTitle.opacity}`);
      if (dom.playerbar) console.log(`  playerbar box=${JSON.stringify(dom.playerbar.rect)}`);
      if (dom.titleBarOverlap && dom.titleBarOverlap.area > 0) console.log(`  歌名条与播放条重叠: ${JSON.stringify(dom.titleBarOverlap)}`);
      console.log(`  is-failed=${report.steps.final.room ? report.steps.final.room.failed : 'n/a'}`);
    }
  }
  const fpsLabels = Object.keys(report.fps);
  if (fpsLabels.length) {
    for (const label of fpsLabels) {
      const value = report.fps[label];
      if (value && !value.error) console.log(`FPS[${label}]: ${value.fps}（p95=${value.p95FrameMs}ms, max=${value.maxFrameMs}ms, longFrames=${value.longFrames}/${value.frames}）`);
      else console.log(`FPS[${label}]: ERROR ${JSON.stringify(value)}`);
    }
  }
  if (report.shots.length) {
    console.log(`截图（${report.shots.length} 张）:`);
    for (const shot of report.shots) {
      console.log(`  ${shot.file}  ${shot.width}x${shot.height} ${fmtBytes(shot.bytes)}${shot.blankSuspicion ? ' [疑似空白]' : ''}`);
    }
  }
  if (report.errors.length) {
    console.log(`控制台错误（${report.errors.length}）:`);
    for (const line of report.errors.slice(0, 20)) console.log(`  ${line}`);
  } else {
    console.log('控制台错误: 无');
  }
  if (report.warnings.length) {
    console.log(`告警（${report.warnings.length}）:`);
    for (const line of report.warnings.slice(0, 15)) console.log(`  ${String(line).slice(0, 300)}`);
  }
  console.log(`JSON: ${opts.json}`);
  console.log('=========================================================');
}

async function run() {
  try {
    await main();
  } catch (error) {
    if (error instanceof FatalError) {
      report.status = 'BLOCKED';
      report.reason = error.reason;
      report.message = error.message;
      report.fatal = { reason: error.reason, message: error.message, extra: error.extra };
      await failureShot(error.reason);
      console.error(`[room-qa] FATAL ${error.reason}: ${error.message}`);
    } else {
      report.status = 'BLOCKED';
      report.reason = 'unexpected-error';
      report.message = String((error && error.stack) || error);
      report.fatal = { reason: 'unexpected-error', message: String((error && error.message) || error), stack: String((error && error.stack) || error) };
      await failureShot('unexpected');
      console.error(`[room-qa] FATAL unexpected-error: ${String((error && error.stack) || error)}`);
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
    try {
      fs.mkdirSync(path.dirname(opts.json), { recursive: true });
      fs.writeFileSync(opts.json, JSON.stringify(report, null, 2), 'utf8');
      log(`报告已写入 ${opts.json}`);
    } catch (error) {
      console.error(`[room-qa] 写 JSON 报告失败: ${error.message || error}`);
    }
    try {
      if (cdp) cdp.close();
    } catch {
      /* ignore */
    }
    printSummary();
    process.exitCode = report.status === 'OK' ? 0 : 1;
  }
}

run();
