#!/usr/bin/env node
/**
 * 把 `mix-audit --json` 里的 drift 失败对按「曲线形状」分类。
 *
 * 只看 `drift = 3.2 LU` 这一个数字，无法判断该修链路还是该修指标：
 *   - 坑在窗口开头（<25%）：多半是 A 尾奏渐隐 / B 前奏本来就轻 —— 编曲，不是缺陷；
 *   - 坑在中段（25–70%）：换手处能量真的掉了 —— 链路问题；
 *   - 坑在尾段（>70%）：A 的能量撤得太早、B 还没接上 —— 收尾问题。
 *
 * 用法：node web/tools/drift-classify.cjs --json=.scratch/mix-audit-round6.json
 */
const fs = require('node:fs');
const path = require('node:path');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const file = path.resolve(arg('json', '.scratch/mix-audit-baseline.json'));
if (!fs.existsSync(file)) {
  console.error(`找不到 ${file}`);
  process.exit(2);
}
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const rows = Array.isArray(data.rows) ? data.rows : [];

/**
 * 复刻 `v2Quality.loudnessRampCurve` 的 drift 定义：**单调方向反转的最大幅度**。
 * 不能只找全局最低点 —— 有些对的 drift 来自中段抬高后的回落，最低点在 p=1 且深度为 0。
 */
function worstTurn(curve) {
  if (!Array.isArray(curve) || curve.length < 4) return null;
  let dir = 0;
  let extreme = curve[0];
  let best = { p: 0, depth: 0 };
  for (let i = 1; i < curve.length; i += 1) {
    const delta = curve[i] - curve[i - 1];
    if (Math.abs(delta) < 0.02) continue;
    const d = delta > 0 ? 1 : -1;
    if (dir === 0) { dir = d; extreme = curve[i]; continue; }
    if (d === dir) { extreme = curve[i]; continue; }
    const depth = Math.abs(curve[i] - extreme);
    if (depth > best.depth) best = { p: i / (curve.length - 1), depth };
    dir = d;
    extreme = curve[i];
  }
  return best;
}

const buckets = { head: 0, mid: 0, tail: 0 };
const byTechnique = new Map();
const samples = [];
for (const row of rows) {
  const q = row.q;
  if (!q || !Array.isArray(q.fail) || !q.fail.includes('loudness-drift')) continue;
  const dip = worstTurn(q.curve);
  if (!dip) continue;
  const where = dip.p < 0.25 ? 'head' : dip.p <= 0.7 ? 'mid' : 'tail';
  buckets[where] += 1;
  const key = row.technique || '-';
  const entry = byTechnique.get(key) || { head: 0, mid: 0, tail: 0, n: 0, worst: 0 };
  entry[where] += 1;
  entry.n += 1;
  entry.worst = Math.max(entry.worst, q.drift);
  byTechnique.set(key, entry);
  samples.push({ pair: `${row.a}->${row.b}`, technique: key, where, p: dip.p.toFixed(2), depth: dip.depth.toFixed(2), drift: q.drift, fade: row.fadeMs });
}

console.log(`drift 失败对：${samples.length}（共 ${rows.length} 对）`);
console.log(`位置分布：开头 ${buckets.head} / 中段 ${buckets.mid} / 尾段 ${buckets.tail}`);
console.log('');
console.log('按手法：');
for (const [tech, e] of [...byTechnique.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${tech.padEnd(16)} ${String(e.n).padStart(3)} 对  头${e.head} 中${e.mid} 尾${e.tail}  最差 ${e.worst.toFixed(2)} LU`);
}
console.log('');
console.log('最差 8 对：');
for (const s of samples.sort((a, b) => b.drift - a.drift).slice(0, 8)) {
  console.log(`  ${s.drift.toFixed(2)} LU  ${s.where.padEnd(4)} p=${s.p} 深=${s.depth} dB  ${s.technique}  fade=${s.fade}  ${s.pair}`);
}
