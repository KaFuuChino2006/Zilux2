# -*- coding: utf-8 -*-
"""背景粒子随鼓点运动：脉冲缩放/变亮、绕视线轴加速旋转、鼓点爆开。"""
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
        sys.stderr.write("MISMATCH count=%d expected=%d\n---\n%s\n" % (n, count, old[:600]))
        raise SystemExit(1)
    return text.replace(old, new)


scene = read(SCENE)

# 1) 鼓点状态 + 视线方向临时向量
scene = rep(
    scene,
    "  let fxLinkDist = 7.8;\n",
    "  let fxLinkDist = 7.8;\n"
    "  // 鼓点驱动：粒子脉冲缩放、绕视线轴加速旋转、向外爆开\n"
    "  let bgFxBeat = 0;\n"
    "  let bgFxBurst = 0;\n"
    "  const fxForward = new THREE.Vector3();\n",
)

# 2) updateBgFx 开头：衰减鼓点、更新尺寸/透明度
scene = rep(
    scene,
    "  function updateBgFx(delta: number, seconds: number): void {\n"
    "    fxStarMaterial.uniforms.uPixelRatio!.value = Math.min(window.devicePixelRatio || 1, 2);\n"
    "    if (fxCount <= 0) return;\n",
    "  function updateBgFx(delta: number, seconds: number): void {\n"
    "    fxStarMaterial.uniforms.uPixelRatio!.value = Math.min(window.devicePixelRatio || 1, 2);\n"
    "    const beatDt = Math.min(0.05, delta);\n"
    "    bgFxBeat = Math.max(0, bgFxBeat - beatDt * 2.3);\n"
    "    bgFxBurst = Math.max(0, bgFxBurst - beatDt * 1.6);\n"
    "    // 鼓点时整片粒子放大、变亮，随后自动回落\n"
    "    const beatSize = 1 + bgFxBeat * 0.6;\n"
    "    fxStarMaterial.uniforms.uSize!.value = fxSize * beatSize;\n"
    "    fxStarMaterial.uniforms.uOpacity!.value = Math.min(1, fxOpacity + bgFxBeat * 0.36);\n"
    "    fxTriangleMaterial.size = 0.36 * fxSize * beatSize;\n"
    "    fxTriangleMaterial.opacity = Math.min(1, fxOpacity + bgFxBeat * 0.36);\n"
    "    fxLinkMaterial.opacity = Math.min(0.8, 0.34 + bgFxBeat * 0.42);\n"
    "    if (fxCount <= 0) return;\n",
)

# 3) 循环前预计算视线方向与旋转角
scene = rep(
    scene,
    "    const camX = camera.position.x;\n"
    "    const camY = camera.position.y;\n"
    "    const camZ = camera.position.z;\n",
    "    const camX = camera.position.x;\n"
    "    const camY = camera.position.y;\n"
    "    const camZ = camera.position.z;\n"
    "    camera.getWorldDirection(fxForward);\n"
    "    const fwdX = fxForward.x;\n"
    "    const fwdY = fxForward.y;\n"
    "    const fwdZ = fxForward.z;\n"
    "    const spinAng = beatDt * (0.05 + bgFxBeat * 2.1);\n"
    "    const spinCos = Math.cos(spinAng);\n"
    "    const spinSin = Math.sin(spinAng);\n"
    "    const spinOne = 1 - spinCos;\n",
)

# 4) 循环内：鼓点爆开 + 绕视线轴旋转
scene = rep(
    scene,
    "      const dz = fxPositions[o + 2] - camZ;\n"
    "      if (dz > FX_HALF.z) fxPositions[o + 2] -= FX_HALF.z * 2;\n"
    "      else if (dz < -FX_HALF.z) fxPositions[o + 2] += FX_HALF.z * 2;\n"
    "    }\n"
    "    fxGeometry.attributes.position!.needsUpdate = true;\n",
    "      const dz = fxPositions[o + 2] - camZ;\n"
    "      if (dz > FX_HALF.z) fxPositions[o + 2] -= FX_HALF.z * 2;\n"
    "      else if (dz < -FX_HALF.z) fxPositions[o + 2] += FX_HALF.z * 2;\n"
    "      const px = fxPositions[o] - camX;\n"
    "      const py = fxPositions[o + 1] - camY;\n"
    "      const pz = fxPositions[o + 2] - camZ;\n"
    "      if (bgFxBurst > 0.004) {\n"
    "        // 鼓点爆开：从视线中心向外推开\n"
    "        const plen = Math.sqrt(px * px + py * py + pz * pz) || 1;\n"
    "        const push = (bgFxBurst * beatDt * (1.5 + seed * 1.4)) / plen;\n"
    "        fxPositions[o] += px * push;\n"
    "        fxPositions[o + 1] += py * push;\n"
    "        fxPositions[o + 2] += pz * push;\n"
    "      }\n"
    "      // 鼓点旋转：整片粒子绕视线轴加速旋转\n"
    "      const dotF = px * fwdX + py * fwdY + pz * fwdZ;\n"
    "      const crossX = fwdY * pz - fwdZ * py;\n"
    "      const crossY = fwdZ * px - fwdX * pz;\n"
    "      const crossZ = fwdX * py - fwdY * px;\n"
    "      fxPositions[o] = camX + px * spinCos + crossX * spinSin + fwdX * dotF * spinOne;\n"
    "      fxPositions[o + 1] = camY + py * spinCos + crossY * spinSin + fwdY * dotF * spinOne;\n"
    "      fxPositions[o + 2] = camZ + pz * spinCos + crossZ * spinSin + fwdZ * dotF * spinOne;\n"
    "    }\n"
    "    fxGeometry.attributes.position!.needsUpdate = true;\n",
)

# 5) 鼓点触发处给粒子注入脉冲
scene = rep(
    scene,
    "  function triggerBeatEffectInternal(kind: 'ring' | 'firework', intensity: number, colors?: string[]): void {\n"
    "    ensureBeatEffects();\n",
    "  function triggerBeatEffectInternal(kind: 'ring' | 'firework', intensity: number, colors?: string[]): void {\n"
    "    ensureBeatEffects();\n"
    "    // 背景粒子同步响应鼓点：亮度脉冲 + 旋转加速 + 向外爆开\n"
    "    bgFxBeat = Math.max(bgFxBeat, Math.min(1.3, 0.4 + intensity * 0.95));\n"
    "    bgFxBurst = Math.max(bgFxBurst, 0.55 + intensity * 1.15);\n",
)

write(SCENE, scene)
print("FX-BEAT-PATCH-OK")
