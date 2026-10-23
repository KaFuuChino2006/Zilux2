# -*- coding: utf-8 -*-
"""按钮/hover 修好后的第二轮手感与观感修复：
1) 拖动上下方向翻转
2) 滚轮缩放加快
3) 删掉玻璃边框高光层（用户要求整块玻璃、无边框切割）
4) 玻璃下方的默认背景并进玻璃纹理本身（去掉独立 bgBlur 层，避免内圈切割）
5) 阴影纹理加边缘淡出遮罩（消除方形硬切）
6) mask 加羽化（圆角边缘抗锯齿）
"""
import io

p = r"E:\Zilux2开发\web\src\three\loginSpace.ts"
lines = io.open(p, "r", encoding="utf-8", newline="").read().split("\n")


def seg(a, b):
    return "\n".join(lines[a - 1:b])


def check(a, b, needle):
    body = seg(a, b)
    assert needle in body, "unexpected segment %d-%d: %r" % (a, b, body[:120])


check(699, 699, "磨砂玻璃层")
check(731, 731, "玻璃边缘高光")
check(754, 754, "地面投影")
check(789, 789, "addSpacePlane(shadowCanvas")
check(829, 829, "viewTarget.pitch = clamp(viewTarget.pitch + dy * 0.0042")
check(831, 831, "pitchVelocity = dy * 0.0042 * 0.6")
check(890, 890, "viewTarget.radius = clamp(viewTarget.radius + event.deltaY * 0.0018")

# --- 从后往前替换，避免行号漂移 ---

# 890: 滚轮更快
lines[890 - 1] = "    viewTarget.radius = clamp(viewTarget.radius + event.deltaY * 0.0042, 6.6, 22);"

# 831 / 829: 拖动上下方向翻转（向下拖 -> 视角更平；向上拖 -> 更俯视）
lines[831 - 1] = "      pitchVelocity = -dy * 0.0042 * 0.6;"
lines[829 - 1] = "      viewTarget.pitch = clamp(viewTarget.pitch - dy * 0.0042, 0.04, 1.3);"

# 789-792: 只保留「阴影 + 一整块玻璃」两层
lines[788:792] = [
    "  addSpacePlane(shadowCanvas, GROUND_W + 0.6, GROUND_D + 0.6, -0.26, 0.9);",
    "  addSpacePlane(glassCanvas, GROUND_W, GROUND_D, 0, 1, groundMask);",
]

# 754-768: 阴影纹理：径向渐隐 + destination-in 边缘归零，消除方形切割
shadow_new = '''  /* 地面投影：径向柔光，四周完全淡出（避免方形的硬切边） */
  const shadowCanvas = document.createElement('canvas');
  shadowCanvas.width = 1024;
  shadowCanvas.height = Math.round((1024 * GROUND_D) / GROUND_W);
  const shadowCtx = shadowCanvas.getContext('2d');
  if (shadowCtx) {
    const W = shadowCanvas.width;
    const H = shadowCanvas.height;
    const halo = shadowCtx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W * 0.52);
    halo.addColorStop(0, 'rgba(23, 26, 33, 0.16)');
    halo.addColorStop(0.55, 'rgba(23, 26, 33, 0.10)');
    halo.addColorStop(1, 'rgba(23, 26, 33, 0)');
    shadowCtx.fillStyle = halo;
    shadowCtx.fillRect(0, 0, W, H);

    const fade = shadowCtx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
    fade.addColorStop(0, 'rgba(0,0,0,1)');
    fade.addColorStop(0.5, 'rgba(0,0,0,1)');
    fade.addColorStop(1, 'rgba(0,0,0,0)');
    shadowCtx.globalCompositeOperation = 'destination-in';
    shadowCtx.fillStyle = fade;
    shadowCtx.fillRect(0, 0, W, H);
    shadowCtx.globalCompositeOperation = 'source-over';
  }'''.split("\n")
lines[753:768] = shadow_new

# 731-752: 删除玻璃边缘高光层（用户：整块玻璃、不要边框）
del lines[730:752]

# 700-729: 玻璃层重写为一整块（背景内容并进玻璃纹理内部）
glass_new = '''  /* 磨砂玻璃层：一整块圆角玻璃，内部直接承载「玻璃下方」的默认背景 */
  const glassCanvas = document.createElement('canvas');
  glassCanvas.width = groundCanvas.w;
  glassCanvas.height = groundCanvas.h;
  const glassCtx = glassCanvas.getContext('2d');
  if (glassCtx) {
    const W = glassCanvas.width;
    const H = glassCanvas.height;
    const radius = (W * GROUND_RADIUS) / GROUND_W;
    glassCtx.clearRect(0, 0, W, H);

    /* 玻璃下方的默认背景（以后换成用户图片时替换这一段即可） */
    glassCtx.save();
    spaceRoundRect(glassCtx, 0, 0, W, H, radius);
    glassCtx.clip();
    const base = glassCtx.createLinearGradient(0, 0, W, H);
    base.addColorStop(0, '#d9e4ff');
    base.addColorStop(0.45, '#ece8ff');
    base.addColorStop(1, '#cfe6ff');
    glassCtx.fillStyle = base;
    glassCtx.fillRect(0, 0, W, H);
    const blob = (cx: number, cy: number, r: number, color: string): void => {
      const g = glassCtx.createRadialGradient(cx * W, cy * H, 0, cx * W, cy * H, r * W);
      g.addColorStop(0, color);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      glassCtx.fillStyle = g;
      glassCtx.fillRect(0, 0, W, H);
    };
    blob(0.24, 0.3, 0.5, 'rgba(120, 110, 255, 0.58)');
    blob(0.78, 0.26, 0.44, 'rgba(66, 194, 255, 0.52)');
    blob(0.56, 0.82, 0.52, 'rgba(255, 124, 188, 0.46)');
    blob(0.9, 0.88, 0.36, 'rgba(255, 200, 108, 0.40)');
    const bgGlow = glassCtx.createRadialGradient(W * 0.5, H * 0.44, 0, W * 0.5, H * 0.44, W * 0.62);
    bgGlow.addColorStop(0, 'rgba(255,255,255,0.16)');
    bgGlow.addColorStop(1, 'rgba(255,255,255,0)');
    glassCtx.fillStyle = bgGlow;
    glassCtx.fillRect(0, 0, W, H);
    glassCtx.restore();

    /* 磨砂白纱 + 细噪点 + 中心柔光：全部裁在圆角内，不留边框 */
    glassCtx.save();
    spaceRoundRect(glassCtx, 0, 0, W, H, radius);
    glassCtx.clip();
    const veil = glassCtx.createLinearGradient(0, 0, W * 0.4, H);
    veil.addColorStop(0, 'rgba(255,255,255,0.34)');
    veil.addColorStop(0.5, 'rgba(255,255,255,0.28)');
    veil.addColorStop(1, 'rgba(255,255,255,0.32)');
    glassCtx.fillStyle = veil;
    glassCtx.fillRect(0, 0, W, H);

    const dots = Math.floor((W * H) / 2600);
    for (let d = 0; d < dots; d += 1) {
      const x = Math.random() * W;
      const y = Math.random() * H;
      const a = Math.random() * 0.07 + 0.02;
      glassCtx.fillStyle = 'rgba(255,255,255,' + a.toFixed(3) + ')';
      glassCtx.fillRect(x, y, 1.6, 1.6);
    }
    const sheen = glassCtx.createRadialGradient(W * 0.42, H * 0.3, 0, W * 0.42, H * 0.3, W * 0.5);
    sheen.addColorStop(0, 'rgba(255,255,255,0.10)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    glassCtx.fillStyle = sheen;
    glassCtx.fillRect(0, 0, W, H);
    glassCtx.restore();
  }'''.split("\n")
lines[698:729] = glass_new

# 648-697: 删除独立的 bg / bgBlur 画布（内容已并入玻璃纹理）
del lines[647:697]

# mask 羽化：给圆角遮罩加 blur，消除边缘硬锯齿
check(644, 644, "maskCtx.fill();")
lines[644 - 1:644] = [
    "    maskCtx.filter = 'blur(3px)';",
    "    maskCtx.fill();",
    "    maskCtx.filter = 'none';",
]

io.open(p, "w", encoding="utf-8", newline="").write("\n".join(lines))
print("loginSpace.ts patched, lines:", len(lines))
