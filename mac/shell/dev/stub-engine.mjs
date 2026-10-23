/**
 * 桩引擎（仅开发联调）：验证 Electron 壳的「spawn 引擎 → 解析 ZILUX2_READY → 推 online 事件 → 页面同源加载」链路。
 *
 * 真引擎（mac/engine 里的 .NET 服务）构建出来之前，用这个脚本代替：
 *   ZILUX2_ENGINE=E:/Zilux2开发/mac/shell/dev/stub-engine.mjs \
 *   ZILUX2_WEB_ROOT=E:/Zilux2开发/web/dist \
 *   mac/build/win-test/electron.exe
 * 主进程检测到引擎路径是 .mjs/.js 时，会用 Electron 的 node 模式（ELECTRON_RUN_AS_NODE=1）跑它。
 *
 * 契约与真引擎一致：
 *   - 参数 --web-root <dir>：web 静态资源根目录；
 *   - 监听 127.0.0.1:<随机端口>，同端口提供 /api/* 与静态页面；
 *   - stdout 打印一行 `ZILUX2_READY {"port":<port>,"token":"<hex>","sources":[...]}`。
 *
 * API 返回的是形状合法、内容固定的测试数据（不联网），足够跑通首页 / 播放 / 歌词 / 房间效果。
 */

import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { startStaticServer } from './static-server.mjs';

const argv = process.argv.slice(2);
const readFlag = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const webRoot = path.resolve(readFlag('--web-root', process.env.ZILUX2_WEB_ROOT || 'web/dist'));
const token = crypto.randomBytes(16).toString('hex');

const COVER = (title, from, to) =>
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="300" height="300" fill="url(#g)"/><text x="150" y="168" font-size="34" font-family="sans-serif" fill="#f3f1ea" text-anchor="middle" opacity="0.82">${title}</text></svg>`,
  );

const TRACKS = [
  { source: 'netease', id: 'stub-ne-1', title: '测试音轨 · 薄荷', artist: 'Zilux2 Stub', album: '壳联调', durationMs: 32000, cover: COVER('薄荷', '#2f6f5e', '#9fe3c8'), playable: true },
  { source: 'netease', id: 'stub-ne-2', title: '测试音轨 · 夜航', artist: 'Zilux2 Stub', album: '壳联调', durationMs: 32000, cover: COVER('夜航', '#1c2a4a', '#6f9be0'), playable: true },
  { source: 'qq', id: 'stub-qq-1', title: '测试音轨 · 潮汐', artist: 'Zilux2 Stub', album: '壳联调', durationMs: 32000, cover: COVER('潮汐', '#3d2a4a', '#c8a0e8'), playable: true },
];

const SOURCES = [
  {
    id: 'netease',
    label: '网易云音乐',
    short: '网',
    accent: '#ff5a5f',
    loginMode: 'code',
    loginHint: '在网易云 App 扫码后确认登录',
    feedKinds: ['recent', 'daily'],
    supportsWordLyrics: true,
    supportsLikedWrite: true,
    hasDaily30: false,
    qualities: [
      { id: 'standard', label: '标准', detail: '128 kbps · MP3' },
      { id: 'high', label: '极高', detail: '320 kbps · MP3' },
      { id: 'lossless', label: '无损', detail: 'FLAC · 需会员' },
    ],
  },
  {
    id: 'qq',
    label: 'QQ 音乐',
    short: 'Q',
    accent: '#31c27c',
    loginMode: 'image',
    loginHint: '打开手机 QQ 扫一扫，用 QQ 账号登录',
    feedKinds: ['recent', 'daily'],
    supportsWordLyrics: true,
    supportsLikedWrite: true,
    hasDaily30: true,
    qualities: [
      { id: 'standard', label: '标准', detail: '128 kbps · MP3' },
      { id: 'high', label: '高', detail: '320 kbps · MP3' },
      { id: 'lossless', label: '无损', detail: 'FLAC · 需会员' },
    ],
  },
  {
    id: 'kugou',
    label: '酷狗音乐',
    short: '酷',
    accent: '#2fb0ff',
    loginMode: 'image',
    loginHint: '仅用于歌词搜索',
    feedKinds: [],
    supportsWordLyrics: true,
    supportsLikedWrite: false,
    hasDaily30: false,
    qualities: [],
    hidden: true,
  },
];

const PLAYLISTS = [
  { source: 'netease', id: 'stub-list-ne', title: '壳联调 · 网易云歌单', cover: COVER('歌单', '#2f6f5e', '#9fe3c8'), count: 3, creator: 'Zilux2 Stub' },
  { source: 'qq', id: 'stub-list-qq', title: '壳联调 · QQ 歌单', cover: COVER('歌单', '#1c3a2a', '#6fe0a8'), count: 3, creator: 'Zilux2 Stub' },
];

const HOST_COVER_COLORS = {
  dominant: '#2f6f5e',
  palette: ['#2f6f5e', '#9fe3c8', '#d9c08d', '#1c2a4a'],
};

/** 32 秒和弦 WAV：让 <audio> 真的能出声、进度真的会走（与页面 ?mock=1 的演示音频同思路）。 */
let wavCache = null;
function wavBuffer() {
  if (wavCache) return wavCache;
  const sampleRate = 8000;
  const seconds = 32;
  const total = sampleRate * seconds;
  const bytes = Buffer.alloc(44 + total * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(36 + total * 2, 4);
  bytes.write('WAVE', 8);
  bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(total * 2, 40);
  const chords = [
    [220.0, 277.18, 329.63],
    [196.0, 246.94, 293.66],
    [174.61, 220.0, 261.63],
  ];
  for (let i = 0; i < total; i += 1) {
    const t = i / sampleRate;
    const chord = chords[Math.floor(t / 4) % chords.length];
    const fade = Math.min(1, t / 0.8) * Math.min(1, (seconds - t) / 0.8);
    const beat = Math.max(0, Math.sin(t * Math.PI * 2)) ** 24 * 0.18;
    const sample =
      (Math.sin(2 * Math.PI * chord[0] * t) * 0.12 +
        Math.sin(2 * Math.PI * chord[1] * t) * 0.09 +
        Math.sin(2 * Math.PI * chord[2] * t) * 0.07) *
        fade +
      beat;
    bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 0x7fff), 44 + i * 2);
  }
  wavCache = bytes;
  return bytes;
}

function lyricFor(track) {
  const rows = [];
  for (let t = 0, i = 0; t + 2 < 32; t += 4, i += 1) {
    const mm = String(Math.floor(t / 60)).padStart(2, '0');
    const ss = String(Math.floor(t % 60)).padStart(2, '0');
    rows.push(`[${mm}:${ss}.00]${track.title} · 第 ${i + 1} 句（桩引擎测试歌词）`);
  }
  return rows.join('\n');
}

const json = (res, body, status = 200) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(text);
};

function handleApi(req, res, pathname, query) {
  if (pathname === '/api/health') return json(res, { ok: true, engine: 'stub', tokenLen: token.length });
  if (pathname === '/api/sources') return json(res, { sources: SOURCES });
  if (pathname === '/api/account') return json(res, { sources: [] });
  if (pathname === '/api/library/overview') {
    return json(res, {
      sources: [
        { source: 'netease', loggedIn: false, liked: null, playlists: [] },
        { source: 'qq', loggedIn: false, liked: null, playlists: [] },
      ],
    });
  }
  if (pathname === '/api/library/recent/merged') return json(res, { tracks: TRACKS });
  if (pathname === '/api/library/recent') return json(res, { ok: true });
  if (pathname === '/api/library/feed') {
    return json(res, { source: query.get('source') || 'netease', kind: query.get('kind') || 'recent', tracks: TRACKS });
  }
  if (pathname === '/api/library/playlist') {
    const source = query.get('source') || 'netease';
    return json(res, {
      source,
      id: query.get('id') || 'stub-list',
      title: '壳联调歌单',
      cover: PLAYLISTS[0].cover,
      count: TRACKS.length,
      tracks: TRACKS,
      hasMore: false,
    });
  }
  if (pathname === '/api/library/liked') return json(res, { liked: {}, ok: true });
  if (pathname === '/api/library/refresh') return json(res, { ok: true });
  if (pathname === '/api/playlists/hot') {
    const source = query.get('source') || 'qq';
    return json(res, { source, playlists: PLAYLISTS });
  }
  if (pathname === '/api/search') {
    const keyword = (query.get('q') || '').trim();
    const source = query.get('source') || 'netease';
    const tracks = TRACKS.filter((track) => track.source === source).filter(
      (track) => !keyword || track.title.includes(keyword) || track.artist.includes(keyword),
    );
    return json(res, { source, query: keyword, tracks, tookMs: 1 });
  }
  if (pathname === '/api/lyric') {
    const track = TRACKS.find((item) => item.id === query.get('id')) || TRACKS[0];
    return json(res, {
      source: track.source,
      id: track.id,
      lrc: lyricFor(track),
      translation: null,
      hasTranslation: false,
      yrc: null,
      hasYrc: false,
      qrc: null,
      hasQrc: false,
    });
  }
  if (pathname === '/api/stream/info') {
    return json(res, {
      source: query.get('source') || 'netease',
      id: query.get('id') || 'stub-ne-1',
      requested: query.get('quality') || 'high',
      quality: 'high',
      bitrate: 320,
      format: 'wav',
    });
  }
  if (pathname === '/api/cover/colors') return json(res, HOST_COVER_COLORS);
  if (pathname === '/api/account/login/qr') return json(res, { key: 'stub-key', image: null, error: 'stub engine: 不支持登录' }, 200);
  if (pathname === '/api/account/login/status') return json(res, { state: 'expired', error: null });
  if (pathname === '/api/account/logout') return json(res, { ok: true });
  return json(res, { error: 'stub engine: not implemented', path: pathname }, 404);
}

function handleStream(req, res) {
  const buffer = wavBuffer();
  const range = req.headers.range;
  const headers = {
    'content-type': 'audio/wav',
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  };
  if (typeof range === 'string') {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), buffer.length - 1) : buffer.length - 1;
      if (start <= end) {
        res.writeHead(206, {
          ...headers,
          'content-range': `bytes ${start}-${end}/${buffer.length}`,
          'content-length': String(end - start + 1),
        });
        res.end(buffer.subarray(start, end + 1));
        return;
      }
    }
  }
  res.writeHead(200, { ...headers, 'content-length': String(buffer.length) });
  res.end(buffer);
}

const staticServer = await startStaticServer({
  root: webRoot,
  host: '127.0.0.1',
  onRequest: (req, res) => {
    const origin = `http://${req.headers.host || '127.0.0.1'}`;
    const url = new URL(req.url || '/', origin);
    if (!url.pathname.startsWith('/api/')) return false;
    if (url.pathname === '/api/stream') {
      handleStream(req, res);
      return true;
    }
    handleApi(req, res, url.pathname, url.searchParams);
    return true;
  },
});

console.log(
  `ZILUX2_READY ${JSON.stringify({
    port: staticServer.port,
    token,
    sources: SOURCES.map((item) => item.id),
    webRoot,
    engine: 'stub',
  })}`,
);
console.error(`[stub-engine] serving ${webRoot} at ${staticServer.origin} (token ${token.slice(0, 8)}…)`);

const shutdown = () => {
  staticServer.close().finally(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
