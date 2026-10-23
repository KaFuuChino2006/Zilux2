# -*- coding: utf-8 -*-
"""Inspect a TTF/TTC structure: tables, fvar, glyf vs CFF/CFF2, cmap coverage stats."""
import sys
from fontTools.ttLib import TTFont

path = sys.argv[1] if len(sys.argv) > 1 else r"C:\Windows\Fonts\NotoSansSC-VF.ttf"
font = TTFont(path, lazy=True)
print("file:", path)
print("tables:", sorted(font.keys()))
cs = font.get("CFF ") is not None
cs2 = font.get("CFF2") is not None
glyf = font.get("glyf") is not None
print("has glyf:", glyf, "| has CFF:", cs, "| has CFF2:", cs2)
if "fvar" in font:
    fvar = font["fvar"]
    print("axes:")
    for a in fvar.axes:
        print("  ", a.axisTag, "min", a.minValue, "default", a.defaultValue, "max", a.maxValue)
    print("named instances:", len(fvar.instances))
    for inst in fvar.instances[:12]:
        print("  ", inst.coordinates, inst.subfamilyNameID)
if "head" in font:
    h = font["head"]
    print("unitsPerEm:", h.unitsPerEm, "| macStyle:", h.macStyle)
if "name" in font:
    name = font["name"]
    for nid in (1, 2, 4, 6, 16, 17):
        rec = name.getDebugName(nid)
        if rec:
            print("nameID", nid, "=", rec)
if "OS/2" in font:
    os2 = font["OS/2"]
    print("OS/2 usWeightClass:", os2.usWeightClass, "| fsType:", os2.fsType)
if "cmap" in font:
    best = font.getBestCmap()
    print("best cmap entries:", len(best))
    cjk = sum(1 for cp in range(0x4E00, 0xA000) if cp in best)
    print("CJK U+4E00-9FFF covered:", cjk, "/", 0x9FFF - 0x4E00 + 1)
    print("ASCII printable covered:", sum(1 for cp in range(0x20, 0x7F) if cp in best), "/", 0x7F - 0x20)
if "maxp" in font:
    print("numGlyphs:", font["maxp"].numGlyphs)
if "post" in font:
    print("post format:", font["post"].formatType)
print("kern table:", "kern" in font, "| GPOS:", "GPOS" in font, "| GSUB:", "GSUB" in font)
font.close()
