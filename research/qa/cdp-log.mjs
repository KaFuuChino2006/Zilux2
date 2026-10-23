// Collect page console/exception output for a few seconds (optionally after reload).
// Usage: node cdp-log.mjs [--reload] [--ms 9000]
import fs from 'node:fs';

const ENDPOINT = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9223';
const args = process.argv.slice(2);
const reload = args.includes('--reload');
const msIndex = args.indexOf('--ms');
const duration = msIndex >= 0 ? Number(args[msIndex + 1]) : 9000;

const list = await (await fetch(ENDPOINT + '/json/list')).json();
const target = list.find((t) => t.type === 'page' && String(t.url).includes('index.html')) || list[0];
if (!target) throw new Error('no page target');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
});

let id = 1;
const pending = new Map();
const logs = [];
ws.addEventListener('message', (event) => {
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    logs.push(`[${msg.params.type}] ${text}`);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    logs.push(`[EXCEPTION] ${d.exception?.description || d.text}`);
  } else if (msg.method === 'Log.entryAdded') {
    logs.push(`[log:${msg.params.entry.level}] ${msg.params.entry.text}`);
  }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const current = id++;
  pending.set(current, resolve);
  ws.send(JSON.stringify({ id: current, method, params }));
});

await send('Runtime.enable');
await send('Log.enable');
if (reload) await send('Page.reload', { ignoreCache: false });
await new Promise((r) => setTimeout(r, duration));
if (reload) {
  // 打开歌词页（纯字档），把绘制链路上的异常也抓出来。
  await send('Runtime.evaluate', {
    expression: "document.querySelector('.pb-btn-lyrics')?.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true}))",
    userGesture: true,
  });
  await new Promise((r) => setTimeout(r, 4000));
}
ws.close();
fs.writeFileSync('research/tmp/last-console.log', logs.join('\n'), 'utf8');
console.log(logs.slice(-60).join('\n') || '(no console output)');
