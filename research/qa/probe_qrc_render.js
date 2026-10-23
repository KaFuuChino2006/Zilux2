const https = require('https');

const body = JSON.stringify({
  comm: { ct: 11, cv: '1003006', v: '1003006', uin: '0' },
  req: {
    module: 'music.musichallSong.PlayLyricInfo',
    method: 'GetPlayLyricInfo',
    param: { songMID: process.argv[2] || '002amEvo2Zqvsy', format: 'qrc', qrc: 1 },
  },
});

function post() {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: 'u.y.qq.com',
        path: '/cgi-bin/musicu.fcg',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Referer: 'https://y.qq.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  const { decryptQrc } = await import('file:///E:/Zilux2开发/web/node_modules/qrc-decoder/dist/qrc_codec.mjs');
  const raw = await post();
  const json = JSON.parse(raw);
  const data = json?.req?.data ?? {};
  const hex = data.lyric || '';
  console.log('hexLen', hex.length, 'qrc', data.qrc, 'crypt', data.crypt);
  try {
    const decrypted = decryptQrc(hex);
    console.log('decryptedLen', decrypted.length);
    const m = /LyricContent="([\s\S]*?)"\s*\/?>/.exec(decrypted);
    const payload = (m ? m[1] : decrypted).replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#10;/g, '\n').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const lines = payload.split(/\r?\n/).filter(Boolean);
    console.log('lines', lines.length);
    console.log(lines.slice(0, 3).join('\n'));
  } catch (err) {
    console.error('DECRYPT FAILED:', err && err.message);
    console.error(String(raw).slice(0, 300));
  }
})();
