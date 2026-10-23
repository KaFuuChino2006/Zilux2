# -*- coding: utf-8 -*-
"""把 hanzi-writer-data 的笔顺笔画数据裁剪成常用字表，并 gzip 成 web/public/strokes.json.gz。

用法：先解压 hanzi-writer-data tgz 到 /tmp/hwd/package，再运行本脚本。
运行时前端用 DecompressionStream('gzip') 解压后 JSON.parse。
"""
import gzip
import io
import json
import os

SOURCE_DIR = os.environ.get('HWD_DIR', '/tmp/hwd/package')
OUT = r'E:\Zilux2开发\web\public\strokes.json.gz'

chars = []
for hi in range(0xB0, 0xD8):
    for lo in range(0xA1, 0xFF):
        try:
            chars.append(bytes([hi, lo]).decode('gb2312'))
        except UnicodeDecodeError:
            continue

out = {}
for ch in chars:
    path = os.path.join(SOURCE_DIR, ch + '.json')
    if not os.path.exists(path):
        continue
    data = json.load(io.open(path, 'r', encoding='utf-8'))
    strokes = data.get('strokes') or []
    if strokes:
        out[ch] = strokes

raw = json.dumps(out, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with gzip.open(OUT, 'wb', compresslevel=9) as fh:
    fh.write(raw)
print('chars:', len(out), 'raw MB:', round(len(raw) / 1048576, 2), 'gz MB:', round(os.path.getsize(OUT) / 1048576, 2))
