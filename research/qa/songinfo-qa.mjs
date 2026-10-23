const EP = 'http://127.0.0.1:9223';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const report = {};

// 1) 发现 → QQ → 打开第一个 QQ 榜单 → 点曲目行歌手
await ev(`(async()=>{const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const rail=[...document.querySelectorAll('.rail-btn')].find(b=>b.textContent.includes('发现')); rail?.click(); await sleep(1800);
  const seg=[...document.querySelectorAll('.disc .seg .seg-btn')].find(b=>b.textContent.trim()==='QQ'); seg?.click(); await sleep(1800);
  const tile=document.querySelector('.disc .ui-tile'); tile?.click(); await sleep(2200);
  return {title:document.querySelector('.disc-hero-title')?.textContent??null, rows:document.querySelectorAll('.disc-track').length};})()`);
await shot('app-songinfo-1-qq-chart.png');
report.qqArtist = await ev(`(async()=>{const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const link=[...document.querySelectorAll('.disc .disc-link')].find(b=>b.closest('.disc-t-sub')&&b.textContent.trim());
  if(!link) return {err:'no artist link'};
  const name=link.textContent.trim(); link.click(); await sleep(2600);
  return {name, title:document.querySelector('.disc-hero-title')?.textContent??null, hot:document.querySelectorAll('.disc-track').length, tiles:document.querySelectorAll('.disc .ui-tile').length};})()`);
await shot('app-songinfo-2-qq-artist.png');

// 2) 回退到榜单，再退到发现根，切到网易云榜单详情，打开曲目「歌曲信息」
await ev(`(async()=>{const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  for(let i=0;i<2;i++){const back=document.querySelector('.disc-back'); if(!back)break; back.click(); await sleep(900);} return true;})()`);
report.songInfo = await ev(`(async()=>{const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const seg=[...document.querySelectorAll('.disc .seg .seg-btn')].find(b=>b.textContent.trim()==='网易云'); seg?.click(); await sleep(1600);
  const tile=document.querySelector('.disc .ui-tile'); tile?.click(); await sleep(2200);
  const info=document.querySelector('.disc-track .disc-info');
  if(!info) return {err:'no info button'};
  info.click(); await sleep(1600);
  const rows=[...document.querySelectorAll('.sinfo-row')].map(r=>[r.querySelector('.sinfo-label')?.textContent, r.querySelector('.sinfo-value')?.textContent]);
  return {sheetTitle:document.querySelector('.sheet-head-title')?.textContent??document.querySelector('.sheet-title')?.textContent??null, title:document.querySelector('.sinfo-title')?.textContent??null, artists:document.querySelector('.sinfo-artists')?.textContent??null, album:document.querySelector('.sinfo-album-line')?.textContent??null, rows};})()`);
await shot('app-songinfo-3-discover-sheet.png');
await ev(`(()=>{const c=document.querySelector('.sheet .icon-btn'); c?.click(); return true;})()`);
await sleep(500);

// 3) 墙面曲目行（最近播放）的歌曲信息按钮
report.wallInfo = await ev(`(async()=>{const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const rail=[...document.querySelectorAll('.rail-btn')].find(b=>b.textContent.includes('最近')); rail?.click(); await sleep(1800);
  const row=document.querySelector('.track-row'); const info=row?.querySelector('.track-info');
  if(!info) return {err:'no wall info button', rows:document.querySelectorAll('.track-row').length};
  info.click(); await sleep(1600);
  return {sheetTitle:document.querySelector('.sheet-head-title')?.textContent??null, title:document.querySelector('.sinfo-title')?.textContent??null, rows:[...document.querySelectorAll('.sinfo-row')].length};})()`);
await shot('app-songinfo-4-wall-sheet.png');
report.errors = errors;
console.log(JSON.stringify(report, null, 1));
ws.close();
