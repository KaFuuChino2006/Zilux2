# -*- coding: utf-8 -*-
"""经典歌词布局：固定镜头 + 封面从磁贴飞入。"""
import io

p = r"E:\Zilux2开发\web\src\three\floatScene.ts"
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# 1. 接口：setClassicCover(url, title?)
old = "  setClassicCover(url: string | null): void;"
assert s.count(old) == 1
s = s.replace(old, "  setClassicCover(url: string | null, title?: string): void;", 1)

# 2. 状态：飞入起点与进度
old = "  let classicCoverAmount = 0;"
assert s.count(old) == 1
s = s.replace(
    old,
    """  let classicCoverAmount = 0;
  let classicCoverTravel = 0;
  let classicCoverFromLocal: THREE.Vector3 | null = null;
  const classicCoverTemp = new THREE.Vector3();""",
    1,
)

# 3. setClassicCover 捕获磁贴世界坐标
old = """  function setClassicCover(url: string | null): void {
    classicCoverUrl = url;
    if (!url) {
      if (classicCoverGroup) classicCoverGroup.visible = false;
      classicCoverAmount = 0;
      return;
    }
    ensureClassicCover();"""
assert s.count(old) == 1
s = s.replace(
    old,
    """  function setClassicCover(url: string | null, title?: string): void {
    classicCoverUrl = url;
    classicCoverTravel = 0;
    classicCoverFromLocal = null;
    if (!url) {
      if (classicCoverGroup) classicCoverGroup.visible = false;
      classicCoverAmount = 0;
      return;
    }
    ensureClassicCover();
    // 优先取「封面磁贴」当前的散开位置，让封面从磁贴飞入
    const source =
      tiles.find((tile) => tile.image && tile.image.src === url) ??
      (title ? tiles.find((tile) => tile.title === title && tile.image) : null) ??
      tiles.find((tile) => tile.image) ??
      null;
    if (source) {
      const world = source.group.getWorldPosition(classicCoverTemp);
      if (lyricGroup) classicCoverFromLocal = lyricGroup.worldToLocal(world.clone());
    }"""
    , 1,
)

# 4. updateClassicCover：飞入插值 + 浮动
old = """    const t = performance.now() * 0.001;
    classicCoverGroup.position.set(2.05, 0.02 + Math.sin(t * 0.7) * 0.03, 0.12);
    const scale = 0.94 + 0.06 * classicCoverAmount;
    classicCoverGroup.scale.setScalar(scale * (classicCoverAmount < 1 ? 1 : 1));
    classicCoverGroup.lookAt(camera.position);
    classicCoverMesh.material.opacity = classicCoverAmount * 0.98;"""
assert s.count(old) == 1
s = s.replace(
    old,
    """    const t = performance.now() * 0.001;
    const targetX = 2.05;
    const targetY = 0.02 + Math.sin(t * 0.7) * 0.03;
    const targetZ = 0.12;
    classicCoverTravel = Math.min(1, classicCoverTravel + delta * 1.5);
    const travel = classicCoverTravel;
    const ease = 1 - (1 - travel) ** 3;
    if (classicCoverFromLocal && travel < 1) {
      classicCoverGroup.position.set(
        classicCoverFromLocal.x + (targetX - classicCoverFromLocal.x) * ease,
        classicCoverFromLocal.y + (targetY - classicCoverFromLocal.y) * ease,
        classicCoverFromLocal.z + (targetZ - classicCoverFromLocal.z) * ease,
      );
    } else {
      classicCoverGroup.position.set(targetX, targetY, targetZ);
    }
    const scale = (0.55 + 0.45 * ease) * (0.94 + 0.06 * classicCoverAmount);
    classicCoverGroup.scale.setScalar(scale);
    classicCoverGroup.lookAt(camera.position);
    classicCoverMesh.material.opacity = classicCoverAmount * 0.98;"""
    , 1,
)

# 5. 固定镜头（经典模式）
old = """    if (lyricAmount > 0.001) {
      lyricAnchor(Math.max(0, lyricActive), lyricLookTarget);
      lyricLookTarget.y += Math.sin(seconds * 0.33) * 0.09;"""
assert s.count(old) == 1
s = s.replace(
    old,
    """    if (lyricAmount > 0.001 && lyricLayoutClassic) {
      // 经典模式：镜头固定在左侧歌词前方，不随句子移动、不摇摆
      lyricAnchorFor(0, classicCoverTemp);
      lyricLookTarget.copy(classicCoverTemp);
      lyricCamPos.set(classicCoverTemp.x + 0.4, classicCoverTemp.y + 0.6, classicCoverTemp.z + 4.4);
      if (lyricGroup) {
        lyricGroup.localToWorld(lyricLookTarget);
        lyricGroup.localToWorld(lyricCamPos);
      }
      camera.up.set(0, 1, 0);
      const dtClassic = Math.min(delta, 0.05);
      camera.position.lerp(lyricCamPos, Math.min(1, dtClassic * 2.4));
      lookTarget.lerp(lyricLookTarget, Math.min(1, dtClassic * 2.4));
    } else if (lyricAmount > 0.001) {
      lyricAnchor(Math.max(0, lyricActive), lyricLookTarget);
      lyricLookTarget.y += Math.sin(seconds * 0.33) * 0.09;""",
    1,
)

# 6. handle 实现签名
old = """    setClassicCover(url) {
      setClassicCover(url);
    },"""
assert s.count(old) == 1
s = s.replace(
    old,
    """    setClassicCover(url, title) {
      setClassicCover(url, title);
    },""",
    1,
)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('classic camera + cover fly-in patched')
