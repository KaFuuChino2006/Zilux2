"""Measure size options for the Zilux2 Chinese font subset.

Outputs, for the finished static TTF, the TTF/WOFF1 sizes of several
coverage strategies so the lead can pick a packaging tradeoff.
"""
import io
import os
import sys
import tempfile

from fontTools.ttLib import TTFont
from fontTools import subset

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SRC = os.path.join(ROOT, "web", "public", "fonts", "zilux2-sans-sc-regular.ttf")
OUT = os.path.join(HERE, "work")
os.makedirs(OUT, exist_ok=True)


def gb2312_chars():
    chars = set()
    for hi in range(0xB0, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                ch = bytes([hi, lo]).decode("gb2312")
            except UnicodeDecodeError:
                continue
            chars.add(ch)
    return chars


GB = gb2312_chars()
GB_CJK = {c for c in GB if "\u4e00" <= c <= "\u9fff"}
print(f"GB2312 total chars: {len(GB)}, CJK: {len(GB_CJK)}")

BASE_ASCII = list(range(0x20, 0x7F))
PUNCT = list(range(0x2000, 0x2070)) + [0x3000 + i for i in range(0x40)] + \
        list(range(0xFF01, 0xFF61)) + list(range(0xFFE0, 0xFFE7)) + [0x00B7]

VARIANTS = {
    # current shipped coverage (for reference; should reproduce ~7.67MB)
    "full": BASE_ASCII + list(range(0x00A0, 0x0100)) + list(range(0x2000, 0x2070))
            + list(range(0x2070, 0x20A0)) + list(range(0x20A0, 0x20C0))
            + list(range(0x2100, 0x2150)) + list(range(0x2190, 0x2200))
            + list(range(0x2200, 0x2300)) + list(range(0x2460, 0x2500))
            + list(range(0x2500, 0x2580)) + list(range(0x25A0, 0x2600))
            + list(range(0x2600, 0x2700)) + list(range(0x2700, 0x27C0))
            + list(range(0x3000, 0x3040)) + list(range(0x3040, 0x3100))
            + list(range(0x3100, 0x3130)) + list(range(0x3300, 0x3400))
            + list(range(0x4E00, 0xA000)) + list(range(0xFE10, 0xFE20))
            + list(range(0xFF01, 0xFF61)) + list(range(0xFFE0, 0xFFE7)) + [0x3007],
    # minimum required: ASCII + required CJK punct + full CJK basic block
    "lean": BASE_ASCII + PUNCT + [0x00B7] + list(range(0x4E00, 0xA000)),
    # two-tier split: tier1 = GB2312 (common/less-common) + ASCII + punct
    "tier1": BASE_ASCII + PUNCT + [0x00B7] + [ord(c) for c in sorted(GB_CJK)],
    # tier2 = full CJK minus GB2312 (rare chars); ASCII/punct kept for standalone use
    "tier2": BASE_ASCII + PUNCT + [0x00B7] + [c for c in range(0x4E00, 0xA000)
                                             if chr(c) not in GB_CJK],
}


def subset_font(src_path, unicodes, keep_layout=True):
    opts = subset.Options()
    opts.layout_features = ["*"] if keep_layout else []
    opts.name_IDs = ["*"]
    opts.name_languages = ["*"]
    opts.name_legacy = True
    opts.notdef_outline = True
    opts.recommended_glyphs = True
    opts.legacy_kern = True
    opts.hinting = True
    opts.desubroutinize = False
    font = TTFont(src_path, lazy=False)
    sub = subset.Subsetter(options=opts)
    sub.populate(unicodes=unicodes)
    sub.subset(font)
    return font


def sizes(font, tag):
    ttf_buf = io.BytesIO()
    font.flavor = None
    font.save(ttf_buf)
    ttf_len = len(ttf_buf.getvalue())
    woff_buf = io.BytesIO()
    font.flavor = "woff"
    font.save(woff_buf)
    woff_len = len(woff_buf.getvalue())
    glyphs = font.getGlyphOrder()
    cmap = font.getBestCmap()
    print(f"{tag:8s} glyphs={len(glyphs):6d} cmap={len(cmap):6d} "
          f"TTF={ttf_len:9,d} ({ttf_len/1048576:.2f} MB) "
          f"WOFF1={woff_len:9,d} ({woff_len/1048576:.2f} MB)")
    path_ttf = os.path.join(OUT, f"variant-{tag}.ttf")
    path_woff = os.path.join(OUT, f"variant-{tag}.woff")
    font.flavor = None
    font.save(path_ttf)
    font.flavor = "woff"
    font.save(path_woff)
    return ttf_len, woff_len


# --- 1) hinting check on the shipped font ---
font = TTFont(SRC, lazy=True)
glyf = font["glyf"]
hinting_bytes = 0
n_hinted = 0
for name in font.getGlyphOrder():
    g = glyf[name]
    if hasattr(g, "program") and g.program is not None:
        n_hinted += 1
        hinting_bytes += len(g.program.getBytecode())
print(f"hinted glyphs: {n_hinted}, instruction bytes: {hinting_bytes}")

# --- 2) coverage variants ---
results = {}
for tag, unis in VARIANTS.items():
    f = subset_font(SRC, unis)
    results[tag] = sizes(f, tag)

# --- 3) no-hinting lean variant, if hinting costs anything ---
if hinting_bytes > 1000:
    f = TTFont(SRC, lazy=False)
    sub_opts = subset.Options()
    sub_opts.layout_features = ["*"]
    sub_opts.hinting = False
    f2 = TTFont(SRC, lazy=False)
    sub = subset.Subsetter(options=sub_opts)
    sub.populate(unicodes=VARIANTS["lean"])
    sub.subset(f2)
    results["lean_nohint"] = sizes(f2, "lean_nohint")

# --- 4) totals for split packaging ---
t1 = results["tier1"]
t2 = results["tier2"]
print(f"\ntwo-tier total TTF  = {t1[0]+t2[0]:,d} ({(t1[0]+t2[0])/1048576:.2f} MB)")
print(f"two-tier total WOFF = {t1[1]+t2[1]:,d} ({(t1[1]+t2[1])/1048576:.2f} MB)")
