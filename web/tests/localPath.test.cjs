"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

function loadStripExt() {
  const file = path.join(__dirname, "..", "src", "ui", "local.ts");
  const source = fs.readFileSync(file, "utf8");
  // stripExt 是模块私有函数：抽出来单独编译（不引入整个 local.ts 的 DOM 依赖）。
  const match = /function stripExt\(rel: string\): string \{[\s\S]*?\n\}/.exec(source);
  assert.ok(match, "stripExt not found in local.ts");
  const js = ts.transpileModule(match[0], { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} };
  new Function("exports", "module", js + "\nexports.stripExt = stripExt;");
  const fn = new Function("exports", "module", js + "\nexports.stripExt = stripExt;");
  fn(module.exports, module);
  return module.exports.stripExt;
}

test("stripExt 只切最后一段的扩展名", () => {
  const stripExt = loadStripExt();
  assert.equal(stripExt("a/b/song.flac"), "a/b/song");
});

test("stripExt 不会把带点的目录名当扩展名", () => {
  const stripExt = loadStripExt();
  assert.equal(stripExt("Vol.2/song"), "Vol.2/song");
  assert.equal(stripExt("music/Vol.2/song.flac"), "music/Vol.2/song");
});

test("stripExt 对隐藏文件与无扩展名保持原样", () => {
  const stripExt = loadStripExt();
  assert.equal(stripExt(".hidden"), ".hidden");
  assert.equal(stripExt("noext"), "noext");
});
