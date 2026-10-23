# -*- coding: utf-8 -*-
import io


def patch_file(path, pairs):
    s = io.open(path, 'r', encoding='utf-8', newline='').read()
    for old, new, label in pairs:
        assert s.count(old) == 1, f"anchor miss {label}: {old[:70]!r}"
        s = s.replace(old, new, 1)
    io.open(path, 'w', encoding='utf-8', newline='').write(s)
    print('patched', path)


FS = r"E:\Zilux2开发\web\src\three\floatScene.ts"
SH = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"

fs_pairs = [
    (
        "export interface LyricLineView {",
        "export type LyricEnterStyle = 'fade' | 'slide' | 'zoom' | 'tilt';\n\nexport interface LyricLineView {",
        "type export",
    ),
    (
        "  let lyricsScale = 1;",
        "  let lyricsScale = 1;\n  let lyricEnterStyle: LyricEnterStyle = 'fade';",
        "state",
    ),
    (
        "  setLyricsScale(scale: number): void;",
        "  setLyricsScale(scale: number): void;\n  /** 歌词每句的出入场动画方式（fade 淡入 / slide 滑入 / zoom 弹入 / tilt 翻折） */\n  setLyricEnterStyle(style: LyricEnterStyle): void;",
        "handle decl",
    ),
    (
        "    setLyricsScale(scale: number) {\n      lyricsScale = Math.max(0.6, Math.min(1.6, scale));\n    },",
        "    setLyricsScale(scale: number) {\n      lyricsScale = Math.max(0.6, Math.min(1.6, scale));\n    },\n    setLyricEnterStyle(style: LyricEnterStyle) {\n      lyricEnterStyle = style;\n    },",
        "handle impl",
    ),
    (
        "        prev.amount = Math.max(0, prev.amount - delta * 2.8);\n        lyricAnchor(lyricPrev, lyricAnchorTemp);\n        prev.group.position.set(\n          lyricAnchorTemp.x,\n          lyricAnchorTemp.y + (1 - prev.amount) * 0.3,\n          lyricAnchorTemp.z,\n        );\n        prev.group.scale.setScalar((0.94 + prev.amount * 0.06) * lyricsScale);\n        prev.group.lookAt(camera.position);",
        "        prev.amount = Math.max(0, prev.amount - delta * 2.8);\n        lyricAnchor(lyricPrev, lyricAnchorTemp);\n        const out = 1 - prev.amount;\n        let prevX = lyricAnchorTemp.x;\n        let prevY = lyricAnchorTemp.y;\n        let prevScale = 1;\n        let prevTilt = 0;\n        switch (lyricEnterStyle) {\n          case 'slide':\n            prevX += out * 1.05;\n            break;\n          case 'zoom':\n            prevScale = 0.82 + prev.amount * 0.18;\n            break;\n          case 'tilt':\n            prevTilt = out * 0.6;\n            break;\n          default:\n            prevY += out * 0.3;\n            prevScale = 0.94 + prev.amount * 0.06;\n            break;\n        }\n        prev.group.position.set(prevX, prevY, lyricAnchorTemp.z);\n        prev.group.scale.setScalar(prevScale * lyricsScale);\n        prev.group.lookAt(camera.position);\n        if (prevTilt !== 0) prev.group.rotateX(prevTilt);",
        "prev exit",
    ),
    (
        "      const enter = view.amount * view.amount * (3 - 2 * view.amount);\n      lyricAnchor(active, lyricAnchorTemp);\n      view.group.position.set(\n        lyricAnchorTemp.x,\n        lyricAnchorTemp.y - (1 - enter) * 0.24,\n        lyricAnchorTemp.z,\n      );\n      view.group.scale.setScalar((0.93 + enter * 0.07) * lyricsScale);\n      view.group.lookAt(camera.position);",
        "      const enter = view.amount * view.amount * (3 - 2 * view.amount);\n      lyricAnchor(active, lyricAnchorTemp);\n      let enterX = lyricAnchorTemp.x;\n      let enterY = lyricAnchorTemp.y;\n      let enterScale = 1;\n      let enterTilt = 0;\n      switch (lyricEnterStyle) {\n        case 'slide':\n          enterX += (1 - enter) * 1.05;\n          break;\n        case 'zoom':\n          enterScale = 0.74 + enter * 0.26 + 0.05 * Math.sin(enter * Math.PI);\n          break;\n        case 'tilt':\n          enterTilt = -(1 - enter) * 0.6;\n          break;\n        default:\n          enterY -= (1 - enter) * 0.24;\n          enterScale = 0.93 + enter * 0.07;\n          break;\n      }\n      view.group.position.set(enterX, enterY, lyricAnchorTemp.z);\n      view.group.scale.setScalar(enterScale * lyricsScale);\n      view.group.lookAt(camera.position);\n      if (enterTilt !== 0) view.group.rotateX(enterTilt);",
        "active enter",
    ),
]
patch_file(FS, fs_pairs)

sh_pairs = [
    (
        "import type { LyricLineData } from '../three/floatScene';",
        "import type { LyricEnterStyle, LyricLineData } from '../three/floatScene';",
        "import type",
    ),
    (
        "  const DEFAULT_CUSTOM = { image: null as string | null, tileCols: 13, tileRows: 7, tileBend: 0.35 };",
        "  const LYRIC_ENTER_LABELS: Record<LyricEnterStyle, string> = {\n    fade: '淡入',\n    slide: '滑入',\n    zoom: '弹入',\n    tilt: '翻折',\n  };\n  const DEFAULT_CUSTOM = {\n    image: null as string | null,\n    tileCols: 13,\n    tileRows: 7,\n    tileBend: 0.35,\n    lyricEnter: 'fade' as LyricEnterStyle,\n  };",
        "default custom",
    ),
    (
        "      const bendRaw = Number(parsed.tileBend);\n      const tileBend = Number.isFinite(bendRaw) ? Math.min(1, Math.max(0, bendRaw)) : DEFAULT_CUSTOM.tileBend;\n      return { image, tileCols, tileRows, tileBend };",
        "      const bendRaw = Number(parsed.tileBend);\n      const tileBend = Number.isFinite(bendRaw) ? Math.min(1, Math.max(0, bendRaw)) : DEFAULT_CUSTOM.tileBend;\n      const lyricEnter: LyricEnterStyle =\n        parsed.lyricEnter === 'slide' || parsed.lyricEnter === 'zoom' || parsed.lyricEnter === 'tilt'\n          ? parsed.lyricEnter\n          : 'fade';\n      return { image, tileCols, tileRows, tileBend, lyricEnter };",
        "load custom",
    ),
    (
        "  const applyCustom = (): void => {\n    space?.setUnderlayImage(custom.image);\n    space?.setTileBend(custom.tileBend);\n  };",
        "  const applyCustom = (): void => {\n    space?.setUnderlayImage(custom.image);\n    space?.setTileBend(custom.tileBend);\n    space?.setLyricEnterStyle(custom.lyricEnter);\n  };",
        "apply custom",
    ),
    (
        "    customBendInput.value = String(Math.round(custom.tileBend * 100));\n    customBendCurrent.textContent = `${Math.round(custom.tileBend * 100)}%`;",
        "    customBendInput.value = String(Math.round(custom.tileBend * 100));\n    customBendCurrent.textContent = `${Math.round(custom.tileBend * 100)}%`;\n    lyricEnterBtns.forEach((button) => {\n      button.classList.toggle('is-on', button.dataset.lyricEnter === custom.lyricEnter);\n    });\n    lyricEnterLabel.textContent = LYRIC_ENTER_LABELS[custom.lyricEnter];",
        "sync custom ui",
    ),
    (
        "  const customBendInput = root.querySelector<HTMLInputElement>('[data-tile-bend]')!;",
        "  const customBendInput = root.querySelector<HTMLInputElement>('[data-tile-bend]')!;\n  const lyricEnterBtns = root.querySelectorAll<HTMLButtonElement>('[data-lyric-enter]');\n  const lyricEnterLabel = root.querySelector<HTMLElement>('[data-lyric-enter-label]')!;",
        "element refs",
    ),
    (
        '          <footer class="custom-foot">',
        '          <section class="custom-section">\n            <header class="custom-section-head">\n              <span class="custom-kicker">歌词</span>\n              <div>\n                <h3>出入场动画</h3>\n                <p>3D 歌词每一句进入、离开的方式</p>\n              </div>\n            </header>\n            <div class="custom-field">\n              <div class="custom-label"><span>出入场方式</span><b data-lyric-enter-label>淡入</b></div>\n              <div class="custom-seg" data-lyric-enter-seg>\n                <button class="custom-seg-btn is-on" data-lyric-enter="fade" type="button">淡入</button>\n                <button class="custom-seg-btn" data-lyric-enter="slide" type="button">滑入</button>\n                <button class="custom-seg-btn" data-lyric-enter="zoom" type="button">弹入</button>\n                <button class="custom-seg-btn" data-lyric-enter="tilt" type="button">翻折</button>\n              </div>\n              <p class="custom-tip">只在 3D 歌词播放界面生效，仅影响本机</p>\n            </div>\n          </section>\n          <footer class="custom-foot">',
        "template section",
    ),
    (
        "  customOpenBtn.addEventListener('click', openCustomSheet);",
        "  lyricEnterBtns.forEach((button) => {\n    button.addEventListener('click', () => {\n      const value = button.dataset.lyricEnter as LyricEnterStyle | undefined;\n      if (!value) return;\n      custom.lyricEnter = value;\n      lyricEnterBtns.forEach((item) => item.classList.toggle('is-on', item === button));\n      lyricEnterLabel.textContent = LYRIC_ENTER_LABELS[value];\n      space?.setLyricEnterStyle(value);\n      persistCustom();\n    });\n  });\n  customOpenBtn.addEventListener('click', openCustomSheet);",
        "event binding",
    ),
]
patch_file(SH, sh_pairs)
print('done')
