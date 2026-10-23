/**
 * 发现页真机 QA（CDP 9223）
 *
 * 用法：node research/qa/discover-app-qa.mjs [--shots research/shots] [--json research/tmp/discover-app-qa.json]
 *
 * 流程：连 app 的 WebView2 → 点 rail「发现」→ 逐 tab 截图/收集 DOM 计数
 * → 进榜单详情、评论、歌手页、专辑页 → 切来源（QQ）→ 汇总 console/exception。
 */
import fs from 'node:fs';
import path from 'node:path';

const ENDPOINT = process.env.DISCOVER_QA_ENDPOINT || 'http://127.0.0.1:9223';
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const SHOTS = argOf('--shots', 'research/shots');
const JSON_OUT = argOf('--json', 'research/tmp/discover-app-qa.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });

const list = await (await fetch(`${ENDPOINT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) throw new Error('找不到 WebView2 page target');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let id = 0;
const pending = new Map();
const errors = [];
const logs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params));
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    logs.push(m.params.args?.map((a) => a.value ?? a.description ?? '').join(' '));
  }
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails)}`);
  return r.result.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(SHOTS, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
};
const visible = async (selector) =>
  ev(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}); if(!el) return null; const r=el.getBoundingClientRect(); return {w:Math.round(r.width),h:Math.round(r.height),top:Math.round(r.top)};})()`);

await send('Runtime.enable');
await send('Page.enable');

const report = { steps: [], errors, logs, shots: [] };

const clickRail = async (label) => {
  const ok = await ev(`(()=>{const b=[...document.querySelectorAll('.rail-btn')].find(x=>x.textContent.trim()===${JSON.stringify(label)}); if(!b) return false; b.click(); return true;})()`);
  if (!ok) throw new Error(`rail 按钮未找到：${label}`);
};
const clickByText = async (selector, text) =>
  ev(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(x=>x.textContent.trim()===${JSON.stringify(text)}); if(!el) return false; el.click(); return true;})()`);
const waitFor = async (selector, timeout = 8000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await ev(`!!document.querySelector(${JSON.stringify(selector)})`)) return true;
    await sleep(160);
  }
  return false;
};

// 1) 打开发现页
await clickRail('发现');
const tabsReady = await waitFor('.disc-tabs');
report.steps.push({ step: 'open-discover', tabsReady, wallTitle: await ev(`document.querySelector('.wall-title')?.textContent?.trim() ?? null`) });
await sleep(1400);
report.shots.push(await shot('app-disc-1-charts'));

const counts = {};
for (const tab of ['歌单广场', '私人漫游', '播客', '收藏', '排行榜']) {
  const ok = await clickByText('.disc-tab', tab);
  await sleep(1600);
  const key = tab.replace(/[^\u4e00-\u9fa5]/g, '');
  counts[key] = await ev(`(()=>({tiles:document.querySelectorAll('.disc .ui-tile').length, rows:document.querySelectorAll('.disc .disc-track').length, cards:document.querySelectorAll('.disc .disc-playlist').length, empty:document.querySelectorAll('.disc-empty').length, title:document.querySelector('.wall-title')?.textContent?.trim()??null}))()`);
  report.steps.push({ step: `tab-${tab}`, ok, ...counts[key] });
  report.shots.push(await shot(`app-disc-2-tab-${['charts','playlists','radio','podcasts','collections'][['歌单广场','私人漫游','播客','收藏','排行榜'].indexOf(tab)]}`));
}

// 2) 榜单详情
await clickByText('.disc-tab', '排行榜');
await sleep(1500);
const tileClicked = await ev(`(()=>{const b=document.querySelector('.disc .ui-tile'); if(!b) return false; b.click(); return true;})()`);
await sleep(1800);
report.steps.push({ step: 'chart-detail', tileClicked, rows: await ev(`document.querySelectorAll('.disc .disc-track').length`), crumb: await ev(`document.querySelector('.disc-crumb')?.textContent?.trim() ?? null`) });
report.shots.push(await shot('app-disc-3-chart-detail'));

// 3) 评论 Sheet
const cmtClicked = await ev(`(()=>{const b=document.querySelector('.disc .disc-cmt'); if(!b) return false; b.click(); return true;})()`);
await sleep(1800);
report.steps.push({ step: 'comments', cmtClicked, sheet: await visible('.disc-comments'), count: await ev(`document.querySelectorAll('.disc-comment').length`) });
report.shots.push(await shot('app-disc-4-comments'));
await ev(`(()=>{const c=document.querySelector('.sheet .sheet-close, .sheet-close'); if(c) c.click(); return !!c;})()`);
await sleep(700);

// 4) 歌手 / 专辑（榜单详情里点歌手名）
const artistClicked = await ev(`(()=>{const b=document.querySelector('.disc-track .disc-link'); if(!b) return false; b.click(); return true;})()`);
await sleep(1800);
report.steps.push({ step: 'artist-page', artistClicked, title: await ev(`document.querySelector('.wall-title')?.textContent?.trim() ?? null`), hot: await ev(`document.querySelectorAll('.disc .disc-track').length`) });
report.shots.push(await shot('app-disc-5-artist'));
const albumClicked = await ev(`(()=>{const b=document.querySelector('.disc .ui-tile'); if(!b) return false; b.click(); return true;})()`);
await sleep(1600);
report.steps.push({ step: 'album-page', albumClicked, title: await ev(`document.querySelector('.wall-title')?.textContent?.trim() ?? null`), rows: await ev(`document.querySelectorAll('.disc .disc-track').length`) });
report.shots.push(await shot('app-disc-6-album'));
// 返回两次
for (let i = 0; i < 2; i += 1) {
  await ev(`(()=>{const b=document.querySelector('.disc-back, .disc-crumb button'); if(b){b.click();return true;} return false;})()`);
  await sleep(900);
}

// 5) 来源切换 QQ
await clickByText('.disc-tab', '排行榜');
await sleep(1200);
const qqPicked = await ev(`(()=>{const segs=[...document.querySelectorAll('.disc .seg')]; for(const s of segs){const b=[...s.querySelectorAll('.seg-btn')].find(x=>x.textContent.trim()==='QQ'); if(b){b.click(); return true;}} return false;})()`);
await sleep(1800);
report.steps.push({ step: 'source-qq', qqPicked, groups: await ev(`[...document.querySelectorAll('.disc .disc-src-label')].map(e=>e.textContent.trim())`) });
report.shots.push(await shot('app-disc-7-source-qq'));

// 6) 播放一行（榜单详情第一行点击）
const playClicked = await ev(`(()=>{const row=document.querySelector('.disc .disc-track .disc-row-main, .disc .disc-track'); if(!row) return false; row.click(); return true;})()`);
await sleep(1600);
report.steps.push({ step: 'play-row', playClicked, playing: await ev(`(()=>{const m=document.querySelector('.pb-btn.is-main'); return m?m.querySelectorAll('rect').length:null;})()`) });
report.shots.push(await shot('app-disc-8-playing'));

// 7) 回首页再进发现（导航稳定性）
await clickRail('首页');
await sleep(1200);
await clickRail('发现');
await sleep(1500);
report.steps.push({ step: 'reenter', tabs: await ev(`document.querySelectorAll('.disc-tab').length`), tiles: await ev(`document.querySelectorAll('.disc .ui-tile').length`) });
report.shots.push(await shot('app-disc-9-reenter'));

report.errors = errors;
report.logs = logs;
fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ steps: report.steps, errorCount: errors.length, logCount: logs.length, shots: report.shots.length, json: JSON_OUT }, null, 2));
ws.close();
