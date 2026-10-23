/**
 * Zilux2 真机 QA —— 一键回归入口
 *
 * 顺序执行全部套件（每个套件是独立进程，互不污染），汇总 PASS/FAIL/SKIP 表。
 *
 * 用法：
 *   node research/qa/suite/run-all.mjs                 # 跑全部
 *   node research/qa/suite/run-all.mjs smoke downloads # 只跑指定套件
 *   ZILUX2_ONLY=smoke,room-effects node research/qa/suite/run-all.mjs
 *
 * 退出码：0 = 全部通过；1 = 有失败/连接不上应用。
 *
 * 说明：
 *   - 子进程用 stdio:'inherit'（本环境禁止用管道捕获 GUI 相关进程输出）。
 *   - 所有套件共用同一个截图/结果目录（ZILUX2_SHOTS_DIR），默认
 *     <仓库根>/research/shots/suite-YYYYMMDD/（由脚本位置反推仓库根，与 cwd 无关）。
 *   - 不重启应用实例：应用需事先用 --remote-debugging-port=9223 启动（见 README）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { REPO_ROOT, CDP_HTTP, dateStamp, findPageTarget, repoRel } from './lib/cdp.mjs';

const SUITE_DIR = path.join(REPO_ROOT, 'research', 'qa', 'suite');

/** 执行顺序：先冒烟（确认基座可用），再跑各功能套件；downloads 最慢放最后。 */
const SUITES = [
  { name: 'smoke', title: '冒烟：基座 + 主要页面' },
  { name: 'room-effects', title: '房间预设（粒子/流星 chips）' },
  { name: 'update-channel', title: '更新通道（设置页 + mock 服务）' },
  { name: 'local-watch', title: '本地目录监控（新增/删除自动刷新）' },
  { name: 'downloads', title: '下载队列（面板 + 真实下载）' },
];

function parseSelection(argv) {
  const positional = argv.slice(2).filter((arg) => !arg.startsWith('-'));
  const envOnly = (process.env.ZILUX2_ONLY || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const requested = positional.length > 0 ? positional : envOnly;
  if (requested.length === 0) return SUITES;
  const known = new Set(SUITES.map((item) => item.name));
  const unknown = requested.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    console.error(`未知套件：${unknown.join(', ')}；可用：${[...known].join(', ')}`);
    process.exit(2);
  }
  return SUITES.filter((item) => requested.includes(item.name));
}

function readResult(dir, name) {
  const file = path.join(dir, 'results', `${name}.json`);
  try {
    return { file, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    return { file, data: null, error: err.message };
  }
}

function printEvidenceLine(step) {
  const parts = [];
  if (step.evidence && step.evidence.shot) parts.push(`截图 ${step.evidence.shot}`);
  if (step.evidence && step.evidence.file) parts.push(`详情 ${step.evidence.file}`);
  return parts.join('；');
}

async function main() {
  const suites = parseSelection(process.argv);
  const shots = path.join(REPO_ROOT, 'research', 'shots', `suite-${dateStamp()}`);
  fs.mkdirSync(shots, { recursive: true });
  const env = { ...process.env, ZILUX2_SHOTS_DIR: shots };

  console.log('='.repeat(78));
  console.log('Zilux2 真机 QA 套件');
  console.log(`仓库根   : ${REPO_ROOT}`);
  console.log(`CDP      : ${CDP_HTTP}`);
  console.log(`截图/结果: ${repoRel(shots)}`);
  console.log(`套件     : ${suites.map((item) => item.name).join(' → ')}`);
  console.log('='.repeat(78));

  // 先确认应用可达，避免每个套件都各自等 30s。
  try {
    const target = await findPageTarget({ timeoutMs: 8000 });
    console.log(`应用已连接：${target.title} · ${target.url}\n`);
  } catch (err) {
    console.error(`连不上应用（${CDP_HTTP}）：${err.message}`);
    console.error('请先用 CDP 端口启动安装版 Zilux2（见 research/qa/suite/README.md「前置条件」），再跑本脚本。');
    process.exitCode = 1;
    return;
  }

  const rows = [];
  for (const suite of suites) {
    const script = path.join(SUITE_DIR, `${suite.name}.mjs`);
    if (!fs.existsSync(script)) {
      rows.push({ name: suite.name, title: suite.title, exitCode: null, missing: true, pass: 0, fail: 1, skip: 0, ms: 0, steps: [] });
      continue;
    }
    console.log(`\n${'─'.repeat(78)}\n▶ ${suite.name} · ${suite.title}\n${'─'.repeat(78)}`);
    const started = Date.now();
    const child = spawnSync(process.execPath, [script], {
      stdio: 'inherit',
      cwd: SUITE_DIR,
      env,
      timeout: 0,
    });
    const ms = Date.now() - started;
    const { file, data, error } = readResult(shots, suite.name);
    if (!data) {
      console.error(`\n[run-all] 套件 ${suite.name} 没有写出结果 JSON（${repoRel(file)}）：${error || '未知原因'}`);
    }
    rows.push({
      name: suite.name,
      title: suite.title,
      exitCode: child.status,
      signal: child.signal,
      resultFile: data ? repoRel(file) : null,
      pass: data ? data.pass : 0,
      fail: data ? data.fail : 1,
      skip: data ? data.skip : 0,
      ms,
      steps: data ? data.steps : [],
    });
  }

  // ---- 汇总表 ----
  const totals = rows.reduce(
    (acc, row) => {
      acc.pass += row.pass;
      acc.fail += row.fail;
      acc.skip += row.skip;
      acc.ms += row.ms;
      return acc;
    },
    { pass: 0, fail: 0, skip: 0, ms: 0 },
  );
  const width = Math.max(...rows.map((row) => row.name.length), 8);
  console.log(`\n${'='.repeat(78)}`);
  console.log('汇总');
  console.log('='.repeat(78));
  console.log(`${'套件'.padEnd(width + 2)} ${'PASS'.padStart(4)} ${'FAIL'.padStart(4)} ${'SKIP'.padStart(4)} ${'耗时'.padStart(8)}  退出码`);
  for (const row of rows) {
    console.log(
      `${row.name.padEnd(width + 2)} ${String(row.pass).padStart(4)} ${String(row.fail).padStart(4)} ${String(row.skip).padStart(4)} ${(`${(row.ms / 1000).toFixed(1)}s`).padStart(8)}  ${row.missing ? '脚本缺失' : row.exitCode}`,
    );
  }
  console.log(
    `${'合计'.padEnd(width + 2)} ${String(totals.pass).padStart(4)} ${String(totals.fail).padStart(4)} ${String(totals.skip).padStart(4)} ${(`${(totals.ms / 1000).toFixed(1)}s`).padStart(8)}`,
  );

  // ---- 失败明细 ----
  const failures = rows.flatMap((row) =>
    row.steps.filter((step) => step.status === 'FAIL').map((step) => ({ suite: row.name, step })),
  );
  if (failures.length > 0) {
    console.log(`\n失败明细（${failures.length}）`);
    for (const { suite, step } of failures) {
      console.log(`✗ [${suite}] ${step.name}`);
      console.log(`  ${String(step.detail || '').replace(/\n/g, '\n  ').slice(0, 1200)}`);
      const evidence = printEvidenceLine(step);
      if (evidence) console.log(`  证据：${evidence}`);
    }
  }

  // 截图/结果路径提示 + 错误目录自检（避免相对路径多一层 research/ 的旧 bug）
  console.log(`\n截图/证据/结果：${repoRel(shots)}`);
  for (const row of rows) {
    if (row.resultFile) console.log(`  ${row.name}: ${row.resultFile}`);
  }
  const stray = path.join(REPO_ROOT, 'research', 'research');
  if (fs.existsSync(stray)) {
    console.log(`\n[警告] 发现异常目录 ${repoRel(stray)}（截图路径 bug 的残留），请删除：rm -rf research/research`);
    process.exitCode = 1;
  }

  const ok = failures.length === 0 && rows.every((row) => !row.missing && row.exitCode === 0);
  console.log(`\n结论：${ok ? 'PASS 全绿' : 'FAIL（见上方失败明细）'}`);
  process.exitCode = ok ? 0 : 1;
}

await main();
