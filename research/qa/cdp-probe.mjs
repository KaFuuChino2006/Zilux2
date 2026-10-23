const CDP_PORT = 9333;
const URL = 'http://127.0.0.1:4174/index.html?snap=1&mock=1&panel=liked';

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  const events = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      events.push(`EXCEPTION: ${d.text} ${d.exception?.description ?? ''} @${d.url ?? ''}:${d.lineNumber ?? ''}`);
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
      if (msg.params.type === 'error' || msg.params.type === 'warning') events.push(`CONSOLE(${msg.params.type}): ${text}`);
    }
    if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      if (e.level === 'error') events.push(`LOG: ${e.text} @${e.url ?? ''}:${e.lineNumber ?? ''}`);
    }
  });
  await new Promise((resolve) => ws.addEventListener('open', resolve));
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: URL });
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const state = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      shell: document.querySelector('.space-shell')?.className ?? 'none',
      canvas: !!document.querySelector('.space-canvas'),
      status: document.querySelector('[data-space-status]')?.textContent ?? '',
      buttons: document.querySelectorAll('[data-page]').length,
      isEntered: document.querySelector('.space-shell')?.classList.contains('is-entered') ?? false
    })`,
    returnByValue: true,
  });
  console.log('STATE:', state?.result?.value);
  console.log('EVENTS:');
  for (const e of events.slice(0, 20)) console.log(' -', e);
  ws.close();
}
main().catch((err) => { console.error('ERR', err); process.exit(1); });
