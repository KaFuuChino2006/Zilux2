const EP = 'http://127.0.0.1:9223';
const list = await (await fetch(EP + '/json/list')).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails)); return r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = await import('node:fs');
const shot = async (n) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync('research/shots/' + n, Buffer.from(r.data, 'base64')); };
const poll = async (expr, timeout = 15000) => { const at = Date.now(); for (;;) { const v = await ev(expr); if (v) return v; if (Date.now() - at > timeout) return null; await sleep(300); } };
const closeSheets = async () => { for (let i = 0; i < 3; i++) { await ev(`(()=>{document.querySelector('.sheet .icon-btn')?.click();return true;})()`); await sleep(320); } };
const report = {};

// A) QQ 歌手页
await closeSheets();
await ev(`(()=>{const r=[...document.querySelectorAll('.rail-btn')].find(b=>b.textContent.includes('发现')); r?.click(); return true;})()`);
await poll(`(()=>{const n=[...document.querySelectorAll('.disc .ui-tile')].length; return n>0?n:0;})()`, 12000);
await ev(`(async()=>{const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  for(let i=0;i<3;i++){const b=document.querySelector('.disc-back'); if(!b) break; b.click(); await sleep(700);}
  const seg=[...document.querySelectorAll('.disc .seg .seg-btn')].find(b=>b.textContent.trim()==='QQ'); seg?.click(); await sleep(1800);
  const tile=document.querySelector('.disc .ui-tile'); tile?.click(); await sleep(2000); return true;})()`);
await poll(`(()=>{const n=document.querySelectorAll('.disc-track').length; return n>0?n:0;})()`, 12000);
report.qqArtist = await ev(`(async()=>{const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const link=document.querySelector('.disc .disc-t-sub .disc-link'); if(!link) return {err:'no artist link'};
  link.click(); await sleep(2600);
  const row=document.querySelector('.disc-track');
  return {hero:document.querySelector('.disc-hero-title')?.textContent??null, hot:document.querySelectorAll('.disc-track').length,
    tiles:document.querySelectorAll('.disc .ui-tile').length,
    rowButtons:row?row.querySelectorAll('.disc-row-btn').length:0,
    infoInRow:!!row?.querySelector('.disc-info'), cmtInRow:!!row?.querySelector('.disc-cmt'),
    firstRowTop: row?Math.round(row.getBoundingClientRect().top):null,
    btnTops: row?[...row.querySelectorAll('.disc-row-btn')].map(b=>Math.round(b.getBoundingClientRect().top)):[]};})()`);
await shot('app-songinfo-9-qq-artist-final.png');

// B) 该歌手热门歌曲的歌曲信息（QQ 音质）
report.qqSongInfo = await ev(`(async()=>{const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const info=document.querySelector('.disc-track .disc-info'); if(!info) return {err:'no info btn'};
  info.click(); await sleep(2200);
  return {head:document.querySelector('.sheet-head-title')?.textContent??null, title:document.querySelector('.sinfo-title')?.textContent??null,
    album:document.querySelector('.sinfo-album-line')?.textContent??null,
    quality:[...document.querySelectorAll('.sinfo-quality-chip')].map(c=>c.textContent),
    rows:[...document.querySelectorAll('.sinfo-row')].map(r=>[r.querySelector('.sinfo-label')?.textContent,r.querySelector('.sinfo-value')?.textContent])};})()`);
await shot('app-songinfo-10-qq-song-sheet-final.png');
report.errors = [];
console.log(JSON.stringify(report, null, 1));
ws.close();
