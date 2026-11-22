#!/usr/bin/env node
/**
 * 30 首盲听基线的「样本与回归」工具。
 *
 * 解决两件事：
 *  1. 从全库体检结果里**分层抽样**出 30 对，覆盖所有手法（每种至少 1 对，其余按比例补），
 *     输出一份可以直接照着听的清单（JSON + Markdown 评分表）。
 *  2. 回归：同一批 30 对，在参数改动之后重跑体检，比较「手法是否漂移」——
 *     听感评分是人的事，但「同一对歌不该悄悄换了手法」这件事机器能守住。
 *
 * 用法：
 *   node web/tools/blind-baseline.cjs --audit=.scratch/audit-latest.json \
 *        --out=.scratch/blind-baseline.json --md=docs/zilux2-blind-baseline.md [--count=30] [--seed=7]
 *   node web/tools/blind-baseline.cjs --compare=.scratch/blind-baseline.json \
 *        --audit=.scratch/audit-new.json [--max-drift=0.2]
 *
 * 退出码：`--compare` 时漂移超过阈值 → 2。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function arg(name, fallback = null) {
  const hit = process.argv.find((x) => x.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const AUDIT = arg('audit', '.scratch/audit-latest.json');
const OUT = arg('out', '.scratch/blind-baseline.json');
const MD = arg('md', 'docs/zilux2-blind-baseline.md');
const COMPARE = arg('compare', null);
const COUNT = Number(arg('count', '30'));
const SEED = Number(arg('seed', '7'));
const MAX_DRIFT = Number(arg('max-drift', '0.2'));

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
}

// ---- 曲名：用 recent-plays 按「时长最接近」反查（缓存文件名不含曲名） -------------

function loadTitles() {
  const p = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Zilux2', 'recent-plays.json');
  const list = [];
  try {
    const raw = readJson(p);
    for (const it of raw.items ?? raw.plays ?? raw ?? []) {
      const dur = Number(it.durationMs ?? it.duration ?? 0);
      const title = String(it.title ?? it.name ?? '').trim();
      const artist = String(it.artist ?? it.artists ?? '').trim();
      if (dur > 0 && title) list.push({ dur, label: artist ? `${title} — ${artist}` : title });
    }
  } catch {
    /* 没有历史播放就当没有曲名 */
  }
  return list;
}

function titleFor(titles, durMs) {
  let best = null;
  let bestDiff = Infinity;
  for (const t of titles) {
    const d = Math.abs(t.dur - durMs);
    if (d < bestDiff) {
      bestDiff = d;
      best = t;
    }
  }
  return best && bestDiff <= 2_500 ? best.label : '';
}

// ---- 分层抽样 ------------------------------------------------------------------

function seededPick(list, k, seed) {
  // 确定性：按 (hash + seed) 排序取前 k，不用 Math.random（同一份报告每次必须一样）
  const hash = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967296;
  };
  return [...list]
    .sort((x, y) => hash(`${seed}:${x.a}:${x.b}`) - hash(`${seed}:${y.a}:${y.b}`))
    .slice(0, k);
}

function stratify(rows, count) {
  const byTech = new Map();
  for (const r of rows) {
    const t = r.technique || '-';
    if (!byTech.has(t)) byTech.set(t, []);
    byTech.get(t).push(r);
  }
  const picked = [];
  const used = new Set();
  const take = (r) => {
    const id = `${r.a}->${r.b}`;
    if (used.has(id)) return;
    used.add(id);
    picked.push(r);
  };
  // 1) 每种手法先拿 1 对（按 technique 名排序，保证确定性）
  for (const t of [...byTech.keys()].sort()) take(byTech.get(t)[0]);
  // 2) 剩下的按「该手法在库里占比」补齐（最大余数法太复杂，直接轮转）
  const pools = [...byTech.entries()].sort((x, y) => y[1].length - x[1].length);
  let poolIdx = 0;
  while (picked.length < count) {
    const [, pool] = pools[poolIdx % pools.length];
    const next = pool.find((r) => !used.has(`${r.a}->${r.b}`));
    if (next) take(next);
    poolIdx += 1;
    if (pools.every(([, list]) => list.every((r) => used.has(`${r.a}->${r.b}`)))) break;
  }
  return seededPick(picked, count, SEED);
}

// ---- 生成样本 ------------------------------------------------------------------

function build(auditPath) {
  const audit = readJson(auditPath);
  const rows = audit.rows ?? [];
  if (!rows.length) throw new Error(`${auditPath} 里没有 rows，先用 mix-audit --json 生成`);
  const titles = loadTitles();
  const samples = stratify(rows, COUNT).map((r, i) => ({
    id: i + 1,
    technique: r.technique || '-',
    cueMode: r.cueMode ?? '',
    aFile: r.a,
    bFile: r.b,
    aTitle: titleFor(titles, r.aDur) || `(${Math.round((r.aDur || 0) / 1000)}s)`,
    bTitle: titleFor(titles, r.bDur) || `(${Math.round((r.bDur || 0) / 1000)}s)`,
    aAt: r.fadeStart,
    fadeMs: r.fadeMs,
    bStart: r.bStart,
    handoff: Boolean(r.handoff),
  }));
  return { at: new Date().toISOString(), count: samples.length, seed: SEED, samples };
}

function writeMd(baseline, mdPath) {
  const lines = [
    '# 30 首盲听基线（进阶混音 v2）',
    '',
    `生成时间：${baseline.at}　seed=${baseline.seed}　样本=${baseline.count} 对`,
    '',
    '## 怎么听',
    '',
    '1. 在 Zilux2 里按下面的「起点」把 A 拖到该位置播放，等它自动过渡到 B；',
    '2. 盲听：先不看手法名，只判断这四件事，然后把手法名对照着看是否匹配；',
    '3. 一次只听一对，别连着听十对——耳朵会钝，评分不可比。',
    '',
    '评分口径（四列）：',
    '',
    '- **换手** 1–5：5 = 完全听不出什么时候换的；3 = 知道换了但不刺；1 = 像硬切/明显断层',
    '- **低频** 0–3：0 = 没塌也没轰；3 = 明显塌了个洞或低频轰上来了',
    '- **人声** 0–3：0 = 没打架；3 = 两句叠在一起听不清词',
    '- **连听** Y/N：愿不愿意就这么连着听下去',
    '',
  ];
  const head = '| # | 手法 | A → B | 起点 | 长度 | 换手 | 低频 | 人声 | 连听 | 备注 |';
  const sep = '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';
  const body = baseline.samples.map((s) =>
    `| ${s.id} | ${s.technique}${s.handoff ? '' : '（无衔接）'} | ${s.aTitle} → ${s.bTitle} | ${(s.aAt / 1000).toFixed(1)}s | ${(s.fadeMs / 1000).toFixed(1)}s |  |  |  |  |  |`);
  const tail = [
    '',
    '## 评分回填后怎么用',
    '',
    '把这张表填完，跑：',
    '',
    '```bash',
    'node web/tools/mix-audit.cjs --pairs=6 --json=.scratch/audit-new.json',
    'node web/tools/blind-baseline.cjs --compare=.scratch/blind-baseline.json --audit=.scratch/audit-new.json',
    '```',
    '',
    '第二行只查一件事：**这 30 对的手法有没有被改动悄悄换掉**。听感评分记在人手上，手法漂移交给机器守——',
    '漂移超过 `--max-drift`（默认 20%）就 `exit 2`，便于放进每轮回归。',
    '',
    '## 已知的取舍',
    '',
    '- 曲名靠 `recent-plays.json` 按「时长最接近」反查，查不到就显示时长；缓存文件名本身不含曲名。',
    '- 起点取自动体检的 `fadeStart`（60% 位置起播时算出的窗口），所以你需要先把 A 拖到该位置附近再播放。',
    '- 样本按「每种手法至少 1 对 + 按库内占比补齐」抽，seed 固定 → 同一份报告每次抽样一致。',
  ];
  fs.writeFileSync(mdPath, [...lines, head, sep, ...body, ...tail].join('\n') + '\n');
}

function compare(baselinePath, auditPath) {
  const baseline = readJson(baselinePath);
  const audit = readJson(auditPath);
  const byKey = new Map((audit.rows ?? []).map((r) => [`${r.a}->${r.b}`, r]));
  const diffs = [];
  for (const s of baseline.samples ?? []) {
    const now = byKey.get(`${s.aFile}->${s.bFile}`);
    if (!now) {
      diffs.push({ id: s.id, a: s.aFile, b: s.bFile, was: s.technique, now: '(缺失)' });
      continue;
    }
    if ((now.technique || '-') !== s.technique) {
      diffs.push({ id: s.id, a: s.aFile, b: s.bFile, was: s.technique, now: now.technique || '-' });
    }
  }
  const total = (baseline.samples ?? []).length || 1;
  const drift = diffs.length / total;
  console.log(`基线样本 ${total} 对，手法漂移 ${diffs.length} 对（${(drift * 100).toFixed(1)}%）`);
  for (const d of diffs.slice(0, 12)) {
    console.log(`  #${d.id} ${d.was} → ${d.now}  (${d.a} -> ${d.b})`);
  }
  if (drift > MAX_DRIFT) {
    console.log(`✖ 漂移超过 ${(MAX_DRIFT * 100).toFixed(0)}%：这 30 对的听感评分已经不可比`);
    process.exitCode = 2;
    return;
  }
  console.log(`✔ 漂移在 ${(MAX_DRIFT * 100).toFixed(0)}% 以内`);
}

if (COMPARE) {
  compare(COMPARE, AUDIT);
} else {
  const baseline = build(AUDIT);
  fs.writeFileSync(OUT, JSON.stringify(baseline, null, 2));
  writeMd(baseline, MD);
  const tech = {};
  for (const s of baseline.samples) tech[s.technique] = (tech[s.technique] ?? 0) + 1;
  console.log(`样本 ${baseline.count} 对 → ${OUT}`);
  console.log(`评分表 → ${MD}`);
  console.log(`手法覆盖: ${JSON.stringify(tech)}`);
}
