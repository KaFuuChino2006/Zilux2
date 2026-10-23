import io
import sys

PATH = r"E:\Zilux2开发\web\src\three\floatScene.ts"

with io.open(PATH, "r", encoding="utf-8", newline="") as handle:
    text = handle.read()

crlf = "\r\n" in text
nl = "\r\n" if crlf else "\n"


def rep(old, new, count=1, label=""):
    global text
    if text.count(old) != count:
        raise AssertionError("%s: expected %d got %d" % (label or old[:40], count, text.count(old)))
    text = text.replace(old, new, count)
    print("OK:", label)


# ---------------------------------------------------------------- 1. Tile/SongRow 接口加背板字段
rep(
    "    backPlane: THREE.Mesh<THREE.PlaneGeometry, THREE.Material>;" + nl,
    "    backPlane: THREE.Mesh<THREE.PlaneGeometry, THREE.Material>;" + nl
    + "    backPlate: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;" + nl,
    label="tile-interface",
)

rep(
    "  interface SongRow {" + nl
    + "    group: THREE.Group;" + nl
    + "    plane: THREE.Mesh<THREE.PlaneGeometry, THREE.Material>;" + nl,
    "  interface SongRow {" + nl
    + "    group: THREE.Group;" + nl
    + "    plane: THREE.Mesh<THREE.PlaneGeometry, THREE.Material>;" + nl
    + "    backPlate: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null;" + nl,
    label="song-interface",
)

rep(
    "    songRows.push({ group, plane, texture, canvas: rowCanvas, hoverT: 0, index: i });",
    "    songRows.push({ group, plane, backPlate: null, texture, canvas: rowCanvas, hoverT: 0, index: i });",
    label="song-push",
)

# ---------------------------------------------------------------- 2. 背板贴图/材质/几何
assets = nl.join(
    [
        "  const TILE_SIZE = 0.98;",
        "  /** 磁贴背板：从墙背面看是一张深色卡背（正面片被背面剔除，不补就会整墙透明） */",
        "  const tileBackTexture = ((): THREE.CanvasTexture => {",
        "    const size = 256;",
        "    const canvas = document.createElement('canvas');",
        "    canvas.width = size;",
        "    canvas.height = size;",
        "    const ctx = canvas.getContext('2d');",
        "    if (ctx) {",
        "      const pad = size * 0.055;",
        "      const radius = size * 0.1;",
        "      const roundRect = (x: number, y: number, w: number, h: number, r: number): void => {",
        "        ctx.beginPath();",
        "        ctx.moveTo(x + r, y);",
        "        ctx.arcTo(x + w, y, x + w, y + h, r);",
        "        ctx.arcTo(x + w, y + h, x, y + h, r);",
        "        ctx.arcTo(x, y + h, x, y, r);",
        "        ctx.arcTo(x, y, x + w, y, r);",
        "        ctx.closePath();",
        "      };",
        "      const base = ctx.createLinearGradient(0, 0, size, size);",
        "      base.addColorStop(0, 'rgba(30, 33, 42, 0.99)');",
        "      base.addColorStop(0.56, 'rgba(15, 17, 23, 0.99)');",
        "      base.addColorStop(1, 'rgba(9, 10, 14, 0.99)');",
        "      roundRect(pad, pad, size - pad * 2, size - pad * 2, radius);",
        "      ctx.fillStyle = base;",
        "      ctx.fill();",
        "      ctx.lineWidth = Math.max(1, size * 0.006);",
        "      ctx.strokeStyle = 'rgba(214, 189, 135, 0.42)';",
        "      const inset = pad + size * 0.024;",
        "      roundRect(inset, inset, size - inset * 2, size - inset * 2, radius * 0.86);",
        "      ctx.stroke();",
        "      ctx.save();",
        "      ctx.translate(size / 2, size / 2);",
        "      ctx.rotate(Math.PI / 4);",
        "      const d = size * 0.105;",
        "      ctx.strokeStyle = 'rgba(226, 205, 156, 0.5)';",
        "      ctx.lineWidth = Math.max(1, size * 0.008);",
        "      ctx.strokeRect(-d, -d, d * 2, d * 2);",
        "      ctx.fillStyle = 'rgba(232, 214, 168, 0.92)';",
        "      ctx.beginPath();",
        "      ctx.arc(0, 0, size * 0.015, 0, Math.PI * 2);",
        "      ctx.fill();",
        "      ctx.restore();",
        "      const sheen = ctx.createLinearGradient(0, 0, 0, size);",
        "      sheen.addColorStop(0, 'rgba(255, 255, 255, 0.08)');",
        "      sheen.addColorStop(0.42, 'rgba(255, 255, 255, 0)');",
        "      sheen.addColorStop(1, 'rgba(0, 0, 0, 0.32)');",
        "      roundRect(pad, pad, size - pad * 2, size - pad * 2, radius);",
        "      ctx.fillStyle = sheen;",
        "      ctx.fill();",
        "    }",
        "    const texture = new THREE.CanvasTexture(canvas);",
        "    texture.colorSpace = THREE.SRGBColorSpace;",
        "    texture.generateMipmaps = false;",
        "    texture.minFilter = THREE.LinearFilter;",
        "    texture.magFilter = THREE.LinearFilter;",
        "    return texture;",
        "  })();",
        "  const tileBackGeometry = new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE);",
        "  const tileBackMaterial = new THREE.MeshBasicMaterial({ map: tileBackTexture, transparent: true, depthWrite: false });",
        "  const songBackGeometry = new THREE.PlaneGeometry(SONG_W, SONG_H);",
        "  const songBackMaterial = new THREE.MeshBasicMaterial({ color: '#0b0d12', transparent: true, opacity: 0.96, depthWrite: false });",
        "  for (const row of songRows) {",
        "    const back = new THREE.Mesh(songBackGeometry, songBackMaterial);",
        "    back.rotation.y = Math.PI;",
        "    back.position.z = -0.012;",
        "    back.visible = false;",
        "    row.group.add(back);",
        "    row.backPlate = back;",
        "  }",
    ]
)
rep("  const TILE_SIZE = 0.98;", assets, label="back-assets")

# ---------------------------------------------------------------- 3. 磁贴背板创建
rep(
    "    backPlane.position.z = -0.002;" + nl + "    backPlane.visible = false;",
    "    backPlane.position.z = -0.002;" + nl
    + "    backPlane.visible = false;" + nl
    + "    const backPlate = new THREE.Mesh(tileBackGeometry, tileBackMaterial);" + nl
    + "    backPlate.rotation.y = Math.PI;" + nl
    + "    backPlate.position.z = -0.012;" + nl
    + "    backPlate.visible = false;",
    label="tile-backplate",
)

rep(
    "    group.add(backPlane);" + nl + "    group.add(hit);",
    "    group.add(backPlane);" + nl + "    group.add(backPlate);" + nl + "    group.add(hit);",
    label="tile-group-add",
)

rep(
    "      backPlane," + nl + "      backImage: null,",
    "      backPlane," + nl + "      backPlate," + nl + "      backImage: null,",
    label="tile-object",
)

# ---------------------------------------------------------------- 4. 每帧更新背板可见性
rep(
    "    tiles.push(tile);" + nl + "    }" + nl + "  }",
    "    tiles.push(tile);" + nl + "    }" + nl + "  }" + nl + nl
    + "  const tileBackDir = new THREE.Vector3();" + nl
    + "  /** 相机转到墙背面时显示背板：正面片被背面剔除，没有背板整墙就是透明的 */" + nl
    + "  function updateTileBacks(): void {" + nl
    + "    camera.getWorldDirection(tileBackDir);" + nl
    + "    const behind = !flipping && tileBackDir.z > 0.08;" + nl
    + "    for (const tile of tiles) {" + nl
    + "      tile.backPlate.visible = behind && tile.group.visible;" + nl
    + "    }" + nl
    + "    for (const row of songRows) {" + nl
    + "      if (row.backPlate) row.backPlate.visible = behind && row.group.visible;" + nl
    + "    }" + nl
    + "  }",
    label="update-tile-backs",
)

rep(
    "    renderer.render(scene, camera);",
    "    updateTileBacks();" + nl + "    renderer.render(scene, camera);",
    label="frame-call",
)

with io.open(PATH, "w", encoding="utf-8", newline="") as handle:
    handle.write(text)

print("WROTE", PATH)
