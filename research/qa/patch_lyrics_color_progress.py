# -*- coding: utf-8 -*-
"""歌词进度改为「颜色变化」：正在唱的一句未唱部分暗、已唱部分亮，按进度从左往右扫过；移除进度条 mesh。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# 1) 类型加 paintProgress
old = """export interface LyricLineView {
  index: number;
  group: THREE.Group;"""
new = """export interface LyricLineView {
  index: number;
  group: THREE.Group;
  paintProgress: number;"""
assert s.count(old) == 1, 'iface'
s = s.replace(old, new, 1)

# 2) 删除进度条状态
old = """  let lyricProgress = 0;
  let lyricProgressMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null = null;"""
new = """  let lyricProgress = 0;"""
assert s.count(old) == 1, 'state'
s = s.replace(old, new, 1)

# 3) 重写 paintLyricLine：颜色填充
a = s.index("  function paintLyricLine(view: LyricLineView): void {")
b = s.index("\n  function ensureLyricLines(): void {", a)
new_paint = '''  function paintLyricLine(view: LyricLineView, progress = 0): void {
    const ctx = view.canvas.getContext('2d');
    if (!ctx) return;
    const W = view.canvas.width;
    const H = view.canvas.height;
    const hasTranslation = view.translation.trim().length > 0;
    const mainY = hasTranslation ? H * 0.38 : H * 0.5;
    const translationY = H * 0.8;
    ctx.clearRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (!view.active) {
      ctx.fillStyle = 'rgba(255,255,255,0.66)';
      drawLyricText(ctx, view.text, W / 2, mainY, W * 0.94, 2, 42, 28, 700);
      if (hasTranslation) {
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        drawLyricText(ctx, view.translation, W / 2, translationY, W * 0.9, 2, 22, 15, 500);
      }
      view.texture.needsUpdate = true;
      return;
    }
    // 正在唱的这句：未唱部分暗，已唱部分亮，按进度从左往右扫过（卡拉 OK 式颜色变化）
    ctx.fillStyle = 'rgba(255,255,255,0.32)';
    drawLyricText(ctx, view.text, W / 2, mainY, W * 0.94, 2, 56, 34, 700);
    if (hasTranslation) {
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      drawLyricText(ctx, view.translation, W / 2, translationY, W * 0.9, 2, 28, 18, 500);
    }
    const sweep = Math.min(1, Math.max(0, progress));
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W * sweep, H);
    ctx.clip();
    ctx.shadowColor = 'rgba(146, 122, 255, 0.85)';
    ctx.shadowBlur = 30;
    ctx.fillStyle = 'rgba(255,255,255,0.98)';
    drawLyricText(ctx, view.text, W / 2, mainY, W * 0.94, 2, 56, 34, 700);
    if (hasTranslation) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      drawLyricText(ctx, view.translation, W / 2, translationY, W * 0.9, 2, 28, 18, 500);
    }
    ctx.restore();
    view.texture.needsUpdate = true;
  }
'''
s = s[:a] + new_paint + s[b:]

# 4) view 初始化加 paintProgress
old = """      const view: LyricLineView = {
        index: -1,
        group,"""
new = """      const view: LyricLineView = {
        index: -1,
        group,
        paintProgress: -1,"""
assert s.count(old) == 1, 'view init'
s = s.replace(old, new, 1)

# 5) 删除进度条 mesh 创建
old = """    // 当前句下方的播放进度条（从左往右长）
    const progressGeo = new THREE.PlaneGeometry(1, 0.042);
    progressGeo.translate(0.5, 0, 0);
    const progressMat = new THREE.MeshBasicMaterial({
      color: 0xbda8ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
    });
    lyricProgressMesh = new THREE.Mesh(progressGeo, progressMat);
    lyricProgressMesh.renderOrder = 42;
    lyricGroup.add(lyricProgressMesh);
  }"""
new = """  }"""
assert s.count(old) == 1, 'mesh block'
s = s.replace(old, new, 1)

# 6) 重写 updateLyrics（去掉进度条，改为按进度重绘当前句）
start_marker = "  function updateLyrics(delta: number): void {"
end_marker = "  /* 详情磁贴"
a = s.index(start_marker)
b = s.index(end_marker, a)
new_func = '''  function updateLyrics(delta: number): void {
    const target = lyricVisible ? 1 : 0;
    lyricAmount += (target - lyricAmount) * Math.min(1, delta * 3.0);
    if (!lyricGroup) {
      if (lyricAmount > 0.01) ensureLyricLines();
      if (!lyricGroup) return;
    }
    lyricGroup.visible = lyricAmount > 0.02;
    if (!lyricGroup.visible) return;
    const ease = lyricAmount * lyricAmount * (3 - 2 * lyricAmount);
    const active = lyricActive;
    lyricSlotUsed.clear();
    if (active >= 0 && lyricData.length > 0) {
      const slot = active % LYRIC_POOL;
      const view = lyricLines[slot];
      const line = lyricData[active];
      // 颜色随播放进度变化：进度每前进约 0.4% 重绘一次（逐字变亮）
      if (
        view.index !== active ||
        Math.abs(view.paintProgress - lyricProgress) > 0.004
      ) {
        view.index = active;
        view.active = true;
        view.text = line.text;
        view.translation = line.translation ?? '';
        view.paintProgress = lyricProgress;
        paintLyricLine(view, lyricProgress);
      }
      // 每句的固定落点由行号决定；只显示正在唱的这一句，已唱/未唱的都不显示
      lyricAnchor(active, lyricAnchorTemp);
      view.group.position.copy(lyricAnchorTemp);
      view.group.scale.setScalar(1);
      view.group.lookAt(camera.position);
      view.plane.material.opacity = ease;
      lyricSlotUsed.add(slot);
    }
    lyricLines.forEach((view, k) => {
      if (!lyricSlotUsed.has(k)) view.plane.material.opacity = 0;
    });
    lyricGroup.position.x = 0;
    lyricGroup.position.y = 0;
    lyricGroup.rotation.z = 0;
    lyricGroup.rotation.y = 0;
  }

'''
s = s[:a] + new_func + s[b:]

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('lyrics: color-fill progress (karaoke sweep), progress bar removed')
