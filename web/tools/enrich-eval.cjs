#!/usr/bin/env node
/**
 * 增强特征体检：拿已缓存的基础分析（analysis/json）与增强 stage（analysis/features），
 * 量化「分轨活动度 vs DSP 代理曲线」的相关性、「SSM 边界 vs 乐句边界」的一致率。
 *
 * 用法：
 *   node web/tools/enrich-eval.cjs            # 只统计已有缓存
 *   node web/tools/enrich-eval.cjs --limit 50 # 最多看多少首
 *
 * 输出：每首一行 + 汇总。没有增强缓存的曲目跳过，不触发任何计算。
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(process.env.LOCALAPPDATA || '', 'Zilux2', 'analysis');
const jsonDir = path.join(root, 'json');
const featureDir = path.join(root, 'features');
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg > 0 ? Math.max(1, Number(process.argv[limitArg + 1]) || 0) : 0;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 8) return null;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i += 1) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da > 1e-9 && db > 1e-9 ? num / Math.sqrt(da * db) : null;
}

/** 把 250 ms 曲线按源 hop 重采样到目标 hop（最近邻，够评估用）。 */
function resample(curve, srcHop, dstHop) {
  if (!curve?.length || !srcHop || !dstHop) return [];
  const n = Math.max(1, Math.round((curve.length * srcHop) / dstHop));
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) out[i] = curve[Math.min(curve.length - 1, Math.round((i * dstHop) / srcHop))];
  return out;
}

function featureHash(inputKey) {
  return require('node:crypto').createHash('sha1').update(inputKey).digest('hex').slice(0, 16);
}

const rows = [];
if (fs.existsSync(jsonDir)) {
  for (const file of fs.readdirSync(jsonDir)) {
    if (!file.endsWith('.json')) continue;
    const entry = readJson(path.join(jsonDir, file));
    if (!entry?.ok || !entry.analysis) continue;
    const a = entry.analysis;
    const inputKey = entry.source === 'local' ? `local:${entry.rel}:` : `${entry.source}:${entry.trackId}`;

    // 缓存目录名是完整 inputKey 的 sha1 前 16 位；本地 key 需要 len/mtime，无法从 json 还原，
    // 所以退而求其次：扫 features 目录，用 structure.json 的 inputKey 前缀匹配。
    let match = null;
    if (fs.existsSync(featureDir)) {
      for (const hash of fs.readdirSync(featureDir)) {
        const dir = path.join(featureDir, hash);
        if (!fs.statSync(dir).isDirectory()) continue;
        const s = readJson(path.join(dir, 'structure.json'));
        const st = readJson(path.join(dir, 'stems.json'));
        const key = s?.inputKey || st?.inputKey;
        if (!key) continue;
        if (key === inputKey || key.startsWith(inputKey)) {
          match = { hash, stems: st?.payload ?? null, structure: s?.payload ?? null };
          break;
        }
      }
    }
    if (!match) continue;

    const stems = match.stems;
    const structure = match.structure;
    const hop = stems?.hopMs || 250;
    const dspHop = a.activity?.hopMs || 0;
    const corr = dspHop && stems
      ? {
          vocal: pearson(resample(stems.vocal, hop, dspHop), a.activity.vocal || []),
          drum: pearson(resample(stems.drum, hop, dspHop), a.activity.drum || []),
          bass: pearson(resample(stems.bass, hop, dspHop), a.activity.bass || []),
        }
      : null;

    // 边界一致率：SSM 边界若落在某乐句起点 ±1 小节内，算命中。
    const barMs = a.barCount > 0 ? entry.durationMs / a.barCount : 0;
    const boundaries = structure?.boundariesMs || [];
    const phrases = a.phraseStartsMs || [];
    let hit = 0;
    for (const b of boundaries) {
      if (phrases.some((p) => Math.abs(p - b) <= barMs * 1.05)) hit += 1;
    }

    rows.push({
      title: entry.title || entry.rel || entry.trackId,
      durationS: +(entry.durationMs / 1000).toFixed(1),
      frames: stems?.vocal?.length || 0,
      corr,
      boundaries: boundaries.length,
      phraseHit: boundaries.length ? hit / boundaries.length : null,
      sections: structure?.sections?.length || 0,
    });
    if (limit && rows.length >= limit) break;
  }
}

function avg(values) {
  const list = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!list.length) return null;
  return list.reduce((s, v) => s + v, 0) / list.length;
}

if (!rows.length) {
  console.log('没有同时具备基础分析与增强缓存的曲目。先播放几首让 /api/analysis?enrich=1 跑一轮。');
  process.exit(0);
}

for (const r of rows) {
  const c = r.corr;
  console.log(
    `${r.title}  ${r.durationS}s  frames=${r.frames}  ` +
      `corr(v/d/b)=${c ? [c.vocal, c.drum, c.bass].map((x) => (x == null ? '—' : x.toFixed(2))).join('/') : '—'}  ` +
      `boundaries=${r.boundaries}  phraseHit=${r.phraseHit == null ? '—' : (r.phraseHit * 100).toFixed(0) + '%'}  sections=${r.sections}`,
  );
}

console.log('---');
console.log(`tracks: ${rows.length}`);
for (const k of ['vocal', 'drum', 'bass']) {
  const v = avg(rows.map((r) => r.corr?.[k]));
  console.log(`mean corr ${k}: ${v == null ? '—' : v.toFixed(3)}`);
}
const h = avg(rows.map((r) => r.phraseHit));
console.log(`mean phraseHit: ${h == null ? '—' : (h * 100).toFixed(0) + '%'}`);
