/**
 * 界面模板（设置 → 通用 → 界面 → 界面模板）的跨层一致性。
 *
 * 为什么值得单独立一条：这条链路上三处失配都是**静默**的 ——
 *   1) 宿主 `IsKnownField` 少一个键 → settings.json 里那一项永远写不进去（页面照常显示、照常切换，
 *      重启后回滚成默认，看起来像「设置没保存」）；
 *   2) `applyUiTemplate` 的类名和 CSS 里选的不同名 → 切到 FX 后顶栏/主区还在，但没有任何报错；
 *   3) 模板 id 与 `.ui-tpl-preview.is-<id>` 的钩子对不上 → 卡片少了缩略示意图。
 * 所以这里把源码与样式当数据源做集合比较，把「靠肉眼记得改第二处」换成断言。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const settingsTs = read('web', 'src', 'core', 'settings.ts');
const appTs = read('web', 'src', 'ui', 'app.ts');
const css = read('web', 'src', 'styles', 'ui-template.css');
const settingsModel = read('src', 'Zilux2', 'Settings', 'SettingsModel.cs');
const settingsService = read('src', 'Zilux2', 'Settings', 'SettingsService.cs');

/** 前端允许的模板 id（`UI_TEMPLATES` 数组里的字符串字面量）。 */
function frontendTemplates() {
  const match = /export const UI_TEMPLATES[^=]*=\s*\[([^\]]*)\]/.exec(settingsTs);
  assert.ok(match, 'settings.ts 里找不到 UI_TEMPLATES（结构变了？）');
  return Array.from(match[1].matchAll(/'([a-z]+)'/g)).map((m) => m[1]);
}

/**
 * 按括号配对切出「含 needle 的那一个 h(...) 调用」。
 * 组装顺序只能在单次调用内部比（跨调用比会被中间几百行代码干扰），
 * 所以先把一段源码切成调用切片，再在切片里找 token 的先后。
 */
function sliceCall(source, needle) {
  const at = source.indexOf(needle);
  if (at < 0) return null;
  let depth = 1; // needle 位于 h( 的实参里，已经进了第一层括号
  for (let i = at; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  return null;
}

test('前端模板 id：标准 + FX，默认标准', () => {
  assert.deepStrictEqual(frontendTemplates(), ['standard', 'fx']);
  assert.match(settingsTs, /uiTemplate:\s*UiTemplate;/, 'Settings.general 缺 uiTemplate 字段');
  assert.match(settingsTs, /uiTemplate:\s*'standard'/, 'DEFAULT_SETTINGS.general 缺 uiTemplate 默认值');
  assert.match(
    settingsTs,
    /uiTemplate:\s*asEnum\(\s*general\.uiTemplate\s*,\s*UI_TEMPLATES/,
    'normalizeSettings 没用 asEnum 白名单收口 uiTemplate（坏值会原样透传）',
  );
});

test('两张卡片都有缩略示意图的样式钩子', () => {
  const ids = frontendTemplates();
  const previewHooks = Array.from(css.matchAll(/\.ui-tpl-preview\.is-([a-z]+)/g)).map((m) => m[1]);
  for (const id of ids) {
    assert.ok(
      previewHooks.includes(id),
      `ui-template.css 缺 .ui-tpl-preview.is-${id}（卡片缩略图会空白）`,
    );
  }
  const labelsBlock = (() => {
    const start = settingsTs.indexOf('export const UI_TEMPLATE_LABELS');
    assert.ok(start >= 0, 'settings.ts 里找不到 UI_TEMPLATE_LABELS（结构变了？）');
    const block = settingsTs.slice(start);
    return block.slice(0, block.indexOf('];') + 2);
  })();
  const labelled = Array.from(
    labelsBlock.matchAll(/\[\s*'(standard|fx)'\s*,\s*'[^']*'\s*\]/g),
  ).map((m) => m[1]);
  assert.deepStrictEqual(labelled, ids, 'UI_TEMPLATE_LABELS 与 UI_TEMPLATES 的 id/顺序不一致');
});

test('宿主侧：键名进白名单 + 有合法值表（否则 patch 会被静默丢弃）', () => {
  assert.match(settingsModel, /UiTemplateStandard\s*=\s*"standard"/, 'SettingsModel 缺 standard 常量');
  assert.match(settingsModel, /UiTemplateFx\s*=\s*"fx"/, 'SettingsModel 缺 fx 常量');
  assert.match(settingsModel, /string\[\]\s+UiTemplates\s*=/, 'SettingsModel 缺 UiTemplates 允许值表');
  assert.match(settingsModel, /public\s+string\s+UiTemplate\s*\{/, 'SettingsModel 缺 UiTemplate 属性');
  assert.match(
    settingsService,
    /"general"\s*=>[^;]*or\s+"uiTemplate"/s,
    'SettingsService.IsKnownField 的 general 白名单里没有 uiTemplate',
  );
  assert.match(
    settingsService,
    /ReadEnum\(\s*general\s*,\s*"uiTemplate"\s*,\s*GeneralSettings\.UiTemplates/,
    'SettingsService.ApplyKnownValues 没有按枚举读 uiTemplate',
  );
});

test('契约文档记了这个键', () => {
  const doc = read('docs', 'zilux2-settings-contract.md');
  assert.match(doc, /general\.uiTemplate/, '设置契约文档没有 general.uiTemplate 这一行');
});

