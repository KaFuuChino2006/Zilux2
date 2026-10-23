# -*- coding: utf-8 -*-
"""
Build static (glyf-outline) TTF subsets from NotoSansSC-VF.ttf.

Pipeline:
  1. subset the variable font to the target unicode coverage (keeps gvar + all layout)
  2. instantiate wght=400 (or other) -> static font (gvar/fvar removed)
  3. rewrite name table + OS/2 weight, drop variation & unused tables
  4. save final TTF

Usage: python build_font.py [weight] [outfile]
"""
import os
import sys
import time

from fontTools.ttLib import TTFont
from fontTools import subset
from fontTools.varLib import instancer

VF = r"C:\Windows\Fonts\NotoSansSC-VF.ttf"
WORK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "work")
os.makedirs(WORK, exist_ok=True)

# (start, end) inclusive ranges requested for the subset.
RANGES = [
    (0x0020, 0x007E),  # ASCII printable
    (0x00A0, 0x00FF),  # Latin-1 supplement (degree, plus-minus, times, divide ...)
    (0x2000, 0x206F),  # general punctuation: – — … ‘ ’ “ ” ‰ etc.
    (0x2070, 0x209F),  # superscripts / subscripts
    (0x20A0, 0x20BF),  # currency signs
    (0x2100, 0x214F),  # letterlike: ℃ ℉ № ™ Ω
    (0x2190, 0x21FF),  # arrows
    (0x2200, 0x22FF),  # math operators
    (0x2460, 0x24FF),  # enclosed alphanumerics ① ② ⑴
    (0x2500, 0x257F),  # box drawing
    (0x25A0, 0x25FF),  # geometric shapes ■ ● ▲
    (0x2600, 0x26FF),  # misc symbols ★ ☆
    (0x2700, 0x27BF),  # dingbats ✓
    (0x3000, 0x303F),  # CJK symbols & punctuation （〇、。「」）
    (0x3040, 0x30FF),  # kana
    (0x3100, 0x312F),  # bopomofo
    (0x3300, 0x33FF),  # CJK compatibility units ㎝ ㎡ ㎞
    (0x4E00, 0x9FFF),  # CJK unified ideographs (all)
    (0xFE10, 0xFE1F),  # vertical forms
    (0xFF01, 0xFF60),  # fullwidth forms ！％＋－～ etc.
    (0xFFE0, 0xFFE6),  # ￥ etc.
]
EXTRA = [0x3007]  # 〇 (just in case, already inside 3000-303F)


def expand(ranges, extra):
    cps = set()
    for a, b in ranges:
        cps.update(range(a, b + 1))
    cps.update(extra)
    return sorted(cps)


def rewrite_names(font, family, style, weight):
    name = font["name"]
    keep = {}
    for rec in name.names:
        if rec.nameID in (1, 2, 3, 4, 5, 6, 16, 17, 21, 22, 25):
            continue  # drop old family/style/full/ps/typo/wws records, rebuild below
        keep[(rec.nameID, rec.platformID, rec.platEncID, rec.langID)] = rec.toUnicode()
    new_records = {
        1: family,
        2: style,
        4: family + " " + style,
        6: family.replace(" ", "") + "-" + style.replace(" ", ""),
        16: family,
        17: style,
        21: family,
        22: style,
    }
    for nid, val in new_records.items():
        if nid in (16, 17, 21, 22):
            name.setName(val, nid, 3, 1, 0x409)
        else:
            name.setName(val, nid, 3, 1, 0x409)  # Windows
            name.setName(val, nid, 1, 0, 0)      # Mac Roman
    # copy back preserved records (copyright / license etc.)
    for (nid, pid, eid, lid), val in keep.items():
        name.setName(val, nid, pid, eid, lid)
    # remove name records we do not want in the shipped font
    for rec in list(name.names):
        if rec.nameID in (7, 8, 9, 10, 11, 12, 13, 14):
            pass  # keep trademark/manufacturer/designer/license
    font["OS/2"].usWeightClass = weight
    if weight >= 700:
        font["head"].macStyle |= 1
    else:
        font["head"].macStyle &= ~1


def main():
    weight = int(sys.argv[1]) if len(sys.argv) > 1 else 400
    outfile = sys.argv[2] if len(sys.argv) > 2 else os.path.join(WORK, "static.ttf")
    family = "Noto Sans SC"
    style = "Regular" if weight == 400 else "Bold" if weight >= 700 else "Medium"
    out_dir = os.path.dirname(os.path.abspath(outfile))
    os.makedirs(out_dir, exist_ok=True)

    t0 = time.time()
    cps = expand(RANGES, EXTRA)
    print(f"[1/4] target codepoints: {len(cps)} (requested ranges)")

    font = TTFont(VF, lazy=False)
    print(f"      loaded VF: {len(font.getGlyphOrder())} glyphs, {time.time()-t0:.1f}s")

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
    opts.recalc_bounds = False
    opts.recalc_timestamp = True
    opts.drop_tables = []          # drop explicitly in stage 3
    opts.passthrough_tables = False
    subsetter = subset.Subsetter(options=opts)
    subsetter.populate(unicodes=cps)
    subsetter.subset(font)
    print(f"[2/4] subset VF: {len(font.getGlyphOrder())} glyphs, {time.time()-t0:.1f}s")
    font.save(os.path.join(WORK, "subset-vf.ttf"))

    # instantiate
    t1 = time.time()
    instancer.instantiateVariableFont(font, {"wght": weight}, inplace=True,
                                      optimize=True, updateFontNames=False)
    print(f"[3/4] instanced wght={weight}: {len(font.getGlyphOrder())} glyphs, "
          f"{time.time()-t1:.1f}s (total {time.time()-t0:.1f}s)")

    # drop variation / irrelevant tables
    drop = ["fvar", "gvar", "avar", "STAT", "HVAR", "VVAR", "MVAR",
            "vhea", "vmtx", "VORG", "BASE", "DSIG", "hdmx", "LTSH", "VDMX",
            "meta", "CFF ", "CFF2", "SVG ", "EBDT", "EBLC", "EBSC", "gasp"]
    for tag in drop:
        if tag in font:
            del font[tag]
    rewrite_names(font, family, style, weight)

    # report final table list
    print("[4/4] final tables:", sorted(font.keys()))
    font.save(outfile)
    size = os.path.getsize(outfile)
    print(f"      saved: {outfile}")
    print(f"      bytes: {size} ({size/1024/1024:.2f} MB)")
    del font

    # minimal variant without OpenType layout (GPOS/GSUB/GDEF)
    try:
        mini = TTFont(outfile, lazy=False)
        for tag in ("GPOS", "GSUB", "GDEF"):
            if tag in mini:
                del mini[tag]
        mini_out = outfile.replace(".ttf", "-nolayout.ttf")
        mini.save(mini_out)
        print(f"      minimal (no layout) variant: {mini_out} "
              f"({os.path.getsize(mini_out)/1024/1024:.2f} MB)")
    except Exception as e:
        print("      minimal variant failed:", e)


if __name__ == "__main__":
    main()
