// Minimal CDP client for the running Zilux2 WebView2 window.
// Usage:
//   node cdp.mjs eval "<expression>"        -> prints JSON result of Runtime.evaluate
//   node cdp.mjs evalfile <file.js>         -> same, reads expression from file
//   node cdp.mjs shot <out.png>             -> Page.captureScreenshot
//   node cdp.mjs targets                    -> list debuggable targets
// Requires the app to be started with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223
import fs from 'node:fs';

const ENDPOINT = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9223';
const [, , cmd, ...rest] = process.argv;

function wsUrl(target) {
  return target.webSocketDebuggerUrl;
}

class CDP {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = null;
  }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', (e) => reject(new Error('ws error: ' + (e.message || e.type))), { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
    return this;
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

async function main() {
  const list = await (await fetch(ENDPOINT + '/json/list')).json();
  if (cmd === 'targets') {
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  const target = list.find((t) => t.type === 'page' && String(t.url).includes('index.html')) || list[0];
  if (!target) throw new Error('no debuggable page target');
  const cdp = await new CDP(wsUrl(target)).open();
  try {
    if (cmd === 'eval' || cmd === 'evalfile') {
      const expression = cmd === 'evalfile' ? fs.readFileSync(rest[0], 'utf8') : rest.join(' ');
      const result = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (result.exceptionDetails) {
        console.error('EXCEPTION: ' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text));
        process.exitCode = 1;
      } else {
        console.log(JSON.stringify(result.result?.value ?? result.result, null, 2));
      }
    } else if (cmd === 'shot') {
      const out = rest[0] || 'cdp-shot.png';
      const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
      fs.writeFileSync(out, Buffer.from(result.data, 'base64'));
      console.log('saved ' + out + ' ' + fs.statSync(out).size + ' bytes');
    } else {
      throw new Error('unknown command: ' + cmd);
    }
  } finally {
    cdp.close();
  }
}

main().catch((err) => { console.error('ERROR: ' + (err && err.stack || err)); process.exit(1); });
