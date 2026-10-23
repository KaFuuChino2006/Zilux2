import io
from pathlib import Path
p = Path('web/src/three/floatScene.ts')
text = p.open(encoding='utf-8', newline='').read()
crlf = '\r\n' in text

def rep(old, count=1):
    global text
    n = text.count(old)
    assert n == count, f'count={n} for {old[:60]!r}'
    text = text.replace(old, new)

# 1) wrap 距离方向修正：NEAR-FAR 才是正的环绕距离，原来 FAR-NEAR 为负，会把粒子一帧帧推向相机背后（进歌词模式相机一动就整片消失）
rep("  const FX_WRAP_Z = FX_FAR - FX_NEAR;",
    "  // 注意：环绕距离必须是 NEAR - FAR（正值）。写成 FAR - NEAR 会变成负值，\n"
    "  // 于是每次往“远侧”搬运反而把粒子越推越近、最终全部飞到相机背后，整片粒子消失。\n"
    "  const FX_WRAP_Z = FX_NEAR - FX_FAR;")

# 2) 安全网：相机大幅移动（进/出歌词、拖拽缩放）后，逐帧把仍在范围外的粒子一次性拉回，
#    避免单帧只搬一格的滞后；同时每帧最多循环几次防止死循环。
rep("""      const dz = positions[o + 2] - camZ;
      if (dz > FX_NEAR) positions[o + 2] -= FX_WRAP_Z;
      else if (dz < FX_FAR) positions[o + 2] += FX_WRAP_Z;""",
    """      let dz = positions[o + 2] - camZ;
      // 相机瞬移（进歌词/退出歌词/缩放）后可能一次跨很多个单位，循环拉回保证始终在身前区间
      for (let guard = 0; guard < 4; guard += 1) {
        if (dz > FX_NEAR) {
          positions[o + 2] -= FX_WRAP_Z;
          dz -= FX_WRAP_Z;
        } else if (dz < FX_FAR) {
          positions[o + 2] += FX_WRAP_Z;
          dz += FX_WRAP_Z;
        } else {
          break;
        }
      }""")

out = text.replace('\n', '\r\n') if crlf else text
p.open('w', encoding='utf-8', newline='').write(out)
print('OK: wrap-sign, wrap-guard')
