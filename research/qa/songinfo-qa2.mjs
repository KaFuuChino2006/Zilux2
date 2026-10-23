const EP = 'http://127.0.0.1:9223';
const list = await (await fetch(EP + '/json/list')).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails)); return r.result.value; };
const fs = await import('node:fs');
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync('research/shots/' + name, Buffer.from(r.data, 'base64')); };
const errors = [];
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description ?? 'exception'); });
await send('Runtime.enable');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const poll = async (expr, timeout = 12000) => {
  const at = Date.now();
  for (;;) {
    const v = await ev(expr);
    if (v) return v;
    if (Date.now() - at > timeout) return null;
    await sleep(250);
  }
};
const report = {};

// A) 墙面「最近播放」行的歌曲信息
await ev(`(()=>{[...document.querySelectorAll('.sheet .icon-btn')].forEach(b=>b.click());return true;})()`);
await sleep(400);
await ev(`(()=>{const r=[...document.querySelectorAll('.rail-btn')].find(b=>b.textContent.includes('最近')); r?.click(); return !!r;})()`);
report.wallRows = await poll(`(()=>{const n=document.querySelectorAll('.track-row').length; return n>0?n:0;})()`, 15000);
report.wallInfo = await ev(`(async()=>{const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const info=document.querySelector('.track-row .track-info');
  if(!info) return {err:'no info button'};
  info.click(); await sleep(1800);
  return {sheetTitle:document.querySelector('.sheet-head-title')?.textContent??null, title:document.querySelector('.sinfo-title')?.textContent??null,
    rows:[...document.querySelectorAll('.sinfo-row')].map(r=>[r.querySelector('.sinfo-label')?.textContent,r.querySelector('.sinfo-value')?.textContent]),
    source:document.querySelector('.sinfo-row .sinfo-value')?.textContent??null};})()`);
await shot('app-songinfo-5-wall-sheet.png');
await ev(`(()=>{document.querySelector('.sheet .icon-btn')?.click();return true;})()`);
await sleep(400);

// B) QQ 榜单曲目行的信息（带音质体积）
await ev(`(()=>{const r=[...document.querySelectorAll('.rail-btn')].find(b=>b.textContent.includes('发现')); r?.click(); return true;})()`);
await sleep(1600);
report.qqRows = await poll(`(()=>{const n=document.querySelectorAll('.disc-track').length; return n>0?n:0;})()`, 12000);
if (!report.qqRows) {
  // 可能停在详情页：回退到根再切 QQ
  await ev(`(async()=>{const sleep=(ms)=>new Promise(r=>setTimeout(r,ms)); for(let i=0;i<3;i++){const b=document.querySelector('.disc-back'); if(!b) break; b.click(); await sleep(800);} const seg=[...document.querySelectorAll('.disc .seg .seg-btn')].find(b=>b.textContent.trim()==='QQ'); seg?.click(); await sleep(1500); const tile=document.querySelector('.disc .ui-tile'); tile?.click(); await sleep(2000); return true;})()`);
  report.qqRows = await poll(`(()=>{const n=document.querySelectorAll('.disc-track').length; return n>0?n:0;})()`, 12000);
}
report.qqInfo = await ev(`(async()=>{const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const info=document.querySelector('.disc-track .disc-info');
  if(!info) return {err:'no info button'};
  info.click(); await sleep(2000);
  return {sheetTitle:document.querySelector('.sheet-head-title')?.textContent??null, title:document.querySelector('.sinfo-title')?.textContent??null,
    artists:document.querySelector('.sinfo-artists')?.textContent??null, album:document.querySelector('.sinfo-album-line')?.textContent??null,
    quality:[...document.querySelectorAll('.sinfo-quality-chip')].map(c=>c.textContent),
    rows:[...document.querySelectorAll('.sinfo-row')].map(r=>[r.querySelector('.sinfo-label')?.textContent,r.querySelector('.sinfo-value')?.textContent])};})()`);
await shot('app-songinfo-6-qq-sheet.png');
report.errors = errors;
console.log(JSON.stringify(report, null, 1));
ws.close();
