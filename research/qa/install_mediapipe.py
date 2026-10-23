import argparse
import io
import json
import sys
import tarfile
import urllib.request
from pathlib import Path

PACKAGE = "@mediapipe/hands"
VERSION = "0.4.1675469240"
TARBALL = f"https://registry.npmjs.org/{PACKAGE}/-/{PACKAGE.split('/')[-1]}-{VERSION}.tgz"
DEST = Path(r"E:\Zilux2开发\web\public\mediapipe")

KEEP_SUFFIXES = (
    "hands.js",
    "hands_solution_packed_assets_loader.js",
    "hands_solution_packed_assets.data",
    "hands_solution_simd_wasm_bin.js",
    "hands_solution_simd_wasm_bin.wasm",
    "hand_landmark_lite.tflite",
    "hands.binarypb",
)


def main() -> int:
    listing = len(sys.argv) > 1 and sys.argv[1] == "--list"
    print(f"GET {TARBALL}")
    request = urllib.request.Request(TARBALL, headers={"User-Agent": "zilux2-installer"})
    with urllib.request.urlopen(request, timeout=120) as response:
        payload = response.read()
    print(f"downloaded {len(payload)} bytes")
    DEST.mkdir(parents=True, exist_ok=True)
    written = []
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
        for member in archive.getmembers():
            if not member.isfile():
                continue
            name = Path(member.name).name
            if listing:
                print(f"{member.size:>10}  {member.name}")
                continue
            if not any(name.endswith(suffix) for suffix in KEEP_SUFFIXES):
                continue
            source = archive.extractfile(member)
            if source is None:
                continue
            target = DEST / name
            target.write_bytes(source.read())
            written.append((name, target.stat().st_size))
    if not listing:
        for name, size in written:
            print(f"  {size:>10}  {name}")
        print(f"OK: mediapipe assets ({len(written)} files) -> {DEST}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
