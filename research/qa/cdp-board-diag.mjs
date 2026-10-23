const CDP_PORT = 9333;
const URL = 'http://127.0.0.1:4174/index.html?enter=1&instant=1&snap=1&mock=1';
async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve) => { const msgId = ++id; pending.set(msgId, resolve); ws.send(JSON.stringify({ id: msgId, method, params })); });
  const events = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      events.push('EXCEPTION text=' + d.text + ' line=' + d.lineNumber + ' col=' + d.columnNumber + ' url=' + d.url + ' desc=' + (d.exception?.description || '').slice(0, 1200));
    }
    if (msg.method === 'Runtime.consoleAPICalled') events.push('CONSOLE[' + msg.params.type + '] ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 600));
  });
  const evalJs = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return res?.result?.value;
  };
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 960, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__errs=[];window.addEventListener('error',(e)=>{window.__errs.push({m:e.message,f:e.filename,l:e.lineno,c:e.colno,stack:(e.error&&e.error.stack||'').slice(0,2000)});});window.addEventListener('unhandledrejection',(e)=>{window.__errs.push({rej:String(e.reason&&e.reason.stack||e.reason).slice(0,2000)});});` });
  await send('Page.navigate', { url: URL });
  await new Promise((r) => setTimeout(r, 4500));
  console.log('ERRS:', JSON.stringify(await evalJs('window.__errs'), null, 1));
  console.log('DOMSTATE:', await evalJs(`(() => { const q=(s)=>document.querySelector(s); const r=q('[data-rail="settings"]'); const cs=(el)=>el?getComputedStyle(el):null; return JSON.stringify({ shell: q('.space-shell')?.className, railRect: r?r.getBoundingClientRect():null, railOpacity: r?cs(r).opacity:null, railDisplay: r?cs(r).display:null, railVisibility: r?cs(r).visibility:null, railParentOpacity: cs(q('.space-rail'))?.opacity, canvasRect: q('.space-canvas')?.getBoundingClientRect(), htmlClass: document.documentElement.className, sheetOpen: !!q('.settings-sheet') }); })()`));
  await evalJs(`document.querySelector('[data-rail="settings"]')?.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}))`);
  await new Promise((r) => setTimeout(r, 1200));
  console.log('AFTER CLICK shell:', await evalJs(`document.querySelector('.space-shell')?.className`));
  console.log('AFTER CLICK errs:', JSON.stringify(await evalJs('window.__errs'), null, 1));
  console.log('events:', events.slice(0, 12).join('\n---\n'));
  ws.close();
}
main().catch((e) => { console.error('ERR', e); process.exit(1); });
