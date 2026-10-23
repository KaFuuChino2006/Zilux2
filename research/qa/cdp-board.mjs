const CDP_PORT = 9333;
const URL = 'http://127.0.0.1:4174/index.html?enter=1&instant=1&snap=1&mock=1';
const OUT = 'E:\\Zilux2开发\\research\\shots\\';
const fs = await import('node:fs');

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  const log = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') log.push('EXCEPTION: ' + JSON.stringify(msg.params.exceptionDetails).slice(0, 400));
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') log.push('CONSOLE: ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
  });
  const evalJs = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return res?.result?.value;
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT + name, Buffer.from(s.data, 'base64'));
    console.log('shot', name);
  };
  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, ...extra });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await new Promise((resolve) => ws.addEventListener('open', resolve));
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 960, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL });
  await wait(4200);
  console.log('entered:', await evalJs(`document.querySelector('.space-shell')?.classList.contains('is-entered')`));

  // 打开 3D 设置面板：点左 rail 设置按钮
  await evalJs(`document.querySelector('[data-rail="settings"]')?.click()`);
  await wait(1400);
  console.log('board class:', await evalJs(`document.querySelector('.space-shell')?.className`));
  await shot('board-new-1-open.png');

  // ① 面板内滚轮：鼠标停在面板内容区，向上滚两次
  await mouse('mouseMoved', 834, 640);
  await mouse('mouseWheel', 834, 640, { deltaX: 0, deltaY: 260 });
  await wait(700);
  await shot('board-new-2-scrolled-1.png');
  await mouse('mouseWheel', 834, 640, { deltaX: 0, deltaY: 260 });
  await wait(700);
  await shot('board-new-3-scrolled-2.png');
  // 滚回顶部
  await mouse('mouseWheel', 834, 640, { deltaX: 0, deltaY: -520 });
  await wait(900);
  await shot('board-new-4-backtop.png');

  // ② 拖动面板：按住标题栏拖到右上
  await mouse('mouseMoved', 834, 470);
  await mouse('mousePressed', 834, 470, { button: 'left', buttons: 1, clickCount: 1 });
  await wait(80);
  for (let i = 1; i <= 6; i += 1) {
    await mouse('mouseMoved', 834 + i * 30, 470 - i * 12, { buttons: 1 });
    await wait(40);
  }
  await mouse('mouseReleased', 1014, 398, { button: 'left', buttons: 0, clickCount: 1 });
  await wait(900);
  await shot('board-new-5-dragged.png');

  // 面板外滚轮：应当仍是缩放场景（对比截图）
  await mouse('mouseMoved', 240, 720);
  await mouse('mouseWheel', 240, 720, { deltaX: 0, deltaY: 300 });
  await wait(900);
  await shot('board-new-6-scene-zoom.png');

  console.log('log:', log.slice(0, 8));
  ws.close();
}
main().catch((err) => { console.error('ERR', err); process.exit(1); });
