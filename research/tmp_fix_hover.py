# -*- coding: utf-8 -*-
"""修复：①登录卡 hover 抖动（改用固定命中平面 + 平滑 hover 过渡）；②空间浮层层级。"""
import io
import sys

TS = r"E:\Zilux2开发\web\src\three\loginSpace.ts"
CSS = r"E:\Zilux2开发\web\src\styles\space.css"

errors = []


def load(path):
    with io.open(path, "r", encoding="utf-8-sig", newline="") as fh:
        return fh.read()


def save(path, text):
    with io.open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


def replace_once(text, old, new, label):
    if text.count(old) != 1:
        errors.append("%s: expected 1 match, found %d" % (label, text.count(old)))
        return text
    return text.replace(old, new, 1)


ts = load(TS)

# 1) Card 增加固定的命中平面与平滑 hover 进度
ts = replace_once(
    ts,
    """interface Card {
  source: Source;
  group: THREE.Group;
  plane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  texture: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  face: Face;
  hovered: boolean;
  scale: number;
  baseX: number;
  phase: number;
}""",
    """interface Card {
  source: Source;
  group: THREE.Group;
  plane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  /** 固定在基础位置上的不可见命中平面：卡片做 hover 位移动画时，命中区域不跟着动，避免抖动。 */
  hitPlane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  texture: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  face: Face;
  hovered: boolean;
  /** 0→1 的 hover 进度，所有 hover 表现都由它插值，避免属性跳变。 */
  hoverT: number;
  baseX: number;
  phase: number;
}""",
    "Card interface",
)

# 2) 创建卡片时同时创建命中平面（挂在 group 下，跟随整体变换但不参与 hover 位移动画）
ts = replace_once(
    ts,
    """    const face = defaultFace(source);
    drawCard(canvasEl, face, source);
    texture.needsUpdate = true;

    cards.push({
      source,
      group: cardGroup,
      plane,
      texture,
      canvas: canvasEl,
      face,
      hovered: false,
      scale: 1,
      baseX,
      phase: index * Math.PI * 0.7 + 0.4,
    });""",
    """    const face = defaultFace(source);
    drawCard(canvasEl, face, source);
    texture.needsUpdate = true;

    const hitMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
      colorWrite: false,
    });
    const hitPlane = new THREE.Mesh(geometry.clone(), hitMaterial);
    hitPlane.position.set(baseX, 0.16, index === 0 ? 0.06 : -0.06);
    hitPlane.rotation.y = index === 0 ? 0.1 : -0.1;
    group.add(hitPlane);

    cards.push({
      source,
      group: cardGroup,
      plane,
      hitPlane,
      texture,
      canvas: canvasEl,
      face,
      hovered: false,
      hoverT: 0,
      baseX,
      phase: index * Math.PI * 0.7 + 0.4,
    });""",
    "card creation",
)

# 3) 命中检测使用固定命中平面
ts = replace_once(
    ts,
    """      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(cards.map((card) => card.plane), false);
      nextHovered = hits.length > 0 ? cards[hits[0].object === cards[0].plane ? 0 : 1].source : null;""",
    """      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(cards.map((card) => card.hitPlane), false);
      nextHovered = hits.length > 0 ? cards[hits[0].object === cards[0].hitPlane ? 0 : 1].source : null;""",
    "raycast targets",
)

# 4) hover 动画：全部走 hoverT 平滑插值，平滑更像"浮起"而不是"跳起"
ts = replace_once(
    ts,
    """    cards.forEach((card) => {
      card.plane.visible = loginOpacity > 0.002;
      card.plane.material.opacity = loginOpacity;
      card.hovered = hoveredSource === card.source;
      const targetScale = card.hovered ? 1.045 : 1;
      card.scale += (targetScale - card.scale) * Math.min(1, delta * 8);
      const bob = Math.sin(clockTime * 0.6 + card.phase) * 0.05;
      const hoverLift = card.hovered ? 0.13 : 0;
      card.group.position.y = 0.16 + bob + hoverLift;
      card.group.position.z = (card.source === 'netease' ? 0.06 : -0.06) + (card.hovered ? 0.16 : 0);
      card.group.scale.setScalar(card.scale);
      const targetRotY =
        (card.source === 'netease' ? 0.1 : -0.1) * (card.hovered ? 0.35 : 1);
      card.group.rotation.y += (targetRotY - card.group.rotation.y) * Math.min(1, delta * 6);
      card.group.rotation.x = card.hovered ? -0.02 : 0;
    });""",
    """    cards.forEach((card) => {
      card.plane.visible = loginOpacity > 0.002;
      card.plane.material.opacity = loginOpacity;
      card.hitPlane.visible = loginOpacity > 0.5;
      card.hovered = hoveredSource === card.source;
      const hoverTarget = card.hovered ? 1 : 0;
      card.hoverT += (hoverTarget - card.hoverT) * Math.min(1, delta * 7);
      const t = card.hoverT * card.hoverT * (3 - 2 * card.hoverT);
      const bob = Math.sin(clockTime * 0.6 + card.phase) * 0.05;
      card.group.position.y = 0.16 + bob + 0.1 * t;
      card.group.position.z = (card.source === 'netease' ? 0.06 : -0.06) + 0.1 * t;
      card.group.scale.setScalar(1 + 0.032 * t);
      const restYaw = card.source === 'netease' ? 0.1 : -0.1;
      card.group.rotation.y = restYaw * (1 - 0.32 * t);
      card.group.rotation.x = -0.018 * t;
    });""",
    "hover animation",
)

if errors:
    sys.stderr.write("ABORT loginSpace:\n" + "\n".join(errors) + "\n")
    sys.exit(1)
save(TS, ts)

css = load(CSS)
css = replace_once(
    css,
    """.space-brand {
  position: absolute;
  top: 26px;""",
    """.space-brand {
  position: absolute;
  z-index: 3;
  top: 26px;""",
    "brand z",
)
css = replace_once(
    css,
    """.space-caption {
  position: absolute;
  top: clamp(64px, 9.2vh, 108px);""",
    """.space-caption {
  position: absolute;
  z-index: 3;
  top: clamp(64px, 9.2vh, 108px);""",
    "caption z",
)
css = replace_once(
    css,
    """.space-foot {
  position: absolute;
  left: 50%;""",
    """.space-foot {
  position: absolute;
  z-index: 3;
  left: 50%;""",
    "foot z",
)
css = replace_once(
    css,
    """.space-actions {
  position: absolute;
  left: 50%;""",
    """.space-actions {
  position: absolute;
  z-index: 4;
  left: 50%;""",
    "actions z",
)
css = replace_once(
    css,
    """.space-back {
  position: absolute;
  top: 24px;""",
    """.space-back {
  position: absolute;
  z-index: 4;
  top: 24px;""",
    "back z",
)
if errors:
    sys.stderr.write("ABORT space.css:\n" + "\n".join(errors) + "\n")
    sys.exit(1)
save(CSS, css)
print("hover + z-index fixes applied")
