# -*- coding: utf-8 -*-
"""Finalize the built subset: clean name table + metrics, then emit WOFF1 alongside.

Input : web/public/fonts/zilux2-sans-sc-regular.ttf  (product of build_font.py 400)
Output: same path (rewritten) + zilux2-sans-sc-regular.woff (WOFF1, zlib per table)

WOFF1 is emitted because troika-three-text 0.52.5 ships its own Typr parser and
*does* accept WOFF1 (it inflates it with the bundled woff2otf.factory.js); it
rejects WOFF2 only.  WOFF1 cuts ~2.9 MB off the file (7.32 MB -> ~4.4 MB).
"""
import hashlib
import os
import sys

from fontTools.ttLib import TTFont

FONTS = r"E:\Zilux2开发\web\public\fonts"
TTF = os.path.join(FONTS, "zilux2-sans-sc-regular.ttf")
WOFF = os.path.join(FONTS, "zilux2-sans-sc-regular.woff")

FAMILY = "Zilux2 Sans SC"
STYLE = "Regular"
PS = "Zilux2SansSC-Regular"
WEIGHT = 400


def clean_name_table(font, ps=PS):
    name = font["name"]
    drop_ids = {1, 2, 3, 4, 6, 16, 17, 21, 22}
    kept = [(r, r.toUnicode()) for r in name.names if r.nameID not in drop_ids]
    name.names = []
    for rec, val in kept:
        name.setName(val, rec.nameID, rec.platformID, rec.platEncID, rec.langID)
    records = {
        1: FAMILY,
        2: STYLE,
        3: f"{FAMILY} {STYLE}; subset of Noto Sans SC (SIL OFL 1.1)",
        4: f"{FAMILY} {STYLE}",
        6: ps,
        16: FAMILY,
        17: STYLE,
    }
    for nid, val in records.items():
        name.setName(val, nid, 3, 1, 0x409)   # en-US
        name.setName(val, nid, 3, 1, 0x804)   # zh-CN
        name.setName(val, nid, 1, 0, 0)       # Mac Roman
    # ensure the OFL license/copyright records survive (OFL 1.1 requires it)
    for nid in (0, 13, 14):
        vals = {r.toUnicode() for r in name.names if r.nameID == nid}
        assert vals, f"missing OFL name record {nid}"


def main(argv=None):
    """Defaults reproduce the shipped 400 build; optional args let a variant
    (e.g. the CJK Ext-A build) be finalized into research/fonts/work/ instead:
      python finalize_font.py <in.ttf> <out.ttf> <out.woff> <PostScriptName>
    """
    argv = list(sys.argv[1:] if argv is None else argv)
    in_ttf = argv[0] if len(argv) > 0 else TTF
    out_ttf = argv[1] if len(argv) > 1 else TTF
    out_woff = argv[2] if len(argv) > 2 else WOFF
    ps_name = argv[3] if len(argv) > 3 else PS

    font = TTFont(in_ttf, lazy=False)
    print("input tables:", sorted(font.keys()))
    clean_name_table(font, ps_name)

    os2 = font["OS/2"]
    os2.usWeightClass = WEIGHT
    os2.usWidthClass = 5
    os2.fsSelection = (os2.fsSelection & ~0x3D) | 0x40  # REGULAR bit only (no bold/italic)
    font["head"].macStyle &= ~3                         # not bold, not italic
    hhea, head = font["hhea"], font["head"]
    print(f"metrics: upm={head.unitsPerEm} hhea={hhea.ascender}/{hhea.descender}/{hhea.lineGap} "
          f"typo={os2.sTypoAscender}/{os2.sTypoDescender}/{os2.sTypoLineGap} "
          f"win={os2.usWinAscent}/{os2.usWinDescent} fsSelection=0x{os2.fsSelection:04x}")

    font.flavor = None
    font.save(out_ttf)
    ttf_size = os.path.getsize(out_ttf)
    print(f"TTF : {out_ttf}\n      {ttf_size} bytes = {ttf_size/1048576:.2f} MB  sha256={sha256(out_ttf)[:16]}")

    # WOFF1: same tables, zlib compressed per table (Troika's woff2otf inflates it)
    font2 = TTFont(out_ttf, lazy=False)
    font2.flavor = "woff"
    font2.save(out_woff)
    woff_size = os.path.getsize(out_woff)
    print(f"WOFF: {out_woff}\n      {woff_size} bytes = {woff_size/1048576:.2f} MB  sha256={sha256(out_woff)[:16]}"
          f"  ({100*woff_size/ttf_size:.1f}% of TTF)")
    # re-open to prove both files are valid
    for p in (out_ttf, out_woff):
        f = TTFont(p, lazy=True)
        print(f"  re-open OK {os.path.basename(p)}: tables={sorted(f.keys())} "
              f"glyphs={f['maxp'].numGlyphs} cmap={len(f.getBestCmap())}")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fp:
        for chunk in iter(lambda: fp.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


if __name__ == "__main__":
    main()
