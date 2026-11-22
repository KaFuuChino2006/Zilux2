'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

/** 把 `web/src/online/lyricRange.ts` 转译后跑在 vm 里（无浏览器依赖的纯函数模块）。 */
function load() {
  const file = path.join(__dirname, '..', 'src', 'online', 'lyricRange.ts');
  const source = fs.readFileSync(file, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: file,
  }).outputText;
  const exports = {};
  const module = { exports };
  // 依赖同目录的歌词解析纯函数（`./lrc`）：真实加载，但只用到 parseLrc 这一支。
  const requireStub = (specifier) => {
    if (specifier === './lrc' || specifier.endsWith('/lrc')) {
      const lrcFile = path.join(__dirname, '..', 'src', 'online', 'lrc.ts');
      const lrcJs = ts.transpileModule(fs.readFileSync(lrcFile, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
        fileName: lrcFile,
      }).outputText;
      const lrcExports = {};
      const lrcModule = { exports: lrcExports };
      new Function('exports', 'require', 'module', lrcJs)(lrcExports, () => ({}), lrcModule);
      return lrcModule.exports;
    }
    return {};
  };
  new Function('exports', 'require', 'module', js)(exports, requireStub, module);
  return module.exports;
}

test('LRC 首句时间戳为 0 也要计入人声区间', () => {
  const mod = load();
  const lrc = '[00:00.00]第一句\n[00:04.00]第二句\n[00:08.00]第三句';
  const range = mod.singingRangeFromLyric({ lrc });
  assert.ok(range, '应解析出区间');
  assert.strictEqual(range.firstMs, 0, '首句不能因为 timeMs=0 被丢掉');
  assert.strictEqual(range.lastStartMs, 8000);
});
