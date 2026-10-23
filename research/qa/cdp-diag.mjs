const PORT = Number(process.argv[2] ?? 9444);
const WAIT = Number(process.argv[3] ?? 12000);

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'));
  if (!page) throw new Error('no page target: ' + JSON.stringify(targets.map((t) => t.url)));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const msgId = ++id;
      pending.set(msgId, resolve);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      events.push('EXC ' + JSON.stringify(msg.params.exceptionDetails).slice(0, 500));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      events.push(
        msg.params.type + ' ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 500),
      );
    }
    if (msg.method === 'Log.entryAdded') {
      events.push('LOG ' + msg.params.entry.level + ' ' + msg.params.entry.text.slice(0, 500));
    }
    if (msg.method === 'Inspector.targetCrashed') events.push('CRASH targetCrashed');
  });
  await new Promise((resolve) => ws.addEventListener('open', resolve));
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await new Promise((resolve) => setTimeout(resolve, WAIT));
  const title = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
  const ready = await send('Runtime.evaluate', {
    expression: `({ rs: document.readyState, canvas: !!document.querySelector('canvas'), body: document.body?.innerText?.slice(0,120) })`,
    returnByValue: true,
  });
  console.log('title:', title?.result?.value);
  console.log('ready:', JSON.stringify(ready?.result?.value));
  console.log('events:', events.length ? events.slice(0, 20) : 'none');
  ws.close();
}
main().catch((err) => {
  console.error('ERR', err);
  process.exit(1);
});
