/**
 * CDP 验收驱动（仅开发联调用，无第三方依赖：Node ≥ 22 自带 WebSocket）。
 *
 * 作用：启动 mac/build/win-test/electron.exe 加载 mac/build/win-test/resources/app，
 * 通过 Chrome DevTools Protocol 连到页面，按步骤执行 JS（点击 / 取状态 / 截图），
 * 同时收集 page console 与未捕获异常，最后把截图 + report.json 写到 mac/build/win-test-shots/。
 *
 * 用法（Windows 联调）：
 *   node mac/shell/dev/cdp-run.mjs
 * 可用环境变量：
 *   ELECTRON_EXE   默认 mac/build/win-test/electron.exe
 *   APP_DIR        默认 mac/build/win-test/resources/app
 *   OUT_DIR        默认 mac/build/win-test-shots
 *   USER_DATA      默认 mac/build/win-test-userdata（隔离的 userData，避免污染）
 *   CDP_PORT       默认 9335
 *   STEPS          步骤文件，默认 mac/shell/dev/steps/smoke.mjs（导出 default 数组）
 *   ZILUX2_ENGINE / ZILUX2_URL / ZILUX2_MOCK 透传给 Electron 主进程
 *   KEEP_OPEN=1    跑完不杀进程（人工看窗口用）
 *
 * 步骤格式（steps/*.mjs，default 导出）：
 *   [
 *     { name: '01-home', shot: true,
 *       js: `const el = document.querySelector('.topbar'); return { text: el?.textContent };` },
 *     { name: '02-play', js: `...` },
 *   ]
 * js 会被包进 `(async () => { ... })()` 在页面上下文执行，返回 JSON 可序列化值。
 * 每步之后可带 waitMs 等待。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

const electronExe = path.resolve(process.env.ELECTRON_EXE || path.join(repoRoot, 'mac', 'build', 'win-test', 'electron.exe'));
const appDir = path.resolve(process.env.APP_DIR || path.join(repoRoot, 'mac', 'build', 'win-test', 'resources', 'app'));
const outDir = path.resolve(process.env.OUT_DIR || path.join(repoRoot, 'mac', 'build', 'win-test-shots'));
const userData = path.resolve(process.env.USER_DATA || path.join(repoRoot, 'mac', 'build', 'win-test-userdata'));
const cdpPort = Number(process.env.CDP_PORT || 9335);
const stepsPath = path.resolve(process.env.STEPS || path.join(here, 'steps', 'smoke.mjs'));
const keepOpen = process.env.KEEP_OPEN === '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
  console.log(`[cdp] ${message}`);
}

// ---------------------------------------------------------------------------
// CDP 客户端
// ---------------------------------------------------------------------------

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.handlers = new Set();
    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
        else resolve(message.result);
        return;
      }
      if (message.method) {
        this.events.push({ t: Date.now(), method: message.method, params: message.params });
        for (const handler of this.handlers) {
          try {
            handler(message.method, message.params);
          } catch {
            /* 忽略回调异常 */
          }
        }
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP websocket open timeout')), 15_000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', (event) => {
        clearTimeout(timer);
        reject(new Error(`CDP websocket error: ${event.message || 'unknown'}`));
      });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30_000);
    });
  }

  onEvent(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async evaluate(expression, { awaitPromise = true, userGesture = true, retries = 3 } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const result = await this.send('Runtime.evaluate', {
          expression,
          awaitPromise,
          returnByValue: true,
          userGesture,
          allowUnsafeEvalBlockedByCSP: true,
        });
        if (result.exceptionDetails) {
          const details = result.exceptionDetails;
          const description =
            (details.exception && (details.exception.description || details.exception.value)) ||
            details.text ||
            'evaluate failed';
          throw new Error(`page exception: ${String(description).split('\n')[0]}`);
        }
        return result.result ? result.result.value : undefined;
      } catch (error) {
        lastError = error;
        const message = String(error && error.message ? error.message : error);
        // 页面还在导航/重载时 execution context 会被销毁：等一会儿重试，不要直接失败。
        const transient = /Execution context was destroyed|Cannot find context|Target closed|-32000/i.test(message);
        if (!transient || attempt === retries) throw error;
        await sleep(400);
      }
    }
    throw lastError;
  }

  async screenshot(filePath) {
    const result = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await fsp.writeFile(filePath, Buffer.from(result.data, 'base64'));
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`http ${response.status}: ${url}`);
  return response.json();
}

async function waitForPageTarget(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const list = await fetchJson(`http://127.0.0.1:${cdpPort}/json/list`);
      const page = list.find(
        (target) =>
          target.type === 'page' &&
          /^http:\/\/127\.0\.0\.1:/.test(target.url || '') &&
          target.webSocketDebuggerUrl,
      );
      if (page) return page;
      lastError = new Error(`no page target yet: ${list.map((t) => `${t.type}:${t.url}`).join(', ')}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw lastError || new Error('page target not found');
}

// ---------------------------------------------------------------------------
// 页面内测试助手（步骤执行前注入）
// ---------------------------------------------------------------------------

const PRELUDE = `
window.__t = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  async waitFor(fn, timeout = 10000, interval = 100) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try { const value = await fn(); if (value) return value; } catch { /* retry */ }
      await this.sleep(interval);
    }
    return null;
  },
  async waitForSelector(selector, timeout = 10000) {
    return this.waitFor(() => document.querySelector(selector), timeout);
  },
  all(selector) { return Array.from(document.querySelectorAll(selector)); },
  byText(text, selector = 'button, [role="button"], a, .rail-btn, .tab, .pill, .quick-tab, .seg-btn, .chip') {
    const nodes = this.all(selector);
    return nodes.find((node) => (node.textContent || '').trim() === text)
      || nodes.find((node) => (node.getAttribute('aria-label') || '').trim() === text)
      || nodes.find((node) => (node.textContent || '').trim().includes(text))
      || null;
  },
  byAria(label, selector = '[aria-label]') {
    return this.all(selector).find((node) => (node.getAttribute('aria-label') || '').trim() === label) || null;
  },
  center(el) {
    const rect = el.getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  },
  visible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  },
  tap(el) {
    if (!el) return false;
    const point = this.center(el);
    const opts = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', clientX: point.x, clientY: point.y, button: 0, buttons: 1 };
    try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch {}
    try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch {}
    try { el.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 })); } catch {}
    try { el.dispatchEvent(new MouseEvent('mouseup', opts)); } catch {}
    try { el.click(); } catch {}
    return true;
  },
  async clickText(text, selector) {
    const el = this.byText(text, selector);
    if (!el) return false;
    this.tap(el);
    return true;
  },
  async clickAria(label, selector) {
    const el = this.byAria(label, selector);
    if (!el) return false;
    this.tap(el);
    return true;
  },
  outline(root = document.body, depth = 3) {
    const walk = (node, level) => {
      if (!node || node.nodeType !== 1 || level > depth) return null;
      const rect = node.getBoundingClientRect();
      const entry = {
        tag: node.tagName.toLowerCase(),
        cls: (node.className || '').toString().slice(0, 120),
        id: node.id || '',
        aria: node.getAttribute('aria-label') || '',
        title: node.getAttribute('title') || '',
        text: (node.childElementCount ? '' : (node.textContent || '')).trim().slice(0, 80),
        rect: [Math.round(rect.width), Math.round(rect.height)],
      };
      const children = Array.from(node.children).map((child) => walk(child, level + 1)).filter(Boolean);
      if (children.length) entry.children = children;
      return entry;
    };
    return walk(root, 0);
  },
  async shotInfo() {
    return {
      title: document.title,
      url: location.href,
      readyState: document.readyState,
      webview: !!window.chrome?.webview,
      appText: (document.querySelector('#app')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 400),
      bodyClass: document.body.className,
      htmlClasses: Array.from(document.documentElement.classList),
    };
  },
};
return true;
`;

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  if (!fs.existsSync(electronExe)) {
    throw new Error(`找不到 electron.exe：${electronExe}（先跑 mac/shell/scripts/assemble-win-test.sh）`);
  }
  if (!fs.existsSync(path.join(appDir, 'main.js'))) {
    throw new Error(`找不到 ${path.join(appDir, 'main.js')}（先跑 mac/shell/scripts/assemble-win-test.sh）`);
  }
  if (!fs.existsSync(stepsPath)) {
    throw new Error(`找不到步骤文件：${stepsPath}`);
  }
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.mkdir(userData, { recursive: true });

  const stepsModule = await import(pathToFileURL(stepsPath).href);
  const steps = stepsModule.default || [];
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('步骤文件没有导出步骤数组');

  // 干净启动：清掉上一次的 Electron / 截图
  const reportPath = path.join(outDir, 'report.json');
  for (const name of await fsp.readdir(outDir)) {
    if (name.endsWith('.png') || name === 'report.json') {
      await fsp.rm(path.join(outDir, name), { force: true }).catch(() => {});
    }
  }

  const env = {
    ...process.env,
    ZILUX2_ALLOW_MULTI_INSTANCE: '1',
    ZILUX2_USER_DATA: userData,
  };
  // 本机环境里可能有 ELECTRON_RUN_AS_NODE=1（会强制 electron.exe 以 node 模式跑），启动前删掉。
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.ZILUX2_ENGINE) env.ZILUX2_ENGINE = path.resolve(process.env.ZILUX2_ENGINE);
  if (process.env.ZILUX2_WEB_ROOT) env.ZILUX2_WEB_ROOT = path.resolve(process.env.ZILUX2_WEB_ROOT);
  if (process.env.ZILUX2_URL) env.ZILUX2_URL = process.env.ZILUX2_URL;

  const args = [`--remote-debugging-port=${cdpPort}`, '--remote-allow-origins=*', '--no-sandbox'];
  if (process.env.ELECTRON_EXTRA_ARGS) args.push(...process.env.ELECTRON_EXTRA_ARGS.split(' ').filter(Boolean));
  // 显式把 app 目录传给 electron（开发回退目录 mac/shell 也必须能跑；win-test 时等价于 resources/app）。
  args.push(appDir);

  log(`electron: ${electronExe}`);
  log(`app dir : ${appDir}`);
  log(`env     : engine=${env.ZILUX2_ENGINE || '(auto)'} url=${env.ZILUX2_URL || '(engine)'} mock=${env.ZILUX2_MOCK || '0'}`);
  const child = spawn(electronExe, args, {
    cwd: path.dirname(electronExe),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const shellOutput = [];
  const capture = (label) => (chunk) => {
    const text = chunk.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) shellOutput.push(`${label} ${line}`);
    }
  };
  child.stdout?.on('data', capture('OUT'));
  child.stderr?.on('data', capture('ERR'));

  const killChild = () => {
    if (!child.pid || child.killed) return;
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      /* ignore */
    }
  };

  const consoleEntries = [];
  const exceptions = [];
  const result = { ok: false, startedAt: new Date().toISOString(), steps: [], console: consoleEntries, exceptions, shellOutput: [], shots: [] };

  let cdp;
  try {
    const target = await waitForPageTarget();
    log(`page target: ${target.url}`);
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    // 页面可能刚好还在首次加载，等一拍再 enable/取值，避免 execution context 被销毁。
    await sleep(400);
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');

    cdp.onEvent((method, params) => {
      if (method === 'Runtime.consoleAPICalled') {
        const text = (params.args || [])
          .map((arg) => {
            if (arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
            if (arg.description !== undefined) return arg.description;
            if (arg.preview && arg.preview.properties) {
              return arg.preview.properties.map((p) => `${p.name}:${p.value}`).join(',');
            }
            return arg.type;
          })
          .join(' ');
        consoleEntries.push({ kind: 'console', level: params.type, text: text.slice(0, 4000), at: Date.now() });
      } else if (method === 'Log.entryAdded') {
        const entry = params.entry || {};
        consoleEntries.push({
          kind: 'log',
          level: entry.level,
          text: (entry.text || '').slice(0, 4000),
          url: entry.url,
          at: Date.now(),
        });
      } else if (method === 'Runtime.exceptionThrown') {
        const details = params.exceptionDetails || {};
        exceptions.push({
          text: details.text,
          description: details.exception?.description,
          url: details.url,
          line: details.lineNumber,
        });
      } else if (method === 'Page.loadEventFired') {
        consoleEntries.push({ kind: 'page', level: 'info', text: 'loadEventFired', at: Date.now() });
      }
    });

    // 等页面进入可交互：桥存在 + #app 有内容
    await cdp.evaluate(`(async () => {
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        const app = document.querySelector('#app');
        const hasBridge = !!window.chrome?.webview;
        const hasText = app && (app.textContent || '').trim().length > 0;
        if (hasBridge && hasText) return true;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return false;
    })()`);
    await cdp.evaluate(`(async () => { ${PRELUDE} })()`);

    for (const [index, step] of steps.entries()) {
      const name = `${String(index + 1).padStart(2, '0')}-${step.name || 'step'}`;
      const started = Date.now();
      let value = null;
      let error = null;
      try {
        value = await cdp.evaluate(`(async () => { ${step.js || 'return null;'} })()`);
      } catch (err) {
        error = String(err.message || err);
      }
      if (step.waitMs) await sleep(step.waitMs);
      if (step.shot) {
        const file = path.join(outDir, `${name}.png`);
        try {
          await cdp.screenshot(file);
          result.shots.push(file);
        } catch (err) {
          error = `${error || ''} screenshot failed: ${err.message}`;
        }
      }
      // 步骤返回值若显式带 ok:false 视为失败；其它对象/值只要没抛错就算通过。
      const explicitOk = value && typeof value === 'object' && 'ok' in value ? value.ok !== false : value !== false;
      const entry = { name, ok: !error && explicitOk, ms: Date.now() - started, value, error: error || undefined };
      result.steps.push(entry);
      log(`${entry.ok ? 'PASS' : 'FAIL'} ${name} (${entry.ms}ms)${entry.error ? ` error=${entry.error}` : ''}`);
      if (value !== null && value !== undefined) log(`     -> ${JSON.stringify(value).slice(0, 1200)}`);
    }

    result.ok = result.steps.every((step) => step.ok) && exceptions.length === 0;
  } catch (error) {
    result.error = String(error && error.stack ? error.stack : error);
    log(`ERROR ${result.error}`);
    try {
      if (cdp) await cdp.screenshot(path.join(outDir, '99-failure.png')).then(() => result.shots.push(path.join(outDir, '99-failure.png')));
    } catch {
      /* 页面可能已挂 */
    }
  } finally {
    result.shellOutput = shellOutput.slice(-400);
    result.finishedAt = new Date().toISOString();
    await fsp.writeFile(reportPath, JSON.stringify(result, null, 2), 'utf8').catch(() => {});
    const errors = consoleEntries.filter((entry) => entry.level === 'error');
    const warnings = consoleEntries.filter((entry) => entry.level === 'warning' || entry.level === 'warn');
    console.log('');
    console.log(`==== report: ${reportPath}`);
    console.log(`steps   : ${result.steps.filter((s) => s.ok).length}/${result.steps.length} passed`);
    console.log(`console : ${consoleEntries.length} entries (${errors.length} errors, ${warnings.length} warnings)`);
    console.log(`exception: ${exceptions.length}`);
    console.log(`shots   : ${result.shots.length}`);
    if (!keepOpen) killChild();
    process.exitCode = result.ok ? 0 : 1;
  }
}

main().catch((error) => {
  console.error(`[cdp] fatal: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 2;
});
