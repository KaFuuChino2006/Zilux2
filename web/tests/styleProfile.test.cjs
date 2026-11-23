/**
 * styleProfile 单测：契约 §3 的 10 个标签各 2 条 fixture，外加语言顺序、
 * mood/vocal 三态、genre 加权、confidence 高低、阈值表快照、纯函数与 stylePolicy 集成。
 *
 * 加载方式：读取 TS 源文件 → 去掉 import 行 → transpile 到 CommonJS → vm 执行。
 * styleProfile 依赖 vocalAnchor 的 vocalPresence，所以先从 vocalAnchor.ts 里
 * 精确摘出 VOCAL_THRESHOLD / vocalPresenceDetail / vocalPresence 拼在前面。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const WEB_ROOT = path.join(__dirname, '..');

function readSource(relativePath) {
  return fs.readFileSync(path.join(WEB_ROOT, relativePath), 'utf8');
}

/** 按名字摘顶层 statement（函数 / const / type）。 */
function pickFrom(relativePath, names) {
  const source = ts.createSourceFile(
    relativePath,
    readSource(relativePath),
    ts.ScriptTarget.Latest,
    true,
  );
  const parts = [];
  for (const name of names) {
    const statement = source.statements.find((item) => {
      if (ts.isFunctionDeclaration(item) || ts.isTypeAliasDeclaration(item)) {
        return item.name?.text === name;
      }
      if (ts.isVariableStatement(item)) {
        return item.declarationList.declarations.some(
          (declaration) => declaration.name.getText(source) === name,
        );
      }
      return false;
    });
    if (!statement) throw new Error(`missing ${name} in ${relativePath}`);
    parts.push(statement.getText(source));
  }
  return parts.join('\n');
}

function loadModule(relativePath, prefix = '') {
  const body = readSource(relativePath).replace(/^\s*import\s[^\n]*\n/gm, '');
  const code = ts.transpileModule(`${prefix}\n${body}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const box = {};
  vm.runInNewContext(code, {
    exports: box,
    module: { exports: box },
    Math,
    Number,
    Array,
    String,
    Object,
    Set,
    JSON,
    console,
  });
  return box;
}

const VOCAL_PREFIX = pickFrom('src/core/automix/vocalAnchor.ts', [
  'VOCAL_THRESHOLD',
  'vocalPresenceDetail',
  'vocalPresence',
]);
const PROFILE = loadModule('src/core/automix/styleProfile.ts', VOCAL_PREFIX);
const POLICY = loadModule('src/core/automix/stylePolicy.ts');

const TAGS = [
  'punk',
  'rock',
  'metal',
  'electronic',
  'hiphop',
  'pop',
  'ballad',
  'acoustic',
  'ambient',
  'instrumental',
];

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// fixture 构造
// ---------------------------------------------------------------------------

function analysis(extra = {}) {
  return {
    bpm: 120,
    bpmConfidence: 0.8,
    meter: 4,
    meterConfidence: 0.8,
    beatIntervalMs: 500,
    firstBeatMs: 0,
    firstDownbeatMs: 0,
    downbeats: [0, 2_000],
    phraseStartsMs: [0],
    barCount: 64,
    sections: [],
    warnings: [],
    ...extra,
  };
}

function features(extra = {}) {
  return {
    v: 1,
    source: 'dsp',
    method: 'band-stats-v1',
    hopMs: 500,
    centroidHz: [2_000],
    flatness: [0.1],
    highRatio: [0.05],
    percussivity: [0.3],
    tonalness: [0.4],
    dynamicRangeLu: 6,
    silenceRatio: 0.02,
    lowEnergyRatio: 0.3,
    midEnergyRatio: 0.4,
    highEnergyRatio: 0.3,
    ...extra,
  };
}

function flat(value, length = 128) {
  return Array.from({ length }, () => value);
}

/** density 比例的点在 0.9，其余 0.05：保证 p50 落在低值、p98 落在高值 → 判 vocal。 */
function vocalCurve(density, length = 100) {
  const high = Math.round(length * density);
  return Array.from({ length }, (_, index) => (index < high ? 0.9 : 0.05));
}

function activity(extra = {}) {
  return {
    hopMs: 250,
    vocal: flat(0.05),
    drum: flat(0.4),
    bass: flat(0.5),
    ...extra,
  };
}

/**
 * 每个标签 2 条 fixture。min 是对应标签分数的下界；mood/vocal 只在明确断言时给。
 */
const FIXTURES = [
  {
    name: 'punk #1 · 高失真 + 快 + 重鼓',
    tag: 'punk',
    min: 0.9,
    mood: 'upbeat',
    vocal: 'vocal',
    input: {
      analysis: analysis({
        bpm: 160,
        beatIntervalMs: 375,
        energy: 0.8,
        keyMode: 'major',
        activity: activity({ vocal: vocalCurve(0.3), drum: flat(0.7), bass: flat(0.5) }),
      }),
      styleFeatures: features({
        highRatio: flat(0.3),
        flatness: flat(0.4),
        lowEnergyRatio: 0.5,
      }),
    },
  },
  {
    name: 'punk #2 · 接近阈值的朋克',
    tag: 'punk',
    min: 0.9,
    mood: 'upbeat',
    input: {
      analysis: analysis({
        bpm: 150,
        beatIntervalMs: 400,
        energy: 0.75,
        keyMode: 'major',
        activity: activity({ vocal: vocalCurve(0.25), drum: flat(0.6), bass: flat(0.5) }),
      }),
      styleFeatures: features({
        highRatio: flat(0.22),
        flatness: flat(0.3),
        lowEnergyRatio: 0.5,
      }),
    },
  },
  {
    name: 'rock #1 · 中速失真 + 鼓组',
    tag: 'rock',
    min: 0.9,
    input: {
      analysis: analysis({
        bpm: 125,
        beatIntervalMs: 480,
        energy: 0.6,
        keyMode: 'major',
        activity: activity({ vocal: vocalCurve(0.2), drum: flat(0.6), bass: flat(0.5) }),
      }),
      styleFeatures: features({
        highRatio: flat(0.18),
        flatness: flat(0.12),
        lowEnergyRatio: 0.5,
      }),
    },
  },
  {
    name: 'rock #2 · 慢一点但仍有失真',
    tag: 'rock',
    min: 0.9,
    input: {
      analysis: analysis({
        bpm: 110,
        beatIntervalMs: 545,
        energy: 0.55,
        keyMode: 'major',
        activity: activity({ vocal: vocalCurve(0.2), drum: flat(0.5), bass: flat(0.5) }),
      }),
      styleFeatures: features({
        highRatio: flat(0.15),
        flatness: flat(0.1),
        lowEnergyRatio: 0.5,
      }),
    },
  },
  {
    name: 'metal #1 · 高平坦度 + 低频不厚',
    tag: 'metal',
    min: 0.9,
    mood: 'upbeat',
    input: {
      analysis: analysis({
        bpm: 135,
        beatIntervalMs: 444.4,
        energy: 0.85,
        keyMode: 'major',
        activity: activity({ vocal: vocalCurve(0.2), drum: flat(0.2), bass: flat(0.5) }),
      }),
      styleFeatures: features({
        highRatio: flat(0.32),
        flatness: flat(0.38),
        lowEnergyRatio: 0.3,
      }),
    },
  },
  {
    name: 'metal #2 · 双踩速度 + 低占比',
    tag: 'metal',
    min: 0.9,
    input: {
      analysis: analysis({
        bpm: 200,
        beatIntervalMs: 300,
        energy: 0.9,
        keyMode: 'major',
        activity: activity({ vocal: vocalCurve(0.15), drum: flat(0.3), bass: flat(0.5) }),
      }),
      styleFeatures: features({
        highRatio: flat(0.26),
        flatness: flat(0.34),
        lowEnergyRatio: 0.38,
      }),
    },
  },
  {
    name: 'electronic #1 · 稳定四踩 + 稳定 tempo',
    tag: 'electronic',
    min: 0.9,
    mood: 'upbeat',
    input: {
      analysis: analysis({
        bpm: 126,
        beatIntervalMs: 476.19,
        tempoStability: 0.95,
        energy: 0.65,
        keyMode: 'major',
        activity: activity({ vocal: vocalCurve(0.2), drum: flat(0.8), bass: flat(0.7) }),
      }),
      styleFeatures: features({
        highRatio: flat(0.02),
        flatness: flat(0.05),
        percussivity: flat(0.35),
        lowEnergyRatio: 0.5,
      }),
    },
  },
  {
    name: 'electronic #2 · 两拍周期的踩点',
    tag: 'electronic',
    min: 0.9,
    mood: 'upbeat',
    input: {
      analysis: analysis({
        bpm: 130,
        beatIntervalMs: 461.5,
        tempoStability: 0.94,
        energy: 0.7,
        keyMode: 'major',
        activity: activity({
          vocal: vocalCurve(0.2),
          drum: Array.from({ length: 128 }, (_, index) => (index % 2 === 0 ? 0.9 : 0.3)),
          bass: Array.from({ length: 128 }, (_, index) => (index % 2 === 0 ? 0.8 : 0.2)),
        }),
      }),
      styleFeatures: features({
        highRatio: flat(0.02),
        flatness: flat(0.06),
        percussivity: flat(0.35),
        lowEnergyRatio: 0.5,
      }),
    },
  },
  {
    name: 'hiphop #1 · 88 BPM + 厚低频 + 人声密',
    tag: 'hiphop',
    min: 0.9,
    vocal: 'vocal',
    input: {
      analysis: analysis({
        bpm: 88,
        beatIntervalMs: 681.8,
        energy: 0.55,
        keyMode: 'major',
        activity: activity({ vocal: vocalCurve(0.45), drum: flat(0.3), bass: flat(0.5) }),
      }),
      styleFeatures: features({
        lowEnergyRatio: 0.5,
        highRatio: flat(0.05),
        flatness: flat(0.08),
        percussivity: flat(0.5),
      }),
    },
  },
  {
    name: 'hiphop #2 · 100 BPM + 高占比偏噪',
    tag: 'hiphop',
    min: 0.9,
    input: {
      analysis: analysis({
        bpm: 100,
        beatIntervalMs: 600,
        energy: 0.5,
        keyMode: 'major',
        activity: activity({ vocal: vocalCurve(0.45), drum: flat(0.3), bass: flat(0.5) }),
      }),
      styleFeatures: features({
        lowEnergyRatio: 0.45,
        highRatio: flat(0.13),
        flatness: flat(0.1),
        percussivity: flat(0.5),
      }),
    },
  },
  {
    name: 'pop #1 · 4/4 + 中速 + 人声',
    tag: 'pop',
    min: 0.9,
    mood: 'neutral',
    vocal: 'vocal',
    input: {
      analysis: analysis({
        bpm: 120,
        energy: 0.55,
        keyMode: 'major',
        activity: activity({ vocal: vocalCurve(0.45), drum: flat(0.3), bass: flat(0.5) }),
      }),
      styleFeatures: features({
        highRatio: flat(0.05),
        flatness: flat(0.08),
        percussivity: flat(0.4),
        lowEnergyRatio: 0.5,
      }),
    },
  },
  {
    name: 'pop #2 · 100 BPM 无强失真',
    tag: 'pop',
    min: 0.9,
    input: {
      analysis: analysis({
        bpm: 100,
        beatIntervalMs: 600,
        energy: 0.5,
        keyMode: 'major',
        activity: activity({ vocal: vocalCurve(0.45), drum: flat(0.3), bass: flat(0.5) }),
      }),
      styleFeatures: features({
        highRatio: flat(0.06),
        flatness: flat(0.1),
        percussivity: flat(0.4),
        lowEnergyRatio: 0.3,
      }),
    },
  },
  {
    name: 'ballad #1 · 小调慢歌 + 大动态',
    tag: 'ballad',
    min: 0.9,
    mood: 'sad',
    input: {
      analysis: analysis({
        bpm: 80,
        beatIntervalMs: 750,
        energy: 0.3,
        keyMode: 'minor',
        activity: activity({ vocal: vocalCurve(0.3), drum: flat(0.25), bass: flat(0.4) }),
      }),
      styleFeatures: features({
        dynamicRangeLu: 12,
        percussivity: flat(0.4),
        highRatio: flat(0.05),
        flatness: flat(0.05),
        tonalness: flat(0.3),
        lowEnergyRatio: 0.3,
      }),
    },
  },
  {
    name: 'ballad #2 · 70 BPM 小调',
    tag: 'ballad',
    min: 0.9,
    mood: 'sad',
    input: {
      analysis: analysis({
        bpm: 70,
        beatIntervalMs: 857,
        energy: 0.35,
        keyMode: 'minor',
        activity: activity({ vocal: vocalCurve(0.25), drum: flat(0.25), bass: flat(0.4) }),
      }),
      styleFeatures: features({
        dynamicRangeLu: 10,
        percussivity: flat(0.35),
        highRatio: flat(0.06),
        flatness: flat(0.06),
        tonalness: flat(0.4),
        lowEnergyRatio: 0.3,
      }),
    },
  },
  {
    name: 'acoustic #1 · 高谐波性 + 低瞬态',
    tag: 'acoustic',
    min: 0.9,
    input: {
      analysis: analysis({
        bpm: 100,
        beatIntervalMs: 600,
        energy: 0.42,
        keyMode: 'major',
        activity: activity({ vocal: vocalCurve(0.1), drum: flat(0.2), bass: flat(0.4) }),
      }),
      styleFeatures: features({
        tonalness: flat(0.8),
        highRatio: flat(0.03),
        percussivity: flat(0.1),
        dynamicRangeLu: 5,
        lowEnergyRatio: 0.4,
      }),
    },
  },
  {
    name: 'acoustic #2 · 90 BPM 原声',
    tag: 'acoustic',
    min: 0.9,
    input: {
      analysis: analysis({
        bpm: 90,
        beatIntervalMs: 666.7,
        energy: 0.45,
        keyMode: 'major',
        activity: activity({ vocal: vocalCurve(0.05), drum: flat(0.15), bass: flat(0.4) }),
      }),
      styleFeatures: features({
        tonalness: flat(0.9),
        highRatio: flat(0.02),
        percussivity: flat(0.15),
        dynamicRangeLu: 4,
        lowEnergyRatio: 0.45,
      }),
    },
  },
  {
    name: 'ambient #1 · 低能量 + 低瞬态 + 大动态',
    tag: 'ambient',
    min: 0.9,
    input: {
      analysis: analysis({
        bpm: 90,
        beatIntervalMs: 666.7,
        energy: 0.2,
        keyMode: 'major',
        activity: activity({ vocal: vocalCurve(0.05), drum: flat(0.1), bass: flat(0.4) }),
      }),
      styleFeatures: features({
        dynamicRangeLu: 14,
        percussivity: flat(0.1),
        highRatio: flat(0.02),
        tonalness: flat(0.3),
        lowEnergyRatio: 0.3,
      }),
    },
  },
  {
    name: 'ambient #2 · 70 BPM 氛围',
    tag: 'ambient',
    min: 0.9,
    input: {
      analysis: analysis({
        bpm: 70,
        beatIntervalMs: 857,
        energy: 0.25,
        keyMode: 'major',
        activity: activity({ vocal: vocalCurve(0.05), drum: flat(0.1), bass: flat(0.4) }),
      }),
      styleFeatures: features({
        dynamicRangeLu: 12,
        percussivity: flat(0.12),
        highRatio: flat(0.03),
        tonalness: flat(0.4),
        lowEnergyRatio: 0.3,
      }),
    },
  },
  {
    name: 'instrumental #1 · 人声活动度几乎为零',
    tag: 'instrumental',
    min: 0.95,
    vocal: 'instrumental',
    input: {
      analysis: analysis({
        bpm: 120,
        energy: 0.5,
        keyMode: 'major',
        activity: activity({ vocal: flat(0.1), drum: flat(0.3), bass: flat(0.5) }),
      }),
      styleFeatures: features({
        highRatio: flat(0.05),
        flatness: flat(0.08),
        percussivity: flat(0.4),
        lowEnergyRatio: 0.5,
      }),
    },
  },
  {
    name: 'instrumental #2 · 活动度全程超阈值（无唱句间隙）',
    tag: 'instrumental',
    min: 0.95,
    vocal: 'instrumental',
    input: {
      analysis: analysis({
        bpm: 120,
        energy: 0.5,
        keyMode: 'major',
        activity: activity({ vocal: flat(0.9), drum: flat(0.3), bass: flat(0.5) }),
      }),
      styleFeatures: features({
        highRatio: flat(0.2),
        flatness: flat(0.1),
        percussivity: flat(0.4),
        lowEnergyRatio: 0.5,
      }),
    },
  },
];

for (const fixture of FIXTURES) {
  test(`画像 fixture · ${fixture.name}`, () => {
    const profile = PROFILE.resolveStyleProfile(fixture.input);

    assert.equal(profile.primary, fixture.tag, `${fixture.name} · primary`);
    assert.ok(
      profile.tags[fixture.tag] >= fixture.min,
      `${fixture.name} · ${fixture.tag} 分数 ${profile.tags[fixture.tag]} < ${fixture.min}`,
    );
    assert.ok(profile.confidence >= 0.45, `${fixture.name} · confidence ${profile.confidence} < 0.45`);
    assert.equal(profile.v, 1);
    assert.ok(profile.source === 'dsp' || profile.source === 'dsp+meta');

    for (const tag of TAGS) {
      const score = profile.tags[tag];
      if (score === undefined) continue;
      assert.ok(score >= 0 && score <= 1, `${fixture.name} · ${tag} 分数越界`);
    }
    for (const key of Object.keys(profile.tags)) {
      assert.ok(TAGS.includes(key), `${fixture.name} · 非法标签 ${key}`);
    }

    if (fixture.mood) assert.equal(profile.mood, fixture.mood, `${fixture.name} · mood`);
    if (fixture.vocal) assert.equal(profile.vocal, fixture.vocal, `${fixture.name} · vocal`);

    const evidence = Array.from(profile.evidence).join('\n');
    assert.match(evidence, /BPM/);
    assert.match(evidence, /人声/);
    assert.match(evidence, /主标签/);
    assert.match(evidence, /语言/);
  });
}

// ---------------------------------------------------------------------------
// 语言判定顺序
// ---------------------------------------------------------------------------

function languageInput(extra = {}) {
  return { analysis: analysis({ bpm: 120, energy: 0.55, keyMode: 'major' }), ...extra };
}

test('语言 · meta 优先于 lyrics 与文本', () => {
  const profile = PROFILE.resolveStyleProfile(languageInput({
    meta: { language: 'ja' },
    lyrics: { language: 'zh-CN', text: 'こんにちは世界' },
  }));
  assert.equal(profile.language, 'ja');
});

test('语言 · 无 meta 时 lyrics.language 优先于文本', () => {
  const profile = PROFILE.resolveStyleProfile(languageInput({
    lyrics: { language: 'zh-CN', text: 'こんにちは世界' },
  }));
  assert.equal(profile.language, 'zh');
});

test('语言 · 假名比例判 ja', () => {
  const profile = PROFILE.resolveStyleProfile(languageInput({
    lyrics: { text: 'こんにちは世界、今日はいい天気ですね' },
  }));
  assert.equal(profile.language, 'ja');
});

test('语言 · 汉字比例判 zh', () => {
  const profile = PROFILE.resolveStyleProfile(languageInput({
    lyrics: { text: '夜空中最亮的星请指引我靠近你' },
  }));
  assert.equal(profile.language, 'zh');
});

test('语言 · 拉丁字母判 en', () => {
  const profile = PROFILE.resolveStyleProfile(languageInput({
    lyrics: { text: 'hello darkness my old friend' },
  }));
  assert.equal(profile.language, 'en');
});

test('语言 · 全无信息归 other', () => {
  const profile = PROFILE.resolveStyleProfile(languageInput());
  assert.equal(profile.language, 'other');
  assert.match(Array.from(profile.evidence).join('\n'), /语言 other/);
});

test('语言 · 无法识别的 language 字符串归 other', () => {
  const profile = PROFILE.resolveStyleProfile(languageInput({
    meta: { language: 'klingon' },
  }));
  assert.equal(profile.language, 'other');
});

// ---------------------------------------------------------------------------
// source / mood / vocal / genre / confidence
// ---------------------------------------------------------------------------

test('source · 有元数据或歌词时标 dsp+meta', () => {
  const withDsp = PROFILE.resolveStyleProfile(languageInput());
  assert.equal(withDsp.source, 'dsp');

  const withGenre = PROFILE.resolveStyleProfile(languageInput({ meta: { genre: 'rock' } }));
  assert.equal(withGenre.source, 'dsp+meta');

  const withLyrics = PROFILE.resolveStyleProfile(languageInput({ lyrics: { text: 'hello darkness' } }));
  assert.equal(withLyrics.source, 'dsp+meta');
});

test('mood · 无信息时 neutral', () => {
  const profile = PROFILE.resolveStyleProfile(languageInput());
  assert.equal(profile.mood, 'neutral');
});

test('vocal · 无人声曲线时 uncertain', () => {
  const profile = PROFILE.resolveStyleProfile({
    analysis: analysis({ bpm: 120, energy: 0.5, keyMode: 'major' }),
  });
  assert.equal(profile.vocal, 'uncertain');
});

test('genre 加权 · punk rock 两个标签各 +0.2', () => {
  const profile = PROFILE.resolveStyleProfile({
    analysis: analysis({ bpm: 120, energy: 0.55, keyMode: 'major' }),
    meta: { genre: 'punk rock' },
  });
  assert.equal(profile.primary, 'punk');
  assert.equal(profile.tags.punk, 0.2);
  assert.equal(profile.tags.rock, 0.2);
  assert.equal(profile.source, 'dsp+meta');
  assert.match(Array.from(profile.evidence).join('\n'), /genre="punk rock"/);
});

test('genre 加权 · 同一标签只加一次', () => {
  const profile = PROFILE.resolveStyleProfile({
    analysis: analysis({ bpm: 120, energy: 0.55, keyMode: 'major' }),
    meta: { genre: 'electronic electronica edm' },
  });
  assert.equal(profile.tags.electronic, 0.2);
});

test('confidence · 数据齐全时高、裸分析时低', () => {
  const rich = PROFILE.resolveStyleProfile(FIXTURES[10].input);
  assert.ok(rich.confidence >= 0.7, `rich confidence ${rich.confidence}`);

  const bare = PROFILE.resolveStyleProfile({ analysis: analysis({ bpm: 120 }) });
  assert.ok(bare.confidence < 0.45, `bare confidence ${bare.confidence}`);
  assert.equal(bare.primary, 'pop');
  assert.equal(bare.tags.pop, 0.12);
});

// ---------------------------------------------------------------------------
// 契约常数 + 纯函数 + 与策略层的集成
// ---------------------------------------------------------------------------

test('STYLE_THRESHOLDS 快照 · 契约 §3 的判定线', () => {
  const T = PROFILE.STYLE_THRESHOLDS;
  assert.equal(T.punk.highRatioMean, 0.018);
  assert.equal(T.punk.flatnessMean, 0.22);
  assert.equal(T.punk.minBpm, 140);
  assert.equal(T.punk.drumMedian, 0.55);

  assert.equal(T.metal.highRatioMean, 0.022);
  assert.equal(T.metal.flatnessMean, 0.26);
  assert.equal(T.metal.minBpm, 120);
  assert.equal(T.metal.maxLowRatio, 0.42);

  assert.equal(T.rock.highRatioMean, 0.012);
  assert.equal(T.rock.drumMedian, 0.45);

  assert.equal(T.electronic.fourOnFloor, 0.78);
  assert.equal(T.electronic.tempoStability, 0.88);
  assert.equal(T.electronic.bassRegularity, 0.7);

  assert.equal(T.hiphop.minBpm, 70);
  assert.equal(T.hiphop.maxBpm, 105);
  assert.equal(T.hiphop.minLowRatio, 0.38);
  assert.equal(T.hiphop.minVocalDensity, 0.4);

  assert.equal(T.pop.meter, 4);
  assert.equal(T.pop.minBpm, 95);
  assert.equal(T.pop.maxBpm, 130);
  assert.equal(T.pop.minVocalDensity, 0.35);
  assert.equal(T.pop.maxHighRatio, 0.08);

  assert.equal(T.ballad.maxBpm, 95);
  assert.equal(T.ballad.maxEnergy, 0.45);
  assert.equal(T.ballad.minDynamicRangeLu, 8);

  assert.equal(T.acoustic.minTonalness, 0.6);
  assert.equal(T.acoustic.maxHighRatio, 0.05);
  assert.equal(T.acoustic.maxPercussivity, 0.3);

  assert.equal(T.ambient.maxEnergy, 0.3);
  assert.equal(T.ambient.maxPercussivity, 0.2);
  assert.equal(T.ambient.minDynamicRangeLu, 10);

  assert.equal(T.instrumental.score, 0.95);
  assert.equal(T.mood.sadMaxEnergy, 0.4);
  assert.equal(T.unknown.primary, 0.12);
  assert.deepEqual(Array.from(PROFILE.STYLE_TAG_ORDER), TAGS);
});

test('纯函数 · 重复调用一致且不改输入', () => {
  const input = FIXTURES[0].input;
  const before = JSON.stringify(input);
  const first = plain(PROFILE.resolveStyleProfile(input));
  const second = plain(PROFILE.resolveStyleProfile(input));
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(input), before);
});

test('集成 · punk + ballad 画像驱动策略规则 1', () => {
  const punk = PROFILE.resolveStyleProfile(FIXTURES[0].input);
  const ballad = PROFILE.resolveStyleProfile(FIXTURES[12].input);
  assert.ok(punk.confidence >= 0.45);
  assert.ok(ballad.confidence >= 0.45);

  const policy = POLICY.resolveStylePolicy(punk, ballad, {
    keyGap: 2,
    bpmGap: 0.05,
    energyGap: 0.3,
    windowMs: 16_000,
    barMs: 2_000,
    aVocal: 0.3,
    bVocal: 0.3,
  });
  assert.equal(policy.windowScale, 1.25);
  assert.equal(policy.duckScale, 0.6);
  assert.match(Array.from(policy.reasons).join('\n'), /规则 1/);
});
