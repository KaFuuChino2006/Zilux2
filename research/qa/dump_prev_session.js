// Decompress a DSH session transcript made of many concatenated zstd frames, then
// emit a readable transcript of user/assistant text messages.
const fs = require('fs');
const zlib = require('zlib');

const src = process.argv[2];
const outTxt = process.argv[3];
const startMsg = Number(process.argv[4] || 0);
const endMsg = Number(process.argv[5] || 100000);

const buf = fs.readFileSync(src);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const magicOffsets = [];
let from = 0;
for (;;) {
  const i = buf.indexOf(MAGIC, from);
  if (i < 0) break;
  magicOffsets.push(i);
  from = i + 4;
}
magicOffsets.push(buf.length);
const chunks = [];
for (let k = 0; k < magicOffsets.length - 1; k += 1) {
  const start = magicOffsets[k];
  let end = magicOffsets[k + 1];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      chunks.push(zlib.zstdDecompressSync(buf.subarray(start, end)));
      break;
    } catch (err) {
      const nextMagic = magicOffsets[k + 1 + attempt + 1];
      if (nextMagic === undefined) break;
      end = nextMagic;
    }
  }
}
const text = Buffer.concat(chunks).toString('utf8');
const lines = text.split('\n').filter((l) => l.trim().length > 0);
fs.writeFileSync('/tmp/session_full.jsonl', text);
console.log('lines:', lines.length);

function extractText(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  if (Array.isArray(payload)) return payload.map(extractText).filter(Boolean).join('\n');
  if (typeof payload === 'object') {
    if (typeof payload.text === 'string') return payload.text;
    if (payload.content !== undefined) return extractText(payload.content);
    if (payload.message !== undefined) return extractText(payload.message);
    if (payload.parts !== undefined) return extractText(payload.parts);
  }
  return '';
}

const entries = [];
for (const line of lines) {
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    continue;
  }
  const role = rec.role || rec.message?.role || rec.payload?.role || rec.type;
  const body = extractText(rec.content ?? rec.message?.content ?? rec.payload?.content ?? rec.payload ?? rec.message);
  if (!body) continue;
  if (!['user', 'assistant', 'system', 'tool'].includes(role)) continue;
  if (role === 'tool' || role === 'system') continue;
  entries.push({ role, body });
}
console.log('messages:', entries.length);
const slice = entries.slice(startMsg, endMsg);
const out = [];
out.push(`# transcript messages ${startMsg}..${Math.min(endMsg, entries.length)} of ${entries.length}`);
slice.forEach((e, i) => {
  const idx = startMsg + i;
  const body = e.body.length > 4000 ? `${e.body.slice(0, 4000)}\n…[truncated ${e.body.length - 4000} chars]` : e.body;
  out.push(`\n===== [${idx}] ${e.role} =====\n${body}`);
});
fs.writeFileSync(outTxt, out.join('\n'));
console.log('wrote', outTxt, fs.statSync(outTxt).size, 'bytes');
