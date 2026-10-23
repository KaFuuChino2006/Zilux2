/**
 * 发现页真机 QA 第二轮：歌手/专辑/评论关闭/QQ 来源/播放
 * node research/qa/discover-app-qa2.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ENDPOINT = 'http://127.0.0.1:9223';
const SHOTS = 'research/shots';
const JSON_OUT = 'research/tmp/discover-app-qa2.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });

const list = await (await fetch(`${ENDPOINT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
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
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description ?? '');
  else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push(m.params.args?.map((a) => a.value ?? a.description ?? '').join(' '));
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)));
  return r.result.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'));
  return name;
};
const clickText = (sel, text) =>
  ev(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(sel)})].find(x=>x.textContent.trim()===${JSON.stringify(text)}); if(!el) return false; el.click(); return true;})()`);
const clickFirst = (sel) => ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return false; el.click(); return true;})()`);
const state = () => ev(`(()=>({crumb:document.querySelector('.disc-back')?.textContent?.trim()??null, hero:document.querySelector('.disc-hero-name, .disc-detail .wall-title')?.textContent?.trim()??document.querySelector('.wall-title')?.textContent?.trim()??null, tiles:document.querySelectorAll('.disc .ui-tile').length, rows:document.querySelectorAll('.disc .disc-track').length, tabs:document.querySelectorAll('.disc-tab').length, segs:[...document.querySelectorAll('.disc .seg')].map(s=>s.textContent.trim())}))()`);

await send('Runtime.enable');
await send('Page.enable');
const report = { steps: [], shots: [], errors, logs };

const backToRoot = async () => {
  for (let i = 0; i < 4; i += 1) {
    const clicked = await clickFirst('.disc-back');
    if (!clicked) break;
    await sleep(900);
  }
  await sleep(400);
};

// rail 发现
await ev(`(()=>{const b=[...document.querySelectorAll('.rail-btn')].find(x=>x.textContent.trim()==='发现'); if(b) b.click(); return !!b;})()`);
await sleep(1500);
await clickText('.disc-tab', '排行榜');
await sleep(1800);
report.steps.push({ step: 'charts-root', ...(await state()) });

// 进榜单 → 歌手
await clickFirst('.disc .ui-tile');
await sleep(1800);
report.shots.push(await shot('app-disc2-1-chart'));
const artistHit = await ev(`(()=>{const a=document.querySelector('.disc-track .disc-link'); if(!a) return false; a.click(); return true;})()`);
await sleep(2200);
const artistState = await state();
report.steps.push({ step: 'artist', artistHit, ...artistState });
report.shots.push(await shot('app-disc2-2-artist'));

// 歌手页 → 专辑
const albumHit = await ev(`(()=>{const b=[...document.querySelectorAll('.disc .ui-tile')].find(x=>{const t=x.textContent||''; return true;}); if(!b) return false; b.click(); return true;})()`);
await sleep(2000);
report.steps.push({ step: 'album', albumHit, ...(await state()) });
report.shots.push(await shot('app-disc2-3-album'));

// 专辑页评论
const cmt = await ev(`(()=>{const b=document.querySelector('.disc-cmt'); if(!b) return false; b.click(); return true;})()`);
await sleep(1800);
report.steps.push({ step: 'comments-open', cmt, sheet: await ev(`!!document.querySelector('.sheet')`) });
report.shots.push(await shot('app-disc2-4-comments'));
const closed = await ev(`(()=>{const b=document.querySelector('.sheet .icon-btn'); if(!b) return false; b.click(); return true;})()`);
await sleep(700);
report.steps.push({ step: 'comments-close', closed, sheetLeft: await ev(`!!document.querySelector('.sheet')`) });

// 回到根 → 切换 QQ 来源
await backToRoot();
const qqHit = await ev(`(()=>{const seg=[...document.querySelectorAll('.disc .seg')].find(s=>s.textContent.includes('QQ')); if(!seg) return false; const b=[...seg.querySelectorAll('.seg-btn')].find(x=>x.textContent.trim()==='QQ'); if(!b) return false; b.click(); return true;})()`);
await sleep(2000);
report.steps.push({ step: 'source-qq', qqHit, ...(await state()) });
report.shots.push(await shot('app-disc2-5-qq-charts'));

// QQ 榜单详情
await clickFirst('.disc .ui-tile');
await sleep(1800);
report.steps.push({ step: 'qq-chart-detail', ...(await state()) });
report.shots.push(await shot('app-disc2-6-qq-chart'));

// QQ 歌单广场
await backToRoot();
await ev(`(()=>{const seg=[...document.querySelectorAll('.disc .seg')].find(s=>s.textContent.includes('QQ')); if(seg){const b=[...seg.querySelectorAll('.seg-btn')].find(x=>x.textContent.trim()==='QQ'); if(b) b.click();} return true;})()`);
await sleep(500);
await clickText('.disc-tab', '歌单广场');
await sleep(2200);
report.steps.push({ step: 'qq-playlists', ...(await state()) });
report.shots.push(await shot('app-disc2-7-qq-playlists'));

// 播放一行
const playHit = await ev(`(()=>{const row=document.querySelector('.disc-track'); if(!row) return false; row.click(); return true;})()`);
await sleep(1800);
report.steps.push({ step: 'play', playHit, mainIcon: await ev(`(()=>{const m=document.querySelector('.pb-btn.is-main'); if(!m) return null; return m.querySelectorAll('rect').length;})()`) });

report.errors = errors;
report.logs = logs;
fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ steps: report.steps, shots: report.shots, errorCount: errors.length, logCount: logs.length }, null, 2));
ws.close();
