const CDP_PORT = 9333;
const URL = process.argv[2];
const fs = await import('node:fs');

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
  const send = (method, params = {}) => new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') errors.push('EXC ' + JSON.stringify(msg.params.exceptionDetails).slice(0, 300));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r?.result?.value;
  };
  const click = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 60));
    }
  };
  await new Promise((resolve) => ws.addEventListener('open', resolve));
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 960, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL });
  await new Promise((r) => setTimeout(r, 6000));

  // 1) 左侧按钮命中测试
  const rail = await evaluate(`(() => {
    const el = document.elementFromPoint(47, 396);
    const btn = el && el.closest('.space-rail-btn');
    return { tag: el && el.tagName, cls: el && el.className, rail: btn && btn.dataset.rail };
  })()`);
  console.log('rail hit:', JSON.stringify(rail));

  // 2) 搜索框命中 + 展开宽度动画采样
  const searchHit = await evaluate(`(() => {
    const el = document.elementFromPoint(750, 42);
    return { tag: el && el.tagName, cls: el && el.className };
  })()`);
  console.log('search hit:', JSON.stringify(searchHit));
  await evaluate(`document.querySelector('[data-searchbar]').scrollIntoView()`);
  await click(750, 42);
  await new Promise((r) => setTimeout(r, 90));
  const w1 = await evaluate(`Math.round(document.querySelector('[data-searchbar]').getBoundingClientRect().width)`);
  await new Promise((r) => setTimeout(r, 400));
  const w2 = await evaluate(`Math.round(document.querySelector('[data-searchbar]').getBoundingClientRect().width)`);
  console.log('search width 90ms/490ms:', w1, w2);

  // 3) 左侧设置按钮真实点击 → 设置面板打开？
  await click(47, 747);
  await new Promise((r) => setTimeout(r, 700));
  const settings = await evaluate(`(() => {
    const el = document.querySelector('[data-settings-sheet]');
    return el ? { hidden: el.hidden, open: el.classList.contains('is-open') } : null;
  })()`);
  console.log('settings sheet:', JSON.stringify(settings));
  console.log('errors:', errors.length ? errors : 'none');
  ws.close();
}
main().catch((err) => { console.error('ERR', err); process.exit(1); });
