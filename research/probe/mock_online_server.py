"""本机联调用的假在线音乐服务：严格按 docs/zilux2-online-music.md 的响应形状返回。

用途：不启动 WPF 宿主时，用 ?onlinePort&onlineToken 参数直连验证前端链路
（搜索面板、歌词面板、音频流、封面代理）。
用法：python mock_online_server.py <port>
"""

from __future__ import annotations

import base64
import json
import math
import struct
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)

SAMPLE_RATE = 8000
DURATION = 24


def make_wav() -> bytes:
    total = SAMPLE_RATE * DURATION
    data = bytearray()
    for i in range(total):
        t = i / SAMPLE_RATE
        sample = (
            math.sin(2 * math.pi * 220 * t) * 0.16
            + math.sin(2 * math.pi * 277.18 * t) * 0.1
            + math.sin(2 * math.pi * 329.63 * t) * 0.08
        ) * min(1.0, t / 0.6) * min(1.0, (DURATION - t) / 0.6)
        data += struct.pack("<h", int(max(-1.0, min(1.0, sample)) * 0x7FFF))
    header = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt "
    header += struct.pack("<IHHIIHH", 16, 1, 1, SAMPLE_RATE, SAMPLE_RATE * 2, 2, 16)
    header += b"data" + struct.pack("<I", len(data))
    return header + bytes(data)


WAV = make_wav()

TRACKS = {
    "netease": [
        ("710001", "夜航星", "林一", "夜航星", 214000, True),
        ("710002", "雨落之前", "苏晚", "雨落之前", 198000, True),
        ("710003", "回声走廊", "陈默", "回声走廊", 236000, False),
    ],
    "qq": [
        ("720001", "银河慢车", "顾星河", "银河慢车", 262000, True),
        ("720002", "潮汐之间", "蔡雨桐", "潮汐之间", 245000, True),
        ("720003", "纸月", "徐念", "纸月", 188000, False),
    ],
}

LRC = """[00:00.00]夜航星
[00:04.20]穿过没有灯的云层
[00:09.60]把整条银河叠进背包
[00:15.00]我们在舷窗上写名字
[00:20.40]像写给未来的信
[00:25.80]如果航线会忘记我
[00:31.20]就让风替我记住
"""


def track_json(source: str, port: int, row) -> dict:
    tid, title, artist, album, duration, playable = row
    return {
        "source": source,
        "id": tid,
        "title": title,
        "artist": artist,
        "album": album,
        "durationMs": duration,
        "cover": f"http://127.0.0.1:{port}/api/cover?source={source}&id={tid}",
        "playable": playable,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "MockOnline/1.0"

    def log_message(self, fmt, *args):  # noqa: D102
        sys.stderr.write("[mock-online] " + fmt % args + "\n")

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        port = self.server.server_address[1]
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        path = parsed.path

        if path == "/api/health":
            self._json(200, {"ok": True, "sources": ["netease", "qq"]})
            return

        if path == "/api/search":
            source = (query.get("source") or ["netease"])[0]
            keyword = (query.get("q") or [""])[0].strip()
            rows = TRACKS.get(source, [])
            if keyword:
                rows = [r for r in rows if keyword in r[1] or keyword in r[2] or keyword in r[3]]
            self._json(
                200,
                {
                    "source": source,
                    "query": keyword,
                    "tracks": [track_json(source, port, row) for row in rows],
                    "tookMs": 12,
                },
            )
            return

        if path == "/api/lyric":
            source = (query.get("source") or ["netease"])[0]
            tid = (query.get("id") or [""])[0]
            self._json(
                200,
                {
                    "source": source,
                    "id": tid,
                    "lrc": LRC,
                    "translation": "[00:04.20]Cross the clouds without a light\n[00:09.60]Fold the galaxy into my bag\n",
                    "hasTranslation": True,
                },
            )
            return

        if path == "/api/cover":
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(PNG_1PX)))
            self.end_headers()
            self.wfile.write(PNG_1PX)
            return

        if path == "/api/stream":
            total = len(WAV)
            range_header = self.headers.get("Range", "")
            if range_header.startswith("bytes="):
                try:
                    start_s, end_s = range_header[6:].split("-", 1)
                    start = int(start_s or 0)
                    end = int(end_s) if end_s else total - 1
                except ValueError:
                    start, end = 0, total - 1
                end = min(end, total - 1)
                chunk = WAV[start : end + 1]
                self.send_response(206)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
                self.send_header("Content-Length", str(len(chunk)))
                self.end_headers()
                self.wfile.write(chunk)
                return
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(total))
            self.end_headers()
            self.wfile.write(WAV)
            return

        self._json(404, {"error": "not-found", "message": "unknown path"})


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5199
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"mock online server on http://127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
