// Run with: node --test web/tests/coverUrl.test.cjs
//
// 封面 URL 跨重启的坑（m08747）：
//   宿主每次启动都换回环端口；队列/歌单里的封面 URL 会被存进 localStorage，
//   旧 URL 因此指向一个已经没人监听的端口。以前 `withLoopbackToken` 见到
//   「已经有 token」就直接原样返回，于是旧端口 + 旧 token 一直活下来：
//   页面缩略图全空、SMTC 封面拿不到，日志里是 `127.0.0.1:58123 connection refused`。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function loadLibrary(info) {
  const file = path.resolve(__dirname, '../src/core/library.ts');
  const source = fs.readFileSync(file, 'utf8');
  const exports = {};
  const raw = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(raw, {
    exports,
    console,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    window: { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} },
    require: (name) => {
      if (name.includes('online/client')) {
        class OnlineError extends Error {}
        return {
          OnlineError,
          isMockOnline: () => false,
          onlineInfo: () => info,
          onlineReady: () => Boolean(info),
        };
      }
      if (name.includes('account')) return { onAccountChange: () => () => {} };
      return {};
    },
  }, { filename: file });
  return exports;
}

test('回环封面 URL 会把旧端口与旧 token 换成这一场的（m08747 回归）', () => {
  const lib = loadLibrary({ port: 5001, token: 'newtok', sources: ['netease'] });
  const stale = 'http://127.0.0.1:58123/api/cover?source=netease&key=abc&token=oldtok';
  const fixed = lib.resolveCoverUrl(stale);
  assert.ok(fixed.includes(':5001/'), `端口应改成 5001，实为 ${fixed}`);
  assert.ok(fixed.includes('token=newtok'), `token 应改成 newtok，实为 ${fixed}`);
  assert.ok(!fixed.includes('oldtok'), '旧 token 不该残留');
});

test('端口没变时不动 URL 的其他部分；缺 token 才补（m08747 回归）', () => {
  const lib = loadLibrary({ port: 5001, token: 'newtok', sources: ['netease'] });
  const same = 'http://127.0.0.1:5001/api/cover?source=qq&key=xyz&token=newtok';
  assert.equal(lib.resolveCoverUrl(same), same);

  const noToken = 'http://127.0.0.1:5001/api/cover?source=qq&key=xyz';
  assert.equal(lib.resolveCoverUrl(noToken), `${noToken}&token=newtok`);
});

test('非回环外链与 data URL 原样返回（m08747 回归）', () => {
  const lib = loadLibrary({ port: 5001, token: 'newtok', sources: ['netease'] });
  const remote = 'https://p1.music.126.net/cover.jpg';
  assert.equal(lib.resolveCoverUrl(remote), remote);
  const data = 'data:image/png;base64,AAAA';
  assert.equal(lib.resolveCoverUrl(data), data);
  assert.equal(lib.resolveCoverUrl(undefined), undefined);
});
