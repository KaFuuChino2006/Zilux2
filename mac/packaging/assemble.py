#!/usr/bin/env python3
"""Zip-level assembly of Zilux2.app (Apple Silicon) from the Electron release zip.

Why zip-level: this repository is built on Windows, where macOS symlinks inside
Electron.app cannot be materialised. Instead of extracting and re-packing, we
rewrite the Electron zip entry-by-entry, which keeps every symlink entry's unix
mode bits (S_IFLNK) and every executable bit exactly as shipped by Electron.

Layout produced inside the bundle:

    Zilux2.app/Contents/MacOS/Electron          (kept as-is; the frame binary)
    Zilux2.app/Contents/Resources/app/          main.js, preload.js, package.json
    Zilux2.app/Contents/Resources/web/          the Vite build (index.html, assets/, fonts/)
    Zilux2.app/Contents/Resources/engine/       self-contained .NET publish for osx-arm64

Usage:
    python assemble.py \
        --electron-zip mac/cache/electron-v33.2.1-darwin-arm64.zip \
        --shell-dir mac/shell \
        --web-dir web/dist \
        --engine-dir mac/engine/publish/osx-arm64 \
        --out-zip research/mac-dist/Zilux2-1.0.0-arm64.zip \
        [--version 1.0.0] [--bundle-name Zilux2] [--bundle-id dev.zilux2.mac]
        [--readme mac/packaging/README-mac.txt] [--dry-run]

The zip contains, at its root:

    Zilux2.app/...
    README-mac.txt
"""

from __future__ import annotations

import argparse
import os
import plistlib
import stat
import sys
import zipfile

APP_DIR = "Zilux2.app"
ELECTRON_PREFIX = "Electron.app/"

# fallback unix modes when the source zip does not carry them
MODE_FILE = 0o644
MODE_EXEC = 0o755
MODE_DIR = 0o755

# files under Resources/engine that must stay executable (besides any entry the
# source publish already marked executable)
ENGINE_EXECUTABLES = {"Zilux2MacEngine"}


def unix_mode(info: zipfile.ZipInfo, default: int) -> int:
    raw = (info.external_attr >> 16) & 0xFFFF
    return raw if raw else default


def mode_is_symlink(mode: int) -> bool:
    return stat.S_ISLNK(mode)


def file_entries(root: str) -> list[tuple[str, str]]:
    """Yield (posix_relative_path, absolute_path) for every file below root."""
    out: list[tuple[str, str]] = []
    root = os.path.abspath(root)
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            absolute = os.path.join(dirpath, name)
            relative = os.path.relpath(absolute, root).replace(os.sep, "/")
            out.append((relative, absolute))
    out.sort(key=lambda item: item[0])
    return out


def patch_info_plist(
    raw: bytes,
    *,
    bundle_name: str,
    bundle_id: str,
    version: str,
    icon_file: str = "",
) -> bytes:
    """Rename the Electron bundle in Info.plist while keeping every other key."""
    try:
        data = plistlib.loads(raw)
    except Exception as error:  # binary or exotic plist: keep it verbatim, warn
        print(f"[assemble] WARN cannot parse Info.plist ({error}); leaving it untouched")
        return raw

    data["CFBundleName"] = bundle_name
    data["CFBundleDisplayName"] = bundle_name
    data["CFBundleIdentifier"] = bundle_id
    data["CFBundleExecutable"] = data.get("CFBundleExecutable", "Electron")
    data["CFBundleShortVersionString"] = version
    data["CFBundleVersion"] = version.replace(".", "")
    data["CFBundleDevelopmentRegion"] = "zh_CN"
    if icon_file:
        data["CFBundleIconFile"] = icon_file
    # Electron keeps its helper processes in Contents/Frameworks; nothing to rename there.
    return plistlib.dumps(data, fmt=plistlib.FMT_XML, sort_keys=False)


def main() -> int:
    parser = argparse.ArgumentParser(description="Assemble a macOS Zilux2.app zip")
    parser.add_argument("--electron-zip", required=True)
    parser.add_argument("--shell-dir", required=True, help="directory with package.json/main.js/preload.js")
    parser.add_argument("--web-dir", required=True, help="web build; index.html lives at its root")
    parser.add_argument("--engine-dir", required=True, help="osx-arm64 self-contained publish output")
    parser.add_argument("--out-zip", required=True)
    parser.add_argument("--version", default="1.0.0")
    parser.add_argument("--bundle-name", default="Zilux2")
    parser.add_argument("--bundle-id", default="dev.zilux2.mac")
    parser.add_argument("--readme", default="")
    parser.add_argument("--icon-icns", default="", help="optional .icns copied into Contents/Resources")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    for label, path in (
        ("electron zip", args.electron_zip),
        ("shell dir", args.shell_dir),
        ("web dir", args.web_dir),
        ("engine dir", args.engine_dir),
    ):
        if not os.path.exists(path):
            print(f"[assemble] ERROR missing {label}: {path}")
            return 2
    if not os.path.exists(os.path.join(args.web_dir, "index.html")):
        print(f"[assemble] ERROR no index.html in {args.web_dir}")
        return 2

    shell_files = [
        entry for entry in file_entries(args.shell_dir) if "/" not in entry[0]
    ]
    web_files = file_entries(args.web_dir)
    engine_files = file_entries(args.engine_dir)
    if not any(name == "main.js" for name, _ in shell_files):
        print("[assemble] ERROR shell dir has no main.js")
        return 2
    if not any(name == "package.json" for name, _ in shell_files):
        print("[assemble] ERROR shell dir has no package.json")
        return 2
    icon_file = ""
    icon_payload = b""
    if args.icon_icns:
        if not os.path.exists(args.icon_icns):
            print(f"[assemble] ERROR missing icon: {args.icon_icns}")
            return 2
        with open(args.icon_icns, "rb") as handle:
            icon_payload = handle.read()
        icon_file = os.path.basename(args.icon_icns)

    if not any(name == "Zilux2MacEngine" for name, _ in engine_files):
        print("[assemble] ERROR engine publish dir has no Zilux2MacEngine executable")
        return 2

    out_dir = os.path.dirname(os.path.abspath(args.out_zip))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    stats = {"carried": 0, "symlinks": 0, "added": 0, "patched": 0}
    plist_name = ELECTRON_PREFIX + "Contents/Info.plist"

    source = zipfile.ZipFile(args.electron_zip, "r")
    try:
        target = zipfile.ZipFile(args.out_zip, "w", zipfile.ZIP_DEFLATED, allowZip64=True)
    except Exception:
        source.close()
        raise

    def write_entry(xinfo: zipfile.ZipInfo, data: bytes) -> None:
        target.writestr(xinfo, data)

    try:
        for info in source.infolist():
            name = info.filename
            if not name.startswith(ELECTRON_PREFIX):
                # ignore top-level LICENSE/version files from the Electron release
                continue
            mode = unix_mode(info, MODE_DIR if name.endswith("/") else MODE_FILE)
            renamed = APP_DIR + "/" + name[len(ELECTRON_PREFIX):]
            data = b"" if name.endswith("/") else source.read(info)

            if name == plist_name:
                data = patch_info_plist(
                    data,
                    bundle_name=args.bundle_name,
                    bundle_id=args.bundle_id,
                    version=args.version,
                    icon_file=icon_file,
                )
                stats["patched"] += 1

            if mode_is_symlink(mode):
                stats["symlinks"] += 1
            else:
                stats["carried"] += 1
            out = zipfile.ZipInfo(renamed, date_time=info.date_time)
            out.compress_type = zipfile.ZIP_STORED if mode_is_symlink(mode) else zipfile.ZIP_DEFLATED
            out.external_attr = (mode & 0xFFFF) << 16
            write_entry(out, data)

        def add_tree(prefix: str, entries: list[tuple[str, str]], executables: set[str]) -> None:
            for relative, absolute in entries:
                arcname = f"{APP_DIR}/Contents/Resources/{prefix}/{relative}"
                with open(absolute, "rb") as handle:
                    payload = handle.read()
                executable = os.path.basename(relative) in executables or relative in executables
                out = zipfile.ZipInfo(arcname, date_time=(2026, 1, 1, 0, 0, 0))
                out.compress_type = zipfile.ZIP_DEFLATED
                out.external_attr = ((MODE_EXEC if executable else MODE_FILE) & 0xFFFF) << 16
                write_entry(out, payload)
                stats["added"] += 1

        add_tree("app", shell_files, set())
        add_tree("web", web_files, set())
        add_tree("engine", engine_files, ENGINE_EXECUTABLES)

        if icon_payload:
            out = zipfile.ZipInfo(
                f"{APP_DIR}/Contents/Resources/{icon_file}", date_time=(2026, 1, 1, 0, 0, 0)
            )
            out.compress_type = zipfile.ZIP_DEFLATED
            out.external_attr = (MODE_FILE & 0xFFFF) << 16
            write_entry(out, icon_payload)
            stats["added"] += 1

        if args.readme and os.path.exists(args.readme):
            with open(args.readme, "rb") as handle:
                payload = handle.read()
            out = zipfile.ZipInfo("README-mac.txt", date_time=(2026, 1, 1, 0, 0, 0))
            out.compress_type = zipfile.ZIP_DEFLATED
            out.external_attr = (MODE_FILE & 0xFFFF) << 16
            write_entry(out, payload)
            stats["added"] += 1
    finally:
        target.close()
        source.close()

    size = os.path.getsize(args.out_zip)
    print(
        "[assemble] OK "
        f"carried={stats['carried']} symlinks={stats['symlinks']} "
        f"added={stats['added']} plist_patched={stats['patched']} "
        f"out={args.out_zip} bytes={size}"
    )
    if args.dry_run:
        print("[assemble] dry-run: removing archive")
        os.remove(args.out_zip)
    return 0


if __name__ == "__main__":
    sys.exit(main())
