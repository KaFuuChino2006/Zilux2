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
      'backspin', 'loopRoll', 'dropEntry', 'doubling', 'genreProfile', 'appleRecipes',
      'styleProfile', 'stylePolicy', 'extensionPlan', 'generativeTransition']);
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
      source: raw.source ?? null,
      trackId: raw.trackId ?? null,
      rel: raw.rel ?? a.rel ?? null,
      durationMs,
      audibleEndMs: Number(a.audibleEndMs ?? durationMs),
      analysis: { ...a, durationMs },
    });
  }
  return out;
}

// ---------- 谱特征（style stage） ----------
const FEATURE_DIR = path.join(process.env.LOCALAPPDATA || '', 'Zilux2', 'analysis', 'features');
function loadStyleFeatures() {
  const byKey = new Map();
  if (!fs.existsSync(FEATURE_DIR)) return byKey;
  for (const dir of fs.readdirSync(FEATURE_DIR)) {
    const file = path.join(FEATURE_DIR, dir, 'style.json');
    if (!fs.existsSync(file)) continue;
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { continue; }
    const p = raw?.payload;
    if (!p || !Array.isArray(p.centroidHz) || !(p.hopMs > 0)) continue;
    byKey.set(raw.inputKey, p);
  }
  return byKey;
}
const STYLE_FEATURES = loadStyleFeatures();

// ---------- 生成段（extend stage）：按同一 inputKey 挂到 B 上，才能体检「垫底」决策 ----------
function loadExtensions() {
  const byKey = new Map();
  if (!fs.existsSync(FEATURE_DIR)) return byKey;
  for (const dir of fs.readdirSync(FEATURE_DIR)) {
    const ext = path.join(FEATURE_DIR, dir, 'extend');
    if (!fs.existsSync(ext)) continue;
    for (const name of fs.readdirSync(ext)) {
      if (!name.endsWith('.json')) continue;
      let raw;
      try { raw = JSON.parse(fs.readFileSync(path.join(ext, name), 'utf8').replace(/^﻿/, '')); } catch { continue; }
      const p = raw?.payload;
      if (!p?.file || !(p.durationMs > 0) || !raw.inputKey) continue;
      const prev = byKey.get(raw.inputKey);
      if (!prev || p.durationMs > prev.durationMs) byKey.set(raw.inputKey, p);
    }
  }
  return byKey;
}
const EXTENSIONS = loadExtensions();
function keyFor(track) {
  if (!track) return null;
  if (track.source && track.source !== 'local' && track.trackId != null) {
    const k = `${track.source}:${track.trackId}`;
    if (STYLE_FEATURES.has(k)) return k;
  }
  if (track.rel) {
    const prefix = `local:${track.rel}:`;
    for (const k of STYLE_FEATURES.keys()) if (k.startsWith(prefix)) return k;
    for (const k of EXTENSIONS.keys()) if (k.startsWith(prefix)) return k;
  }
  return null;
}

function featuresFor(track) {
  if (!track?.analysis) return null;
  if (track.source && track.trackId === undefined && track.rel === undefined) return null;
  if (track.source && track.source !== 'local' && track.trackId != null) {
    const hit = STYLE_FEATURES.get(`${track.source}:${track.trackId}`);
    if (hit) return hit;
  }
  if (track.rel) {
    const prefix = `local:${track.rel}:`;
    for (const [key, payload] of STYLE_FEATURES) {
      if (key.startsWith(prefix)) return payload;
    }
  }
  return null;
}
function centroidNear(features, ms, dir) {
  if (!features) return null;
  const hop = features.hopMs;
  const idx = Math.round(ms / hop);
  const out = [];
  for (let k = 1; k <= 4; k += 1) {
    const i = idx + dir * k;
    const v = features.centroidHz[i];
    if (Number.isFinite(v) && v > 50 && v < 16000) out.push(v);
  }
  if (!out.length) return null;
  return out.reduce((x, y) => x + y, 0) / out.length;
}

// ---------- 体检规则 ----------
function auditOne(engine, A, B, posMs) {
  const active = { currentTime: 0, readyState: 4, playbackRate: 1, volume: 1, paused: false, pause() {}, play() { return Promise.resolve(); } };
  const standby = { ...active };
  const bKey = keyFor(B);
  if (bKey && EXTENSIONS.has(bKey) && !B.analysis.extension) {
    B.analysis.extension = EXTENSIONS.get(bKey);
  }
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
    // 窗口关不住 A 末句时，引擎用 aTailHold+tailBleed 把最后一句唱完再淡出；
    // 这段缺口不算「切断」，算「延长尾巴」（判规则时把它加进覆盖长度）。
    tailGuard: s.tailGuardMs ?? 0,
    splitHz: s.splitHz ?? 120,
    lowCorr: s.lowCorr ?? null,
    lowInvert: s.lowInvert === true,
    bed: s.extensionPlan?.mode ?? null,
    bTrimMax: s.bTrimMax ?? 0,
    lowPlanOverlap: (() => {
      const a = s.v2Plan && s.v2Plan.a && s.v2Plan.a.low;
      const b = s.v2Plan && s.v2Plan.b && s.v2Plan.b.low;
      if (!Array.isArray(a) || !Array.isArray(b) || a.length < 2) return null;
      const sample = (pts, p) => {
        for (let i = 1; i < pts.length; i += 1) {
          if (p <= pts[i].t) {
            const l = pts[i - 1], r = pts[i];
            const span = r.t - l.t;
            return span <= 0 ? r.v : l.v + ((r.v - l.v) * (p - l.t)) / span;
          }
        }
        return pts[pts.length - 1].v;
      };
      let both = 0, n = 0;
      for (let i = 0; i <= 200; i += 1) {
        const p = i / 200;
        if (sample(a, p) > 0.1 && sample(b, p) > 0.1) both += 1;
        n += 1;
      }
      return Math.round((both / n) * 1000) / 1000;
    })(),
    lowBoth: (() => {
      const ca = A.analysis.activity && A.analysis.activity.bass;
      const cb = B.analysis.activity && B.analysis.activity.bass;
      if (!Array.isArray(ca) || !Array.isArray(cb)) return null;
      const ha = A.analysis.activity.hopMs || 250;
      const hb = B.analysis.activity.hopMs || 250;
      const ta = s.tempoRate || 1;
      let both = 0, n = 0;
      for (let t = s.fadeStartFileMs; t < s.fadeStartFileMs + s.fadeMs; t += 250) {
        const va = ca[Math.floor(t / ha)] || 0;
        const vb = cb[Math.floor((s.bStartFileMs + (t - s.fadeStartFileMs) / Math.max(0.5, ta)) / hb)] || 0;
        if (va > 0.12 && vb > 0.12) both += 1;
        n += 1;
      }
      return n ? Math.round((both / n) * 1000) / 1000 : null;
    })(),
    exitOff: (() => {
      const db = A.analysis.downbeats;
      const beat = A.analysis.beatIntervalMs;
      if (!Array.isArray(db) || !db.length || !(beat > 0)) return null;
      let best = Infinity;
      for (const d of db) best = Math.min(best, Math.abs(d - s.fadeStartFileMs));
      return Math.round((best / beat) * 100) / 100;
    })(),
    timbreDb: (() => {
      const fa = featuresFor(A); const fb = featuresFor(B);
      const aHz = centroidNear(fa, A.audibleEndMs, -1);
      const bHz = centroidNear(fb, (s.bStartFileMs ?? 0), +1);
      if (!aHz || !bHz) return null;
      return Math.round(200 * Math.log10(bHz / aHz)) / 10;
    })(),
    bDuck: Array.isArray(s.bDuck) ? s.bDuck.filter((e) => e.db < -1).length : 0,
    q: s.quality ? { pass: !!s.quality.pass, bass: +s.quality.bassBumpDb?.toFixed?.(2), vocal: +s.quality.vocalOverlapBeats?.toFixed?.(2), clash: +s.quality.vocalClashBeats?.toFixed?.(2), drift: +s.quality.loudnessDriftLu?.toFixed?.(2), rate: +s.quality.rateJumpPctPerBeat?.toFixed?.(2), fail: s.quality.failures ?? [], curve: s.quality.curve?.lufs } : null,
    swap: s.v2Plan ? { start: +s.v2Plan.handoffStartP?.toFixed(3), end: +s.v2Plan.handoffP?.toFixed(3) } : null,
    // A 在「末句那一刻」还剩多少电平：low/high 的功率包络换算成 dB。
    // 用来区分「被切走」与「已经在淡出、只是歌词还没唱完」。
    // A 在末句那一刻被 duck 了多少：压到 ‑4 dB 以下说明人声正在交接，不算「切断」。
    aDuckAtVocal: (() => {
      const ev = Array.isArray(s.v2Duck) ? s.v2Duck : null;
      if (!ev || !ev.length) return 0;
      const last = Math.min(
        lastVocalEnd(A.analysis, A.audibleEndMs),
        A.audibleEndMs > 0 ? A.audibleEndMs : Number.POSITIVE_INFINITY,
      );
      if (!(last > 0)) return 0;
      const t = last - s.fadeStartFileMs + 120;
      let db = 0;
      for (const e of ev) if (e.offsetMs <= t) db = Math.min(db, e.db);
      return Math.round(db * 10) / 10;
    })(),
    aEnvVocalDb: (() => {
      const cur = s.v2Plan && s.v2Plan.a;
      if (!cur || !Array.isArray(cur.low) || !Array.isArray(cur.high)) return null;
      const at = (arr, q) => {
        const pos = q * (arr.length - 1);
        const i0 = Math.floor(pos), i1 = Math.min(arr.length - 1, i0 + 1);
        return (arr[i0] ?? 0) + ((arr[i1] ?? 0) - (arr[i0] ?? 0)) * (pos - i0);
      };
      const last = Math.min(
        lastVocalEnd(A.analysis, A.audibleEndMs),
        A.audibleEndMs > 0 ? A.audibleEndMs : Number.POSITIVE_INFINITY,
      );
      if (!(last > 0) || !(s.fadeMs > 0)) return null;
      const q = Math.min(1, Math.max(0, (last - s.fadeStartFileMs) / s.fadeMs));
      const lo = at(cur.low, q), hi = at(cur.high, q);
      return Math.round(100 * 10 * Math.log10(Math.max(1e-6, (lo * lo + hi * hi) / 2))) / 100;
    })(),
    note: s.autoNote ?? '',
    bPresence: presence ? presence(B.analysis) : 'unknown',
    aPresence: presence ? presence(A.analysis) : 'unknown',
    // A 最后一句唱到哪儿（曲内毫秒，和引擎同一个「唱句段」口径）。
    // 引擎把末句夹在 audibleEnd 之内（audibleEnd 之后是静音/母带残响，不算还在唱），
    // 这里也必须同样夹，否则「末句越过可听结尾 10 s」会被误报成切断。
    aLastVocalMs: lastVocalEnd
      ? Math.min(
        lastVocalEnd(A.analysis, A.audibleEndMs),
        A.audibleEndMs > 0 ? A.audibleEndMs : Number.POSITIVE_INFINITY,
      )
      : 0,
    // B 第一句真正开唱的位置，以及那一刻让位有多深。
    // 只看「窗口里出现过让位」会把「前 0.5 s 垫底被压、2.5 s 才开唱」误判成 B 首句被压。
    bDuckAtVocal: (() => {
      const act = B.analysis && B.analysis.activity;
      const vocal = act && act.vocal;
      if (!Array.isArray(vocal) || !vocal.length || !Array.isArray(s.bDuck)) return 0;
      const hop = act.hopMs || 250;
      const from = s.bStartFileMs ?? 0;
      const start = Math.max(0, Math.floor(from / hop));
      const need = Math.max(2, Math.ceil(600 / hop));
      let first = -1;
      for (let i = start; i + need - 1 < vocal.length; i += 1) {
        let ok = true;
        for (let k = 0; k < need; k += 1) if ((vocal[i + k] || 0) < 0.35) { ok = false; break; }
        if (ok) { first = i * hop; break; }
      }
      if (first < 0) return 0;
      const rate = s.tempoRate > 0 ? s.tempoRate : 1;
      const offset = (first - from) / rate;
      // 只看开唱那一刻的让位值（最后一个不晚于它的点），不是整段窗口的最小值。
      let at = -1;
      let db = 0;
      for (const e of s.bDuck) {
        if (e.offsetMs <= offset + 120 && e.offsetMs >= at) { at = e.offsetMs; db = e.db || 0; }
      }
      return Math.round(db * 100) / 100;
    })(),
    // B 开播前 3 秒有没有在唱：决定「B 被压」到底是不是缺陷。
    bEntryVocal: (() => {
      const act = B.analysis && B.analysis.activity;
      const vocal = act && act.vocal;
      if (!Array.isArray(vocal) || !vocal.length) return 0;
      const hop = act.hopMs || 250;
      const from = s.bStartFileMs ?? 0;
      const i0 = Math.max(0, Math.floor(from / hop));
      const i1 = Math.min(vocal.length - 1, Math.floor((from + 3000) / hop));
      let peak = 0;
      for (let i = i0; i <= i1; i += 1) peak = Math.max(peak, vocal[i] || 0);
      return Math.round(peak * 100) / 100;
    })(),
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
    // 只有「B 开播就在唱、同时被压」才是缺陷；压 B 的器乐垫底是设计内行为。
    // B 被整段让位（A 还在唱、B 主动退到人声后面）是设计内的「A 优先」，
    // 记成 B_YIELDS 信息项，不算缺陷 —— 否则 18% 的报表会把正确行为淹没（r5）。
    if (r.bDuckAtVocal < -2) f.push('ENTRY_DUCKED');
    else if (r.bDuck > 0) f.push('B_YIELDS');
    else if (Number.isFinite(r.fadeStart)
      && meanVocalInWindow(A.analysis, r.fadeStart, Math.min(2000, r.fadeMs ?? 2000)) < 0.3) {
      // B 从窗口开头就唱、但 A 这一段本来没人声：没有「对齐」可谈，也没有冲突。
      //   记信息项，不算缺陷（否则「B 提前开唱」会被当成漏处理）。
      f.push('B_ENTRY_AHEAD');
    } else f.push('HANDOFF_UNALIGNED');
  }
  // A 还在唱就开始收尾 = 唱到一半被切走。歌词缺失时这条以前完全没有守卫（48 对 / 最多 4 小节）。
  // r2 起：窗口关不住时引擎改为把 A 停在 −10 dB、用尾巴把这一句唱完再收（tailGuardMs），
  // 只有连尾巴都盖不住才算「切断」。
  if (r.aLastVocalMs > 0
    && r.fadeStart + r.fadeMs + 600 + (r.tailGuard ?? 0) < r.aLastVocalMs) {
    // 已经被压到 ‑12 dB 以下才断：那是「淡出收尾」，歌词只是还没唱完；
    // 仍在 ‑12 dB 以上就断，才是真切断。
    if ((r.aDuckAtVocal ?? 0) <= -4) f.push('A_VOCAL_YIELD');
    else if (r.aEnvVocalDb !== null && r.aEnvVocalDb !== undefined && r.aEnvVocalDb <= -12) f.push('A_VOCAL_TAIL');
    else f.push('A_VOCAL_CUT');
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
  // 低频相位冲突：两边低频同时活跃且波形反相，120–180 Hz 分频只能减轻、不能消除。
  if (r.lowCorr !== null) {
    const effCorr = r.lowInvert ? -r.lowCorr : r.lowCorr;
    if (effCorr < -0.3 && (r.lowBoth ?? 0) > 0.4) f.push('LOW_PHASE_CLASH');
  }
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
const INFORMATIONAL = new Set(['B_YIELDS', 'A_VOCAL_TAIL', 'A_VOCAL_YIELD']);
const flagInfo = new Map();
for (const r of rows) for (const f of r.flags) {
  if (INFORMATIONAL.has(f)) flagInfo.set(f, (flagInfo.get(f) ?? 0) + 1);
  else flagCounts.set(f, (flagCounts.get(f) ?? 0) + 1);
}
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
for (const [f, n] of [...flagInfo].sort((a, b) => b[1] - a[1])) console.log(`  (信息) ${f.padEnd(17)} ${String(n).padStart(4)}  ${pct(n)}`);
if (failCounts.size) {
  console.log('  质量门内部:');
  for (const [f, n] of [...failCounts].sort((a, b) => b[1] - a[1])) console.log(`    ${f.padEnd(18)} ${String(n).padStart(4)}  ${pct(n)}`);
}
const driftSorted = rows.map((r) => r.q?.drift).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
if (driftSorted.length) {
  const dq = (p) => driftSorted[Math.min(driftSorted.length - 1, Math.floor(p * driftSorted.length))];
  console.log(`  drift LU: p50 ${dq(0.5)} / p75 ${dq(0.75)} / p90 ${dq(0.9)} / max ${driftSorted.at(-1)}`);
  const exit = rows.map((r) => r.exitOff).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (exit.length) {
    const at = (q) => exit[Math.min(exit.length - 1, Math.floor(exit.length * q))];
    console.log(`  A 出点距强拍: n ${exit.length} / p50 ${at(0.5).toFixed(2)} 拍 / p90 ${at(0.9).toFixed(2)} 拍 / ≤0.1 拍 ${(100 * exit.filter((v) => v <= 0.1).length / exit.length).toFixed(1)}%`);
  }
  const timbre = rows.map((r) => r.timbreDb).filter((v) => Number.isFinite(v)).map(Math.abs).sort((a, b) => a - b);
  if (timbre.length) {
    const tq = (q) => timbre[Math.min(timbre.length - 1, Math.floor(timbre.length * q))].toFixed(1);
    console.log(`  谱质心台阶 dB: n ${timbre.length} / p50 ${tq(0.5)} / p75 ${tq(0.75)} / p90 ${tq(0.9)} / max ${timbre.at(-1).toFixed(1)} / >6dB ${timbre.filter((v) => v > 6).length}`);
  }
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

const worst = rows.filter((r) => r.flags.some((f) => !INFORMATIONAL.has(f))).sort((x, y) => y.flags.filter((f) => !INFORMATIONAL.has(f)).length - x.flags.filter((f) => !INFORMATIONAL.has(f)).length).slice(0, TOP);
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
