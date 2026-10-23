# -*- coding: utf-8 -*-
"""Compress the produced TTF to WOFF1 / WOFF2 and report sizes."""
import os
import sys
import gzip

from fontTools.ttLib import TTFont

path = sys.argv[1] if len(sys.argv) > 1 else r"E:\Zilux2开发\web\public\fonts\zilux2-sans-sc-regular.ttf"
base = os.path.dirname(path)
print("input:", path, os.path.getsize(path) / 1024 / 1024, "MB")
raw = open(path, "rb").read()
for label, blobs, ext in [
    ("gzip file", gzip.compress(raw, 9), ".ttf.gz"),
    ("zlib raw", __import__("zlib").compress(raw, 9), ".z"),
]:
    out = os.path.join(base, "..", "..", "..", "research", "fonts", "work",
                       os.path.basename(path).replace(".ttf", ext))
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    open(out, "wb").write(blobs)
    print(f"{label:12s} {len(blobs)/1024/1024:6.2f} MB -> {out}")

for flavor, ext in [("woff", ".woff"), ("woff2", ".woff2")]:
    out = os.path.join(r"E:\Zilux2开发\research\fonts\work",
                       os.path.basename(path).replace(".ttf", ext))
    try:
        f = TTFont(path, lazy=False)
        f.flavor = flavor
        f.save(out)
        print(f"{flavor:12s} {os.path.getsize(out)/1024/1024:6.2f} MB -> {out}")
    except Exception as e:
        print(flavor, "FAILED:", type(e).__name__, e)
