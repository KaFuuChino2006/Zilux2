# -*- coding: utf-8 -*-
"""空间灯光改为「摄像机处直视照明」：光源跟着相机走，照亮看到的地方。"""
import io, sys

SCENE = r"E:\Zilux2开发\web\src\three\floatScene.ts"


def read(p):
    with io.open(p, "r", encoding="utf-8") as f:
        return f.read()


def write(p, s):
    with io.open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(s)


def rep(text, old, new, count=1):
    n = text.count(old)
    if n != count:
        sys.stderr.write("MISMATCH count=%d expected=%d\n---\n%s\n" % (n, count, old[:500]))
        raise SystemExit(1)
    return text.replace(old, new)


scene = read(SCENE)

# 1) key light 强度基数提高（光源移到相机后到磁贴距离变长）
scene = rep(
    scene,
    "      keyLight.intensity = (42 + lightingPulse * 90) * strength;",
    "      keyLight.intensity = (64 + lightingPulse * 120) * strength;",
)

# 2) key light 位置：相机处（略微上移 0.18，避免自阴影条纹），目标是视线中心
scene = rep(
    scene,
    """      // 主光跟随镜头视线中心，从右上打向墙面
      keyLight.position.set(lookTarget.x + 2.8, lookTarget.y + 4.6, lookTarget.z + 5.2);
      keyLight.target.position.copy(lookTarget);""",
    """      // 主光放在摄像机处：看见哪里就照亮哪里，模拟直视照明（不再从侧上方打光）
      keyLight.position.set(camera.position.x, camera.position.y + 0.18, camera.position.z);
      keyLight.target.position.copy(lookTarget);""",
)

# 3) 歌词灯也跟到摄像机（略偏上），保证直视方向的歌词被照亮
scene = rep(
    scene,
    """        lyricLight.position.set(lookTarget.x, lookTarget.y + 2.6, lookTarget.z + 3.4);""",
    """        lyricLight.position.set(camera.position.x, camera.position.y + 0.5, camera.position.z);""",
)

# 4) 直视照明下环境光略提，避免暗部死黑（阴影侧仍有细节）
scene = rep(
    scene,
    "      ambientLight.intensity = 0.22 * strength;",
    "      ambientLight.intensity = 0.34 * strength;",
)

write(SCENE, scene)
print("LIGHT-PATCH-OK")
