import os
import struct
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

folder = r"C:\Users\13329\Music"
target = None
for name in os.listdir(folder):
    if name.lower().endswith(".m4a"):
        target = os.path.join(folder, name)
        print("m4a:", name, os.path.getsize(target))
if target is None:
    print("no m4a found")
    sys.exit(0)

head = open(target, "rb").read(3_000_000)
print("ftyp:", head[4:12])
for tag in (b"alac", b"mp4a", b"esds", b"ac-3", b"ec-3", b"Opus", b"fLaC", b"mp4v"):
    print(tag.decode(), "at", head.find(tag))

offset = 0
atoms = []
while offset + 8 <= len(head):
    size = struct.unpack(">I", head[offset:offset + 4])[0]
    kind = head[offset + 4:offset + 8].decode("latin-1")
    atoms.append((kind, size))
    if size < 8:
        break
    offset += size
print("top atoms:", atoms[:8])
