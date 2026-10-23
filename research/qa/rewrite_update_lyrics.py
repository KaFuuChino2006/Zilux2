# -*- coding: utf-8 -*-
import io

p = r"E:\Zilux2开发\web\src\three\floatScene.ts"
s = io.open(p, 'r', encoding='utf-8', newline='').read()

start = s.index("  function updateLyrics(delta: number): void {")
end = s.index("\n  function ", start + 10)

new_func = r'''  function updateLyrics(delta: number): void {
    lyricColorClock += delta;
    if (lyricColorFlash > 0) lyricColorFlash = Math.max(0, lyricColorFlash - delta * 2.1);
    if (!lyricVisible) lyricSweep = -1;
    if (lyricSweep >= 0) {
      lyricSweep += delta / 0.62;
      if (lyricSweep > 1.35) lyricSweep = -1;
    }
    applyLyricSweepUniforms();
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
    const activeView = lyricLines[0];
    const prevView = lyricLines[1];
    if (!activeView || !prevView) return;
    if (active < 0) {
      for (const view of lyricLines) {
        view.amount = 0;
        view.index = -1;
        view.active = false;
        view.text = '';
        view.translation = '';
        view.group.visible = false;
        view.plane.visible = true;
        view.plane.material.uniforms.uOpacity!.value = 0;
        hideSplitLine(view);
      }
      return;
    }
    const style = lyricEnterStyle;
    const split = style.startsWith('split-');
    // 换句：把当前句内容搬进「上一句」视图（重绘到它自己的画布），当前视图再重绘新句
    if (activeView.index !== active || activeView.text !== (lyricData[active]?.text ?? '')) {
      if (activeView.index >= 0 && activeView.text) {
        prevView.index = activeView.index;
        prevView.text = activeView.text;
        prevView.translation = activeView.translation;
        prevView.charBoxes = activeView.charBoxes.slice();
        prevView.strokeStamp = [];
        prevView.amount = 1;
        prevView.active = true;
        prevView.group.visible = true;
        paintLyricLine(prevView);
      } else if (prevView.index !== activeView.index) {
        prevView.amount = 0;
        prevView.index = -1;
        prevView.group.visible = false;
        hideSplitLine(prevView);
      }
      const line = lyricData[active];
      activeView.index = active;
      activeView.active = true;
      activeView.text = line.text;
      activeView.translation = line.translation ?? '';
      activeView.amount = 0;
      activeView.strokeStamp = [];
      activeView.group.visible = true;
      paintLyricLine(activeView);
    }
    // 上一句退场
    if (prevView.index >= 0 && prevView.amount > 0.001) {
      prevView.amount = Math.max(0, prevView.amount - delta * (split ? 0.8 : 2.0));
      lyricAnchor(prevView.index, lyricAnchorTemp);
      const out = 1 - prevView.amount;
      const prevEase = out * out * (3 - 2 * out);
      let prevX = lyricAnchorTemp.x;
      let prevY = lyricAnchorTemp.y;
      let prevScale = 1;
      let prevTilt = 0;
      let prevRotY = 0;
      let prevRotZ = 0;
      switch (style) {
        case 'slide': prevX += out * 1.05; break;
        case 'zoom': prevScale = 0.82 + prevView.amount * 0.18; break;
        case 'tilt': prevTilt = out * 0.6; break;
        case 'flip': prevRotY = prevEase * 1.5; prevScale = 1 - prevEase * 0.04; break;
        case 'drop': prevY -= prevEase * 0.75; prevScale = 1 - prevEase * 0.08; break;
        case 'rise': prevY += prevEase * 0.7; prevScale = 1 - prevEase * 0.08; break;
        case 'spin': prevRotZ = -prevEase * 1.25; prevY += prevEase * 0.12; prevScale = 1 - prevEase * 0.16; break;
        case 'swing': prevRotZ = Math.sin(prevEase * Math.PI * 1.4) * 0.42; prevX -= prevEase * 0.5; break;
        case 'skew': prevRotZ = -prevEase * 0.2; prevX += prevEase * 0.95; break;
        case 'elastic': prevScale = 1 - prevEase * 0.24 + Math.sin(prevEase * Math.PI) * 0.04; prevY += prevEase * 0.1; break;
        case 'swirl': prevX += Math.cos(prevEase * Math.PI * 1.1) * prevEase * 0.85; prevY += Math.sin(prevEase * Math.PI * 1.1) * prevEase * 0.55; prevRotZ = -prevEase * 0.9; break;
        case 'wave': prevY += Math.sin(prevEase * Math.PI * 2) * 0.22; prevX += prevEase * 0.5; break;
        case 'vanish': prevScale = Math.max(0, 1 - prevEase); break;
        default: prevY += out * 0.3; prevScale = 0.94 + prevView.amount * 0.06; break;
      }
      if (split) prevScale = 1;
      if (lyricLayout === 'rise') prevY += out * 2.6;
      prevView.group.position.set(prevX, prevY, lyricAnchorTemp.z);
      prevView.group.scale.setScalar(prevScale * lyricsScale);
      prevView.group.lookAt(camera.position);
      if (split) applySplitLine(prevView, prevView.amount, style);
      else hideSplitLine(prevView);
      if (prevTilt !== 0) prevView.group.rotateX(prevTilt);
      if (prevRotY !== 0) prevView.group.rotateY(prevRotY);
      if (prevRotZ !== 0) prevView.group.rotateZ(prevRotZ);
      prevView.group.visible = true;
      prevView.plane.material.uniforms.uProgress!.value = 1;
      prevView.plane.material.uniforms.uOpacity!.value =
        ease * prevView.amount * (lyricLayout === 'rise' ? 0.32 + 0.68 * prevView.amount : 0.8);
      applyLyricColorUniforms(prevView.plane.material);
      if (prevView.amount <= 0.001) {
        prevView.amount = 0;
        prevView.index = -1;
        prevView.text = '';
        prevView.translation = '';
        prevView.group.visible = false;
        hideSplitLine(prevView);
      }
    }
    // 当前句入场
    {
      const view = activeView;
      const line = lyricData[active];
      view.amount = Math.min(1, view.amount + delta * (split ? 0.85 : 2.4));
      const enter = view.amount * view.amount * (3 - 2 * view.amount);
      lyricAnchor(active, lyricAnchorTemp);
      let enterX = lyricAnchorTemp.x;
      let enterY = lyricAnchorTemp.y;
      let enterScale = 1;
      let enterTilt = 0;
      let enterRotY = 0;
      let enterRotZ = 0;
      const enterOut = 1 - enter;
      const enterEase = enterOut * enterOut * (3 - 2 * enterOut);
      switch (style) {
        case 'slide': enterX += enterOut * 1.05; break;
        case 'zoom': enterScale = 0.74 + enter * 0.26 + 0.05 * Math.sin(enter * Math.PI); break;
        case 'tilt': enterTilt = -enterOut * 0.6; break;
        case 'flip': enterRotY = -enterEase * 1.5; enterScale = 0.94 + enter * 0.06; break;
        case 'drop': enterY += enterOut * enterOut * 0.95; enterScale = 0.9 + enter * 0.1; break;
        case 'rise': enterY -= enterOut * 0.85; enterScale = 0.9 + enter * 0.1; break;
        case 'spin': enterRotZ = enterOut * 1.25; enterScale = 0.8 + enter * 0.2; break;
        case 'swing': enterRotZ = -Math.sin(enterOut * Math.PI * 1.4) * 0.42; enterX -= enterOut * 0.5; break;
        case 'skew': enterRotZ = enterOut * 0.2; enterX += enterOut * 0.95; break;
        case 'elastic': enterScale = 0.6 + enter * 0.4 + Math.sin(enter * Math.PI) * 0.14; break;
        case 'swirl': enterX += Math.cos(enterOut * Math.PI * 1.1) * enterOut * 0.95; enterY += Math.sin(enterOut * Math.PI * 1.1) * enterOut * 0.6; enterRotZ = enterOut * 0.9; break;
        case 'wave': enterY += Math.sin(enter * Math.PI * 2) * enterOut * 0.24; enterX += enterOut * 0.5; break;
        case 'vanish': enterScale = 0.12 + enter * 0.88; break;
        default: enterY -= enterOut * 0.24; enterScale = 0.93 + enter * 0.07; break;
      }
      if (split) enterScale = 1;
      if (lyricLayout === 'rise') enterY -= (1 - enter) * 5.6;
      view.group.position.set(enterX, enterY, lyricAnchorTemp.z);
      mgActivePos.set(enterX, enterY, lyricAnchorTemp.z);
      view.group.scale.setScalar(enterScale * lyricsScale);
      view.group.lookAt(camera.position);
      if (split) applySplitLine(view, enter, style);
      else hideSplitLine(view);
      if (enterTilt !== 0) view.group.rotateX(enterTilt);
      if (enterRotY !== 0) view.group.rotateY(enterRotY);
      if (enterRotZ !== 0) view.group.rotateZ(enterRotZ);
      const material = view.plane.material;
      const chars = line.chars;
      const boxes = view.charBoxes;
      const charCount = chars && boxes.length === chars.length ? Math.min(chars.length, 48) : 0;
      const boxArr = material.uniforms.uCharBox!.value as Float32Array;
      const alphaArr = material.uniforms.uCharAlpha!.value as Float32Array;
      const writeArr = material.uniforms.uCharWrite!.value as Float32Array;
      for (let i = 0; i < charCount; i += 1) {
        const box = boxes[i];
        boxArr[i * 2] = box.x0;
        boxArr[i * 2 + 1] = box.x1;
        const char = chars![i];
        const sinceStart = lyricClock - char.start;
        if (wordFill) {
          if (sinceStart < 0 || wordAppear !== 'fade') alphaArr[i] = 1;
          else {
            const t = Math.min(1, Math.max(0, sinceStart / 0.22));
            const eased = t * t * (3 - 2 * t);
            alphaArr[i] = 0.35 + 0.65 * eased;
          }
        } else if (wordAppear === 'fade') {
          const t = Math.min(1, Math.max(0, sinceStart / 0.26));
          alphaArr[i] = t * t * (3 - 2 * t);
        } else alphaArr[i] = 1;
        const span = Math.max(0.26, (char.end - char.start) * 1.15);
        writeArr[i] = Math.min(1, Math.max(0, (lyricClock - char.start) / span));
      }
      const assembleActive = wordWrite && strokeFontReady() && charCount > 0;
      material.uniforms.uCharCount!.value = charCount;
      material.uniforms.uWrite!.value = assembleActive ? 0 : wordWrite && charCount > 0 ? 1 : 0;
      material.uniforms.uFill!.value = wordFill ? 1 : 0;
      material.uniforms.uProgress!.value = wordFill ? lyricRevealFor(view) : 1;
      material.uniforms.uOpacity!.value = ease * enter;
      applyLyricColorUniforms(material);
      if (assembleActive) {
        const now = performance.now();
        if (now - view.strokePaintedAt > 45) {
          const nextStamp: number[] = [];
          let changed = view.strokeStamp.length !== charCount;
          for (let i = 0; i < charCount; i += 1) {
            const char = chars![i];
            const span = Math.max(0.24, (char.end - char.start) * 1.05);
            const progress = Math.min(1, Math.max(0, (lyricClock - char.start) / span));
            const count = progress * (charStrokes(char.text)?.length ?? 0);
            nextStamp.push(count);
            if (!changed && Math.abs((view.strokeStamp[i] ?? 0) - count) > 0.04) changed = true;
          }
          if (changed) {
            view.strokeStamp = nextStamp;
            view.strokePaintedAt = now;
            paintLyricLine(view);
          }
        }
      }
    }
    lyricGroup.position.x = 0;
    lyricGroup.position.y = 0;
    lyricGroup.rotation.z = 0;
    lyricGroup.rotation.y = 0;
  }
'''

s = s[:start] + new_func + s[end:]

# 歌词池只创建 2 个视图
old_loop = "    for (let i = 0; i < LYRIC_POOL; i += 1) {"
assert s.count(old_loop) == 1
s = s.replace(old_loop, "    for (let i = 0; i < 2; i += 1) {", 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print("rewrote updateLyrics to 2-view model")
