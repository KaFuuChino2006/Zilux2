#!/usr/bin/env node
/**
 * 房间效果独立预览截图流水线（无需 puppeteer，手写 CDP）。
 *
 * 一条命令：
 *   1. 检查 / 启动 vite dev（127.0.0.1:5173，日志 research/tmp/vite-dev.log，已在跑则复用）
 *   2. 启动 headless Edge（--remote-debugging-port=9333，独立 user-data-dir，不碰用户的 Edge）
 *   3. 通过 /json/list 拿 target，对每个时间点导航
 *        /preview-room.html?t=<秒>&play=0&debug=0
 *      等 window.__roomPreview.ready（带超时）→ document.fonts.ready → 主线程再 seek 一次
 *      → 额外等待 --extra-wait → 采样画布非空 → Page.captureScreenshot 存 PNG
 *   4. 打印 JSON 摘要；结束时杀掉自己启动的 headless Edge（默认保留 vite dev 供下次复用；
 *      --stop-dev 时连 vite 一起杀）
 *
 * 用法示例：
 *   node research/qa/room-preview-shot.mjs
 *   node research/qa/room-preview-shot.mjs --times 12,30,60 --out research/shots/room-preview --sheet
 *
 * 说明：
 *   - node 直接用 DSH 运行时：C:\Users\13329\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe
 *   - --out 为相对路径时，相对「仓库根目录」解析；最终文件为 <out>-<秒>.png，contact sheet 为 <out>-sheet.png。
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const WEB_DIR = path.join(ROOT, 'web');
const TMP_DIR = path.join(ROOT, 'research', 'tmp');
const SHOTS_DIR = path.join(ROOT, 'research', 'shots');
const VITE_LOG = path.join(TMP_DIR, 'vite-dev.log');
const EDGE_LOG = path.join(TMP_DIR, 'edge-preview.log');
const DEV_PORT = 5173;
const DEV_ORIGIN = `http://127.0.0.1:${DEV_PORT}`;
const CDP_PORT = 9333;
const EDGE_PATH = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EDGE_USER_DATA_DIR = path.join(TMP_DIR, 'edge-preview');
const PREVIEW_PATH = '/preview-room.html';
const DEFAULT_TIMES = [10, 22, 40, 65, 90, 130];
const NODE_EXE = process.execPath;
const PILLOW_PROBE_CODE = 'import PIL, sys; print(sys.version.split()[0], PIL.__version__)';

/* ── 通用小工具 ─────────────────────────────────────────────────────── */

function logLine(message) {
  process.stderr.write(`[room-preview ${new Date().toISOString().slice(11, 19)}] ${message}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function truncate(text, maxLength = 400) {
  const value = String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

/** TCP 端口是否已有人在听（不依赖 HTTP 语义）。 */
function isPortOpen(port, host = '127.0.0.1', timeoutMs = 900) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function waitForPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortOpen(port))) return true;
    await sleep(150);
  }
  return !(await isPortOpen(port));
}

function pidsListeningOnPort(port) {
  if (process.platform !== 'win32') return [];
  try {
    const output = execFileSync('netstat', ['-ano', '-p', 'tcp'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });
    const pids = new Set();
    for (const rawLine of output.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.includes(`:${port}`)) continue;
      const columns = line.split(/\s+/);
      if (columns.length < 4) continue;
      const localAddress = columns[1] || '';
      const stateIndex = columns.findIndex((column) => /^LISTEN/i.test(column));
      if (!localAddress.endsWith(`:${port}`)) continue;
      if (stateIndex < 0) continue;
      const pid = Number(columns[stateIndex + 1]);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
    return [...pids];
  } catch (error) {
    logLine(`netstat 解析失败（忽略）：${truncate(error && error.message ? error.message : error)}`);
    return [];
  }
}

function killProcessTree(pid, label) {
  if (!pid) return false;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 20000,
    });
    logLine(`已结束${label}（pid=${pid}）`);
    return true;
  } catch (error) {
    logLine(`结束${label}（pid=${pid}）失败，可能已自行退出：${truncate(error && error.message ? error.message : error, 160)}`);
    return false;
  }
}

function readLogTail(filePath, lineCount = 20) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.split(/\r?\n/).slice(-lineCount).join('\n');
  } catch {
    return '';
  }
}

async function fetchJson(url, timeoutMs = 3000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.json();
}

async function fetchText(url, timeoutMs = 3000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.text();
}

/* ── CLI 参数 ───────────────────────────────────────────────────────── */

function usage() {
  return [
    '房间效果预览截图流水线',
    '',
    '用法：',
    '  node research/qa/room-preview-shot.mjs [选项]',
    '',
    '选项：',
    `  --times 10,22,40   要截图的播放位置（秒），默认 ${DEFAULT_TIMES.join(',')}`,
    '  --out <路径>       输出前缀（相对路径相对仓库根目录），默认 research/shots/room-preview',
    '  --w <像素>         视口宽，默认 1600',
    '  --h <像素>         视口高，默认 960',
    '  --extra-wait <ms>  ready 之后额外等待，默认 500（等字体/首帧稳定）',
    '  --ready-timeout <ms> 等 window.__roomPreview.ready 的超时，默认 30000',
    '  --sheet           额外用 python(Pillow) 拼 2 列缩略图 <out>-sheet.png',
    '  --stop-dev        跑完同时杀掉 vite dev（默认保留以便下次复用）',
    '                    每张截图后会额外采样 1.5s（rAF FPS + scene.update 每帧耗时）',
    '  --help, -h        显示本帮助',
  ].join('\n');
}

function takeOptionValue(argv, index, name) {
  const argument = argv[index];
  const equalIndex = argument.indexOf('=');
  if (equalIndex >= 0) return { value: argument.slice(equalIndex + 1), nextIndex: index };
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('--')) throw new Error(`${name} 需要一个值`);
  return { value: next, nextIndex: index + 1 };
}

function parsePositiveInt(raw, name) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} 需要正整数，收到：${raw}`);
  return Math.round(value);
}

function parseTimes(raw) {
  const times = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const value = Number(part);
      if (!Number.isFinite(value) || value < 0) throw new Error(`--times 里有非法时间点：${part}`);
      return value;
    });
  if (times.length === 0) throw new Error('--times 至少需要一个时间点');
  return [...new Set(times)];
}

function parseArgs(argv) {
  const options = {
    times: [...DEFAULT_TIMES],
    out: path.join(SHOTS_DIR, 'room-preview'),
    width: 1600,
    height: 960,
    extraWait: 500,
    readyTimeout: 30000,
    stopDev: false,
    sheet: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--stop-dev') {
      options.stopDev = true;
    } else if (argument === '--sheet') {
      options.sheet = true;
    } else if (argument === '--times' || argument.startsWith('--times=')) {
      const taken = takeOptionValue(argv, index, '--times');
      options.times = parseTimes(taken.value);
      index = taken.nextIndex;
    } else if (argument === '--out' || argument.startsWith('--out=')) {
      const taken = takeOptionValue(argv, index, '--out');
      options.out = path.isAbsolute(taken.value) ? taken.value : path.resolve(ROOT, taken.value);
      index = taken.nextIndex;
    } else if (argument === '--w' || argument.startsWith('--w=') || argument === '--width' || argument.startsWith('--width=')) {
      const taken = takeOptionValue(argv, index, '--w');
      options.width = parsePositiveInt(taken.value, '--w');
      index = taken.nextIndex;
    } else if (argument === '--h' || argument.startsWith('--h=') || argument === '--height' || argument.startsWith('--height=')) {
      const taken = takeOptionValue(argv, index, '--h');
      options.height = parsePositiveInt(taken.value, '--h');
      index = taken.nextIndex;
    } else if (argument === '--extra-wait' || argument.startsWith('--extra-wait=')) {
      const taken = takeOptionValue(argv, index, '--extra-wait');
      options.extraWait = parsePositiveInt(taken.value, '--extra-wait');
      index = taken.nextIndex;
    } else if (argument === '--ready-timeout' || argument.startsWith('--ready-timeout=')) {
      const taken = takeOptionValue(argv, index, '--ready-timeout');
      options.readyTimeout = parsePositiveInt(taken.value, '--ready-timeout');
      index = taken.nextIndex;
    } else {
      throw new Error(`未知参数：${argument}\n\n${usage()}`);
    }
  }
  options.out = path.resolve(options.out);
  options.previewUrlBase = `${DEV_ORIGIN}${PREVIEW_PATH}`;
  return options;
}

/* ── vite dev ───────────────────────────────────────────────────────── */

async function probeDevServer() {
  try {
    const html = await fetchText(`${DEV_ORIGIN}/`, 2000);
    return { running: true, ours: html.includes('Zilux2') || html.includes('preview-room') };
  } catch {
    return { running: false, ours: false };
  }
}

async function waitForDevServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await probeDevServer();
    if (probe.running) return probe;
    await sleep(300);
  }
  return { running: false, ours: false };
}

/**
 * 确保 vite dev 在 5173 上跑：已跑则复用，否则按任务约定命令启动并写日志。
 * 返回 { reused, started, pid, log }。
 */
async function ensureDevServer(options, state) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(options.out), { recursive: true });

  const viteEntry = path.join(WEB_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(viteEntry)) {
    throw new Error(`找不到 vite：${viteEntry}（不要在无 node_modules 的环境跑本脚本，也不要 npm/pnpm 安装）`);
  }

  let probe = await probeDevServer();
  if (probe.running) {
    if (!probe.ours) {
      throw new Error(`127.0.0.1:${DEV_PORT} 已被别的项目占用（返回的 HTML 不像 Zilux2）。先关掉占用进程再跑。`);
    }
    logLine(`复用已在运行的 vite dev：${DEV_ORIGIN}（日志不归本脚本管）`);
    state.dev.reused = true;
    state.dev.started = false;
    return;
  }

  const logFd = fs.openSync(VITE_LOG, 'w');
  fs.writeSync(logFd, `[room-preview] ${new Date().toISOString()} 启动 vite dev（cwd=${WEB_DIR}）\n`);
  const child = spawn(NODE_EXE, ['./node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(DEV_PORT)], {
    cwd: WEB_DIR,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(logFd);
  state.dev.started = true;
  state.dev.reused = false;
  state.dev.pid = child.pid || null;
  logLine(`启动 vite dev（pid=${state.dev.pid}），日志：${VITE_LOG}`);

  probe = await waitForDevServer(60000);
  if (probe.running) {
    if (!probe.ours) throw new Error(`vite dev 起来了但 5173 返回的页面不像 Zilux2：${DEV_ORIGIN}/`);
    logLine(`vite dev 就绪：${DEV_ORIGIN}`);
    return;
  }

  if (child.exitCode !== null) {
    throw new Error(`vite dev 启动后立即退出（exit=${child.exitCode}），日志尾部：\n${readLogTail(VITE_LOG, 30)}`);
  }
  throw new Error(`等待 vite dev 就绪超时（60s），日志尾部：\n${readLogTail(VITE_LOG, 30)}`);
}

async function stopDevServer(state) {
  if (state.dev.pid) killProcessTree(state.dev.pid, ' vite dev');
  for (const pid of pidsListeningOnPort(DEV_PORT)) killProcessTree(pid, '占用 5173 的进程');
  const freed = await waitForPortFree(DEV_PORT, 6000);
  state.dev.stopped = true;
  state.dev.portFreed = freed;
  if (!freed) logLine(`警告：${DEV_PORT} 在 6s 内没有释放`);
}

/* ── headless Edge ──────────────────────────────────────────────────── */

async function startEdge(options, state) {
  if (!fs.existsSync(EDGE_PATH)) throw new Error(`找不到 Edge：${EDGE_PATH}（可用环境变量 EDGE_PATH 覆盖）`);
  fs.mkdirSync(EDGE_USER_DATA_DIR, { recursive: true });

  // 上次异常退出留下的 profile 锁 / DevToolsActivePort 清掉，避免 Edge 直接退出。
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort']) {
    try {
      fs.rmSync(path.join(EDGE_USER_DATA_DIR, name), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  const stalePids = pidsListeningOnPort(CDP_PORT);
  if (stalePids.length > 0) {
    logLine(`检测到 9333 上还有残留 CDP 进程（${stalePids.join(',')}），先清掉`);
    for (const pid of stalePids) killProcessTree(pid, ' 残留 Edge');
    await waitForPortFree(CDP_PORT, 5000);
  }

  const logFd = fs.openSync(EDGE_LOG, 'w');
  const args = [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--window-size=${options.width},${options.height}`,
    '--force-device-scale-factor=1',
    '--hide-scrollbars',
    '--disable-first-run-ui',
    '--no-first-run',
    `--user-data-dir=${EDGE_USER_DATA_DIR}`,
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-component-update',
    '--disable-background-networking',
    'about:blank',
  ];
  const child = spawn(EDGE_PATH, args, {
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  fs.closeSync(logFd);
  state.edge.pid = child.pid || null;
  state.edge.args = args;
  logLine(`启动 headless Edge（pid=${state.edge.pid}，cdp=${CDP_PORT}，user-data-dir=${EDGE_USER_DATA_DIR}）`);

  const deadline = Date.now() + 25000;
  let lastError = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `headless Edge 启动后立即退出（exit=${child.exitCode}），日志尾部：\n${readLogTail(EDGE_LOG, 30)}`,
      );
    }
    try {
      const version = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/version`, 1500);
      state.edge.browser = version.Browser || null;
      logLine(`Edge CDP 就绪：${state.edge.browser}`);
      return;
    } catch (error) {
      lastError = truncate(error && error.message ? error.message : error, 200);
    }
    await sleep(250);
  }
  throw new Error(`等待 Edge CDP 就绪超时（25s）：${lastError}\n日志尾部：\n${readLogTail(EDGE_LOG, 30)}`);
}

async function stopEdge(state) {
  if (state.edge.pid) killProcessTree(state.edge.pid, ' headless Edge');
  for (const pid of pidsListeningOnPort(CDP_PORT)) killProcessTree(pid, '占用 9333 的进程');
  const freed = await waitForPortFree(CDP_PORT, 6000);
  state.edge.stopped = true;
  state.edge.portFreed = freed;
  if (!freed) logLine(`警告：${CDP_PORT} 在 6s 内没有释放`);
}

/* ── 极简 CDP 客户端（Node 24 自带 WebSocket，无需依赖） ───────────── */

class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket = null;
    this.closed = false;
  }

  async connect() {
    if (typeof WebSocket !== 'function') {
      throw new Error('当前 node 没有全局 WebSocket，请用 Node 22+（DSH 运行时 node 即可）');
    }
    this.socket = new WebSocket(this.webSocketUrl);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve(), { once: true });
      this.socket.addEventListener(
        'error',
        (event) => reject(new Error(`CDP WebSocket 连接失败：${truncate(event && (event.message || event.type))}`)),
        { once: true },
      );
    });
    this.socket.addEventListener('message', (event) => this.handleMessage(event));
    this.socket.addEventListener('close', () => {
      this.closed = true;
      for (const entry of this.pending.values()) entry.reject(new Error('CDP 连接已关闭'));
      this.pending.clear();
    });
    return this;
  }

  handleMessage(event) {
    let message = null;
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
      return;
    }
    if (message.method && this.listeners.has(message.method)) {
      for (const listener of this.listeners.get(message.method)) {
        try {
          listener(message.params || {});
        } catch {
          /* 监听器异常不影响主流程 */
        }
      }
    }
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }

  send(method, params = {}, timeoutMs = 15000) {
    if (!this.socket || this.closed) return Promise.reject(new Error(`CDP 未连接，无法 ${method}`));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
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
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      if (this.socket && !this.closed) this.socket.close();
    } catch {
      /* ignore */
    }
  }
}

async function getPageTarget(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/list`, 2000);
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
      lastError = `target 列表里没有 page：${truncate(JSON.stringify(targets.map((target) => target.type)))}`;
    } catch (error) {
      lastError = truncate(error && error.message ? error.message : error, 200);
    }
    await sleep(250);
  }
  throw new Error(`拿不到 Edge page target（${timeoutMs}ms）：${lastError}`);
}

/* ── 页面内探测表达式 ──────────────────────────────────────────────── */

const READY_PROBE = "typeof window.__roomPreview !== 'undefined' && !!window.__roomPreview";
const READY_AWAIT = "window.__roomPreview.ready.then(function () { return 'painted'; })";
const FONTS_AWAIT = "document.fonts.ready.then(function () { return document.fonts.status; })";
const SEEK_REFRESH = 'window.__roomPreview.seek(window.__roomPreview.positionMs)';
const ERROR_TEXT_PROBE = [
  '(function () {',
  "  var overlay = document.querySelector('vite-error-overlay');",
  '  if (overlay && overlay.shadowRoot) return (overlay.shadowRoot.textContent || "").slice(0, 1200);',
  '  return ((document.body && document.body.innerText) || "").slice(0, 1200);',
  '})()',
].join('\n');

/** 采样 roomScene root 里的 canvas 像素 + DOM 文本，判断「画面非空」。 */
const PAINT_PROBE = [
  '(function () {',
  "  var api = window.__roomPreview;",
  '  var root = api && api.scene && api.scene.root ? api.scene.root : null;',
  '  var scope = root || document;',
  "  var canvases = Array.prototype.slice.call(scope.querySelectorAll('canvas'));",
  '  var sampled = 0;',
  '  var nonBlack = 0;',
  '  var withPixels = 0;',
  '  for (var index = 0; index < canvases.length; index += 1) {',
  '    var canvas = canvases[index];',
  '    var context = null;',
  '    try { context = canvas.getContext("2d"); } catch (error) { context = null; }',
  '    if (!context || !canvas.width || !canvas.height) continue;',
  '    withPixels += 1;',
  '    try {',
  '      var width = canvas.width;',
  '      var height = canvas.height;',
  '      var data = context.getImageData(0, 0, width, height).data;',
  '      var stepX = Math.max(1, Math.floor(width / 120));',
  '      var stepY = Math.max(1, Math.floor(height / 80));',
  '      for (var y = 0; y < height; y += stepY) {',
  '        for (var x = 0; x < width; x += stepX) {',
  '          var offset = (y * width + x) * 4;',
  '          sampled += 1;',
  '          if (data[offset + 3] > 8 && (data[offset] + data[offset + 1] + data[offset + 2]) > 18) nonBlack += 1;',
  '        }',
  '      }',
  '    } catch (error) { /* 被跨域污染时忽略 */ }',
  '  }',
  '  var text = root ? (root.innerText || "").trim() : "";',
  '  return {',
  '    rootFound: !!root,',
  '    rootChildren: root ? root.childElementCount : 0,',
  '    canvasCount: canvases.length,',
  '    canvasesWith2dPixels: withPixels,',
  '    pixelsSampled: sampled,',
  '    nonBlackPixels: nonBlack,',
  '    nonBlackRatio: sampled > 0 ? Number((nonBlack / sampled).toFixed(4)) : 0,',
  '    textChars: text.length',
  '  };',
  '})()',
].join('\n');

/** 用真实播放路径（逐帧 scene.update）采样 1.5s，得到 rAF FPS 与每帧渲染成本。 */
const PERF_PROBE = [
  '(function () {',
  "  var api = window.__roomPreview;",
  '  if (!api || !api.scene) return Promise.reject(new Error("没有 window.__roomPreview.scene"));',
  '  var scene = api.scene;',
  '  var base = api.positionMs || 0;',
  '  var samples = [];',
  '  var start = 0;',
  '  return new Promise(function (resolve) {',
  '    function step(now) {',
  '      if (!start) start = now;',
  '      var before = performance.now();',
  '      try { scene.update(base + (now - start), true, 1); } catch (error) { /* 单帧异常不终止采样 */ }',
  '      samples.push(performance.now() - before);',
  '      if (now - start < 1500) { requestAnimationFrame(step); return; }',
  '      var elapsed = performance.now() - start;',
  '      var sorted = samples.slice().sort(function (a, b) { return a - b; });',
  '      var total = samples.reduce(function (sum, value) { return sum + value; }, 0);',
  '      var p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];',
  '      resolve({',
  '        frames: samples.length,',
  '        windowMs: Number(elapsed.toFixed(1)),',
  '        fps: Number(((samples.length / elapsed) * 1000).toFixed(1)),',
  '        avgUpdateMs: Number((total / Math.max(1, samples.length)).toFixed(2)),',
  '        maxUpdateMs: Number(sorted[sorted.length - 1].toFixed(2)),',
  '        p95UpdateMs: Number(p95.toFixed(2)),',
  '        dpr: window.devicePixelRatio',
  '      });',
  '    }',
  '    requestAnimationFrame(step);',
  '  });',
  '})()',
].join('\n');

function hasVisiblePaint(painted) {
  if (!painted) return false;
  if (painted.nonBlackRatio >= 0.01) return true;
  if (painted.textChars > 0) return true;
  return false;
}

/* ── 单页截图 ──────────────────────────────────────────────────────── */

async function evaluate(cdp, expression, timeoutMs, awaitPromise = false) {
  const result = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise, returnByValue: true, userGesture: true },
    timeoutMs,
  );
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception && result.exceptionDetails.exception.description;
    throw new Error(`页面脚本异常：${truncate(description || result.exceptionDetails.text, 300)}`);
  }
  return result.result ? result.result.value : undefined;
}

async function captureShot(cdp, timeSeconds, options, state) {
  const url = `${options.previewUrlBase}?t=${encodeURIComponent(String(timeSeconds))}&play=0&debug=0`;
  const startedAt = Date.now();
  const shot = {
    timeSec: timeSeconds,
    url,
    path: `${options.out}-${timeSeconds}.png`,
    ready: false,
    readyDetail: null,
    positionMs: null,
    positionExpectedMs: Math.round(timeSeconds * 1000),
    consoleErrorCount: 0,
    consoleWarningCount: 0,
    exceptionCount: 0,
    painted: null,
    paintedVisible: false,
    ok: false,
    bytes: 0,
    screenshotMs: 0,
    error: null,
  };
  logLine(`t=${timeSeconds}s 导航：${url}`);

  try {
    const navigation = await cdp.send('Page.navigate', { url }, 20000);
    if (navigation && navigation.errorText) {
      shot.readyDetail = `导航失败：${navigation.errorText}`;
    }
  } catch (error) {
    shot.readyDetail = `导航异常：${truncate(error && error.message ? error.message : error, 300)}`;
  }

  // 先确认新文档真的到了：旧页面残留的 __roomPreview 会让 ready 判断假阳。
  let navigationConfirmed = false;
  const urlDeadline = Date.now() + Math.min(15000, options.readyTimeout);
  while (Date.now() < urlDeadline) {
    try {
      const currentUrl = await evaluate(cdp, 'location.href', 2500);
      if (currentUrl === url) {
        navigationConfirmed = true;
        break;
      }
    } catch {
      /* 导航中 evaluate 可能短暂失败，继续等 */
    }
    await sleep(100);
  }

  if (!shot.readyDetail && !navigationConfirmed) {
    shot.readyDetail = `导航超时，地址未变成 ${url}`;
  }

  if (!shot.readyDetail) {
    // 等 document complete（module import 报错也会 complete，所以后面还要等 ready）。
    const loadDeadline = Date.now() + Math.min(15000, options.readyTimeout);
    while (Date.now() < loadDeadline) {
      try {
        const stateName = await evaluate(cdp, 'document.readyState', 2500);
        if (stateName === 'complete') break;
      } catch {
        /* 导航中 evaluate 可能短暂失败，继续等 */
      }
      await sleep(100);
    }

    // 等 window.__roomPreview 出现（模块加载成功），再 await ready（onPainted 后 resolve）。
    const readyDeadline = Date.now() + options.readyTimeout;
    let apiFound = false;
    while (Date.now() < readyDeadline) {
      try {
        const found = await evaluate(cdp, READY_PROBE, 2500);
        if (found === true) {
          apiFound = true;
          break;
        }
      } catch {
        /* ignore */
      }
      await sleep(120);
    }

    if (!apiFound) {
      shot.readyDetail = `等 window.__roomPreview 超时（${options.readyTimeout}ms）`;
      try {
        const pageText = await evaluate(cdp, ERROR_TEXT_PROBE, 3000);
        if (pageText) shot.readyDetail += `；页面文本：${truncate(pageText, 800)}`;
      } catch {
        /* ignore */
      }
    } else {
      try {
        await evaluate(cdp, READY_AWAIT, Math.max(5000, Math.min(options.readyTimeout, 30000)), true);
        shot.ready = true;
      } catch (error) {
        shot.readyDetail = `ready 超时/失败：${truncate(error && error.message ? error.message : error, 300)}`;
        try {
          const pageText = await evaluate(cdp, ERROR_TEXT_PROBE, 3000);
          if (pageText) shot.readyDetail += `；页面文本：${truncate(pageText, 800)}`;
        } catch {
          /* ignore */
        }
      }
    }
  }

  if (shot.ready) {
    // Lead 要求 JSON 里带 window.__roomPreview.positionMs，用于确认 t=<秒> 定位真的生效。
    try {
      shot.positionMs = await evaluate(cdp, 'window.__roomPreview.positionMs', 3000);
      if (
        typeof shot.positionMs === 'number' &&
        Math.abs(shot.positionMs - shot.positionExpectedMs) > 60
      ) {
        state.warnings.push(
          `t=${timeSeconds}s 定位偏差：positionMs=${shot.positionMs}，期望 ${shot.positionExpectedMs}`,
        );
      }
    } catch (error) {
      state.warnings.push(`t=${timeSeconds}s 读 positionMs 失败：${truncate(error && error.message ? error.message : error, 200)}`);
    }
    // 字体就绪后再 seek 自身位置，触发 roomScene 重新排版 + 短暂 settle 渲染。
    try {
      await evaluate(cdp, FONTS_AWAIT, 5000, true);
    } catch {
      /* 字体等待失败不致命 */
    }
    try {
      await evaluate(cdp, SEEK_REFRESH, 3000);
    } catch (error) {
      state.warnings.push(`t=${timeSeconds}s seek 刷新失败：${truncate(error && error.message ? error.message : error, 200)}`);
    }
    await sleep(options.extraWait);
    try {
      shot.painted = await evaluate(cdp, PAINT_PROBE, 5000);
      shot.paintedVisible = hasVisiblePaint(shot.painted);
    } catch (error) {
      state.warnings.push(`t=${timeSeconds}s 画面采样失败：${truncate(error && error.message ? error.message : error, 200)}`);
    }
    shot.consoleErrorCount = state.diagnostics.counts.consoleErrors + state.diagnostics.counts.logErrors;
    shot.consoleWarningCount = state.diagnostics.counts.consoleWarnings + state.diagnostics.counts.logWarnings;
    shot.exceptionCount = state.diagnostics.counts.exceptions;
  }

  const screenshotStartedAt = Date.now();
  try {
    const result = await cdp.send(
      'Page.captureScreenshot',
      { format: 'png', fromSurface: true, captureBeyondViewport: false },
      30000,
    );
    const buffer = Buffer.from(result.data, 'base64');
    fs.mkdirSync(path.dirname(shot.path), { recursive: true });
    fs.writeFileSync(shot.path, buffer);
    shot.bytes = buffer.length;
    shot.ok = shot.ready && buffer.length > 100;
  } catch (error) {
    shot.error = truncate(error && error.message ? error.message : error, 400);
  }
  shot.screenshotMs = Date.now() - screenshotStartedAt;
  shot.ms = Date.now() - startedAt;

  // 截图后再采样性能，避免 play 路径推进时间影响构图。
  if (shot.ok) {
    try {
      shot.perf = await evaluate(cdp, PERF_PROBE, 8000, true);
    } catch (error) {
      state.warnings.push(
        `t=${timeSeconds}s 性能采样失败：${truncate(error && error.message ? error.message : error, 200)}`,
      );
    }
  }

  if (shot.ready && !shot.paintedVisible) {
    state.warnings.push(`t=${timeSeconds}s ready 了但采样不到非空画面（可能黑屏 / 全透明）`);
  }
  logLine(
    `t=${timeSeconds}s ${shot.ok ? '截图 OK' : '截图失败'}（ready=${shot.ready}，` +
      `${shot.bytes} bytes，${shot.ms}ms）→ ${shot.path}`,
  );
  return shot;
}

/* ── contact sheet（python + Pillow） ──────────────────────────────── */

const CONTACT_SHEET_PY = String.raw`
import json
import sys

from PIL import Image, ImageDraw

RESAMPLE = getattr(Image, "Resampling", Image)


def main():
    spec = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    shots = spec["shots"]
    out = spec["out"]
    columns = int(spec.get("columns", 2))
    cell_width = int(spec.get("cellWidth", 800))
    pad = 10
    label_height = 26
    image_width = cell_width - pad * 2
    cells = []
    for item in shots:
        image = Image.open(item["path"]).convert("RGB")
        scale = image_width / image.width
        image = image.resize(
            (image_width, max(1, int(round(image.height * scale)))),
            RESAMPLE.LANCZOS,
        )
        cells.append((image, str(item.get("label", ""))))
    if not cells:
        raise SystemExit("no shots to compose")
    cell_height = max(image.height for image, _ in cells) + label_height + pad * 2
    rows = (len(cells) + columns - 1) // columns
    sheet = Image.new("RGB", (cell_width * columns, cell_height * rows), (13, 15, 18))
    draw = ImageDraw.Draw(sheet)
    for index, (image, label) in enumerate(cells):
        column = index % columns
        row = index // columns
        x = column * cell_width + pad
        y = row * cell_height + label_height
        draw.text((x + 1, y - label_height + 7), label, fill=(232, 240, 238))
        sheet.paste(image, (x, y))
        draw.rectangle((x, y, x + image.width - 1, y + image.height - 1), outline=(80, 92, 88))
    sheet.save(out)
    print(json.dumps({"ok": True, "path": out, "width": sheet.width, "height": sheet.height, "cells": len(cells)}))


main()
`;

let cachedPython = null;
let pythonLookupDone = false;

function findPythonWithPillow() {
  if (pythonLookupDone) return cachedPython;
  pythonLookupDone = true;
  const candidates = [];
  if (process.env.PYTHON) candidates.push({ command: process.env.PYTHON, args: [] });
  candidates.push({ command: 'python', args: [] }, { command: 'python3', args: [] }, { command: 'py', args: ['-3'] });
  try {
    const runtimesDir = path.join(os.homedir(), '.dsh', 'dsh-runtimes');
    for (const runtimeName of fs.readdirSync(runtimesDir)) {
      const pythonExe = path.join(runtimesDir, runtimeName, 'dependencies', 'python', 'python.exe');
      if (fs.existsSync(pythonExe)) candidates.push({ command: pythonExe, args: [] });
    }
  } catch {
    /* 没有 DSH 运行时目录也没关系 */
  }
  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate.command, [...candidate.args, '-c', PILLOW_PROBE_CODE], {
        encoding: 'utf8',
        timeout: 25000,
        windowsHide: true,
      });
      if (probe.status === 0 && /\d+\.\d+/.test(String(probe.stdout || ''))) {
        cachedPython = { ...candidate, version: String(probe.stdout).trim() };
        return cachedPython;
      }
    } catch {
      /* 换下一个候选 */
    }
  }
  return null;
}

function makeContactSheet(options, shots) {
  const sheetPath = `${options.out}-sheet.png`;
  if (shots.length === 0) return { ok: false, path: null, error: '没有成功截图，跳过 contact sheet' };
  const python = findPythonWithPillow();
  if (!python) {
    return {
      ok: false,
      path: null,
      error: '找不到带 Pillow 的 python；可设 PYTHON 环境变量指向 python.exe，或去掉 --sheet',
    };
  }
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const scriptPath = path.join(TMP_DIR, 'room-preview-sheet.py');
  fs.writeFileSync(scriptPath, CONTACT_SHEET_PY, 'utf8');
  const spec = {
    shots: shots.map((shot) => ({ path: shot.path, label: `t=${shot.timeSec}s  ${path.basename(shot.path)}` })),
    out: sheetPath,
    columns: 2,
    cellWidth: Math.max(400, Math.round(options.width / 2)),
  };
  const result = spawnSync(python.command, [...python.args, scriptPath], {
    input: JSON.stringify(spec),
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true,
    cwd: ROOT,
    // 中文路径：强制 python 用 UTF-8 读写 stdio，避免 Windows 默认 GBK 把路径解坏。
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
  if (result.status !== 0) {
    return {
      ok: false,
      path: null,
      error: `python 拼图失败（exit=${result.status}）：${truncate(result.stderr || result.stdout, 600)}`,
      python: python.version,
    };
  }
  try {
    const parsed = JSON.parse(String(result.stdout || '').trim().split(/\r?\n/).pop() || '{}');
    return { ok: parsed.ok === true, path: parsed.path || sheetPath, width: parsed.width, height: parsed.height, python: python.version };
  } catch {
    return { ok: fs.existsSync(sheetPath), path: fs.existsSync(sheetPath) ? sheetPath : null, python: python.version };
  }
}

/* ── 主流程 ────────────────────────────────────────────────────────── */

const activeState = {
  edgePid: null,
  devPid: null,
  stopDev: false,
  cleaned: false,
};

function emergencyCleanup() {
  if (activeState.cleaned) return;
  activeState.cleaned = true;
  try {
    if (activeState.edgePid) killProcessTree(activeState.edgePid, ' headless Edge');
    for (const pid of pidsListeningOnPort(CDP_PORT)) killProcessTree(pid, '占用 9333 的进程');
    if (activeState.stopDev) {
      if (activeState.devPid) killProcessTree(activeState.devPid, ' vite dev');
      for (const pid of pidsListeningOnPort(DEV_PORT)) killProcessTree(pid, '占用 5173 的进程');
    }
  } catch {
    /* ignore */
  }
}

function registerSignalCleanup(stopDev) {
  activeState.stopDev = stopDev;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      logLine(`收到 ${signal}，清理自己启动的进程后退出`);
      emergencyCleanup();
      process.exit(130);
    });
  }
}

async function main() {
  const startedAt = Date.now();
  let options = null;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${truncate(error && error.message ? error.message : error, 2000)}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  registerSignalCleanup(options.stopDev);

  const state = {
    dev: {
      port: DEV_PORT,
      origin: DEV_ORIGIN,
      log: VITE_LOG,
      started: false,
      reused: false,
      pid: null,
      stopped: false,
      portFreed: null,
    },
    edge: {
      path: EDGE_PATH,
      cdpPort: CDP_PORT,
      userDataDir: EDGE_USER_DATA_DIR,
      log: EDGE_LOG,
      pid: null,
      browser: null,
      args: [],
      stopped: false,
      portFreed: null,
    },
    shots: [],
    warnings: [],
    diagnostics: {
      exceptions: [],
      consoleErrors: [],
      logEntries: [],
      counts: { exceptions: 0, consoleErrors: 0, consoleWarnings: 0, logErrors: 0, logWarnings: 0 },
    },
  };
  const diagnosticLimit = 40;

  let hardError = null;
  let cdp = null;
  try {
    await ensureDevServer(options, state);
    activeState.devPid = state.dev.pid;

    await startEdge(options, state);
    activeState.edgePid = state.edge.pid;

    const target = await getPageTarget();
    cdp = await new CdpClient(target.webSocketDebuggerUrl).connect();
    logLine(`CDP 已连接：${truncate(target.url, 120)}`);

    cdp.on('Runtime.exceptionThrown', (params) => {
      state.diagnostics.counts.exceptions += 1;
      if (state.diagnostics.exceptions.length >= diagnosticLimit) return;
      const details = params.exceptionDetails || {};
      const description = details.exception && details.exception.description ? details.exception.description : details.text;
      state.diagnostics.exceptions.push(truncate(description, 500));
    });
    cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') state.diagnostics.counts.consoleErrors += 1;
      else if (params.type === 'warning') state.diagnostics.counts.consoleWarnings += 1;
      else return;
      if (state.diagnostics.consoleErrors.length >= diagnosticLimit) return;
      const text = (params.args || [])
        .map((argument) => (argument.value !== undefined ? argument.value : argument.description || argument.type))
        .join(' ');
      state.diagnostics.consoleErrors.push(truncate(`${params.type}: ${text}`, 500));
    });
    cdp.on('Log.entryAdded', (params) => {
      const entry = params.entry || {};
      if (entry.level === 'error') state.diagnostics.counts.logErrors += 1;
      else if (entry.level === 'warning') state.diagnostics.counts.logWarnings += 1;
      else return;
      if (state.diagnostics.logEntries.length >= diagnosticLimit) return;
      state.diagnostics.logEntries.push(truncate(`${entry.level}: ${entry.text}`, 500));
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    try {
      await cdp.send('Log.enable');
    } catch {
      /* 某些 Edge 版本 Log 域不可用 */
    }
    // dev 模式下强制每次导航都拿最新模块，避免改完 roomScene.ts 后截图还是旧代码。
    try {
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    } catch {
      /* ignore */
    }
    // 视口严格等于 --w/--h，保证 root.clientWidth/Height 与截图尺寸一致。
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: options.width,
      height: options.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    for (const timeSeconds of options.times) {
      const shot = await captureShot(cdp, timeSeconds, options, state);
      state.shots.push(shot);
    }
  } catch (error) {
    hardError = error;
    logLine(`失败：${truncate(error && error.stack ? error.stack : error, 1200)}`);
  } finally {
    if (cdp) cdp.close();
    await stopEdge(state);
    if (options.stopDev) await stopDevServer(state);
    else logLine(`vite dev 保留在 ${DEV_ORIGIN}（下次可复用；要杀用 --stop-dev）`);
    activeState.cleaned = true;
  }

  let sheet = null;
  if (options.sheet) {
    const captured = state.shots.filter((shot) => shot.ok);
    sheet = makeContactSheet(options, captured);
    if (sheet.ok) logLine(`contact sheet：${sheet.path}`);
    else state.warnings.push(`contact sheet 失败：${sheet.error}`);
  }

  const ok =
    hardError === null &&
    state.shots.length === options.times.length &&
    state.shots.every((shot) => shot.ok === true);
  const summary = {
    ok,
    generatedAt: new Date().toISOString(),
    totalMs: Date.now() - startedAt,
    viewport: { width: options.width, height: options.height },
    previewUrl: options.previewUrlBase,
    times: options.times,
    out: options.out,
    devServer: state.dev,
    edge: state.edge,
    shots: state.shots,
    sheet,
    diagnostics: {
      counts: state.diagnostics.counts,
      exceptions: state.diagnostics.exceptions,
      consoleErrors: state.diagnostics.consoleErrors,
      logEntries: state.diagnostics.logEntries,
    },
    warnings: state.warnings,
    error: hardError ? truncate(hardError && hardError.stack ? hardError.stack : hardError, 2000) : null,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return ok ? 0 : 1;
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    process.stderr.write(`[room-preview] 未捕获异常：${error && error.stack ? error.stack : error}\n`);
    emergencyCleanup();
    process.exitCode = 1;
  });
