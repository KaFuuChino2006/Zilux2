const CDP_PORT = 9333;
const pageUrl = process.argv[2];
async function main() {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (m, p = {}) => new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method: m, params: p }));
  });
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 960, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: pageUrl });
  await new Promise((r) => setTimeout(r, 9000));
  for (const expr of ['window.__lyricDebug2 ?? null', 'window.__lyricDebug ?? null']) {
    const out = await send('Runtime.evaluate', { expression: `JSON.stringify(${expr})`, returnByValue: true });
    console.log(out?.result?.value);
  }
  ws.close();
}
main().catch((e) => { console.error('ERR', e); process.exit(1); });
