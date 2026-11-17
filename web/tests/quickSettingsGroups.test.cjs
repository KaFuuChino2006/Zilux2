/**
 * 界面分组一致性：快捷设置里每个 `cell('标题', …)` 都必须在 `groupOfTitle` 里有归属。
 *
 * 为什么值得单独立一条：分页是靠 `node.classList.toggle('is-group-hidden', cellGroup !== group)`
 * 实现的，`groupOfTitle` 里**漏一个键**不会报错、不会抛异常，结果是那一行永远显示在
 * 播放/音效/试听/过渡四个页面上（看起来「多了一行」）。第 24 轮新增的「换手手法」正是
 * 这么漏掉过一次。这里把源码当数据源做集合比较，不再靠肉眼。
 *
 * 注意：分组表里可以有**不是 cell 的行**（例如「均衡器」是独立 section 的标题），
 * 所以只检查「cell → 有分组」这一个方向，反向不加断言。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..', 'src', 'ui', 'app.ts');
const source = fs.readFileSync(SRC, 'utf8');

function quickPaneCells() {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes("cell('音量'"));
  const end = lines.findIndex((line, i) => i > start && line.includes("cell('歌词衔接'"));
  assert.ok(start > 0 && end > start, '找不到快捷设置的 cell 列表边界（app.ts 结构变了？）');
  const titles = [];
  for (const line of lines.slice(start, end + 1)) {
    const m = line.match(/cell\('([^']+)'/);
    if (m) titles.push(m[1]);
  }
  return titles;
}

function groupEntries() {
  const block = source.slice(source.indexOf('const groupOfTitle'));
  const body = block.slice(0, block.indexOf('\n    ]);'));
  assert.ok(body.length > 100, '分组表解析失败');
  return Array.from(body.matchAll(/\['([^']+)',\s*'(play|sound|preview|transition)'\]/g)).map((m) => ({
    title: m[1],
    group: m[2],
  }));
}

test('快捷设置每一行都登记了所属分页', () => {
  const cells = quickPaneCells();
  const known = new Set(groupEntries().map((e) => e.title));
  const missing = cells.filter((t) => !known.has(t));
  assert.deepStrictEqual(missing, [], `这些行没有分组，会出现在所有页面上：${missing.join('、')}`);
  assert.ok(cells.length >= 20, `cell 数量异常（${cells.length}），可能解析错了`);
});

test('四个分页都至少有一行（避免整页空白）', () => {
  const groups = new Set(groupEntries().map((e) => e.group));
  for (const g of ['play', 'sound', 'preview', 'transition']) {
    assert.ok(groups.has(g), `分页 ${g} 没有任何行`);
  }
});

test('分组表覆盖了全部 cell（允许额外的非 cell 行）', () => {
  const cells = quickPaneCells();
  const entries = groupEntries();
  assert.ok(entries.length >= cells.length, `分组表 ${entries.length} 项少于界面行数 ${cells.length}`);
});
