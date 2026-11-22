'use strict';
/**
 * 唱词锚点：从 activity.vocal 切句、选入口、找末句。
 *
 * 这些函数决定「过渡落在哪一句人声上」，错了就是人声打架或淡化落在间奏里，
 * 所以每条阈值与降级路径都钉一个断言。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function loadModules(entries) {
  const cache = new Map();
  const load = (file) => {
    if (cache.has(file)) return cache.get(file).exports;
    const source = fs.readFileSync(file, 'utf8');
    const js = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const module = { exports: {} };
    cache.set(file, module);
    const sandbox = {
      module,
      exports: module.exports,
      require: (request) => {
        if (!request.startsWith('.')) return require(request);
        const resolved = path.resolve(path.dirname(file), request);
        for (const candidate of [resolved, `${resolved}.ts`, path.join(resolved, 'index.ts')]) {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return load(candidate);
        }
        throw new Error(`无法解析模块：${request}（来自 ${file}）`);
      },
      console,
      Math,
      Number,
      Array,
      Object,
      JSON,
      String,
      Boolean,
      Error,
      isFinite,
      setTimeout,
      clearTimeout,
    };
    vm.runInNewContext(js, sandbox, { filename: file });
    return module.exports;
  };
  const out = {};
  for (const [name, file] of Object.entries(entries)) out[name] = load(path.join(root, file));
  return out;
}

const { vocalAnchor } = loadModules({
  vocalAnchor: 'src/core/automix/vocalAnchor.ts',
});

const HOP = 250;

/** 用「秒区间」造一条 vocal 曲线：区间内 0.8、其余 0.05。 */
function curve(spans, durationSec = 40) {
  const length = Math.round((durationSec * 1000) / HOP);
  const vocal = new Array(length).fill(0.05);
  for (const [fromSec, toSec] of spans) {
    const from = Math.round((fromSec * 1000) / HOP);
    const to = Math.round((toSec * 1000) / HOP);
    for (let i = from; i < to && i < length; i += 1) vocal[i] = 0.8;
  }
  return { hopMs: HOP, vocal, drum: new Array(length).fill(0.2), bass: new Array(length).fill(0.2) };
}

function analysis(spans, extra = {}) {
  return {
    durationMs: 40_000,
    bpm: 120,
    activity: curve(spans),
    sections: [],
    ...extra,
  };
}

test('切句：一句 2 秒切出 1 段，起终点落在 250ms 网格上', () => {
  const segments = vocalAnchor.findVocalSegments(analysis([[4, 6]]));
  assert.equal(segments.length, 1);
  assert.equal(segments[0].startMs, 4000);
  assert.equal(segments[0].endMs, 6000);
  assert.ok(segments[0].mean > 0.7);
});

test('切句：句内 500ms 换气不断句（<600ms gap）', () => {
  const segments = vocalAnchor.findVocalSegments(analysis([[4, 6], [6.5, 8]]));
  assert.equal(segments.length, 1);
  assert.equal(segments[0].startMs, 4000);
  assert.equal(segments[0].endMs, 8000);
});

test('切句：句间 1.5 秒静默必须断成两句', () => {
  const segments = vocalAnchor.findVocalSegments(analysis([[4, 6], [7.5, 9.5]]));
  assert.equal(segments.length, 2);
  // 跨 realm 数组不能用 deepEqual（原型不同），比较拼接结果。
  assert.equal(
    segments.map((s) => s.startMs).join(','),
    '4000,7500',
  );
});

test('切句：短于 700ms 的气口被丢掉', () => {
  const segments = vocalAnchor.findVocalSegments(analysis([[4, 6], [10, 10.5]]));
  assert.equal(segments.length, 1);
});

test('切句：没有 activity 曲线时返回空数组，不抛异常', () => {
  assert.equal(vocalAnchor.findVocalSegments({ durationMs: 1000 }).length, 0);
  assert.equal(vocalAnchor.findVocalSegments({ durationMs: 1000, activity: { hopMs: 250, vocal: [] } }).length, 0);
});

test('末句：只取 beforeMs 之前的最后一段结束点', () => {
  const a = analysis([[4, 6], [20, 22]]);
  assert.equal(vocalAnchor.lastVocalEnd(a, 30_000), 22_000);
  assert.equal(vocalAnchor.lastVocalEnd(a, 21_000), 6000);
  assert.equal(vocalAnchor.lastVocalEnd(a, 3000), 0);
});

test('入口 first：取 fromMs 之后最早一句', () => {
  const a = analysis([[2, 4], [10, 12]]);
  const entry = vocalAnchor.selectVocalEntry(a, 'first', { fromMs: 5000 });
  assert.equal(entry.ms, 10_000);
  assert.equal(entry.kind, 'first');
});

test('入口 strongest：取平均活动度最高的那句', () => {
  const a = analysis([[2, 4], [10, 13]]);
  // 把第二句整体抬到 1.0，第一句保持 0.8
  const hop = HOP;
  for (let i = Math.round(10_000 / hop); i < Math.round(13_000 / hop); i += 1) a.activity.vocal[i] = 1;
  const entry = vocalAnchor.selectVocalEntry(a, 'strongest', { fromMs: 0 });
  assert.equal(entry.kind, 'strongest');
  assert.equal(entry.ms, 10_000);
});

test('入口 chorus：落到 chorus 段起点附近的唱句，而不是首句', () => {
  const a = analysis([[2, 4], [24, 27]], {
    sections: [
      { label: 'verse', startMs: 0, endMs: 20_000, confidence: 0.8 },
      { label: 'chorus', startMs: 23_000, endMs: 35_000, confidence: 0.8 },
    ],
  });
  const entry = vocalAnchor.selectVocalEntry(a, 'chorus', { fromMs: 1000, barMs: 2000 });
  assert.equal(entry.kind, 'chorus');
  assert.equal(entry.ms, 24_000);
});

test('入口 chorus：没有副歌段就退回首句（并写清原因）', () => {
  const a = analysis([[2, 4], [24, 27]]);
  const entry = vocalAnchor.selectVocalEntry(a, 'chorus', { fromMs: 1000, barMs: 2000 });
  assert.equal(entry.ms, 2000);
  assert.match(entry.reason, /退回首句/);
});

test('入口 off：显式关闭返回 null', () => {
  assert.equal(vocalAnchor.selectVocalEntry(analysis([[2, 4]]), 'off', {}), null);
});

test('入口 off 等价：fromMs 之后没有唱句也返回 null（不硬塞）', () => {
  assert.equal(vocalAnchor.selectVocalEntry(analysis([[2, 4]]), 'first', { fromMs: 10_000 }), null);
});

// ---- 器乐误判防护：纯器乐的「主旋律」不能当成人声 ----
test('presence：人声断续 + 有动态 → vocal', () => {
  assert.equal(vocalAnchor.vocalPresence(analysis([[4, 6], [20, 22], [30, 33]])), 'vocal');
});

test('presence：几乎整首都有「谐波」→ instrumental（器乐主旋律/铺底）', () => {
  const a = analysis([]);
  const length = a.activity.vocal.length;
  for (let i = 0; i < length; i += 1) a.activity.vocal[i] = 0.62 + (i % 7) * 0.01;
  assert.equal(vocalAnchor.vocalPresence(a), 'instrumental');
});

test('presence：曲线太平（p90 − 中位数 < 0.18）→ instrumental', () => {
  const a = analysis([]);
  for (let i = 0; i < a.activity.vocal.length; i += 1) a.activity.vocal[i] = 0.5 + (i % 3) * 0.02;
  assert.equal(vocalAnchor.vocalPresence(a), 'instrumental');
});

test('presence：没有曲线 → unknown（调用方自己决定回退）', () => {
  assert.equal(vocalAnchor.vocalPresence({ durationMs: 1000 }), 'unknown');
});

test('器乐：lastVocalEnd 与 selectVocalEntry 都必须放弃，不能把过渡拉到歌中间', () => {
  const a = analysis([]);
  const length = a.activity.vocal.length;
  for (let i = 0; i < length; i += 1) a.activity.vocal[i] = 0.7;
  assert.equal(vocalAnchor.lastVocalEnd(a, 39_000), 0);
  assert.equal(vocalAnchor.selectVocalEntry(a, 'first', { fromMs: 0 }), null);
});

test('唱句平均活动度低于 0.55 不算唱句（器乐主旋律落在 0.4–0.55）', () => {
  const a = analysis([]);
  const length = a.activity.vocal.length;
  for (let i = 0; i < length; i += 1) a.activity.vocal[i] = 0.12;
  for (let i = 40; i < 48; i += 1) a.activity.vocal[i] = 0.5;
  assert.equal(vocalAnchor.findVocalSegments(a).length, 0);
});

test('双源仲裁：歌词与曲线差得不多时取歌词（精度更高）', () => {
  const mod = vocalAnchor;
  const out = mod.reconcileVocalAnchor({ lyricMs: 30_500, curveMs: 30_000, barMs: 2000 });
  assert.equal(out.source, 'lyric');
  assert.equal(out.ms, 30_500);
});

test('双源仲裁：歌词离曲线太远时判为错位，改用曲线', () => {
  const mod = vocalAnchor;
  // 8 小节 × 2 s = 16 s 容差；差 40 s 明显是别版歌词
  const out = mod.reconcileVocalAnchor({ lyricMs: 70_000, curveMs: 30_000, barMs: 2000 });
  assert.equal(out.source, 'curve');
  assert.equal(out.ms, 30_000);
  assert.match(out.reason, /错位/);
});

test('双源仲裁：只有一边有值时直接用那一边', () => {
  const mod = vocalAnchor;
  assert.equal(mod.reconcileVocalAnchor({ lyricMs: 0, curveMs: 12_000, barMs: 2000 }).source, 'curve');
  assert.equal(mod.reconcileVocalAnchor({ lyricMs: 9000, curveMs: 0, barMs: 2000 }).source, 'lyric');
  const none = mod.reconcileVocalAnchor({ lyricMs: 0, curveMs: 0, barMs: 2000 });
  assert.equal(none.source, 'none');
  assert.equal(none.ms, 0);
});

test('双源仲裁：容差随小节长度放大（慢歌不该被当成错位）', () => {
  const mod = vocalAnchor;
  // 4 s 一小节 → 8 小节 = 32 s 容差，差 20 s 仍算同一句
  const out = mod.reconcileVocalAnchor({ lyricMs: 50_000, curveMs: 30_000, barMs: 4000 });
  assert.equal(out.source, 'lyric');
});

test('末句守卫：离结尾超过一次过渡最大长度就不锚', () => {
  const mod = vocalAnchor;
  assert.equal(mod.tailAnchorUsable(120_000, 130_000, 32_000), true);
  assert.equal(mod.tailAnchorUsable(60_000, 130_000, 32_000), false);
  assert.equal(mod.tailAnchorUsable(0, 130_000, 32_000), false);
});

test('器乐尾端锚点：优先取最后一个乐句起点（在 32 s 窗口内）', () => {
  const a = analysis([], { durationMs: 180_000 });
  a.phraseStartsMs = [10_000, 60_000, 150_000, 158_000];
  a.downbeats = [148_000, 150_000, 152_000, 154_000, 156_000, 158_000, 160_000];
  a.audibleEndMs = 162_000;
  const anchor = vocalAnchor.instrumentalAnchor(a, { barMs: 2000, maxTailMs: 32_000 });
  assert.ok(anchor);
  assert.equal(anchor.kind, 'phrase');
  assert.equal(anchor.ms, 158_000);
  assert.equal(anchor.barsFromEnd, 2);
});

test('器乐尾端锚点：没有乐句时退到最后一个强拍', () => {
  const a = analysis([], { durationMs: 180_000 });
  a.phraseStartsMs = [];
  a.downbeats = [150_000, 152_000, 154_000, 156_000, 158_000, 161_500];
  a.audibleEndMs = 162_000;
  const anchor = vocalAnchor.instrumentalAnchor(a, { barMs: 2000, maxTailMs: 32_000 });
  assert.ok(anchor);
  assert.equal(anchor.kind, 'bar');
  assert.equal(anchor.ms, 158_000);
});

test('器乐尾端锚点：太靠近结尾（不足 2 小节）的候选被丢掉', () => {
  const a = analysis([], { durationMs: 180_000 });
  a.phraseStartsMs = [156_000, 161_000];
  a.downbeats = [159_000];
  a.audibleEndMs = 162_000;
  const anchor = vocalAnchor.instrumentalAnchor(a, { barMs: 2000, maxTailMs: 32_000 });
  // 161000 只剩 1 s、159000 剩 3 s（<2 小节 4 s）都被丢 → 156000 剩 6 s 合格
  assert.ok(anchor);
  assert.equal(anchor.ms, 156_000);
});

test('器乐尾端锚点：连强拍都没有时退到「结尾前两小节」', () => {
  const a = analysis([], { durationMs: 180_000 });
  a.phraseStartsMs = [];
  a.downbeats = [];
  a.beatIntervalMs = 0;
  a.audibleEndMs = 100_000;
  const anchor = vocalAnchor.instrumentalAnchor(a, { barMs: 2000 });
  assert.ok(anchor);
  assert.equal(anchor.kind, 'end');
  assert.equal(anchor.ms, 96_000);
});

test('器乐尾端锚点：没有可听结尾就没有锚点（不瞎猜）', () => {
  const a = analysis([], { durationMs: 180_000 });
  a.audibleEndMs = 0;
  assert.equal(vocalAnchor.instrumentalAnchor(a, { barMs: 2000 }), null);
});

test('强判定：连续 1.5 s ≥0.6 才算真开唱，短峰不算', () => {
  // 第 2 秒有个 0.57 短峰（前奏人声切片），第 17 秒才真正开唱
  const vocal = new Array(160).fill(0.1);
  vocal[8] = 0.57;
  vocal[9] = 0.57;
  for (let i = 68; i < 80; i += 1) vocal[i] = 0.72;
  const analysis = { activity: { hopMs: 250, vocal, drum: [], bass: [] } };
  assert.equal(vocalAnchor.firstStrongVocalMs(analysis), 68 * 250);
  // 只有短峰时返回 0
  const short = { activity: { hopMs: 250, vocal: [0.1, 0.6, 0.6, 0.1, 0.1], drum: [], bass: [] } };
  assert.equal(vocalAnchor.firstStrongVocalMs(short), 0);
  // 没有曲线 / 空曲线
  assert.equal(vocalAnchor.firstStrongVocalMs({}), 0);
  assert.equal(vocalAnchor.firstStrongVocalMs({ activity: { hopMs: 250, vocal: [], drum: [], bass: [] } }), 0);
});

test('强判定：fromMs 之前的不算，返回的是文件时间', () => {
  const vocal = new Array(200).fill(0.1);
  for (let i = 68; i < 80; i += 1) vocal[i] = 0.8;
  const analysis = { cueInMs: 30_000, activity: { hopMs: 250, vocal, drum: [], bass: [] } };
  assert.equal(vocalAnchor.firstStrongVocalMs(analysis, { fromMs: 0 }), 68 * 250);
  // fromMs 落在段内时按 250ms 网格取整（仍返回该段起点）
  assert.equal(vocalAnchor.firstStrongVocalMs(analysis, { fromMs: 68 * 250 + 1 }), 68 * 250);
  // fromMs 越过整段之后就没有了
  assert.equal(vocalAnchor.firstStrongVocalMs(analysis, { fromMs: 20_000 }), 0);
});

test('firstVocalLineMs：第一句偏轻也只有它算首句，不会跳到第二三句', () => {
  const built = analysis([], {
    durationMs: 60000,
    activity: {
      hopMs: 250,
      drum: [],
      bass: [],
      // 0.6 s 的呼吸峰（会被切句丢掉）+ 3 s 偏轻的第一句（0.58，仍高于切句门槛 0.55）+ 4 s 唱满的第二句（0.85）
      vocal: [
        ...Array(60).fill(0),
        ...Array(3).fill(0.6),
        ...Array(30).fill(0),
        ...Array(12).fill(0.58),
        ...Array(10).fill(0),
        ...Array(16).fill(0.85),
        ...Array(40).fill(0),
      ],
    },
  });
  assert.equal(vocalAnchor.firstVocalLineMs(built), 23250);
});

test('firstVocalLineMs：没有可用唱句时返回 0，器乐直接 0', () => {
  assert.equal(vocalAnchor.firstVocalLineMs(analysis([], { durationMs: 30000 })), 0);
  const instrumental = analysis([], {
    durationMs: 30000,
    activity: { hopMs: 250, drum: [], bass: [], vocal: Array(120).fill(0.2) },
  });
  assert.equal(vocalAnchor.firstVocalLineMs(instrumental), 0);
});

test('vocalEnergyNear 在歌词点附近能找到唱句能量，也能识别空白段', () => {
  const mod = vocalAnchor;
  const vocal = new Array(200).fill(0.05);
  for (let i = 38; i <= 42; i++) vocal[i] = 0.55; // 9.5–10.5 s 有一句
  const a = analysis([], { activity: { hopMs: 250, vocal, drum: vocal.map(() => 0.1), bass: vocal.map(() => 0.1) } });
  assert.ok(mod.vocalEnergyNear(a, 9280, { beforeMs: 500, afterMs: 4800 }) > 0.5);
  assert.ok(mod.vocalEnergyNear(a, 30000, { beforeMs: 500, afterMs: 2000 }) < 0.1);
});
