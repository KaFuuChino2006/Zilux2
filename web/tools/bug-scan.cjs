#!/usr/bin/env node
/**
 * 静态 bug 扫描：只找「能让功能静默失效」的形态，不做风格检查。
 *
 * 用法：
 *   node web/tools/bug-scan.cjs [--top=20] [--json=.scratch/bug-scan.json]
 *
 * 为什么存在：这个项目里最贵的 bug 都是静默的——监听器没解绑、定时器叠加、
 * localStorage 键名不一致、catch 后返回默认值。它们不会报错，只会让功能
 * 在某些路径下失效，靠肉眼看几万行是不现实的。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', 'src');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'assets']);
const EXT = new Set(['.ts', '.tsx', '.js', '.cjs', '.mjs']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (EXT.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

const counts = (text, re) => (text.match(re) ?? []).length;

const RULES = [
  {
    id: 'listener-leak',
    why: '注册了监听器却没有对应的移除；组件/浮层重建后旧回调仍活在元素上，同一事件会被触发 N 次。',
    test: (text) => {
      const add = counts(text, /addEventListener\(/g);
      const rem = counts(text, /removeEventListener\(/g);
      if (add < 3 || rem > 0) return null;
      // 只有「有销毁路径的模块」才算漏：模块级单例从不销毁，注册一次是正常的。
      const hasTeardown = /(?:dispose|destroy|teardown|unmount)\s*[(:]/.test(text);
      return hasTeardown ? `${add} 个 addEventListener、0 个 removeEventListener（但有销毁路径）` : null;
    },
  },
  {
    id: 'timer-leak',
    why: '定时器/动画帧没有清理路径；重入时叠加，表现为越用越卡或某次过渡后速度翻倍。',
    test: (text) => {
      // 只盯「重复型」定时器：setTimeout 一次性自清理是常态，setInterval / rAF 链才是叠加源。
      // 只盯定时器轮询：`setInterval` 没有清就是真叠加；rAF 自终止链（`if (k < 1) rAF`）
      // 和「每页一个、从不销毁」的单例都属于正常写法，不在这里报警。
      const interval = counts(text, /setInterval\(/g);
      const cleared = counts(text, /clearInterval\(/g);
      return interval >= 2 && cleared === 0 ? `${interval} 处 setInterval，0 处 clearInterval` : null;
    },
  },
  {
    id: 'empty-catch',
    why: 'catch 后什么都不做会让失败变成「默认值」，后续判断全部建立在假数据上。',
    test: (text) => {
      // 只算「跨行的空 catch」：`try { x(); } catch {}` 这种一行式通常是有意忽略
      // （localStorage 在隐私模式会抛、AudioBufferSourceNode 重复 stop 会抛）。
      const rows = text.split(String.fromCharCode(10));
      let n = 0;
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        if (!/catch\s*(?:\([^)]*\))?\s*\{/.test(row)) continue;
        const afterBrace = row.slice(row.indexOf('{') + 1).trim();
        if (afterBrace.length > 0) continue; // 一行式：catch { … } 或 catch {} 都在同一行
        let j = i + 1;
        while (j < rows.length && !rows[j].trim()) j += 1;
        if (j < rows.length && rows[j].trim() === '}') n += 1;
      }
      return n > 0 ? `${n} 个跨行空 catch（吞掉了整段错误）` : null;
    },
  },
  {
    id: 'ts-escape',
    why: 'as any / @ts-ignore / 非空断言绕过了类型检查，是契约错位的常见来源。',
    test: (text) => {
      const n = counts(text, /\bas any\b/g) + counts(text, /@ts-(?:ignore|expect-error)/g);
      return n >= 3 ? `${n} 处类型逃逸` : null;
    },
  },
  {
    id: 'nan-risk',
    why: 'Number(...)/parseFloat 结果直接参与算术，未校验 NaN 会静默污染下游。',
    test: (text) => {
      const raw = counts(text, /(?:Number|parseFloat|parseInt)\(/g);
      const guarded = counts(text, /Number\.isFinite|Number\.isNaN|isNaN\(/g);
      return raw >= 12 && guarded === 0 ? `${raw} 处数字解析、0 处 NaN 校验` : null;
    },
  },
  {
    id: 'storage-key',
    why: 'localStorage 键名拼错/大小写不一致，读写各自成立但永远读不到刚写的值。',
    test: (text) => {
      const keys = Array.from(text.matchAll(/localStorage\.(?:get|set|remove)Item\(\s*['"]([^'"]+)['"]/g)).map((m) => m[1]);
      if (keys.length < 3) return null;
      // 同一文件内出现形近不同名（去掉点与大小写后相同）的键 → 高度可疑
      const norm = new Map();
      const dupes = [];
      for (const k of new Set(keys)) {
        const n = k.toLowerCase().replace(/[.\-_]/g, '');
        if (norm.has(n) && norm.get(n) !== k) dupes.push(`${norm.get(n)} / ${k}`);
        norm.set(n, k);
      }
      return dupes.length ? `形近键名：${dupes.join('，')}` : null;
    },
  },
  {
    id: 'promise-float',
    why: 'async 调用没 await 也没 catch，失败会变成 unhandledRejection，功能静默不生效。',
    test: (text) => {
      const n = counts(text, /^\s*(?!return|await|void|const|let|if|for|while)[\w.]*(?:Async|async)\([^)]*\);\s*$/gm);
      return n >= 2 ? `${n} 处裸 async 调用` : null;
    },
  },
];

function scanFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(path.resolve(__dirname, '..', '..'), file).replace(/\\/g, '/');
  const hits = [];
  for (const rule of RULES) {
    const detail = rule.test(text);
    if (detail) hits.push({ rule: rule.id, why: rule.why, detail, file: rel, lines: text.split(/\r?\n/).length });
  }
  return hits;
}

function main() {
  const argOf = (name, fallback) => {
    const hit = process.argv.find((x) => x.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
  };
  const top = Number(argOf('top', '20')) || 20;
  const jsonPath = argOf('json', '');

  const files = walk(ROOT);
  const hits = files.flatMap(scanFile);
  const byRule = new Map();
  for (const h of hits) {
    const list = byRule.get(h.rule) ?? [];
    list.push(h);
    byRule.set(h.rule, list);
  }

  console.log(`扫描 ${files.length} 个前端文件，命中 ${hits.length} 条可疑点。\n`);
  for (const [rule, list] of [...byRule.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`● ${rule}  ${list.length} 个文件`);
    console.log(`  为什么重要：${list[0].why}`);
    for (const h of list.slice(0, top)) console.log(`  - ${h.file}（${h.lines} 行）${h.detail}`);
    if (list.length > top) console.log(`  … 其余 ${list.length - top} 个`);
    console.log();
  }
  if (!hits.length) console.log('没有命中任何规则。');

  if (jsonPath) {
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify({ scanned: files.length, hits }, null, 2));
    console.log(`JSON → ${jsonPath}`);
  }
}

main();
