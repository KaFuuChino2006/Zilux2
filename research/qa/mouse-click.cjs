// 用 CDP 发真实鼠标事件点击坐标（绕过合成 PointerEvent 不被信任的问题）。
const http = require('node:http');

const port = 9223;
const [x, y] = process.argv.slice(2).map(Number);
if (!Number.isFinite(x) || !Number.isFinite(y)) {
  console.error('usage: node mouse-click.cjs <x> <y>');
  process.exit(1);
}

function listTargets() {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/json/list' }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  const targets = await listTargets();
  const target = targets.find((item) => item.type === 'page');
  if (!target) throw new Error('no page target');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, (message) => {
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  console.log(`clicked ${x},${y}`);
  socket.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
