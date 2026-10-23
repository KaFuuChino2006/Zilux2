# -*- coding: utf-8 -*-
import io

# ---------------- floatScene.ts ----------------
p = r"E:\Zilux2开发\web\src\three\floatScene.ts"
s = io.open(p, 'r', encoding='utf-8', newline='').read()

def rep(old, new, count=1):
    global s
    assert s.count(old) >= 1, old[:80]
    s = s.replace(old, new, count)

rep("import { pickPixelRatio } from './quality';",
    "import { pickPixelRatio } from './quality';\nimport { createSettingsBoard, type BoardSettingsState } from './settingsBoard';")

rep("""  /** 视角变化回调（节流），用于持久化“当前视角作为默认视角” */
  onViewChange?: (view: { yaw: number; pitch: number; zoom: number; panX: number; panY: number }) => void;
}""",
"""  /** 视角变化回调（节流），用于持久化“当前视角作为默认视角” */
  onViewChange?: (view: { yaw: number; pitch: number; zoom: number; panX: number; panY: number }) => void;
  /** 3D 设置面板：修改设置（嵌套 patch） */
  onBoardPatch?(patch: Record<string, Record<string, unknown>>): void;
  onBoardReset?(): void;
  onBoardClose?(): void;
}""")

rep("  resetView(): void;\n  setGlassThickness(value: number): void;",
"  resetView(): void;\n  openSettingsBoard(): void;\n  closeSettingsBoard(): void;\n  setBoardSettings(state: BoardSettingsState): void;\n  setGlassThickness(value: number): void;")

rep("  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 80);",
"""  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 80);
  const settingsBoard = createSettingsBoard(scene, camera, canvas, {
    onPatch: (patch) => options.onBoardPatch?.(patch),
    onReset: () => options.onBoardReset?.(),
    onClose: () => options.onBoardClose?.(),
  });""")

rep("    const delta = Math.min(0.05, rawDelta);",
    "    const delta = Math.min(0.05, rawDelta);\n    settingsBoard.update(delta);")

rep("""  const onPointerMove = (event: PointerEvent): void => {
    hoverSuppressed = false;""",
"""  const onPointerMove = (event: PointerEvent): void => {
    if (settingsBoard.pointerMove(event)) return;
    hoverSuppressed = false;""")

rep("""    if (event.button !== 0) return;
    downX = event.clientX;""",
"""    if (event.button !== 0) return;
    if (settingsBoard.pointerDown(event)) return;
    downX = event.clientX;""")

rep("""    if (event.button !== 0) return;
    orbitting = false;""",
"""    if (event.button !== 0) return;
    if (settingsBoard.pointerUp(event)) return;
    orbitting = false;""")

rep("""    start,
    stop,
    resize,""",
"""    openSettingsBoard() {
      settingsBoard.open();
    },
    closeSettingsBoard() {
      settingsBoard.close();
    },
    setBoardSettings(boardSettings) {
      settingsBoard.setSettings(boardSettings);
    },
    start,
    stop,
    resize,""")

rep("      starGeometry.dispose();",
    "      settingsBoard.dispose();\n      starGeometry.dispose();")

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('floatScene board wired')

# ---------------- spaceShell.ts ----------------
p2 = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
s2 = io.open(p2, 'r', encoding='utf-8', newline='').read()

def rep2(old, new, count=1):
    global s2
    assert s2.count(old) >= 1, old[:80]
    s2 = s2.replace(old, new, count)

rep2("""      if (feature === 'settings') {
        openSettingsSheet();
        return;
      }""",
"""      if (feature === 'settings') {
        syncBoardSettings();
        space?.openSettingsBoard();
        return;
      }""")

rep2("    onMgSweep: runMgSweep2d,",
"""    onMgSweep: runMgSweep2d,
    onBoardPatch: (patch) => {
      patchSettings(patch as never);
    },
    onBoardReset: () => {
      resetSettings();
    },
    onBoardClose: () => {
      space?.closeSettingsBoard();
    },""")

rep2("""  });
  space.start();
  applyCustom();""",
"""  });
  space.start();

  function syncBoardSettings(): void {
    const settings = getSettings();
    space?.setBoardSettings({
      general: { splash: settings.general.splash, startMaximized: settings.general.startMaximized },
      appearance: {
        reduceMotion: settings.appearance.reduceMotion,
        glow: settings.appearance.glow,
        lyricsSize: settings.appearance.lyricsSize,
      },
      playback: {
        defaultSource: settings.playback.defaultSource,
        searchLimit: settings.playback.searchLimit,
        volume: settings.playback.volume,
      },
    });
  }
  syncBoardSettings();
  applyCustom();""")

rep2("""  onSettingsChange((next) => {
    applySettingsToScene(next);
    syncSettingsUi();""",
"""  onSettingsChange((next) => {
    applySettingsToScene(next);
    syncSettingsUi();
    syncBoardSettings();""")

io.open(p2, 'w', encoding='utf-8', newline='').write(s2)
print('spaceShell board wired')
