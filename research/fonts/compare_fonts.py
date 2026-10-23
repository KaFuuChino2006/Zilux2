# -*- coding: utf-8 -*-
"""Quick size comparison: subset a candidate font to the same unicode coverage and report size."""
import os
import sys
import time

from fontTools.ttLib import TTFont
from fontTools import subset

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_font import RANGES, EXTRA, expand, WORK

PYF = __file__


def build(path, label, ttc_index=None, inst=None):
    t0 = time.time()
    cps = expand(RANGES, EXTRA)
    try:
        font = TTFont(path, fontNumber=ttc_index) if ttc_index is not None else TTFont(path)
        opts = subset.Options()
        opts.glyph_names = False
        opts.notdef_outline = True
        opts.recommended_glyphs = False
        opts.name_IDs = ["*"]
        opts.name_languages = ["*"]
        opts.layout_features = ["*"]
        opts.layout_scripts = ["*"]
        opts.symbol_cmap = False
        opts.legacy_cmap = False
        opts.prune_unicode_ranges = True
        opts.drop_tables = []
        s = subset.Subsetter(options=opts)
        s.populate(unicodes=cps)
        s.subset(font)
        if inst is not None:
            from fontTools.varLib import instancer
            instancer.instantiateVariableFont(font, {"wght": inst}, inplace=True,
                                              optimize=True, updateFontNames=False)
        for tag in ["fvar", "gvar", "avar", "STAT", "HVAR", "VVAR", "MVAR",
                    "vhea", "vmtx", "VORG", "BASE", "DSIG", "hdmx", "LTSH",
                    "VDMX", "meta", "CFF ", "CFF2", "SVG ", "gasp"]:
            if tag in font:
                del font[tag]
        out = os.path.join(WORK, f"cmp-{label}.ttf")
        font.save(out)
        sz = os.path.getsize(out)
        print(f"{label:22s} glyphs={len(font.getGlyphOrder()):6d} size={sz/1024/1024:6.2f} MB  "
              f"({time.time()-t0:4.1f}s) -> {out}")
        return out
    except Exception as e:
        print(f"{label:22s} FAILED: {type(e).__name__}: {e}")
        return None


if __name__ == "__main__":
    import glob
    cands = [
        (r"C:\Windows\Fonts\simhei.ttf", "simhei", None, None),
        (r"C:\Windows\Fonts\simkai.ttf", "simkai", None, None),
        (r"C:\Windows\Fonts\simfang.ttf", "simfang", None, None),
        (r"C:\Windows\Fonts\msyh.ttc", "msyh", 0, None),
        (r"C:\Windows\Fonts\simsun.ttc", "simsun", 0, None),
    ]
    for path, label, idx, inst in cands:
        if os.path.exists(path):
            build(path, label, idx, inst)
        else:
            print(label, "MISSING", path)
