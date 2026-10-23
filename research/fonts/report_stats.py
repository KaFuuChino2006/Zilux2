# -*- coding: utf-8 -*-
"""Print the numbers needed for FONT_REPORT.md (name records + per-block coverage)."""
import os

from fontTools.ttLib import TTFont

FONTS = r"E:\Zilux2开发\web\public\fonts"
TTF = os.path.join(FONTS, "zilux2-sans-sc-regular.ttf")

font = TTFont(TTF)
name = font["name"]
print("=== name records ===")
for nid in (0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 13, 14):
    v = name.getDebugName(nid)
    if v is None:
        continue
    print(f"nameID {nid}: {v[:220]!r}")
print("nameID>255 (reserved-name records):",
      sorted({r.nameID for r in name.names if r.nameID > 255}))
print("name languages:", sorted({(r.platformID, r.platEncID, r.langID) for r in name.names}))

cmap = font.getBestCmap()
print("\n=== per-block coverage ===")
BLOCKS = [
    ("ASCII 0020-007E", 0x20, 0x7F),
    ("Latin-1 sup 00A0-00FF", 0xA0, 0x100),
    ("General punct 2000-206F", 0x2000, 0x2070),
    ("Sup/sub 2070-209F", 0x2070, 0x20A0),
    ("Currency 20A0-20BF", 0x20A0, 0x20C0),
    ("Letterlike 2100-214F", 0x2100, 0x2150),
    ("Arrows 2190-21FF", 0x2190, 0x2200),
    ("Math 2200-22FF", 0x2200, 0x2300),
    ("Circled 2460-24FF", 0x2460, 0x2500),
    ("Box 2500-257F", 0x2500, 0x2580),
    ("Shapes 25A0-25FF", 0x25A0, 0x2600),
    ("Misc symbols 2600-26FF", 0x2600, 0x2700),
    ("Dingbats 2700-27BF", 0x2700, 0x27C0),
    ("CJK punct 3000-303F", 0x3000, 0x3040),
    ("Hiragana 3040-309F", 0x3040, 0x30A0),
    ("Katakana 30A0-30FF", 0x30A0, 0x3100),
    ("Bopomofo 3100-312F", 0x3100, 0x3130),
    ("CJK compat 3300-33FF", 0x3300, 0x3400),
    ("CJK unified 4E00-9FFF", 0x4E00, 0xA000),
    ("Vertical forms FE10-FE1F", 0xFE10, 0xFE20),
    ("Fullwidth FF01-FF60", 0xFF01, 0xFF61),
    ("Fullwidth signs FFE0-FFE6", 0xFFE0, 0xFFE7),
]
total_have = total_need = 0
for label, lo, hi in BLOCKS:
    need = hi - lo
    have = sum(1 for c in range(lo, hi) if c in cmap)
    total_have += have
    total_need += need
    pct = 100.0 * have / need if need else 0
    print(f"  {label:28s} {have:6d}/{need:6d} = {pct:7.3f}%")
print(f"  {'TOTAL':28s} {total_have:6d}/{total_need:6d} = {100.0*total_have/total_need:7.3f}%")
print("  plus U+3007:", 0x3007 in cmap)
print("  total cmap entries:", len(cmap), " numGlyphs:", font["maxp"].numGlyphs)

# required punctuation set from the task
REQ = "，。！？、；：「」『』（）《》—…·～％＋－"
missing_req = [ch for ch in REQ if ord(ch) not in cmap]
print("  required punctuation:", len(REQ), "missing:", missing_req)

# GB2312
l1 = l2 = 0
have_l1 = have_l2 = 0
for hi in range(0xB0, 0xD8):
    for lo in range(0xA1, 0xFF):
        try:
            ch = bytes([hi, lo]).decode("gb2312")
        except UnicodeDecodeError:
            continue
        l1 += 1
        have_l1 += ord(ch) in cmap
for hi in range(0xD8, 0xF8):
    for lo in range(0xA1, 0xFF):
        try:
            ch = bytes([hi, lo]).decode("gb2312")
        except UnicodeDecodeError:
            continue
        l2 += 1
        have_l2 += ord(ch) in cmap
print(f"  GB2312 level-1: {have_l1}/{l1}; level-2: {have_l2}/{l2}")

print("\n=== glyph stats ===")
glyf = font["glyf"]
empty = [n for n in font.getGlyphOrder()
         if glyf[n].numberOfContours == 0 and not hasattr(glyf[n], "getComponentNames")
         or (hasattr(glyf[n], "getComponentNames") and glyf[n].getComponentNames() is None
             and glyf[n].numberOfContours == 0)]
print("  empty-outline glyphs:", empty)
hint_bytes = sum(len(g.program.getBytecode()) for g in glyf.glyphs.values()
                 if hasattr(g, "program") and g.program is not None)
print("  hinting instruction bytes:", hint_bytes)
print("  advance widths: min", min(font["hmtx"].metrics[n][0] for n in font.getGlyphOrder()),
      "max", max(font["hmtx"].metrics[n][0] for n in font.getGlyphOrder()))
print("  head bbox:", (font["head"].xMin, font["head"].yMin,
                       font["head"].xMax, font["head"].yMax))
print("  post format:", font["post"].formatType)
print("  OS/2 version:", font["OS/2"].version, " fsType:", font["OS/2"].fsType,
      " usFirstChar:", font["OS/2"].usFirstCharIndex,
      " usLastChar:", font["OS/2"].usLastCharIndex)
# table sizes
print("\n=== table sizes (bytes) ===")
from fontTools.ttLib import sfnt  # noqa: E402
reader = sfnt.SFNTReader(TTF)
for tag, (offset, length) in sorted(reader.tables.items(), key=lambda kv: -kv[1][1]):
    print(f"  {tag}: {length:,d}")
