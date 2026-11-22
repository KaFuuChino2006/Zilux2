#!/usr/bin/env node
/**
 * 全库混音过渡体检：把真实分析缓存喂给 buildSchedule，跑一遍「每一首 → 另一首」，
 * 统计决策结果、标记规则打架 / 判断不到位的情况，输出 JSON + 可读摘要。
 *
 *   node web/tools/mix-audit.cjs [--pairs=8] [--seed=7] [--json=out.json] [--top=20]
 *   node web/tools/mix-audit.cjs --baseline=.scratch/mix-audit.json --fail-on=2
 *
 * `--baseline=<上一轮 JSON>`：与本轮逐条规则命中率对比，打印「规则  前 → 后（Δ）」。
 * `--fail-on=<百分点>`：任一条规则的命中率比基线劣化超过这个值，进程返回退出码 2，
 *   用来把体检台接成回归闸门（CI / 提交前跑一遍）。没给 --fail-on 时只报告不拦。
 *
 * 仅读 %LOCALAPPDATA%\Zilux2\analysis\json\*.json（UTF-8 BOM）与 recent-plays.json，
 * 不碰音频、不写缓存、不启动 App。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(path.resolve(__dirname, '..', 'node_modules', 'typescript'));

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const PAIRS = Number(args.pairs ?? 8);
const SEED = Number(args.seed ?? 7);
const TOP = Number(args.top ?? 25);
const JSON_OUT = args.json ? path.resolve(process.cwd(), args.json) : null;
const BASELINE = typeof args.baseline === 'string' ? path.resolve(process.cwd(), args.baseline) : null;
const FAIL_ON = args['fail-on'] !== undefined ? Number(args['fail-on']) : null;
/** --only=<缓存名前缀>：只打印这一首当 A 的行（排查单曲用）。 */
const ONLY = typeof args.only === 'string' ? args.only : null;
const PAIRDIFF = typeof args.pairdiff === 'string' ? path.resolve(process.cwd(), args.pairdiff) : null;
/** 本轮相对基线劣化的规则（超过 --fail-on 阈值），最后决定退出码。 */
const regressions = [];

// ---------- 加载 crossfadeDeck（与 web/tests/crossfade.test.cjs 同一套路） ----------
function makeHarness() {
  const store = new Map();

  // `--store=key=value`（可重复）：给 A/B 交叉验证用，例如 `--store=zilux2.dev.applebias=0`。
  for (const raw of process.argv.filter((x) => x.startsWith('--store=')).map((x) => x.slice(8))) {
    const eq = raw.indexOf('=');
    if (eq > 0) store.set(raw.slice(0, eq), raw.slice(eq + 1));
  }
  let now = 1000;
  const modules = new Map();
  const windowStub = {
    addEventListener() {}, dispatchEvent() {},
    setTimeout() { return 1; }, clearTimeout() {},
    requestAnimationFrame() { return 1; }, cancelAnimationFrame() {},
  };
  const audioStub = new Proxy({
    audioTapClock: () => 10,
    audioTapGraphActive: () => true,
    attachDeckToGraph: () => true,
  }, { get: (t, k) => t[k] ?? (() => 0) });
  function load(name) {
    const cands = [
      path.resolve(__dirname, '../src/ui', name + '.ts'),
      path.resolve(__dirname, '../src/core', name + '.ts'),
      path.resolve(__dirname, '../src/core/automix', name + '.ts'),
      path.resolve(__dirname, '../src/audio', name + '.ts'),
      path.resolve(__dirname, '../src/online', name + '.ts'),
    ];
    const file = cands.find((f) => fs.existsSync(f));
    if (!file) return {};
    if (modules.has(file)) return modules.get(file);
    let source = fs.readFileSync(file, 'utf8');
    if (name === 'crossfadeDeck') source += '\nexport { buildSchedule };';
    const exports = {};
    modules.set(file, exports);
    const allowed = new Set(['phraseMix', 'transitionMath', 'transitionLoudness', 'loudness',
      'mixTransitionMode', 'vocalAnchor', 'introBridge', 'tailFade', 'v2Plan', 'v2Quality',
      'automixPlan', 'bridgePlan', 'pitchShift', 'melodyAnchor', 'echoTail', 'styleKit', 'vocalOverlay',
      'backspin', 'loopRoll', 'dropEntry', 'doubling', 'genreProfile', 'appleRecipes']);
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText, {
      exports, console,
      window: windowStub,
      performance: { now: () => now++ },
      localStorage: {
        getItem: (k) => (k === 'mixTransitionMode' ? 'automixV2' : store.get(k) ?? null),
        setItem: (k, v) => store.set(k, v),
      },
      CustomEvent: class {},
      require: (n) => {
        const base = n.slice(n.lastIndexOf('/') + 1);
        if (n.includes('audioTap')) return audioStub;
        return allowed.has(base) ? load(base) : {};
      },
    }, { filename: file });
    return exports;
  }
  const deck = () => ({ currentTime: 0, readyState: 4, playbackRate: 1, volume: 1, paused: false,
    pause() {}, play() { return Promise.resolve(); } });
  return {
    engine: load('crossfadeDeck'),
    deck,
    presence: load('vocalAnchor').vocalPresence,
    lastVocalEnd: load('vocalAnchor').lastVocalEnd,
    quality: load('v2Quality'),
  };
}

// ---------- 读缓存 ----------
const CACHE_DIR = path.join(process.env.LOCALAPPDATA || '', 'Zilux2', 'analysis', 'json');
function loadCaches() {
  const out = [];
  for (const name of fs.readdirSync(CACHE_DIR)) {
    if (!name.endsWith('.json')) continue;
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, name), 'utf8').replace(/^\uFEFF/, '')); }
    catch { continue; }
    const a = raw.analysis ?? raw;
    if (!a || !Number.isFinite(a.bpm) || !Array.isArray(a.beatsMs)) continue;
    const durationMs = Number(raw.durationMs ?? a.durationMs ?? 0);
    if (!(durationMs > 30_000)) continue;
    out.push({
      file: name,
      durationMs,
      audibleEndMs: Number(a.audibleEndMs ?? durationMs),
      analysis: { ...a, durationMs },
    });
  }
  return out;
}

// ---------- 体检规则 ----------
function auditOne(engine, A, B, posMs) {
  const active = { currentTime: 0, readyState: 4, playbackRate: 1, volume: 1, paused: false, pause() {}, play() { return Promise.resolve(); } };
  const standby = { ...active };
  const options = {
    active, standby,
    current: { startAt: 0, track: { source: 'local', id: A.file, durationMs: A.durationMs } },
    next: { startAt: 0, track: { source: 'local', id: B.file, durationMs: B.durationMs } },
    currentPositionMs: posMs,
    currentDurationMs: A.durationMs,
    currentAnalysis: { analysis: A.analysis, durationMs: A.durationMs },
    nextAnalysis: { analysis: B.analysis, durationMs: B.durationMs },
    nextVocalStartMs: 0, currentLastVocalEndMs: 0,
    nextUrl: 'x', baseVolume: () => 0.7, baseRate: () => 1,
    isValid: () => true, onFinish() {},
  };
  let s = null;
  try { s = engine.buildSchedule(options); } catch (e) { return { err: String(e && e.message || e) }; }
  if (!s) return { err: 'null' };
  const ms = (v) => (Number.isFinite(v) ? Math.round(v) : null);
  return {
    _schedule: s,
    fadeStart: ms(s.fadeStartFileMs), fadeMs: ms(s.fadeMs), bStart: ms(s.bStartFileMs),
    bEntry: ms(s.vocalEntryMs ?? s.bEntryMs ?? 0), style: s.style, form: s.form ?? null,
    cueMode: s.cueMode ?? null, technique: s.styleId ?? null, handoff: !!s.handoff, vocalAligned: !!s.vocalAligned,
    rate: Math.round((s.tempoRate ?? 1) * 1000) / 1000, inverted: !!s.tempoInverted,
    anchorKind: s.vocalAnchor?.kind ?? null, melodySim: s.vocalAnchor?.melodySim ?? 0,
    instSeam: s.instSeam?.kind ?? null,
    instDrift: s.instSeam ? Math.round((s.fadeStartFileMs ?? 0) - s.instSeam.ms) : 0,
    aTailGapBars: (() => {
      const av = A.analysis && A.analysis.activity && A.analysis.activity.vocal;
      const hop = (A.analysis && A.analysis.activity && A.analysis.activity.hopMs) || 250;
      if (!av || !A.audibleEndMs) return null;
      let last = -1;
      for (let i = av.length - 1; i >= 0; i -= 1) { if (av[i] >= 0.45) { last = i; break; } }
      if (last < 0) return 99;
      const bar = (A.analysis.barCount ? (A.audibleEndMs - (A.analysis.cueInMs || 0)) / A.analysis.barCount : 2000) || 2000;
      return (A.audibleEndMs - last * hop) / bar;
    })(),
    // 墙钟窗口：`tempoInverted` 时整个过渡按变速系数拉长/压短（crossfadeDeck.ts:5382 的 wallMs），
    // 体检报告过去只写 fadeMs，于是出现过「报表 12 s、耳朵 9 s」——把两个都记下来。
    wallMs: Math.round((s.fadeMs ?? 0) * (s.tempoInverted ? Math.max(0.5, s.tempoRate ?? 1) : 1)),
    tempoInverted: !!s.tempoInverted,
    bleed: s.aTailBleedMs ?? 0, echo: !!s.echo?.enabled,
    bDuck: Array.isArray(s.bDuck) ? s.bDuck.filter((e) => e.db < -1).length : 0,
    q: s.quality ? { pass: !!s.quality.pass, bass: +s.quality.bassBumpDb?.toFixed?.(2), vocal: +s.quality.vocalOverlapBeats?.toFixed?.(2), clash: +s.quality.vocalClashBeats?.toFixed?.(2), drift: +s.quality.loudnessDriftLu?.toFixed?.(2), rate: +s.quality.rateJumpPctPerBeat?.toFixed?.(2), fail: s.quality.failures ?? [], curve: s.quality.curve?.lufs } : null,
    swap: s.v2Plan ? { start: +s.v2Plan.handoffStartP?.toFixed(3), end: +s.v2Plan.handoffP?.toFixed(3) } : null,
    note: s.autoNote ?? '',
    bPresence: presence ? presence(B.analysis) : 'unknown',
    aPresence: presence ? presence(A.analysis) : 'unknown',
    // A 最后一句唱到哪儿（曲内毫秒，和引擎同一个「唱句段」口径）。
    // 别再自己扫 activity 下标：桶是按 hopMs 取的，直接乘回去会比引擎多出 2 小节。
    aLastVocalMs: lastVocalEnd ? lastVocalEnd(A.analysis, A.audibleEndMs) : 0,
  };
}

// ---------- 规则检查 ----------
/** A 在过渡窗口里到底有没有人在唱（0–1）。用来区分「真的漏了衔接」和「A 已经是器乐尾段」。 */
function meanVocalInWindow(analysis, fromMs, lengthMs) {
  const act = analysis.activity;
  if (!act || !Array.isArray(act.vocal) || !act.vocal.length) return 0;
  const hop = act.hopMs || 250;
  const i0 = Math.max(0, Math.floor(fromMs / hop));
  const i1 = Math.min(act.vocal.length - 1, Math.floor((fromMs + lengthMs) / hop));
  if (i1 < i0) return 0;
  let sum = 0;
  for (let i = i0; i <= i1; i += 1) sum += act.vocal[i] ?? 0;
  return sum / (i1 - i0 + 1);
}

function flagsFor(A, B, r) {
  const f = [];
  if (r.err) { f.push(`ERR:${r.err}`); return f; }
  const barA = (A.analysis.beatIntervalMs || 500) * (A.analysis.meter || 4);
  // dropSwap / doubleDrop 的语义就是「把 B 的 drop 当落点」，bStart > 0 是设计而不是缺陷。
  const dropStyle = r.technique === 'dropSwap' || r.technique === 'doubleDrop';
  // halfTime 是把 B 折叠成一半时值来接（2:1），backspin/cut/slam 是手势型处理：
  // 这几类的「落点」本来就不是 A 的末句，B 从 0 或折叠点起播是设计，不是 seek 缺陷。
  const gestureStyle = dropStyle || r.technique === 'halfTime' || r.technique === 'backspin'
    || r.technique === 'cut' || r.technique === 'slam';
  if (r.bStart > 0 && !gestureStyle) f.push('B_SEEK');
  // 硬切/砸切本来就是短窗口：2.6–4 s 是设计值，不该算缺陷。
  const isHardCut = r.technique === 'cut' || r.technique === 'slam';
  if (!isHardCut && r.fadeMs && r.fadeMs < 2_500) f.push('TOO_SHORT');
  // 变速会把实际时长改掉：B 半速播放时 5 s 的曲线只铺开 2.5 s 的音乐，反之亦然。
  // 只按 fadeMs 判会漏掉「报表够长、实际太短」的那一类。
  if (!isHardCut && r.wallMs && r.wallMs < 2_500) f.push('WALL_TOO_SHORT');
  if (r.fadeMs && r.fadeMs > 32_500) f.push('TOO_LONG');
  // B 整首没有唱句（器乐/纯伴奏）时不需要「人声衔接」，那是数据属性不是缺陷。
  // 两侧都没有唱句时「唱词衔接」本就不适用；这是数据属性，不是决策缺陷。
  if (!r.handoff) {
    if (gestureStyle) f.push('GESTURE_STYLE');
    else if (r.bPresence === 'instrumental') f.push('B_INSTRUMENTAL');
    else if (r.aPresence === 'instrumental') f.push('A_INSTRUMENTAL');
    else if (Number.isFinite(r.fadeStart) && meanVocalInWindow(A.analysis, r.fadeStart, r.fadeMs) < 0.3) f.push('A_OUTRO');
    else f.push('NO_HANDOFF');
  }
  // 「B 一开播就唱」的对不追求首句对齐，改用 B 侧让位处理（m05230）：
  //   有人声处理且真排了让位事件，就算合格，只做一条信息性标记。
  // B 本身是器乐（没唱词）时，「首句有没有对上」没有意义，不该判缺陷。
  if (r.handoff && !r.vocalAligned && r.bPresence !== 'instrumental') {
    f.push(r.bDuck > 0 ? 'ENTRY_DUCKED' : 'HANDOFF_UNALIGNED');
  }
  // A 还在唱就开始收尾 = 唱到一半被切走。歌词缺失时这条以前完全没有守卫（48 对 / 最多 4 小节）。
  if (r.aLastVocalMs > 0 && r.fadeStart + r.fadeMs + 600 < r.aLastVocalMs) {
    f.push('A_VOCAL_CUT');
  }
  // A 是纯器乐时没有「末句」可交接（handoff 恒假），但 B 早唱仍会盖住 A 的乐器：
  // 这时走的是 B 侧常驻让位（aInstrumental）。单独记一条，便于确认它真的排上了。
  if (!r.handoff && r.aPresence === 'instrumental' && r.bPresence !== 'instrumental' && r.bDuck > 0) {
    f.push('INSTRUMENTAL_DUCK');
  }
  if (r.bEntry > 0 && r.bEntry < 4_000) f.push('ENTRY_SUSPECT');
  if (r.anchorKind === 'structure') f.push('ANCHOR_STRUCTURE');
  // 器乐接缝被兜底夹走了（起点不能早于当前播放位置 / 最短窗口），单独记一条便于观察。
  if (r.instSeam && Math.abs(r.instDrift) > 20) f.push('INST_SEAM_SHIFTED');
  if (r.style === 'cut') f.push('CUT');
  if (r.q && !r.q.pass) f.push('QUALITY_FAIL');
  if (r.q && Number.isFinite(r.q.vocal) && r.q.vocal > 2) f.push('VOCAL_OVERLAP');
  // 咬字冲突：两边都满嗓子 + 调性不兼容（Camelot ≥4）。同调重叠属编曲，单独统计。
  if (r.q && Number.isFinite(r.q.vocalClash) && r.q.vocalClash > 2) f.push('VOCAL_CLASH');
  if (r.q && Number.isFinite(r.q.bass) && r.q.bass > 2) f.push('BASS_BUMP');
  if (r.fadeStart !== null && A.audibleEndMs && r.fadeStart + r.fadeMs > A.audibleEndMs + 100) f.push('PAST_END');
  // A 尾段本来就没唱词（末句离结尾 > 8 小节）时，「没人声可交接」不是缺陷。
  if (r.aTailGapBars !== null && r.aTailGapBars > 8 && f.includes('NO_HANDOFF')) {
    f.splice(f.indexOf('NO_HANDOFF'), 1);
    f.push('INSTRUMENTAL_TAIL');
  }
  // 「整段过渡挤在 A 的最后一小节里」要同时满足两条：起点落进最后一小节，**且窗口本身短于一拍小节**。
  // 歌在末句上收尾时（最后一击之后只剩 3.2 s），窗口只能那么长，那是物理长度不是缺陷（m08895）。
  if (!isHardCut && r.fadeStart !== null && A.audibleEndMs && A.audibleEndMs - r.fadeStart < barA && r.fadeMs < barA) {
    f.push('LAST_BAR');
  }
  if (r.bleed > 0 && r.fadeMs && r.bleed > r.fadeMs) f.push('BLEED_DOMINATES');
  // 2:1 折叠是 halfTime 的手法本体；手法被丢之后还留着 ×0.5/×2 的速率，
  // 就是「B 在窗口里慢放/快放」而没有对应的手法补偿（m08895 的听感是拖长糊音）。
  if (Number.isFinite(r.rate) && Math.abs(r.rate - 1) >= 0.4 && r.technique !== 'halfTime') f.push('RATE_UNSTYLED');
  return f;
}

// ---------- 主流程 ----------
const caches = loadCaches();
if (caches.length < 2) { console.error('缓存太少，先播几首让宿主分析'); process.exit(1); }
// 稳定伪随机（LCG），保证同一 seed 可复现
let seed = SEED >>> 0;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000);

const { engine, presence, lastVocalEnd, quality: QMOD } = makeHarness();
const CACHE_BY_FILE = new Map(caches.map((c) => [c.file, c]));
const rows = [];
const t0 = Date.now();
for (const A of caches) {
  const posMs = Math.round(Math.min(A.durationMs * 0.62, A.audibleEndMs - 25_000));
  const pool = caches.filter((x) => x !== A);
  const picks = [];
  for (let i = 0; i < Math.min(PAIRS, pool.length); i += 1) {
    const j = Math.floor(rnd() * pool.length);
    if (!picks.includes(pool[j])) picks.push(pool[j]);
  }
  for (const B of picks) {
    const r = auditOne(engine, A, B, posMs);
    rows.push({ a: A.file, b: B.file, aDur: A.durationMs, bDur: B.durationMs, ...r, flags: flagsFor(A, B, r) });
  }
}
const elapsed = Date.now() - t0;

// ---------- 汇总 ----------
const flagCounts = new Map();
for (const r of rows) for (const f of r.flags) flagCounts.set(f, (flagCounts.get(f) ?? 0) + 1);
// 质量门内部哪一条在拦（loudness-drift / vocal-overlap / bass-bump / rate-jump 各占多少）
const failCounts = new Map();
for (const r of rows) for (const f of r.q?.fail ?? []) failCounts.set(f, (failCounts.get(f) ?? 0) + 1);
const forms = new Map();
for (const r of rows) forms.set(r.form ?? '-', (forms.get(r.form ?? '-') ?? 0) + 1);
const techniques = new Map();
for (const r of rows) techniques.set(r.technique ?? '-', (techniques.get(r.technique ?? '-') ?? 0) + 1);
const cues = new Map();
for (const r of rows) cues.set(r.cueMode ?? '-', (cues.get(r.cueMode ?? '-') ?? 0) + 1);
const anchors = new Map();
for (const r of rows) anchors.set(r.anchorKind ?? '-', (anchors.get(r.anchorKind ?? '-') ?? 0) + 1);

const fadeSorted = rows.filter((r) => Number.isFinite(r.fadeMs)).map((r) => r.fadeMs).sort((x, y) => x - y);
const q = (p) => (fadeSorted.length ? fadeSorted[Math.min(fadeSorted.length - 1, Math.floor(p * fadeSorted.length))] : 0);
const pct = (n) => `${((n / Math.max(1, rows.length)) * 100).toFixed(1)}%`;

const out = {
  at: new Date().toISOString(), caches: caches.length, pairs: rows.length, elapsedMs: elapsed,
  fadeMs: { min: fadeSorted[0] ?? 0, p10: q(0.1), p50: q(0.5), p90: q(0.9), max: fadeSorted.at(-1) ?? 0 },
  flags: Object.fromEntries([...flagCounts].sort((a, b) => b[1] - a[1])),
  forms: Object.fromEntries(forms), cueModes: Object.fromEntries(cues), anchors: Object.fromEntries(anchors),
  techniques: Object.fromEntries(techniques),
  rows,
};
if (JSON_OUT) {
  // `_schedule` 只给曲线诊断用（每份含完整 plan，能到 20MB），落盘前剥掉。
  const slim = { ...out, rows: out.rows.map(({ _schedule, ...rest }) => rest) };
  fs.writeFileSync(JSON_OUT, JSON.stringify(slim, null, 2));
}

console.log(`\n曲目 ${caches.length} 首，取样 ${rows.length} 对，用时 ${elapsed} ms`);
console.log(`过渡时长 ms: min ${out.fadeMs.min} / p10 ${out.fadeMs.p10} / p50 ${out.fadeMs.p50} / p90 ${out.fadeMs.p90} / max ${out.fadeMs.max}`);
console.log(`形态 form: ${JSON.stringify(out.forms)}`);
console.log(`过渡手法: ${JSON.stringify(out.techniques)}`);
console.log(`cueMode: ${JSON.stringify(out.cueModes)}`);
console.log(`锚点: ${JSON.stringify(out.anchors)}`);
console.log('\n规则命中:');
for (const [f, n] of Object.entries(out.flags)) console.log(`  ${f.padEnd(20)} ${String(n).padStart(4)}  ${pct(n)}`);
if (failCounts.size) {
  console.log('  质量门内部:');
  for (const [f, n] of [...failCounts].sort((a, b) => b[1] - a[1])) console.log(`    ${f.padEnd(18)} ${String(n).padStart(4)}  ${pct(n)}`);
}
const driftSorted = rows.map((r) => r.q?.drift).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
if (driftSorted.length) {
  const dq = (p) => driftSorted[Math.min(driftSorted.length - 1, Math.floor(p * driftSorted.length))];
  console.log(`  drift LU: p50 ${dq(0.5)} / p75 ${dq(0.75)} / p90 ${dq(0.9)} / max ${driftSorted.at(-1)}`);
}
// ---------- 曲线诊断：--curves=N ----------
const CURVES = Number(args.curves ?? 0);
if (CURVES > 0 && QMOD) {
  const worst = rows
    .filter((r) => r._schedule && Number.isFinite(r.q?.drift))
    .sort((a, b) => (b.q.drift ?? 0) - (a.q.drift ?? 0))
    .slice(0, CURVES);
  console.log(`
响度曲线（最差 ${worst.length} 对，右端为过渡结束）：`);
  for (const r of worst) {
    const s = r._schedule;
    // 用 v2 计划的真实曲线算能量包络（low²+high² 归一到 1），不猜等功率/保持模型。
    const ENV_STEPS = 21;
    const envOf = (curves) => {
      if (!curves) return null;
      const out = [];
      const at = (arr, p) => {
        if (!Array.isArray(arr) || !arr.length) return 0;
        const pos = p * (arr.length - 1);
        const i0 = Math.floor(pos);
        const i1 = Math.min(arr.length - 1, i0 + 1);
        return (arr[i0] ?? 0) + ((arr[i1] ?? 0) - (arr[i0] ?? 0)) * (pos - i0);
      };
      for (let i = 0; i < ENV_STEPS; i += 1) {
        const p = i / (ENV_STEPS - 1);
        const lo = at(curves.low, p);
        const hi = at(curves.high, p);
        out.push((lo * lo + hi * hi) / 2);
      }
      return out;
    };
    const aEnv = envOf(s.v2Plan?.a);
    const bEnv = envOf(s.v2Plan?.b);
    const ramp = QMOD.loudnessRampCurve({
      a: CACHE_BY_FILE.get(r.a)?.analysis,
      b: CACHE_BY_FILE.get(r.b)?.analysis,
      fadeStartAMs: s.fadeStartFileMs,
      fadeStartBMs: s.bStartFileMs,
      fadeMs: s.fadeMs,
      tempoRate: s.tempoRate ?? 1,
      gainTrimDb: s.gainTrimDb ?? 0,
      swapShare: s.v2Plan ? Math.min(0.95, Math.max(0.05, 1 - (s.v2Plan.handoffStartP ?? 0))) : undefined,
      weights: aEnv && bEnv ? 'plan' : 'equal',
      aEnv: aEnv ?? undefined,
      bEnv: bEnv ?? undefined,
    });
    if (!ramp.lufs.length) continue;
    const lo = Math.min(...ramp.lufs);
    const hi = Math.max(...ramp.lufs);
    const bars = ramp.lufs.map((v) => '▁▂▃▄▅▆▇█'[Math.min(7, Math.max(0, Math.round(((v - lo) / Math.max(0.001, hi - lo)) * 7)))]).join('');
    console.log(
      `  ${String(r.q.drift).padStart(5)} LU  ${r.technique ?? '-'}  fade=${r.fadeMs}ms  ${bars}  ` +
      `[${lo.toFixed(1)} … ${hi.toFixed(1)}]  ${r.a.slice(0, 8)}→${r.b.slice(0, 8)}`,
    );
  }
}

// ---------- 与基线对比（回归闸门） ----------
if (BASELINE && fs.existsSync(BASELINE)) {
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const baseFlags = base.flags ?? {};
  const basePairs = Math.max(1, base.pairs ?? 1);
  const keys = new Set([...Object.keys(baseFlags), ...Object.keys(out.flags)]);
  console.log(`
对比基线 ${path.basename(BASELINE)}（${basePairs} 对 → ${rows.length} 对）:`);
  for (const k of [...keys].sort()) {
    const before = (100 * (baseFlags[k] ?? 0)) / basePairs;
    const after = (100 * (out.flags[k] ?? 0)) / Math.max(1, rows.length);
    const delta = after - before;
    const mark = Math.abs(delta) < 0.05 ? ' ' : delta > 0 ? '↑' : '↓';
    console.log(`  ${k.padEnd(20)} ${before.toFixed(1).padStart(5)}% → ${after.toFixed(1).padStart(5)}%  ${mark}${Math.abs(delta).toFixed(1)}`);
    if (FAIL_ON !== null && delta > FAIL_ON) regressions.push(`${k} +${delta.toFixed(1)}pp`);
  }
  // 「本该永远为 0」的规则：出现任何一条都算回归，不受 --fail-on 的百分点容忍。
  // LAST_BAR 不进这个列表：歌在末句上收尾时（末句之后只剩 3.2 s）窗口只能那么长，
  // 那是 A 的物理长度，不是可修的缺陷。它仍会出现在报告里供人工看。
  const MUST_BE_ZERO = ['RATE_UNSTYLED', 'NO_HANDOFF', 'TOO_SHORT', 'WALL_TOO_SHORT', 'B_SEEK'];
  for (const k of MUST_BE_ZERO) {
    const hits = out.flags[k] ?? 0;
    if (hits > 0) regressions.push(`${k} ${hits} 条（应为 0）`);
  }
  if (FAIL_ON !== null) {
    if (regressions.length) console.log(`
✖ 回归：${regressions.join('，')} 超过 --fail-on=${FAIL_ON}pp`);
    else console.log(`
✔ 没有规则命中率劣化超过 ${FAIL_ON}pp`);
  }
} else if (BASELINE) {
  console.log(`
（基线 ${BASELINE} 不存在，跳过对比；本轮 --json 写出的文件可直接当基线）`);
}

// ---------- 逐对身份对比：同 seed 下每对歌的「决定」不该变 ----------
if (PAIRDIFF && fs.existsSync(PAIRDIFF)) {
  const prev = JSON.parse(fs.readFileSync(PAIRDIFF, 'utf8'));
  const prevRows = Array.isArray(prev) ? prev : (prev.rows ?? []);
  const keyOf = (r) => `${r.a}|${r.b}`;
  const prevMap = new Map(prevRows.map((r) => [keyOf(r), r]));
  const changes = [];
  for (const r of rows) {
    const p = prevMap.get(keyOf(r));
    if (!p) continue;
    const d = [];
    if ((p.technique ?? '-') !== (r.technique ?? '-')) d.push(`手法 ${p.technique ?? '-'}→${r.technique ?? '-'}`);
    if ((p.form ?? '-') !== (r.form ?? '-')) d.push(`形态 ${p.form ?? '-'}→${r.form ?? '-'}`);
    const fr = p.fadeMs > 0 ? Math.abs(r.fadeMs - p.fadeMs) / p.fadeMs : 0;
    if (fr > 0.2) d.push(`时长 ${p.fadeMs}→${r.fadeMs}（${(fr * 100).toFixed(0)}%）`);
    if (Math.abs((r.bStart ?? 0) - (p.bStart ?? 0)) > 500) d.push(`B 入点 ${p.bStart}→${r.bStart}`);
    if (Math.abs((r.rate ?? 1) - (p.rate ?? 1)) > 0.01) d.push(`速率 ${p.rate}→${r.rate}`);
    if (!!p.handoff !== !!r.handoff) d.push(`衔接 ${!!p.handoff}→${!!r.handoff}`);
    if (d.length) changes.push(`${r.a.slice(0, 8)}->${r.b.slice(0, 8)}: ${d.join(' · ')}`);
  }
  console.log(`
逐对身份对比（基线 ${path.basename(PAIRDIFF)}，${prevRows.length} 对）：`);
  if (!changes.length) console.log(`  ✔ ${rows.length} 对的决定全部相同（手法/形态/时长/B 入点/速率/衔接）`);
  else {
    for (const c of changes.slice(0, 30)) console.log(`  ✖ ${c}`);
    if (changes.length > 30) console.log(`  … 另有 ${changes.length - 30} 对`);
    console.log(`  合计 ${changes.length} 对决定变化`);
  }
}

const worst = rows.filter((r) => r.flags.length).sort((x, y) => y.flags.length - x.flags.length).slice(0, TOP);
console.log(`\n问题最多的 ${worst.length} 对:`);
for (const r of worst) {
  console.log(`  ${r.flags.join(',')} | ${r.a.slice(0, 8)}->${r.b.slice(0, 8)} fade=${r.fadeMs} bStart=${r.bStart} entry=${r.bEntry} form=${r.form} rate=${r.rate} tech=${r.technique ?? '-'} style=${r.style ?? '-'} q=${r.q ? (r.q.pass ? 'ok' : 'FAIL') : '-'}`);
}

if (ONLY) {
  const hit = rows.filter((r) => r.a.startsWith(ONLY));
  console.log(`
--only ${ONLY}：${hit.length} 行`);
  for (const r of hit.slice(0, 3)) console.log(JSON.stringify(r, null, 2));
}

if (regressions.length) process.exitCode = 2;
