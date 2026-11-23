const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// 只测纯函数：把 mergeEnhancedFeatures / cleanCurve / describeFeatureSource
// 从 TS 源里摘出来，避免把 relOf / api 这些浏览器依赖拖进 node。
const file = path.join(__dirname, '../src/online/analysisFeatures.ts');
const source = ts.createSourceFile('analysisFeatures.ts', fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

function pick(names) {
  const parts = [];
  for (const name of names) {
    const node = source.statements.find(
      (item) => (ts.isFunctionDeclaration(item) || ts.isVariableStatement(item) || ts.isTypeAliasDeclaration(item))
        && (item.name?.text === name
          || (ts.isVariableStatement(item) && item.declarationList.declarations.some((d) => d.name.getText(source) === name))),
    );
    if (!node) throw new Error('missing ' + name);
    parts.push(node.getText(source));
  }
  return parts.join('\n');
}

const code = ts.transpileModule(
  `${pick(['FeatureSource', 'cleanCurve', 'mergeEnhancedFeatures', 'describeFeatureSource'])}\nexports.mergeEnhancedFeatures = mergeEnhancedFeatures;
   exports.describeFeatureSource = describeFeatureSource;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText;
const exportsBox = {};
vm.runInNewContext(code, { exports: exportsBox, Math, Number, Array, String, Object, console });
const { mergeEnhancedFeatures, describeFeatureSource } = exportsBox;

function baseAnalysis() {
  return {
    bpm: 120,
    downbeats: [0, 2000, 4000],
    phraseStartsMs: [0, 8000],
    sections: [{ startMs: 0, endMs: 8000, label: 'intro', confidence: 0.5 }],
    activity: { hopMs: 250, vocal: [0.1, 0.1], drum: [0.2, 0.2], bass: [0.3, 0.3] },
    cueInMs: 8000,
    cueOutMs: 60000,
  };
}

test('stems 合并：替换 activity 并打上来源', () => {
  const analysis = baseAnalysis();
  const changed = mergeEnhancedFeatures(analysis, {
    v: 1,
    version: 'stems/v1',
    stems: {
      hopMs: 250,
      vocal: [0.9, 0.8],
      drum: [0.1, 0.2],
      bass: [0.2, 0.3],
      other: [0.4, 0.4],
      source: 'htdemucs',
      modelSha256: 'abc123',
      durationMs: 1000,
      normalized: true,
    },
  });
  assert.equal(changed, true);
  assert.equal(analysis.activitySource, 'stems');
  assert.equal(analysis.activityModel, 'abc123');
  assert.deepEqual(Array.from(analysis.activity.vocal), [0.9, 0.8]);
  assert.deepEqual(Array.from(analysis.activity.drum), [0.1, 0.2]);
  assert.equal(analysis.featuresVersion, 'stems/v1');
});

test('stems 形状不合法：不覆盖 DSP 曲线', () => {
  const analysis = baseAnalysis();
  const before = analysis.activity;
  const changed = mergeEnhancedFeatures(analysis, {
    v: 1,
    version: 'stems/v1',
    stems: {
      hopMs: 250,
      vocal: [0.9, 0.8],
      drum: [0.1],
      bass: [0.2, 0.3],
      other: [],
      source: 'htdemucs',
      modelSha256: '',
      durationMs: 1000,
      normalized: true,
    },
  });
  assert.equal(changed, false);
  assert.equal(analysis.activity, before);
  assert.equal(analysis.activitySource, undefined);
});

test('structure 合并：替换 sections、保留已有 cue，来源标 ssm', () => {
  const analysis = baseAnalysis();
  const changed = mergeEnhancedFeatures(analysis, {
    v: 1,
    version: 'structure/ssm-v1',
    structure: {
      source: 'ssm',
      method: 'ssm-checkerboard',
      boundariesMs: [0, 32000, 96000],
      sections: [
        { startMs: 0, endMs: 32000, label: 'intro', confidence: 0.6 },
        { startMs: 32000, endMs: 96000, label: 'drop', confidence: 0.8 },
        { startMs: 96000, endMs: 160000, label: 'outro', confidence: 0.7 },
      ],
      barCount: 80,
    },
  });
  assert.equal(changed, true);
  assert.equal(analysis.sectionsSource, 'ssm');
  assert.equal(analysis.sections.length, 3);
  assert.equal(analysis.sections[1].label, 'drop');
  assert.equal(analysis.cueInMs, 8000, '已有 cue 不被覆盖');
  assert.equal(analysis.cueOutMs, 60000);
  assert.deepEqual(Array.from(analysis.boundariesMs), [0, 32000, 96000]);
});

test('structure 合并：没有 cue 时按 drop/outro 补', () => {
  const analysis = baseAnalysis();
  analysis.cueInMs = 0;
  analysis.cueOutMs = 0;
  mergeEnhancedFeatures(analysis, {
    v: 1,
    version: 'x',
    structure: {
      source: 'ssm+dsp',
      method: 'ssm-checkerboard',
      boundariesMs: [],
      sections: [
        { startMs: 0, endMs: 32000, label: 'verse', confidence: 0.4 },
        { startMs: 32000, endMs: 64000, label: 'chorus', confidence: 0.6 },
        { startMs: 64000, endMs: 90000, label: 'outro', confidence: 0.5 },
      ],
      barCount: 45,
    },
  });
  assert.equal(analysis.cueInMs, 32000);
  assert.equal(analysis.cueOutMs, 64000);
  assert.equal(analysis.sectionsSource, 'ssm');
});

test('空特征 / 非法段落：不动对象', () => {
  const analysis = baseAnalysis();
  assert.equal(mergeEnhancedFeatures(analysis, null), false);
  assert.equal(mergeEnhancedFeatures(analysis, { v: 1, version: '', structure: { source: 'ssm', method: '', boundariesMs: [], sections: [{ startMs: 10, endMs: 5, label: 'x', confidence: 1 }], barCount: 1 } }), false);
  assert.equal(analysis.sectionsSource, undefined);
});

test('describeFeatureSource 文案', () => {
  const analysis = baseAnalysis();
  assert.match(describeFeatureSource(analysis), /DSP/);
  mergeEnhancedFeatures(analysis, {
    v: 1,
    version: 'v',
    stems: { hopMs: 250, vocal: [0.5, 0.5], drum: [0.5, 0.5], bass: [0.5, 0.5], other: [], source: 'htdemucs', modelSha256: '', durationMs: 1, normalized: true },
    structure: { source: 'ssm', method: '', boundariesMs: [], sections: [{ startMs: 0, endMs: 10, label: 'intro', confidence: 0.5 }, { startMs: 10, endMs: 20, label: 'verse', confidence: 0.5 }], barCount: 2 },
  });
  assert.match(describeFeatureSource(analysis), /分轨/);
  assert.match(describeFeatureSource(analysis), /SSM/);
});

