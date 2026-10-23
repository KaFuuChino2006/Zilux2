"""Final sanity check of the two shipped font files."""
import hashlib
import os

from fontTools.ttLib import TTFont

FONTS = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), "web", "public", "fonts")
FILES = ["zilux2-sans-sc-regular.ttf", "zilux2-sans-sc-regular.woff"]

for fn in FILES:
    p = os.path.join(FONTS, fn)
    data = open(p, "rb").read()
    print(fn)
    print("   bytes:", len(data), " sha256:", hashlib.sha256(data).hexdigest())
    print("   magic:", data[:4])
    f = TTFont(p)
    print("   flavor:", f.flavor, " sfntVersion:", f.sfntVersion,
          " tables:", sorted(f.keys()))
    print("   numGlyphs:", f["maxp"].numGlyphs, " cmap:", len(f.getBestCmap()))
    n = f["name"]
    print("   family(1):", n.getDebugName(1), " subfamily(2):", n.getDebugName(2))
    print("   full(4):", n.getDebugName(4), " ps(6):", n.getDebugName(6))
    print("   typoFamily(16):", n.getDebugName(16),
          " typoSub(17):", n.getDebugName(17))
    print("   license(13) len:", len(n.getDebugName(13) or ""),
          " licenseURL(14):", n.getDebugName(14))
    print("   OS/2 weight:", f["OS/2"].usWeightClass,
          " fsSelection:", hex(f["OS/2"].fsSelection),
          " fsType:", f["OS/2"].fsType)
    print("   upm:", f["head"].unitsPerEm,
          " macStyle:", f["head"].macStyle,
          " hhea:", (f["hhea"].ascender, f["hhea"].descender, f["hhea"].lineGap),
          " typo:", (f["OS/2"].sTypoAscender, f["OS/2"].sTypoDescender,
                     f["OS/2"].sTypoLineGap),
          " win:", (f["OS/2"].usWinAscent, f["OS/2"].usWinDescent))
    print("   kern:", "kern" in f, " GPOS:", "GPOS" in f, " GSUB:", "GSUB" in f,
          " yMin/yMax:", f["head"].yMin, f["head"].yMax)
