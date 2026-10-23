/**
 * 极简静态文件服务器（仅开发联调用）：把 web/dist 以 HTTP 提供给 Electron 页面。
 *
 * 为什么需要它：Electron 壳通过 http://127.0.0.1:<port>/index.html 加载页面（与 API 同源），
 * 真引擎还没构建出来时，用本文件先验证壳 / 桥 / 页面渲染。
 *
 * 用法：
 *   node mac/shell/dev/static-server.mjs --root web/dist [--port 0]
 *   SERVE_DIR=web/dist node mac/shell/dev/cdp-run.mjs ...
 *
 * 作为模块：
 *   import { startStaticServer } from './static-server.mjs';
 *   const { port, origin, close } = await startStaticServer({ root: 'E:/Zilux2开发/web/dist' });
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

export function contentTypeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/** 解析请求路径到 root 内真实文件；越界 / 不存在返回 null。 */
function resolveFile(root, requestPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath.split('?')[0]);
  } catch {
    return null;
  }
  const relative = decoded.replace(/^\/+/, '');
  const target = path.resolve(root, relative || 'index.html');
  const rootWithSep = path.resolve(root) + path.sep;
  if (target !== path.resolve(root, 'index.html') && !target.startsWith(rootWithSep)) return null;
  return target;
}

/**
 * 启动静态服务器。
 * @param {{ root: string, port?: number, host?: string, onRequest?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean }} options
 * @returns {Promise<{ server: http.Server, port: number, origin: string, close: () => Promise<void> }>}
 */
export function startStaticServer(options) {
  const root = path.resolve(options.root);
  const host = options.host || '127.0.0.1';
  const onRequest = options.onRequest;

  const server = http.createServer(async (req, res) => {
    try {
      if (onRequest && onRequest(req, res)) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
        res.end('method not allowed');
        return;
      }
      const urlPath = req.url || '/';
      let filePath = resolveFile(root, urlPath);
      if (filePath && !filePath.endsWith(path.sep) && !fs.existsSync(filePath)) filePath = null;
      if (!filePath) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end(`not found: ${urlPath}`);
        return;
      }
      const stat = await fsp.stat(filePath);
      if (stat.isDirectory()) {
        res.writeHead(302, { location: (urlPath.endsWith('/') ? urlPath : urlPath + '/') + 'index.html' });
        res.end();
        return;
      }
      const headers = {
        'content-type': contentTypeFor(filePath),
        'content-length': String(stat.size),
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      };
      res.writeHead(200, headers);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      fs.createReadStream(filePath)
        .on('error', () => res.destroy())
        .pipe(res);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`server error: ${error.message}`);
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        server,
        port,
        origin: `http://${host}:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// 命令行入口
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const argv = process.argv.slice(2);
  const readFlag = (name, fallback) => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  const root = path.resolve(readFlag('--root', 'web/dist'));
  const port = Number(readFlag('--port', '0'));
  startStaticServer({ root, port })
    .then(({ origin }) => {
      console.log(`STATIC_READY {"origin":"${origin}","root":${JSON.stringify(root)}}`);
    })
    .catch((error) => {
      console.error(`static server failed: ${error.message}`);
      process.exit(1);
    });
}
