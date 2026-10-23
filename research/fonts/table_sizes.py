# -*- coding: utf-8 -*-
"""Print table sizes (uncompressed sum from directory) of a font."""
import sys
from fontTools.ttLib import TTFont

path = sys.argv[1]
font = TTFont(path, lazy=True)
rows = []
for tag in font.reader.keys():
    try:
        entry = font.reader.tables[tag]
        rows.append((entry.length, tag))
    except Exception as e:
        rows.append((0, tag + "!"))
rows.sort(reverse=True)
total = sum(r[0] for r in rows)
for length, tag in rows:
    print(f"{tag:8s} {length/1024/1024:8.3f} MB")
print("TOTAL    %8.3f MB" % (total / 1024 / 1024))
print("numGlyphs:", font["maxp"].numGlyphs)
font.close()
