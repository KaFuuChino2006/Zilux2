"""摄像头手势接线：gesture.ts 日志桥、floatScene.zoomBy、外观面板手势设置、宿主相机权限。"""
import io
from pathlib import Path

ROOT = Path(r"E:\Zilux2开发")


def load(rel):
    return io.open(ROOT / rel, "r", encoding="utf-8", newline="").read()


def save(rel, text):
    io.open(ROOT / rel, "w", encoding="utf-8", newline="").write(text)


def rep(text, old, new, label):
    got = text.count(old)
    assert got == 1, f"{label}: count={got}"
    print("OK:", label)
    return text.replace(old, new)


# ---------------- gesture.ts ----------------
p = "web/src/ui/gesture.ts"
t = load(p)
t = rep(
    t,
    "export interface GestureCallbacks {",
    "import { host } from '../bridge';\r\n\r\nexport interface GestureCallbacks {",
    "gesture-import",
)
old_hostlog = (
    "function hostLog(level: 'info' | 'warn', message: string): void {\r\n"
    "  try {\r\n"
    "    const bridge = (window as unknown as { dshHost?: { log?: (level: string, message: string) => void } }).dshHost;\r\n"
    "    bridge?.log?.(level, message);\r\n"
    "  } catch {\r\n"
    "    // ignore\r\n"
    "  }\r\n"
    "}"
)
new_hostlog = (
    "function hostLog(level: 'info' | 'warn', message: string): void {\r\n"
    "  host.log(level, message);\r\n"
    "}"
)
t = rep(t, old_hostlog, new_hostlog, "gesture-hostlog")
save(p, t)

# ---------------- floatScene.ts ----------------
p = "web/src/three/floatScene.ts"
t = load(p)
t = rep(
    t,
    "  turnPage(direction: number): boolean;",
    "  turnPage(direction: number): boolean;\r\n"
    "  /** 手势捏合缩放：在当前缩放上乘一个系数（1.0 附近，>1 放大） */\r\n"
    "  zoomBy(factor: number): void;",
    "fs-interface",
)
t = rep(
    t,
    "    isFlipping() {\r\n      return flipping;\r\n    },",
    "    zoomBy(factor) {\r\n"
    "      zoomTarget = Math.min(2.6, Math.max(0.3, zoomTarget * factor));\r\n"
    "    },\r\n"
    "    isFlipping() {\r\n"
    "      return flipping;\r\n"
    "    },",
    "fs-impl",
)
save(p, t)

# ---------------- spaceShell.ts ----------------
p = "web/src/ui/spaceShell.ts"
t = load(p)
t = rep(
    t,
    "import { createIslandPlayer, formatClock } from './islandPlayer';",
    "import { createIslandPlayer, formatClock } from './islandPlayer';\r\n"
    "import { createGestureController, type GestureController } from './gesture';",
    "shell-import",
)

html = (
    '          <section class="custom-section">\r\n'
    '            <header class="custom-section-head">\r\n'
    '              <span class="custom-kicker">手势</span>\r\n'
    '              <div>\r\n'
    "                <h3>摄像头手势</h3>\r\n"
    "                <p>挥手翻页 · 握拳播放/暂停 · 捏合缩放</p>\r\n"
    "              </div>\r\n"
    "            </header>\r\n"
    '            <div class="custom-field">\r\n'
    '              <div class="custom-seg" data-gesture-seg>\r\n'
    '                <button class="custom-seg-btn" data-gesture="off" type="button">关</button>\r\n'
    '                <button class="custom-seg-btn" data-gesture="on" type="button">开</button>\r\n'
    "              </div>\r\n"
    '              <p class="custom-tip" data-gesture-status>开启后会请求摄像头权限；画面只在本地识别，不上传</p>\r\n'
    "            </div>\r\n"
    '            <div class="custom-field">\r\n'
    '              <div class="custom-label"><span>手势灵敏度</span><b data-gesture-sensitivity-current>60%</b></div>\r\n'
    '              <input class="custom-slider" data-gesture-sensitivity type="range" min="20" max="100" step="1" value="60" aria-label="手势灵敏度" />\r\n'
    '              <p class="custom-tip">越高越容易触发挥手翻页</p>\r\n'
    "            </div>\r\n"
    "          </section>\r\n"
)
t = rep(
    t,
    '          <section class="custom-section custom-collapse" data-lyrics-anim>',
    html + '          <section class="custom-section custom-collapse" data-lyrics-anim>',
    "shell-html",
)

t = rep(
    t,
    "  const hotkeysReset = root.querySelector<HTMLButtonElement>('[data-hotkeys-reset]');",
    "  const hotkeysReset = root.querySelector<HTMLButtonElement>('[data-hotkeys-reset]');\r\n"
    "  const gestureBtns = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-gesture]'));\r\n"
    "  const gestureSensitivityInput = root.querySelector<HTMLInputElement>('[data-gesture-sensitivity]')!;\r\n"
    "  const gestureSensitivityCurrent = root.querySelector<HTMLElement>('[data-gesture-sensitivity-current]')!;\r\n"
    "  const gestureStatusEl = root.querySelector<HTMLElement>('[data-gesture-status]')!;",
    "shell-queries",
)

t = rep(
    t,
    "    mgcInset: 34,",
    "    gesture: false,\r\n    gestureSensitivity: 60,\r\n    mgcInset: 34,",
    "shell-default",
)

t = rep(
    t,
    "        lyricTracking: clampUnit(parsed.lyricTracking, DEFAULT_CUSTOM.lyricTracking, 50, 250),",
    "        lyricTracking: clampUnit(parsed.lyricTracking, DEFAULT_CUSTOM.lyricTracking, 50, 250),\r\n"
    "        gesture: (parsed as { gesture?: unknown }).gesture === true,\r\n"
    "        gestureSensitivity: clampUnit(\r\n"
    "          (parsed as { gestureSensitivity?: unknown }).gestureSensitivity,\r\n"
    "          DEFAULT_CUSTOM.gestureSensitivity,\r\n"
    "          20,\r\n"
    "          100,\r\n"
    "        ),",
    "shell-load",
)

t = rep(
    t,
    "    syncHotkeysUi();\r\n    syncSweepUi();",
    "    syncHotkeysUi();\r\n    syncGestureUi();\r\n    syncSweepUi();",
    "shell-sync",
)

t = rep(
    t,
    "    space?.setLyricFontFamily(custom.lyricFont || '');\r\n    applyLyricTypeStyle();",
    "    space?.setLyricFontFamily(custom.lyricFont || '');\r\n"
    "    applyLyricTypeStyle();\r\n"
    "    applyGestureSetting();",
    "shell-apply-custom",
)

logic = (
    "  // 摄像头手势（MediaPipe Hands，本地离线资源；画面不出本机）\r\n"
    "  let gestureController: GestureController | null = null;\r\n"
    "  let gestureStatusText = '开启后会请求摄像头权限；画面只在本地识别，不上传';\r\n"
    "  const syncGestureUi = (): void => {\r\n"
    "    gestureBtns.forEach((btn) => {\r\n"
    "      btn.classList.toggle('is-on', (btn.dataset.gesture === 'on') === custom.gesture);\r\n"
    "    });\r\n"
    "    gestureSensitivityInput.value = String(custom.gestureSensitivity);\r\n"
    "    gestureSensitivityCurrent.textContent = `${custom.gestureSensitivity}%`;\r\n"
    "    gestureStatusEl.textContent = gestureStatusText;\r\n"
    "  };\r\n"
    "  const stopGesture = (): void => {\r\n"
    "    gestureController?.stop();\r\n"
    "    gestureController = null;\r\n"
    "  };\r\n"
    "  const applyGestureSetting = (): void => {\r\n"
    "    if (!custom.gesture) {\r\n"
    "      stopGesture();\r\n"
    "      gestureStatusText = '开启后会请求摄像头权限；画面只在本地识别，不上传';\r\n"
    "      syncGestureUi();\r\n"
    "      return;\r\n"
    "    }\r\n"
    "    if (!gestureController) {\r\n"
    "      gestureController = createGestureController({\r\n"
    "        onSwipe: (direction) => {\r\n"
    "          if (lyricsOpen) return;\r\n"
    "          space?.turnPage(direction);\r\n"
    "        },\r\n"
    "        onFist: () => {\r\n"
    "          island.toggle();\r\n"
    "        },\r\n"
    "        onPinch: (scale) => {\r\n"
    "          space?.zoomBy(scale);\r\n"
    "        },\r\n"
    "        onStatus: (active, label) => {\r\n"
    "          gestureStatusText = active ? `手势 · ${label}` : label;\r\n"
    "          gestureStatusEl.textContent = gestureStatusText;\r\n"
    "        },\r\n"
    "        onError: (message) => {\r\n"
    "          custom.gesture = false;\r\n"
    "          persistCustom();\r\n"
    "          stopGesture();\r\n"
    "          gestureStatusText = message;\r\n"
    "          showToast(message, 'error');\r\n"
    "          syncGestureUi();\r\n"
    "        },\r\n"
    "      });\r\n"
    "    }\r\n"
    "    gestureController.setSensitivity(custom.gestureSensitivity / 100);\r\n"
    "    gestureStatusText = '手势 · 正在启动摄像头…';\r\n"
    "    void gestureController.start().catch(() => undefined);\r\n"
    "    syncGestureUi();\r\n"
    "  };\r\n"
    "  gestureBtns.forEach((btn) => {\r\n"
    "    btn.addEventListener('click', () => {\r\n"
    "      custom.gesture = btn.dataset.gesture === 'on';\r\n"
    "      persistCustom();\r\n"
    "      applyGestureSetting();\r\n"
    "      setStatus(custom.gesture ? '摄像头手势已开启' : '摄像头手势已关闭');\r\n"
    "    });\r\n"
    "  });\r\n"
    "  gestureSensitivityInput.addEventListener('input', () => {\r\n"
    "    custom.gestureSensitivity = Math.min(\r\n"
    "      100,\r\n"
    "      Math.max(20, Math.round(Number(gestureSensitivityInput.value) || 60)),\r\n"
    "    );\r\n"
    "    gestureSensitivityCurrent.textContent = `${custom.gestureSensitivity}%`;\r\n"
    "    gestureController?.setSensitivity(custom.gestureSensitivity / 100);\r\n"
    "    persistCustom();\r\n"
    "  });\r\n"
)

hotkey_block = (
    "  hotkeysReset?.addEventListener('click', () => {\r\n"
    "    hotkeyCapture = null;\r\n"
    "    custom.hotkeys = { ...HOTKEY_DEFAULT };\r\n"
    "    persistCustom();\r\n"
    "    syncHotkeysUi();\r\n"
    "    setStatus('已恢复默认快捷键');\r\n"
    "  });"
)
t = rep(t, hotkey_block, hotkey_block + "\r\n" + logic, "shell-handlers")
save(p, t)

# ---------------- WebViewHost.cs ----------------
p = "src/Zilux2/WebViewHost.cs"
t = load(p)
t = rep(
    t,
    "            core.NewWindowRequested += OnNewWindowRequested;",
    "            core.NewWindowRequested += OnNewWindowRequested;\r\n"
    "            core.PermissionRequested += OnPermissionRequested;",
    "host-hook",
)
t = rep(
    t,
    "                core.NewWindowRequested -= OnNewWindowRequested;",
    "                core.NewWindowRequested -= OnNewWindowRequested;\r\n"
    "                core.PermissionRequested -= OnPermissionRequested;",
    "host-unhook",
)
t = rep(
    t,
    "    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)",
    "    private static void OnPermissionRequested(object? sender, CoreWebView2PermissionRequestedEventArgs e)\r\n"
    "    {\r\n"
    "        // 摄像头手势需要相机权限；其余权限保持默认（拒绝）\r\n"
    "        if (e.PermissionKind == CoreWebView2PermissionKind.Camera)\r\n"
    "        {\r\n"
    "            e.State = CoreWebView2PermissionState.Allow;\r\n"
    "            HostLog.Info(\"[web] camera permission allowed\");\r\n"
    "        }\r\n"
    "    }\r\n"
    "\r\n"
    "    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)",
    "host-handler",
)
save(p, t)
print("DONE")
