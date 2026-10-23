/**
 * 引擎契约探针（仅开发联调用）：不经过 Electron 壳，直接按契约启动引擎并校验：
 *   1. 可执行文件存在、能启动；
 *   2. stdout 打印一行 `ZILUX2_READY {"port":...,"token":...,"sources":[...]}`；
 *   3. `GET /api/health`、`GET /api/sources?token=...` 可用（同端口还服务 web 静态文件）；
 *   4. `GET /index.html` 返回页面。
 *
 * 用法（Windows 联调）：
 *   node mac/shell/dev/probe-engine.mjs
 *   node mac/shell/dev/probe-engine.mjs --engine mac/engine/publish/win-x64/Zilux2MacEngine.exe --web-root web/dist
 * 参数也支持环境变量 ZILUX2_ENGINE / ZILUX2_WEB_ROOT，以及 --timeout <ms>。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

const argv = process.argv.slice(2);
const readFlag = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const isWin = process.platform === 'win32';
const enginePath = path.resolve(
  readFlag('--engine', process.env.ZILUX2_ENGINE || path.join(repoRoot, 'mac', 'engine', 'publish', isWin ? 'win-x64' : 'osx-arm64', isWin ? 'Zilux2MacEngine.exe' : 'Zilux2MacEngine')),
);
const webRoot = path.resolve(readFlag('--web-root', process.env.ZILUX2_WEB_ROOT || path.join(repoRoot, 'web', 'dist')));
const timeoutMs = Number(readFlag('--timeout', '30000'));

const log = (message) => console.log(`[probe] ${message}`);

function fail(message) {
  console.error(`[probe] FAIL ${message}`);
  process.exitCode = 1;
}

if (!fs.existsSync(enginePath)) {
  fail(`引擎不存在：${enginePath}`);
  process.exit(1);
}
if (!fs.existsSync(path.join(webRoot, 'index.html'))) {
  fail(`web root 无效（没有 index.html）：${webRoot}`);
  process.exit(1);
}

log(`engine : ${enginePath}`);
log(`webRoot: ${webRoot}`);

const started = Date.now();
const child = spawn(enginePath, ['--web-root', webRoot], {
  cwd: path.dirname(enginePath),
  // stdin 保持打开：引擎把 stdin EOF 当退出指令（Electron 壳里同样必须喂一条 pipe）。
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

let output = '';
let ready = null;
let settled = false;
let buffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  output += chunk;
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).replace(/\r$/, '');
    buffer = buffer.slice(index + 1);
    log(`stdout: ${line}`);
    if (!ready && line.startsWith('ZILUX2_READY')) {
      try {
        ready = JSON.parse(line.slice('ZILUX2_READY'.length).trim());
      } catch (error) {
        fail(`READY 行不是合法 JSON：${error.message}`);
      }
      if (ready) verify(ready);
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  for (const line of chunk.split(/\r?\n/)) if (line.trim()) log(`stderr: ${line}`);
});
child.on('exit', (code, signal) => {
  if (!settled) fail(`引擎提前退出 code=${code} signal=${signal ?? ''}`);
});

const timer = setTimeout(() => {
  if (!ready) fail(`${timeoutMs}ms 内没有收到 ZILUX2_READY（stdout 如下）\n${output}`);
  finish();
}, timeoutMs);

function finish(earlyCode) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  try {
    if (isWin && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    log(`done, took ${Date.now() - started}ms`);
    process.exit(process.exitCode ?? earlyCode ?? 0);
  }, 300);
}

async function fetchCheck(port, pathname, { expectStatus = 200, expectJson = false } = {}) {
  const url = `http://127.0.0.1:${port}${pathname}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  const entry = {
    path: pathname,
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    bytes: Buffer.byteLength(text),
    ok: response.status === expectStatus,
    problem: null,
  };
  if (expectJson) {
    const typeOk = entry.contentType.includes('application/json');
    if (!typeOk) {
      entry.ok = false;
      entry.problem = `content-type 不是 JSON: ${entry.contentType}`;
    } else {
      try {
        entry.json = JSON.parse(text);
      } catch {
        entry.ok = false;
        entry.problem = '响应不是合法 JSON';
      }
    }
  }
  if (!entry.ok && !entry.problem) entry.problem = `HTTP ${response.status}`;
  return entry;
}

async function verify(info) {
  try {
    if (typeof info.port !== 'number' || info.port <= 0) throw new Error(`READY.port 非法: ${JSON.stringify(info)}`);
    if (typeof info.token !== 'string' || info.token.length === 0) throw new Error('READY.token 缺失');
    if (!Array.isArray(info.sources)) throw new Error('READY.sources 缺失');
    log(`READY port=${info.port} tokenLen=${info.token.length} sources=${info.sources.join(',')}`);

    const checks = [];
    checks.push(await fetchCheck(info.port, '/index.html'));
    checks.push(await fetchCheck(info.port, `/api/health?token=${encodeURIComponent(info.token)}`, { expectJson: true }));
    checks.push(await fetchCheck(info.port, `/api/sources?token=${encodeURIComponent(info.token)}`, { expectJson: true }));

    for (const check of checks) {
      log(`${check.ok ? 'PASS' : 'FAIL'} GET ${check.path} -> ${check.status} ${check.contentType} ${check.bytes}B${check.problem ? ` (${check.problem})` : ''}`);
      if (check.json) log(`     json: ${JSON.stringify(check.json).slice(0, 500)}`);
      if (!check.ok) process.exitCode = 1;
    }

    // 静态 index.html 内容抽查：应该就是 web/dist 的页面，且引用的第一个 https 资源可访问
    const html = await (await fetch(`http://127.0.0.1:${info.port}/index.html`)).text();
    const hasApp = html.includes('id="app"');
    log(`${hasApp ? 'PASS' : 'FAIL'} index.html 含 #app（${html.length} bytes）`);
    if (!hasApp) process.exitCode = 1;
    const asset = /(?:src|href)="\.?(\/assets\/[^"]+)"/.exec(html);
    if (asset) {
      const assetCheck = await fetchCheck(info.port, asset[1]);
      log(`${assetCheck.ok ? 'PASS' : 'FAIL'} GET ${asset[1]} -> ${assetCheck.status} ${assetCheck.contentType} ${assetCheck.bytes}B`);
      if (!assetCheck.ok) process.exitCode = 1;
    } else {
      log('WARN index.html 里没找到 /assets/ 资源引用');
    }

    finish(process.exitCode ?? 0);
  } catch (error) {
    fail(`校验失败：${error.message}`);
    finish(1);
  }
}
