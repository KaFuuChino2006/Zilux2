"""Minimal npm tarball installer (pnpm bundled in the runtime is corrupted).

Installs troika-three-text + its transitive deps into web/node_modules by
fetching tarballs from registry.npmjs.org and extracting them flat
(node_modules/<name>). three is expected to be present already (peer dep).
"""
from __future__ import annotations

import io
import json
import re
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(r"E:/Zilux2开发/web")
NODE_MODULES = ROOT / "node_modules"
REG = "https://registry.npmjs.org"
SEED = {"troika-three-text": "latest"}


def fetch_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def resolve(name: str, rng: str) -> tuple[str, dict]:
    """Resolve a package (dist-tag or exact/latest-ish range) to manifest."""
    meta = fetch_json(f"{REG}/{name}")
    versions = meta.get("versions", {})
    if rng in versions:  # exact version pinned
        return rng, versions[rng]
    dist_tags = meta.get("dist-tags", {})
    if rng in dist_tags:
        v = dist_tags[rng]
        return v, versions[v]
    # treat as range like ^1.0.3 / >=0.125.0: pick highest semver satisfying major
    m = re.match(r"[\^~]?(\d+)\.(\d+)\.(\d+)", rng or "")
    if m:
        want = tuple(int(x) for x in m.groups())
        cands = []
        for v in versions:
            mm = re.match(r"^(\d+)\.(\d+)\.(\d+)$", v)
            if not mm:
                continue
            t = tuple(int(x) for x in mm.groups())
            if rng.startswith("^"):
                ok = t[0] == want[0] and (t[0] > 0 or t[1] == want[1]) and t >= want
            elif rng.startswith("~"):
                ok = t[:2] == want[:2] and t >= want
            else:
                ok = t >= want
            if ok:
                cands.append(t)
        if cands:
            best = max(cands)
            v = ".".join(str(x) for x in best)
            return v, versions[v]
    v = dist_tags.get("latest") or sorted(versions)[-1]
    return v, versions[v]


def install(name: str, rng: str, seen: dict, stack: list) -> None:
    if name in seen:
        return
    version, manifest = resolve(name, rng)
    seen[name] = version
    tarball = manifest["dist"]["tarball"]
    print(f"install {name}@{version} <- {tarball}")
    with urllib.request.urlopen(tarball, timeout=120) as resp:
        data = resp.read()
    dest = NODE_MODULES / name
    dest.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        for member in tar.getmembers():
            parts = member.name.split("/", 1)
            if len(parts) < 2 or not parts[1]:
                continue
            member.name = parts[1]
            if member.isdir():
                (dest / member.name).mkdir(parents=True, exist_ok=True)
                continue
            if not member.isfile():
                continue
            target = dest / member.name
            target.parent.mkdir(parents=True, exist_ok=True)
            src = tar.extractfile(member)
            if src is None:
                continue
            target.write_bytes(src.read())
    deps = manifest.get("dependencies") or {}
    for dep, dep_rng in deps.items():
        if dep in ("three",):
            continue  # peer / already installed
        install(dep, dep_rng, seen, stack + [name])


def main() -> None:
    NODE_MODULES.mkdir(parents=True, exist_ok=True)
    seen: dict = {}
    for name, rng in SEED.items():
        install(name, rng, seen, [])
    print("installed:", json.dumps(seen, indent=2))

    pkg_path = ROOT / "package.json"
    pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
    deps = pkg.setdefault("dependencies", {})
    for name, version in seen.items():
        deps.setdefault(name, f"^{version}" if name in SEED else f"^{version}")
    pkg_path.write_text(json.dumps(pkg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("package.json deps:", json.dumps(deps, indent=2))


if __name__ == "__main__":
    main()
