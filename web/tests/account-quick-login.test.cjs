const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the actual login-panel method, with network/timers and a small DOM harness.
const source = ts.createSourceFile('app.ts', fs.readFileSync(path.join(__dirname, '../src/ui/app.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const appClass = source.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'App');
const method = appClass.members.find(n => n.name?.getText(source) === 'buildLoginPanel');
const code = ts.transpileModule(`class Harness { ${method.getText(source)} } exports.Harness = Harness;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

class Node {
  constructor(tag, props, children) {
    this.tag = tag; this.children = children; this.events = {}; this.disabled = false;
    this.classes = new Set((props.class || '').split(' ')); Object.assign(this, props);
    this._text = props.text || '';
    this.classList = { add: (...c) => c.forEach(x => this.classes.add(x)), remove: (...c) => c.forEach(x => this.classes.delete(x)) };
  }
  set textContent(value) { this._text = value; this.children = []; }
  get textContent() { return this._text; }
  append(...nodes) { this.children.push(...nodes); }
  addEventListener(event, fn) { this.events[event] = fn; }
  querySelectorAll(selector) { return this.all().filter(n => n.tag === selector); }
  all() { return this.children.flatMap(n => [n, ...n.all()]); }
  async click() { if (!this.disabled) await this.events.click?.(); }
}

function harness(source = 'qq', options = {}) {
  const calls = [], login = deferred(), polling = deferred();
  const qrCalls = [], pollCalls = [];
  const timers = new Map(); let nextTimer = 0, changed = 0, popups = 0;
  const exports = {};
  vm.runInNewContext(code, {
    exports, console: { ...console, warn() {} }, Error,
    h: (tag, props, ...children) => new Node(tag, props, children.filter(Boolean)),
    accountOf: () => ({ loggedIn: false }),
    quickAccount: async () => ({ available: true, accounts: [
      { id: 'local-qq-A', nickname: 'A', avatarUrl: 'https://q1.qlogo.cn/a' },
      { id: 'local-qq-B', nickname: 'B', avatarUrl: 'https://q1.qlogo.cn/b' },
    ] }),
    quickWebLogin: (platform, id) => { calls.push([platform, id]); return login.promise; },
    webLogin: () => { popups++; },
    refreshAccounts: async () => {},
    requestQr: async (platform, channel) => {
      qrCalls.push([platform, channel]);
      return options.requestQr ? options.requestQr(platform, channel)
        : { key: `qr-${qrCalls.length}`, mode: 'image', imageDataUrl: 'data:image/png;base64,AA==' };
    },
    pollLogin: (...args) => { pollCalls.push(args); return polling.promise; },
    toast: () => {}, SOURCE_LABEL: { qq: 'QQ 音乐', netease: '网易云' },
    window: {
      setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay, repeat: false }); return id; },
      setInterval: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay, repeat: true }); return id; },
      clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
    },
  });
  const app = new exports.Harness();
  app.refreshAccountDependentViews = () => {};
  app.syncAccount = () => {};
  app.likedCache = { clear() {} };
  const view = app.buildLoginPanel(source, () => changed++);
  const find = cls => view.root.all().filter(n => n.classes.has(cls));
  const startQr = async () => {
    const entry = [...timers.entries()].find(([, t]) => t.delay === 160);
    timers.delete(entry[0]); entry[1].fn(); await flush();
  };
  return { ...view, find, login, polling, calls, qrCalls, pollCalls, timers, startQr, changed: () => changed, popups: () => popups };
}

for (const source of ['qq', 'netease', 'kugou']) {
  test(`${source}: the clicked local account signs in once without a popup`, async () => {
    const h = harness(source); await flush(); await h.startQr();
    const buttons = h.find('login-quick-btn');
    assert.equal(buttons.length, 2);
    assert.equal(h.calls.length, 0, 'discovery must not authorize');
    const pending = buttons[1].click();
    await buttons[0].click(); await buttons[1].click();
    assert.deepEqual(h.calls, [[source, 'local-qq-B']]);
    assert.ok(buttons.every(b => b.disabled));
    h.login.resolve(); await pending;
    assert.equal(h.changed(), 1); assert.equal(h.popups(), 0);
    assert.equal(h.find('qr-note')[0].textContent, '登录成功');
    h.dispose(); assert.equal(h.timers.size, 1); // only the short QR entrance animation remains
  });
}

test('a QR response in flight cannot overwrite quick-login feedback; failure stays inline', async () => {
  const h = harness(); await flush(); await h.startQr();
  [...h.timers.values()].find(t => t.repeat).fn();
  const pending = h.find('login-quick-btn')[0].click();
  h.polling.resolve({ state: 'scanned' }); await flush();
  assert.equal(h.find('qr-note')[0].textContent, '正在用本机 QQ 登录…');
  h.login.reject(new Error('请重试或扫码登录')); await pending;
  assert.equal(h.find('qr-note')[0].textContent, '请重试或扫码登录');
  assert.equal(h.popups(), 0); assert.equal(h.changed(), 0);
  assert.ok([...h.timers.values()].some(t => t.repeat), 'QR polling resumes after failure');
  assert.ok(h.find('login-quick-btn').every(b => !b.disabled));
});

test('closing a panel during login prevents delayed UI updates and polling resurrection', async () => {
  const h = harness(); await flush(); await h.startQr();
  const pending = h.find('login-quick-btn')[0].click();
  h.dispose(); h.login.reject(new Error('cancelled')); await pending;
  assert.equal(h.changed(), 0); assert.equal(h.popups(), 0);
  assert.ok(![...h.timers.values()].some(t => t.repeat));
});

test('NetEase defaults to a QQ QR; selecting its app replaces the session and ignores old scan replies', async () => {
  const h = harness('netease'); await flush(); await h.startQr();
  assert.deepEqual(h.qrCalls, [['netease', 'ptlogin']]);
  assert.ok(h.find('login-qr-channel')[0].classes.has('is-on'));
  [...h.timers.values()].find(t => t.repeat).fn();
  await h.find('login-qr-channel')[1].click(); await flush();
  assert.deepEqual(h.qrCalls, [['netease', 'ptlogin'], ['netease', undefined]]);
  assert.ok(h.find('login-qr-channel')[1].classes.has('is-on'));
  h.polling.resolve({ state: 'scanned', message: 'old QQ scan' }); await flush();
  assert.equal(h.find('qr-note')[0].textContent, '使用网易云音乐 App 扫一扫登录');
  assert.equal(h.find('login-scan-hint')[0].textContent, '网易云音乐 App 扫一扫');
});

test('failure to obtain a QQ QR stays explicit and never silently changes scan apps', async () => {
  const h = harness('netease', { requestQr: async (_, channel) => {
    if (channel === 'ptlogin') throw new Error('offline');
    return { key: 'app-key', mode: 'image', imageDataUrl: 'data:image/png;base64,AA==' };
  } });
  await flush(); await h.startQr();
  assert.equal(h.qrCalls.length, 1);
  assert.ok(h.find('login-qr-channel')[0].classes.has('is-on'));
  assert.equal(h.popups(), 0);
  await h.find('login-qr-channel')[1].click(); await flush();
  assert.equal(h.qrCalls.length, 2);
  assert.equal(h.find('qr-note')[0].textContent, '使用网易云音乐 App 扫一扫登录');
});

test('QR polling is serialized for each code and displays the platform confirmation message', async () => {
  const h = harness('netease'); await flush(); await h.startQr();
  const tick = [...h.timers.values()].find(t => t.repeat).fn;
  tick(); tick(); tick();
  assert.equal(h.pollCalls.length, 1);
  h.polling.resolve({ state: 'scanned', message: '手机 QQ 已确认，正在完成网易云授权…' }); await flush();
  assert.equal(h.find('qr-note')[0].textContent, '手机 QQ 已确认，正在完成网易云授权…');
});

test('closing before a QR arrives cannot start a background polling loop', async () => {
  const qr = deferred();
  const h = harness('netease', { requestQr: () => qr.promise }); await flush(); await h.startQr();
  h.dispose();
  qr.resolve({ key: 'late', mode: 'image', imageDataUrl: 'data:image/png;base64,AA==' }); await flush();
  assert.ok(![...h.timers.values()].some(t => t.repeat));
  assert.equal(h.popups(), 0);
});
