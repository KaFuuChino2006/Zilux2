# -*- coding: utf-8 -*-
"""歌词出入场效果：在 fade/slide/zoom/tilt 基础上新增 10 种（flip/drop/rise/spin/swing/skew/elastic/swirl/wave/vanish）。"""
import io

fp = r"E:\Zilux2开发\web\src\three\floatScene.ts"
s = io.open(fp, "r", encoding="utf-8", newline="").read()

# 1) 类型
old = "export type LyricEnterStyle = 'fade' | 'slide' | 'zoom' | 'tilt';"
new = (
    "export type LyricEnterStyle =\n"
    "  | 'fade'\n"
    "  | 'slide'\n"
    "  | 'zoom'\n"
    "  | 'tilt'\n"
    "  | 'flip'\n"
    "  | 'drop'\n"
    "  | 'rise'\n"
    "  | 'spin'\n"
    "  | 'swing'\n"
    "  | 'skew'\n"
    "  | 'elastic'\n"
    "  | 'swirl'\n"
    "  | 'wave'\n"
    "  | 'vanish';"
)
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 2) 上一句退场
old = """        let prevTilt = 0;
        switch (lyricEnterStyle) {
          case 'slide':
            prevX += out * 1.05;
            break;
          case 'zoom':
            prevScale = 0.82 + prev.amount * 0.18;
            break;
          case 'tilt':
            prevTilt = out * 0.6;
            break;
          default:
            prevY += out * 0.3;
            prevScale = 0.94 + prev.amount * 0.06;
            break;
        }
        prev.group.position.set(prevX, prevY, lyricAnchorTemp.z);
        prev.group.scale.setScalar(prevScale * lyricsScale);
        prev.group.lookAt(camera.position);
        if (prevTilt !== 0) prev.group.rotateX(prevTilt);"""
new = """        let prevTilt = 0;
        let prevRotY = 0;
        let prevRotZ = 0;
        const prevEase = out * out * (3 - 2 * out);
        switch (lyricEnterStyle) {
          case 'slide':
            prevX += out * 1.05;
            break;
          case 'zoom':
            prevScale = 0.82 + prev.amount * 0.18;
            break;
          case 'tilt':
            prevTilt = out * 0.6;
            break;
          case 'flip':
            prevRotY = prevEase * 1.5;
            prevScale = 1 - prevEase * 0.04;
            break;
          case 'drop':
            prevY -= prevEase * 0.75;
            prevScale = 1 - prevEase * 0.08;
            break;
          case 'rise':
            prevY += prevEase * 0.7;
            prevScale = 1 - prevEase * 0.08;
            break;
          case 'spin':
            prevRotZ = -prevEase * 1.25;
            prevY += prevEase * 0.12;
            prevScale = 1 - prevEase * 0.16;
            break;
          case 'swing':
            prevRotZ = Math.sin(prevEase * Math.PI * 1.4) * 0.42;
            prevX -= prevEase * 0.5;
            break;
          case 'skew':
            prevRotZ = -prevEase * 0.2;
            prevX += prevEase * 0.95;
            break;
          case 'elastic':
            prevScale = 1 - prevEase * 0.24 + Math.sin(prevEase * Math.PI) * 0.04;
            prevY += prevEase * 0.1;
            break;
          case 'swirl':
            prevX += Math.cos(prevEase * Math.PI * 1.1) * prevEase * 0.85;
            prevY += Math.sin(prevEase * Math.PI * 1.1) * prevEase * 0.55;
            prevRotZ = -prevEase * 0.9;
            break;
          case 'wave':
            prevY += Math.sin(prevEase * Math.PI * 2) * 0.22;
            prevX += prevEase * 0.5;
            break;
          case 'vanish':
            prevScale = Math.max(0, 1 - prevEase);
            break;
          default:
            prevY += out * 0.3;
            prevScale = 0.94 + prev.amount * 0.06;
            break;
        }
        prev.group.position.set(prevX, prevY, lyricAnchorTemp.z);
        prev.group.scale.setScalar(prevScale * lyricsScale);
        prev.group.lookAt(camera.position);
        if (prevTilt !== 0) prev.group.rotateX(prevTilt);
        if (prevRotY !== 0) prev.group.rotateY(prevRotY);
        if (prevRotZ !== 0) prev.group.rotateZ(prevRotZ);"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 3) 当前句入场
old = """      let enterTilt = 0;
      switch (lyricEnterStyle) {
        case 'slide':
          enterX += (1 - enter) * 1.05;
          break;
        case 'zoom':
          enterScale = 0.74 + enter * 0.26 + 0.05 * Math.sin(enter * Math.PI);
          break;
        case 'tilt':
          enterTilt = -(1 - enter) * 0.6;
          break;
        default:
          enterY -= (1 - enter) * 0.24;
          enterScale = 0.93 + enter * 0.07;
          break;
      }
      view.group.position.set(enterX, enterY, lyricAnchorTemp.z);
      view.group.scale.setScalar(enterScale * lyricsScale);
      view.group.lookAt(camera.position);
      if (enterTilt !== 0) view.group.rotateX(enterTilt);"""
new = """      let enterTilt = 0;
      let enterRotY = 0;
      let enterRotZ = 0;
      const enterOut = 1 - enter;
      const enterEase = enterOut * enterOut * (3 - 2 * enterOut);
      switch (lyricEnterStyle) {
        case 'slide':
          enterX += enterOut * 1.05;
          break;
        case 'zoom':
          enterScale = 0.74 + enter * 0.26 + 0.05 * Math.sin(enter * Math.PI);
          break;
        case 'tilt':
          enterTilt = -enterOut * 0.6;
          break;
        case 'flip':
          enterRotY = -enterEase * 1.5;
          enterScale = 0.94 + enter * 0.06;
          break;
        case 'drop':
          enterY += enterOut * enterOut * 0.95;
          enterScale = 0.9 + enter * 0.1;
          break;
        case 'rise':
          enterY -= enterOut * 0.85;
          enterScale = 0.9 + enter * 0.1;
          break;
        case 'spin':
          enterRotZ = enterOut * 1.25;
          enterScale = 0.8 + enter * 0.2;
          break;
        case 'swing':
          enterRotZ = -Math.sin(enterOut * Math.PI * 1.4) * 0.42;
          enterX -= enterOut * 0.5;
          break;
        case 'skew':
          enterRotZ = enterOut * 0.2;
          enterX += enterOut * 0.95;
          break;
        case 'elastic':
          enterScale = 0.6 + enter * 0.4 + Math.sin(enter * Math.PI) * 0.14;
          break;
        case 'swirl':
          enterX += Math.cos(enterOut * Math.PI * 1.1) * enterOut * 0.95;
          enterY += Math.sin(enterOut * Math.PI * 1.1) * enterOut * 0.6;
          enterRotZ = enterOut * 0.9;
          break;
        case 'wave':
          enterY += Math.sin(enter * Math.PI * 2) * enterOut * 0.24;
          enterX += enterOut * 0.5;
          break;
        case 'vanish':
          enterScale = 0.12 + enter * 0.88;
          break;
        default:
          enterY -= enterOut * 0.24;
          enterScale = 0.93 + enter * 0.07;
          break;
      }
      view.group.position.set(enterX, enterY, lyricAnchorTemp.z);
      view.group.scale.setScalar(enterScale * lyricsScale);
      view.group.lookAt(camera.position);
      if (enterTilt !== 0) view.group.rotateX(enterTilt);
      if (enterRotY !== 0) view.group.rotateY(enterRotY);
      if (enterRotZ !== 0) view.group.rotateZ(enterRotZ);"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

io.open(fp, "w", encoding="utf-8", newline="").write(s)
print("floatScene: 10 new lyric enter styles")
