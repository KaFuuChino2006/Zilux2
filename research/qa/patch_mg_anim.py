# -*- coding: utf-8 -*-
"""MG 动画（3D 扫光长条 + 几何线条装饰）+ 歌词从下升起布局。"""

import io

P = r"E:\Zilux2开发\web\src\three\floatScene.ts"
s = io.open(P, "r", encoding="utf-8", newline="").read()


def rep(old, new, count=1):
    global s
    assert s.count(old) == count, old[:80]
    s = s.replace(old, new, count)


# 1) 状态
rep(
    "  let lyricSweepEnabled = true;",
    """  let lyricSweepEnabled = true;
  // MG 动画：3D 扫光长条 + 几何线条装饰；歌词布局 random=随机落点 / rise=从下升起
  let mgSweepEnabled = true;
  let mgLinesEnabled = true;
  let lyricLayout: 'random' | 'rise' = 'random';
  let mgSweepLife = -1;
  let mgSweepKind = 0;
  let mgSweepFlip = false;
  let mgSweepBar: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null = null;
  type MgLineView = {
    plane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
    life: number;
    max: number;
    vx: number;
    vy: number;
    rotSpeed: number;
  };
  const mgLines: MgLineView[] = [];
  let mgGroup: THREE.Group | null = null;
  const mgActivePos = new THREE.Vector3();""",
)

# 2) 函数：放在 ensurePvLines 之前
rep(
    "  function ensurePvLines(): void {",
    """  function ensureMgLayer(): void {
    if (mgGroup) return;
    mgGroup = new THREE.Group();
    mgGroup.renderOrder = 46;
    (lyricGroup ?? scene).add(mgGroup);
    mgSweepBar = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: '#ffffff',
        transparent: true,
        opacity: 0,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
      }),
    );
    mgSweepBar.visible = false;
    mgSweepBar.renderOrder = 46;
    mgGroup.add(mgSweepBar);
    const lineGeo = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < 16; i += 1) {
      const mat = new THREE.MeshBasicMaterial({
        color: '#ffffff',
        transparent: true,
        opacity: 0,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
      });
      const plane = new THREE.Mesh(lineGeo, mat);
      plane.visible = false;
      plane.renderOrder = 47;
      mgGroup.add(plane);
      mgLines.push({ plane, life: 0, max: 1, vx: 0, vy: 0, rotSpeed: 0 });
    }
  }

  function triggerMgSweep(): void {
    if (!mgSweepEnabled) return;
    ensureMgLayer();
    if (!mgSweepBar) return;
    mgSweepLife = 0;
    mgSweepKind = Math.floor(Math.random() * 4);
    mgSweepFlip = Math.random() < 0.35;
    const kind = mgSweepKind;
    if (kind === 0) mgSweepBar.scale.set(0.62, 1.5, 1);
    else if (kind === 1) mgSweepBar.scale.set(1.05, 1.7, 1);
    else if (kind === 2) mgSweepBar.scale.set(0.16, 1.7, 1);
    else mgSweepBar.scale.set(1.7, 0.52, 1);
    mgSweepBar.material.color.set(lyricPalette[2] ?? '#ffffff');
    mgSweepBar.visible = true;
  }

  function spawnMgLines(): void {
    if (!mgLinesEnabled) return;
    ensureMgLayer();
    let spawned = 0;
    for (const line of mgLines) {
      if (line.life > 0) continue;
      if (spawned >= 6) break;
      spawned += 1;
      line.max = 0.85 + Math.random() * 0.75;
      line.life = line.max;
      const angle = Math.random() * Math.PI;
      line.plane.scale.set(1.1 + Math.random() * 3.2, 0.012 + Math.random() * 0.03, 1);
      line.plane.rotation.set(0, 0, angle);
      line.plane.position.set(
        (Math.random() - 0.5) * 10,
        (Math.random() - 0.5) * 5.2,
        -1.6 + Math.random() * 2.4,
      );
      line.vx = (Math.random() - 0.5) * 0.5;
      line.vy = (Math.random() - 0.5) * 0.34;
      line.rotSpeed = (Math.random() - 0.5) * 0.6;
      line.plane.material.color.set(
        lyricPalette[Math.floor(Math.random() * lyricPalette.length)] ?? '#ffffff',
      );
      line.plane.visible = true;
    }
  }

  function updateMg(delta: number): void {
    if (!mgGroup) return;
    if (mgSweepBar) {
      if (mgSweepLife >= 0) {
        mgSweepLife += delta / 0.5;
        if (mgSweepLife > 1) {
          mgSweepLife = -1;
          mgSweepBar.visible = false;
        } else {
          const t = mgSweepLife;
          const span = 4.6;
          const dir = mgSweepFlip ? 1 : -1;
          mgSweepBar.position.set(
            mgActivePos.x + dir * (span * 0.5 - t * span),
            mgActivePos.y,
            mgActivePos.z + 0.14,
          );
          mgSweepBar.lookAt(camera.position);
          if (mgSweepKind === 1) mgSweepBar.rotateZ(0.62);
          if (mgSweepKind === 2) mgSweepBar.rotateZ(Math.PI / 2);
          mgSweepBar.material.opacity = Math.sin(Math.PI * Math.min(1, t)) * 0.92;
        }
      }
    }
    for (const line of mgLines) {
      if (line.life <= 0) continue;
      line.life -= delta;
      if (line.life <= 0) {
        line.plane.visible = false;
        continue;
      }
      const p = line.life / line.max;
      line.plane.material.opacity = Math.sin(Math.PI * p) * 0.85;
      line.plane.position.x += line.vx * delta;
      line.plane.position.y += line.vy * delta;
      line.plane.rotation.z += line.rotSpeed * delta;
    }
  }

  function ensurePvLines(): void {""",
)

# 3) setLyricsTime：换句时触发
rep(
    """        if (lyricSweepEnabled && active >= 0) {
          lyricSweep = 0;
          lyricSweepKind = Math.floor(Math.random() * 3);
          lyricSweepStrength = 0.62 + Math.random() * 0.26;
        }""",
    """        if (lyricSweepEnabled && active >= 0) {
          lyricSweep = 0;
          lyricSweepKind = Math.floor(Math.random() * 3);
          lyricSweepStrength = 0.62 + Math.random() * 0.26;
        }
        if (active >= 0) {
          triggerMgSweep();
          spawnMgLines();
        }""",
)

# 4) 上一句：从下升起布局时向上顶 + 文字更快消失
rep(
    "        prev.group.position.set(prevX, prevY, lyricAnchorTemp.z);",
    """        if (lyricLayout === 'rise') prevY += out * 2.6;
        prev.group.position.set(prevX, prevY, lyricAnchorTemp.z);""",
)
rep(
    "        prev.plane.material.uniforms.uOpacity!.value = ease * prev.amount * 0.8;",
    """        prev.plane.material.uniforms.uOpacity!.value =
          ease * prev.amount * (lyricLayout === 'rise' ? 0.32 + 0.68 * prev.amount : 0.8);""",
)

# 5) 当前句：从下升起布局时从画面下方升起
rep(
    "      view.group.position.set(enterX, enterY, lyricAnchorTemp.z);",
    """      if (lyricLayout === 'rise') enterY -= (1 - enter) * 5.6;
      view.group.position.set(enterX, enterY, lyricAnchorTemp.z);
      mgActivePos.set(enterX, enterY, lyricAnchorTemp.z);""",
)

# 6) frame 中更新 MG
rep("    updateLyrics(delta);", "    updateLyrics(delta);\n    updateMg(delta);")

# 7) 接口
rep(
    "  setLyricSweepEnabled(enabled: boolean): void;",
    """  setLyricSweepEnabled(enabled: boolean): void;
  setLyricMg(sweep: boolean, lines: boolean): void;
  setLyricLayout(layout: 'random' | 'rise'): void;""",
)
# 8) 实现
rep(
    """    setLyricSweepEnabled(enabled) {
      lyricSweepEnabled = enabled;
      if (!enabled) lyricSweep = -1;
    },""",
    """    setLyricSweepEnabled(enabled) {
      lyricSweepEnabled = enabled;
      if (!enabled) lyricSweep = -1;
    },
    setLyricMg(sweep, lines) {
      mgSweepEnabled = sweep;
      mgLinesEnabled = lines;
      if (!sweep && mgSweepBar) {
        mgSweepLife = -1;
        mgSweepBar.visible = false;
      }
      if (!lines) {
        for (const line of mgLines) {
          line.life = 0;
          line.plane.visible = false;
        }
      }
    },
    setLyricLayout(layout) {
      lyricLayout = layout;
    },""",
)

io.open(P, "w", encoding="utf-8", newline="").write(s)
print("floatScene MG + rise layout patched")
