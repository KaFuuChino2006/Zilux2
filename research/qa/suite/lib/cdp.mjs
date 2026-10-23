/**
 * Zilux2 真机 QA 套件 —— CDP 基础设施
 *
 * 连接真实的安装版应用（WebView2），通过 --remote-debugging-port=9223 暴露的
 * DevTools 协议做 Runtime.evaluate / Page.captureScreenshot。
 *
 * 设计约束（来自 research/HANDOFF.md §4 的真机 QA 经验）：
 *   - 一律用页面内 JS 事件（el.click() / dispatchEvent）触发交互，不做真实鼠标坐标点击；
 *   - 不做 Page.reload（偶发卡死），不弹 window.confirm / prompt（会卡死页面）；
 *   - 每次 CDP 调用都有超时；超时会在错误里提示「重启安装版」，但脚本绝不自行 taskkill；
 *   - 任何断言失败都自动收集证据：截图 + DOM 快照 + console 错误 + host.log 尾部。
 *
 * 用法：
 *   import { runSuite } from './lib/cdp.mjs';
 *   await runSuite('smoke', '冒烟', async (suite) => {
 *     const cdp = suite.cdp;
 *     await suite.step('首页渲染', async () => { ... });
 *   });
 *
 * 环境变量：
 *   ZILUX2_CDP_HTTP        默认 http://127.0.0.1:9223
 *   ZILUX2_CDP_TIMEOUT_MS  单次 CDP 调用默认超时，默认 15000
 *   ZILUX2_SHOTS_DIR       截图/结果输出目录，默认 research/shots/suite-YYYYMMDD
 *   ZILUX2_HOST_LOG        宿主日志路径，默认 %LOCALAPPDATA%\Zilux2\logs\host.log
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根目录（research/qa/suite/lib → 上溯 4 级到 E:\Zilux2开发）。脚本与 cwd 无关。 */
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
export const CDP_HTTP = process.env.ZILUX2_CDP_HTTP || 'http://127.0.0.1:9223';
export const PAGE_URL_PREFIX = process.env.ZILUX2_PAGE_URL_PREFIX || 'https://zilux2.local';
export const DEFAULT_TIMEOUT_MS = Number(process.env.ZILUX2_CDP_TIMEOUT_MS || 15000);
export const HOST_LOG =
  process.env.ZILUX2_HOST_LOG ||
  path.join(
    process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'),
    'Zilux2',
    'logs',
    'host.log',
  );

export const RESTART_HINT =
  '页面可能已卡死或无响应（Page.reload / 原生 confirm 是已知风险）。' +
  '处理办法：taskkill /IM Zilux2.exe /F 后用安装版重新启动（命令见 research/qa/suite/README.md）。' +
  '脚本不会自行重启应用。';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function repoRel(absPath) {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
}

export function dateStamp(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** 截图输出目录（每次进程内一致，run-all 通过 ZILUX2_SHOTS_DIR 统一）。 */
export function shotsDir() {
  const dir = process.env.ZILUX2_SHOTS_DIR
    ? path.resolve(process.env.ZILUX2_SHOTS_DIR)
    : path.join(REPO_ROOT, 'research', 'shots', `suite-${dateStamp()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function slugify(text, fallback = 'item') {
  const slug = String(text || '')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/[^\w.\-\u4e00-\u9fa5]+/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

/** 宿主日志尾部（缺少文件时返回空串，不抛错）。 */
export function hostLogTail(lines = 60) {
  try {
    const text = fs.readFileSync(HOST_LOG, 'utf8');
    const all = text.split(/\r?\n/).filter(Boolean);
    return all.slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/** 宿主日志当前字节数（用于「点按钮后读新增日志」）。 */
export function hostLogSize() {
  try {
    return fs.statSync(HOST_LOG).size;
  } catch {
    return 0;
  }
}

/** 读从 offset 开始的新日志（返回 { text, size }）。 */
export function hostLogSince(offset) {
  try {
    const buf = fs.readFileSync(HOST_LOG);
    const size = buf.length;
    if (offset >= size) return { text: '', size };
    return { text: buf.subarray(offset).toString('utf8'), size };
  } catch {
    return { text: '', size: offset };
  }
}

/** 找出以 https://zilux2.local 开头的页面 target（带重试，等待应用启动）。 */
export async function findPageTarget({ timeoutMs = 30000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const res = await fetch(`${CDP_HTTP}/json/list`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = await res.json();
      const pages = Array.isArray(list) ? list.filter((t) => t && t.type === 'page') : [];
      const target = pages.find((t) => String(t.url || '').startsWith(PAGE_URL_PREFIX));
      if (target && target.webSocketDebuggerUrl) return target;
      lastError = new Error(
        `CDP 已连通但没有找到 url 以 ${PAGE_URL_PREFIX} 开头的页面（现有页面：${
          pages.map((t) => t.url).join(' | ') || '无'
        }）`,
      );
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `无法连接 CDP ${CDP_HTTP}/json/list（等待 ${timeoutMs}ms）。` +
          '应用是否以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 启动？' +
          ` 最后错误：${lastError ? lastError.message : '未知'}`,
      );
    }
    await sleep(intervalMs);
  }
}

/** 页面内点击：返回元素快照；找不到返回 null。 */
function pageClick(selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  el.click();
  return {
    tag: el.tagName.toLowerCase(),
    cls: String(el.className || ''),
    text: (el.textContent || '').trim().slice(0, 80),
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
  };
}

/** 页面内按文本点击（含 title 兜底）：找不到返回 { __notFound: [...现有文本] }。 */
function pageClickText(selector, text) {
  const nodes = Array.from(document.querySelectorAll(selector));
  const want = String(text);
  const hit =
    nodes.find((n) => (n.textContent || '').trim().includes(want)) ||
    nodes.find((n) => (n.getAttribute('title') || '').includes(want));
  if (!hit) {
    return { __notFound: nodes.map((n) => (n.textContent || '').trim().slice(0, 40)).slice(0, 12) };
  }
  const rect = hit.getBoundingClientRect();
  hit.click();
  return {
    tag: hit.tagName.toLowerCase(),
    cls: String(hit.className || ''),
    text: (hit.textContent || '').trim().slice(0, 80),
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
  };
}

/** 页面内派发 pointerdown（给只用 pointerdown 监听的元素用，如 .pb-btn-lyrics）。 */
function pagePointerDown(selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true }));
  return { tag: el.tagName.toLowerCase(), cls: String(el.className || '') };
}

/** 页面内 DOM 快照（返回可 JSON 序列化的对象）。 */
function pageDomSnapshot(selectors) {
  const clip = (value, n) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, n);
  const out = {
    url: location.href,
    title: document.title,
    viewport: { w: innerWidth, h: innerHeight },
    active: clip(document.activeElement && (document.activeElement.className || document.activeElement.tagName), 100),
    bodyText: clip(document.body ? document.body.innerText : '', 1500),
    selectors: {},
  };
  for (const sel of selectors) {
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(sel));
    } catch (err) {
      out.selectors[sel] = { error: String(err) };
      continue;
    }
    out.selectors[sel] = {
      count: nodes.length,
      items: nodes.slice(0, 3).map((n) => ({
        tag: n.tagName.toLowerCase(),
        cls: clip(n.className, 120),
        text: clip(n.textContent, 160),
        html: clip(n.outerHTML, 500),
      })),
    };
  }
  return out;
}

/** 常用选择器：失败证据里统一 dump 一遍，方便直接看出是哪一层 DOM 断了。 */
export const COMMON_SELECTORS = [
  '.rail-btn',
  '.home-host',
  '.wall',
  '.wall-title',
  '.wall-sub',
  '.search-dock',
  '.track-row',
  '.track-download',
  '.quick',
  '.quick-panel',
  '.lyrics-view',
  '.sheet',
  '.sheet-title',
  '.settings-layout',
  '.settings-nav',
  '.room-sheet',
  '.room-preset-row',
  '.ts-group',
  '.dlq-panel',
  '.dlq-row',
  '[data-qa="download-entry"]',
  '.toast',
];

export class Cdp {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #closed = false;

  /** 连接期间捕获的 console 错误 / 未捕获异常 / Log error。 */
  consoleErrors = [];

  constructor(ws, target) {
    this.#ws = ws;
    this.target = target;
    this.shots = [];
  }

  static async connect({ timeoutMs = 30000 } = {}) {
    const target = await findPageTarget({ timeoutMs });
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP WebSocket 连接超时（${target.webSocketDebuggerUrl}）`)), 10000);
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        'error',
        (event) => {
          clearTimeout(timer);
          reject(new Error(`CDP WebSocket 连接失败：${event?.message || 'error'}`));
        },
        { once: true },
      );
    });
    const cdp = new Cdp(ws, target);
    ws.addEventListener('message', (event) => cdp.#onMessage(event.data));
    ws.addEventListener('close', () => cdp.#onClose());
    await cdp.send('Page.enable', {}, 10000);
    await cdp.send('Runtime.enable', {}, 10000);
    try {
      await cdp.send('Log.enable', {}, 5000);
    } catch {
      /* Log domain 不可用时只用 Runtime 事件 */
    }
    // Log.enable 会把 WebView2 里 buffered 的旧错误重放一遍（例如上一轮脚本/probe 留下的
    // net::ERR、资源 404）。等重放结束后清空，保证 consoleErrors 只反映本次连接之后的事件。
    await new Promise((resolve) => setTimeout(resolve, 350));
    cdp.consoleErrors = [];
    return cdp;
  }

  #onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    if (msg.id) {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(`CDP 调用失败[${pending.method}]：${msg.error.message}`));
      else pending.resolve(msg.result || {});
      return;
    }
    const params = msg.params || {};
    if (msg.method === 'Runtime.consoleAPICalled' && params.type === 'error') {
      this.consoleErrors.push({
        kind: 'console.error',
        text: (params.args || [])
          .map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description || arg.type))
          .join(' ')
          .slice(0, 1000),
        at: Date.now(),
      });
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails || {};
      this.consoleErrors.push({
        kind: 'exception',
        text: (details.exception && (details.exception.description || details.exception.value)) || details.text || '未捕获异常',
        at: Date.now(),
      });
    } else if (msg.method === 'Log.entryAdded') {
      const entry = params.entry || {};
      if (entry.level === 'error') {
        this.consoleErrors.push({
          kind: 'log.error',
          text: `${entry.source || 'log'}: ${entry.text || ''}${entry.url ? ` (${entry.url})` : ''}`.slice(0, 1000),
          at: Date.now(),
        });
      }
    }
  }

  #onClose() {
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      pending.reject(new Error(`CDP 连接已断开（${RESTART_HINT}）`));
    }
    this.#pending.clear();
  }

  /** 发一条 CDP 命令（带超时；超时错误标记 fatal）。 */
  send(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (this.#closed) {
      const err = new Error(`CDP 连接已断开，无法执行 ${method}（${RESTART_HINT}）`);
      err.fatal = true;
      return Promise.reject(err);
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        const err = new Error(`CDP 响应超时（${method}，${timeoutMs}ms）。${RESTART_HINT}`);
        err.fatal = true;
        reject(err);
      }, timeoutMs);
      this.#pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      try {
        this.#ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new Error(`CDP 发送失败（${method}）：${err.message}`));
      }
    });
  }

  /** Runtime.evaluate（returnByValue）。页面异常会带页面栈抛出来。 */
  async eval(expression, { timeoutMs = DEFAULT_TIMEOUT_MS, awaitPromise = true } = {}) {
    const res = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise, returnByValue: true, userGesture: true },
      timeoutMs,
    );
    if (res.exceptionDetails) {
      const details = res.exceptionDetails;
      const desc = (details.exception && (details.exception.description || details.exception.value)) || details.text || '未知异常';
      throw new Error(`页面 JS 异常：${String(desc).slice(0, 1200)}\n表达式片段：${String(expression).slice(0, 300)}`);
    }
    return res.result ? res.result.value : undefined;
  }

  /** Runtime.evaluate，吞掉异常返回 fallback。 */
  async evalOpt(expression, fallback = null, opts = {}) {
    try {
      const value = await this.eval(expression, opts);
      return value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  }

  /**
   * 轮询表达式直到满足条件。
   * @param {string} expression 页面表达式
   * @param {object} opts { timeoutMs, intervalMs, desc, accept }
   * accept: (value) => boolean，默认 !!value
   */
  async waitFor(expression, { timeoutMs = 10000, intervalMs = 200, desc = '条件', accept = (v) => !!v } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    for (;;) {
      const remain = deadline - Date.now();
      if (remain <= 0) {
        const err = new Error(
          `${desc} 未在 ${timeoutMs}ms 内满足。表达式：${String(expression).slice(0, 300)}` +
            (lastError ? `；最后异常：${lastError.message}` : ''),
        );
        throw err;
      }
      try {
        const value = await this.eval(expression, { timeoutMs: Math.max(1000, Math.min(10000, remain + 1000)) });
        if (accept(value)) return value;
      } catch (err) {
        if (err.fatal) throw err;
        lastError = err;
      }
      await sleep(Math.min(intervalMs, Math.max(50, deadline - Date.now())));
    }
  }

  /** 等待元素出现并点击（页面内 el.click()）。 */
  async click(selector, { desc = selector, timeoutMs = 8000 } = {}) {
    await this.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, {
      timeoutMs,
      desc: `${desc}（选择器 ${selector}）出现`,
    });
    const info = await this.eval(`(${pageClick.toString()})(${JSON.stringify(selector)})`);
    if (!info) throw new Error(`${desc} 点击失败：元素在等待后消失（选择器 ${selector}）`);
    return info;
  }

  /** 等待元素出现并按文本点击。 */
  async clickText(selector, text, { desc = `${selector} 中文本「${text}」`, timeoutMs = 8000 } = {}) {
    await this.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, {
      timeoutMs,
      desc: `${selector} 出现`,
    });
    const info = await this.eval(`(${pageClickText.toString()})(${JSON.stringify(selector)}, ${JSON.stringify(text)})`);
    if (!info) throw new Error(`${desc} 点击失败：元素消失`);
    if (info.__notFound) {
      throw new Error(
        `${desc} 没有找到。现有候选文本：${JSON.stringify(info.__notFound)}（选择器 ${selector}）`,
      );
    }
    return info;
  }

  /** 派发 pointerdown（给只监听 pointerdown 的元素用）。 */
  async pointerDown(selector, { timeoutMs = 5000, desc = selector } = {}) {
    await this.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, {
      timeoutMs,
      desc: `${desc}（选择器 ${selector}）出现`,
    });
    const info = await this.eval(`(${pagePointerDown.toString()})(${JSON.stringify(selector)})`);
    if (!info) throw new Error(`${desc} pointerdown 失败：元素消失`);
    return info;
  }

  /** 截图，返回绝对路径；name 不含路径时存进本次 shotsDir。 */
  async shot(name) {
    const fileName = String(name).endsWith('.png') ? String(name) : `${name}.png`;
    const file = path.isAbsolute(fileName) ? fileName : path.join(shotsDir(), fileName);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const res = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 20000);
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
    this.shots.push(file);
    return file;
  }

  /** DOM 快照（选择器列表 ⇒ count + 前 3 个节点的文本/HTML）。 */
  async domSnapshot(selectors = COMMON_SELECTORS) {
    return this.eval(`(${pageDomSnapshot.toString()})(${JSON.stringify(selectors)})`, { timeoutMs: 8000 });
  }

  /** 页面 → 宿主 postMessage（bridge.ts 消息形状）。返回 webview 是否可用。 */
  async hostPost(payload) {
    return this.eval(
      `(() => { const wv = window.chrome && window.chrome.webview; if (!wv || typeof wv.postMessage !== 'function') return false; wv.postMessage(${JSON.stringify(
        payload,
      )}); return true; })()`,
    );
  }

  /** 取走期间的 console 错误（默认清空）。 */
  takeConsoleErrors({ clear = true } = {}) {
    const errors = this.consoleErrors.slice();
    if (clear) this.consoleErrors = [];
    return errors;
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#ws.close();
    } catch {
      /* 忽略 */
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Suite：步骤记录、失败证据、汇总、结果 JSON                                   */
/* -------------------------------------------------------------------------- */

export class Suite {
  constructor(name, { title = name } = {}) {
    this.name = name;
    this.title = title;
    this.startedAt = new Date();
    this.steps = [];
    this.shots = [];
    this.cdp = null;
    this.fatal = false;
  }

  async connect(opts) {
    this.cdp = await Cdp.connect(opts);
    this.target = this.cdp.target;
    return this.cdp;
  }

  get dir() {
    return shotsDir();
  }

  log(message) {
    console.log(`[${this.name}] ${message}`);
  }

  note(message) {
    console.log(`[${this.name}] · ${message}`);
  }

  assert(condition, message) {
    if (!condition) throw new Error(`断言失败：${message}`);
  }

  record(status, name, detail = '', ms = 0, evidence = null) {
    const step = { name, status, detail: String(detail || ''), ms, evidence };
    this.steps.push(step);
    const time = ms > 0 ? ` (${ms}ms)` : '';
    const mark = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'SKIP';
    console.log(`[${this.name}] ${mark} ${name}${time}${detail ? ` —— ${String(detail).slice(0, 400)}` : ''}`);
    return step;
  }

  async shot(name) {
    if (!this.cdp) throw new Error('未连接 CDP，无法截图');
    const file = await this.cdp.shot(`${this.name}-${name}`);
    this.shots.push(file);
    console.log(`[${this.name}] 截图 ${repoRel(file)}`);
    return file;
  }

  /** 失败证据：DOM 快照 + 截图 + console 错误 + host.log 尾部，落盘并返回摘要。 */
  async captureEvidence(label) {
    const evidence = {
      label,
      at: new Date().toISOString(),
      shot: null,
      dom: null,
      consoleErrors: [],
      hostLog: hostLogTail(50),
    };
    if (this.cdp) {
      try {
        evidence.shot = repoRel(await this.cdp.shot(`${this.name}-fail-${slugify(label)}`));
      } catch (err) {
        evidence.shot = `截图失败：${err.message}`;
      }
      try {
        evidence.dom = await this.cdp.domSnapshot();
      } catch (err) {
        evidence.dom = { error: String(err.message || err) };
      }
      evidence.consoleErrors = this.cdp.takeConsoleErrors();
    }
    const dir = path.join(shotsDir(), 'evidence');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${this.name}-${slugify(label)}.json`);
    fs.writeFileSync(file, JSON.stringify(evidence, null, 2));
    evidence.file = repoRel(file);
    return evidence;
  }

  /** 执行一个步骤；异常记为 FAIL 并继续（fatal 连接错误则停止后续步骤）。 */
  async step(name, fn) {
    if (this.fatal) {
      this.record('SKIP', name, '前序步骤出现连接级致命错误，跳过');
      return undefined;
    }
    const started = Date.now();
    try {
      const result = await fn();
      this.record('PASS', name, typeof result === 'string' ? result : '', Date.now() - started);
      return result;
    } catch (err) {
      const evidence = await this.captureEvidence(name);
      this.record('FAIL', name, err && err.message ? err.message : String(err), Date.now() - started, evidence);
      if (err && err.fatal) this.fatal = true;
      return undefined;
    }
  }

  skip(name, reason = '') {
    this.record('SKIP', name, reason);
  }

  async finish() {
    const pass = this.steps.filter((s) => s.status === 'PASS').length;
    const fail = this.steps.filter((s) => s.status === 'FAIL').length;
    const skip = this.steps.filter((s) => s.status === 'SKIP').length;
    const endedAt = new Date();
    const durationMs = endedAt - this.startedAt;
    const line = '='.repeat(72);
    console.log(`\n${line}`);
    console.log(`${this.name}（${this.title}）  PASS ${pass} | FAIL ${fail} | SKIP ${skip} | ${(durationMs / 1000).toFixed(1)}s`);
    console.log(line);
    for (const step of this.steps) {
      const mark = step.status === 'PASS' ? 'PASS' : step.status === 'FAIL' ? 'FAIL' : 'SKIP';
      console.log(`${mark}  ${step.name}`);
      if (step.status !== 'PASS' && step.detail) console.log(`      ${step.detail.replace(/\n/g, '\n      ').slice(0, 1500)}`);
      if (step.evidence) {
        const ev = step.evidence;
        const counts = ev.dom && ev.dom.selectors
          ? Object.entries(ev.dom.selectors)
              .filter(([, info]) => info && info.count > 0)
              .map(([sel, info]) => `${sel}=${info.count}`)
              .slice(0, 12)
              .join(' ')
          : '';
        const errs = (ev.consoleErrors || []).length;
        console.log(`      证据: 截图=${ev.shot || '无'}${ev.file ? ` 详情=${ev.file}` : ''}`);
        if (counts) console.log(`      DOM: ${counts}`);
        if (ev.dom && ev.dom.bodyText) console.log(`      正文: ${ev.dom.bodyText.slice(0, 300)}`);
        if (errs) console.log(`      console 错误 ${errs} 条: ${(ev.consoleErrors[0] || {}).text || ''}`);
      }
    }
    const resultDir = path.join(shotsDir(), 'results');
    fs.mkdirSync(resultDir, { recursive: true });
    const resultFile = path.join(resultDir, `${this.name}.json`);
    const result = {
      suite: this.name,
      title: this.title,
      startedAt: this.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs,
      pass,
      fail,
      skip,
      page: this.target ? { url: this.target.url, title: this.target.title } : null,
      shots: this.shots.map((file) => repoRel(file)),
      steps: this.steps.map((step) => ({
        name: step.name,
        status: step.status,
        detail: step.detail,
        ms: step.ms,
        evidence: step.evidence ? { shot: step.evidence.shot, file: step.evidence.file } : null,
      })),
    };
    fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
    console.log(`截图目录: ${repoRel(shotsDir())}`);
    console.log(`结果 JSON: ${repoRel(resultFile)}`);
    if (this.cdp) await this.cdp.close().catch(() => {});
    if (fail > 0) process.exitCode = 1;
    return result;
  }
}

/** 套件入口：连接 → 执行 → 汇总（保证一定会打印汇总并写结果 JSON）。 */
export async function runSuite(name, title, fn, { connectTimeoutMs = 30000 } = {}) {
  const suite = new Suite(name, { title });
  try {
    await suite.connect({ timeoutMs: connectTimeoutMs });
    suite.log(`已连接 CDP 页面：${suite.target.url}`);
  } catch (err) {
    suite.record('FAIL', `连接 CDP（${CDP_HTTP}）`, err.message);
    await suite.finish();
    return;
  }
  try {
    await fn(suite);
  } catch (err) {
    const evidence = await suite.captureEvidence('套件未捕获异常');
    suite.record('FAIL', '套件未捕获异常', (err && err.stack) || String(err), 0, evidence);
  } finally {
    await suite.finish();
  }
}
