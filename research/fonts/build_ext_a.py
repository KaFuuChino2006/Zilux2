# -*- coding: utf-8 -*-
"""Optional "rare characters" build: same pipeline as the shipped subset, but also
includes CJK Ext-A (U+3400-U+4DBF) and CJK compatibility ideographs (U+2F00-U+2FDF)
so that rare characters in internet lyrics still map to a real glyph.

The shipped files stay in web/public/fonts/ (CJK basic block only).  This script
writes its output into research/fonts/work/ so 开发侧 can decide whether the
extra ~2.0 MB (TTF) / ~1.2 MB (WOFF1) is acceptable:

    research/fonts/work/zilux2-sans-sc-regular-exta.ttf    (finalized, renamed)
    research/fonts/work/zilux2-sans-sc-regular-exta.woff   (WOFF1 for troika)

Usage: python build_ext_a.py
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import build_font as bf          # noqa: E402
import finalize_font as ff       # noqa: E402

WORK = os.path.join(HERE, "work")
os.makedirs(WORK, exist_ok=True)

RAW = os.path.join(WORK, "exta-raw.ttf")
OUT_TTF = os.path.join(WORK, "zilux2-sans-sc-regular-exta.ttf")
OUT_WOFF = os.path.join(WORK, "zilux2-sans-sc-regular-exta.woff")


def main():
    # extend coverage, then reuse the shipped build pipeline (subset VF -> instance
    # wght=400 -> drop variation tables -> save static TTF)
    bf.RANGES = bf.RANGES + [(0x3400, 0x4DBF), (0x2F00, 0x2FDF)]
    sys.argv = ["build_font.py", "400", RAW]
    bf.main()

    # rename family/PS, normalise metrics, emit WOFF1 -- can't touch shipped files
    ff.main([RAW, OUT_TTF, OUT_WOFF, "Zilux2SansSC-RegularExtA"])


if __name__ == "__main__":
    main()
