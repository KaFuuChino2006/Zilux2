# -*- coding: utf-8 -*-
"""Verify the built subset: tables, glyphs, cmap coverage, outlines, names."""
import sys
import unicodedata
from fontTools.ttLib import TTFont

path = sys.argv[1] if len(sys.argv) > 1 else r"E:\Zilux2开发\web\public\fonts\zilux2-sans-sc-regular.ttf"
f = TTFont(path, lazy=True)
print("FILE:", path)
import os
print("SIZE:", os.path.getsize(path), "bytes", round(os.path.getsize(path) / 1048576, 2), "MB")
print("TABLES:", f.keys())
print("numGlyphs:", f["maxp"].numGlyphs, "upm:", f["head"].unitsPerEm,
      "macStyle:", f["head"].macStyle, "indexToLocFormat:", f["head"].indexToLocFormat)
os2 = f["OS/2"]
print("usWeightClass:", os2.usWeightClass, "usWidthClass:", os2.usWidthClass,
      "fsType:", os2.fsType, "sTypoAscender:", os2.sTypoAscender, "sTypoDescender:", os2.sTypoDescender)
print("hhea ascender/descender/lineGap:", f["hhea"].ascender, f["hhea"].descender, f["hhea"].lineGap)
print("post format:", f["post"].formatType)
for rec in f["name"].names:
    if rec.nameID in (1, 2, 4, 6, 16, 17):
        try:
            val = rec.toUnicode()
        except Exception:
            val = repr(rec.string)
        print(f"name[{rec.nameID}] platform={rec.platformID},{rec.platEncID} lang={rec.langID}: {val!r}")

cmap = f.getBestCmap()
print("cmap size:", len(cmap))

# --- coverage ---
def cov(rng):
    total = rng[1] - rng[0] + 1
    have = sum(1 for c in range(rng[0], rng[1] + 1) if c in cmap)
    return have, total

ascii_have, ascii_total = cov((0x20, 0x7E))
print(f"ASCII U+0020-007E: {ascii_have}/{ascii_total}")
punct = "，。！？、；：「」『』（）《》—…·～％＋－"
punct_missing = [p for p in punct if ord(p) not in cmap]
print("punct required:", len(punct), "missing:", punct_missing)
cjk_have, cjk_total = cov((0x4E00, 0x9FFF))
print(f"CJK basic U+4E00-9FFF: {cjk_have}/{cjk_total} = {cjk_have/cjk_total*100:.3f}%")
missing_cjk = [c for c in range(0x4E00, 0x9FFF + 1) if c not in cmap]
print("missing CJK count:", len(missing_cjk))
print("missing CJK:", " ".join(f"U+{c:04X}({unicodedata.name(chr(c),'?')})" if unicodedata.name(chr(c), '') else f"U+{c:04X}(unassigned)" for c in missing_cjk))
# Unicode assigned count inside block
assigned = [c for c in range(0x4E00, 0x9FFF + 1) if unicodedata.category(chr(c)) != 'Cn']
assigned_missing = [c for c in assigned if c not in cmap]
print(f"CJK assigned per unicodedata({unicodedata.unidata_version}): {len(assigned)}; assigned missing: {len(assigned_missing)}")
# GB2312 common chars (level 1 = 3755) and level 2
gb1, gb2 = [], []
for hi in range(0xA1, 0xF8):
    for lo in range(0xA1, 0xFF):
        try:
            ch = bytes([hi, lo]).decode("gb2312")
        except UnicodeDecodeError:
            continue
        if '\u4e00' <= ch <= '\u9fff':
            (gb1 if hi <= 0xD7 else gb2).append(ch)
gb1_cov = sum(1 for ch in gb1 if ord(ch) in cmap)
gb2_cov = sum(1 for ch in gb2 if ord(ch) in cmap)
print(f"GB2312 level1 (常用 3755): {len(gb1)} chars, covered {gb1_cov}")
print(f"GB2312 level2 (次常用 3008): {len(gb2)} chars, covered {gb2_cov}")
gbk_chars = []
for hi in range(0x81, 0xFF):
    for lo in range(0x40, 0xFF):
        if lo == 0x7F:
            continue
        try:
            ch = bytes([hi, lo]).decode("gbk")
        except UnicodeDecodeError:
            continue
        gbk_chars.append(ch)
uniq = set(gbk_chars)
gbk_cov = sum(1 for ch in uniq if ord(ch) in cmap or ord(ch) > 0xFFFF and ord(ch) in cmap)
print(f"GBK chars (unique): {len(uniq)}, covered by cmap: {gbk_cov} (mapped via BMP check: {sum(1 for ch in uniq if ord(ch) in cmap)})")
# all required ranges present?
required_ranges = [(0x20, 0x7E), (0x2000, 0x206F), (0x3000, 0x303F), (0xFF01, 0xFF60), (0x2100, 0x214F)]
for r in required_ranges:
    h, t = cov(r)
    print(f"range U+{r[0]:04X}-U+{r[1]:04X}: {h}/{t}")

# --- outline check ---
glyf = f["glyf"]
empty_glyphs = []
for name in f.getGlyphOrder():
    g = glyf[name]
    ncont = getattr(g, "numberOfContours", 0)
    if ncont == 0:
        empty_glyphs.append(name)
print("empty glyf contours count:", len(empty_glyphs), "sample:", empty_glyphs[:20])
# cmap -> gid 0?
glyph_order = f.getGlyphOrder()
gid_of = {n: i for i, n in enumerate(glyph_order)}
notdef_refs = [c for c, n in cmap.items() if n == ".notdef"]
print("cmap entries mapped to .notdef:", len(notdef_refs), [hex(c) for c in notdef_refs[:10]])
# glyph name check: are names synthetic 'glyphNNNNN'?
print("sample glyph order:", glyph_order[:6], "...", glyph_order[-3:])
# check composite glyphs reference valid glyphs? (fontTools decompiles lazily; force)
bad = 0
for name in glyph_order:
    g = glyf[name]
    if getattr(g, "numberOfContours", 0) < 0:
        _ = g.components  # force decode
print("composite glyph decode ok")
# hmtx sanity
hmtx = f["hmtx"]
zero_adv = sum(1 for n in glyph_order if hmtx[n][0] <= 0)
print("glyphs with advance <=0:", zero_adv)
print("advance range:", min(hmtx[n][0] for n in glyph_order), max(hmtx[n][0] for n in glyph_order))
# table sizes in bytes
print("\nTABLE SIZES:")
for tag in f.keys():
    try:
        n = len(f.reader[tag])
    except Exception:
        n = -1
    print(f"  {tag:6s} {n:9d} B  {n/1048576:.3f} MB")
