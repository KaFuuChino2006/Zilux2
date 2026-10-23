import os
import zipfile

root = r"E:\Zilux2开发\dist\Zilux2"
out = r"E:\Zilux2开发\src\Zilux2.Installer\payload.zip"

count = 0
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for base, dirs, files in os.walk(root):
        for name in files:
            full = os.path.join(base, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            archive.write(full, rel)
            count += 1

print("zipped", count, "files", os.path.getsize(out), "bytes")
