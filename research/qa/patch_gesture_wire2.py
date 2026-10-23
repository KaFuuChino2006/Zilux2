"""手势接线补丁（第二版）：按文件自动识别换行，可重复执行。"""
import io
from pathlib import Path

ROOT = Path(r"E:\Zilux2开发")


def edit(rel, steps):
    path = ROOT / rel
    raw = io.open(path, "r", encoding="utf-8", newline="").read()
    nl = "\r\n" if "\r\n" in raw else "\n"
    t = raw.replace("\r\n", "\n")
    for label, old, new in steps:
        if new and new in t and old not in t:
            print("SKIP(already):", label)
            continue
        got = t.count(old)
        if got != 1:
            raise SystemExit(f"FAIL {label}: count={got}")
        t = t.replace(old, new)
        print("OK:", label)
    io.open(path, "w", encoding="utf-8", newline="").write(t.replace("\n", nl))


# ---------------- gesture.ts ----------------
edit(
    "web/src/ui/gesture.ts",
    [
        (
            "gesture-import",
            "export interface GestureCallbacks {",
            "import { host } from '../bridge';\n\nexport interface GestureCallbacks {",
        ),
        (
            "gesture-hostlog",
            "function hostLog(level: 'info' | 'warn', message: string): void {\n"
            "  try {\n"
            "    const bridge = (window as unknown as { dshHost?: { log?: (level: string, message: string) => void } }).dshHost;\n"
            "    bridge?.log?.(level, message);\n"
            "  } catch {\n"
            "    // ignore\n"
            "  }\n"
            "}",
            "function hostLog(level: 'info' | 'warn', message: string): void {\n"
            "  host.log(level, message);\n"
            "}",
        ),
    ],
)

# ---------------- floatScene.ts ----------------
edit(
    "web/src/three/floatScene.ts",
    [
        (
            "fs-interface",
            "  turnPage(direction: number): boolean;",
            "  turnPage(direction: number): boolean;\n"
            "  /** 手势捏合缩放：在当前缩放上乘一个系数（1.0 附近，>1 放大） */\n"
            "  zoomBy(factor: number): void;",
        ),
        (
            "fs-impl",
            "    isFlipping() {\n      return flipping;\n    },",
            "    zoomBy(factor) {\n"
            "      zoomTarget = Math.min(2.6, Math.max(0.3, zoomTarget * factor));\n"
            "    },\n"
            "    isFlipping() {\n"
            "      return flipping;\n"
            "    },",
        ),
    ],
)

# ---------------- spaceShell.ts ----------------
html = (
    '          <section class="custom-section">\n'
    '            <header class="custom-section-head">\n'
    '              <span class="custom-kicker">手势</span>\n'
    "              <div>\n"
    "                <h3>摄像头手势</h3>\n"
    "                <p>挥手翻页 · 握拳播放/暂停 · 捏合缩放</p>\n"
    "              </div>\n"
    "            </header>\n"
    '            <div class="custom-field">\n'
    '              <div class="custom-seg" data-gesture-seg>\n'
    '                <button class="custom-seg-btn" data-gesture="off" type="button">关</button>\n'
    '                <button class="custom-seg-btn" data-gesture="on" type="button">开</button>\n'
    "              </div>\n"
    '              <p class="custom-tip" data-gesture-status>开启后会请求摄像头权限；画面只在本地识别，不上传</p>\n'
    "            </div>\n"
    '            <div class="custom-field">\n'
    '              <div class="custom-label"><span>手势灵敏度</span><b data-gesture-sensitivity-current>60%</b></div>\n'
    '              <input class="custom-slider" data-gesture-sensitivity type="range" min="20" max="100" step="1" value="60" aria-label="手势灵敏度" />\n'
    '              <p class="custom-tip">越高越容易触发挥手翻页</p>\n'
    "            </div>\n"
    "          </section>\n"
)

logic = (
    "  // 摄像头手势（MediaPipe Hands，本地离线资源；画面不出本机）\n"
    "  let gestureController: GestureController | null = null;\n"
    "  let gestureStatusText = '开启后会请求摄像头权限；画面只在本地识别，不上传';\n"
    "  const syncGestureUi = (): void => {\n"
    "    gestureBtns.forEach((btn) => {\n"
    "      btn.classList.toggle('is-on', (btn.dataset.gesture === 'on') === custom.gesture);\n"
    "    });\n"
    "    gestureSensitivityInput.value = String(custom.gestureSensitivity);\n"
    "    gestureSensitivityCurrent.textContent = `${custom.gestureSensitivity}%`;\n"
    "    gestureStatusEl.textContent = gestureStatusText;\n"
    "  };\n"
    "  const stopGesture = (): void => {\n"
    "    gestureController?.stop();\n"
    "    gestureController = null;\n"
    "  };\n"
    "  const applyGestureSetting = (): void => {\n"
    "    if (!custom.gesture) {\n"
    "      stopGesture();\n"
    "      gestureStatusText = '开启后会请求摄像头权限；画面只在本地识别，不上传';\n"
    "      syncGestureUi();\n"
    "      return;\n"
    "    }\n"
    "    if (!gestureController) {\n"
    "      gestureController = createGestureController({\n"
    "        onSwipe: (direction) => {\n"
    "          if (lyricsOpen) return;\n"
    "          space?.turnPage(direction);\n"
    "        },\n"
    "        onFist: () => {\n"
    "          island.toggle();\n"
    "        },\n"
    "        onPinch: (scale) => {\n"
    "          space?.zoomBy(scale);\n"
    "        },\n"
    "        onStatus: (active, label) => {\n"
    "          gestureStatusText = active ? `手势 · ${label}` : label;\n"
    "          gestureStatusEl.textContent = gestureStatusText;\n"
    "        },\n"
    "        onError: (message) => {\n"
    "          custom.gesture = false;\n"
    "          persistCustom();\n"
    "          stopGesture();\n"
    "          gestureStatusText = message;\n"
    "          showToast(message, 'error');\n"
    "          syncGestureUi();\n"
    "        },\n"
    "      });\n"
    "    }\n"
    "    gestureController.setSensitivity(custom.gestureSensitivity / 100);\n"
    "    gestureStatusText = '手势 · 正在启动摄像头…';\n"
    "    void gestureController.start().catch(() => undefined);\n"
    "    syncGestureUi();\n"
    "  };\n"
    "  gestureBtns.forEach((btn) => {\n"
    "    btn.addEventListener('click', () => {\n"
    "      custom.gesture = btn.dataset.gesture === 'on';\n"
    "      persistCustom();\n"
    "      applyGestureSetting();\n"
    "      setStatus(custom.gesture ? '摄像头手势已开启' : '摄像头手势已关闭');\n"
    "    });\n"
    "  });\n"
    "  gestureSensitivityInput.addEventListener('input', () => {\n"
    "    custom.gestureSensitivity = Math.min(\n"
    "      100,\n"
    "      Math.max(20, Math.round(Number(gestureSensitivityInput.value) || 60)),\n"
    "    );\n"
    "    gestureSensitivityCurrent.textContent = `${custom.gestureSensitivity}%`;\n"
    "    gestureController?.setSensitivity(custom.gestureSensitivity / 100);\n"
    "    persistCustom();\n"
    "  });\n"
)

hotkey_block = (
    "  hotkeysReset?.addEventListener('click', () => {\n"
    "    hotkeyCapture = null;\n"
    "    custom.hotkeys = { ...HOTKEY_DEFAULT };\n"
    "    persistCustom();\n"
    "    syncHotkeysUi();\n"
    "    setStatus('已恢复默认快捷键');\n"
    "  });"
)

edit(
    "web/src/ui/spaceShell.ts",
    [
        (
            "shell-import",
            "import { createIslandPlayer, formatClock } from './islandPlayer';",
            "import { createIslandPlayer, formatClock } from './islandPlayer';\n"
            "import { createGestureController, type GestureController } from './gesture';",
        ),
        (
            "shell-html",
            '          <section class="custom-section custom-collapse" data-lyrics-anim>',
            html + '          <section class="custom-section custom-collapse" data-lyrics-anim>',
        ),
        (
            "shell-queries",
            "  const hotkeysReset = root.querySelector<HTMLButtonElement>('[data-hotkeys-reset]');",
            "  const hotkeysReset = root.querySelector<HTMLButtonElement>('[data-hotkeys-reset]');\n"
            "  const gestureBtns = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-gesture]'));\n"
            "  const gestureSensitivityInput = root.querySelector<HTMLInputElement>('[data-gesture-sensitivity]')!;\n"
            "  const gestureSensitivityCurrent = root.querySelector<HTMLElement>('[data-gesture-sensitivity-current]')!;\n"
            "  const gestureStatusEl = root.querySelector<HTMLElement>('[data-gesture-status]')!;",
        ),
        (
            "shell-default",
            "    mgcInset: 34,",
            "    gesture: false,\n    gestureSensitivity: 60,\n    mgcInset: 34,",
        ),
        (
            "shell-load",
            "        lyricTracking: clampUnit(parsed.lyricTracking, DEFAULT_CUSTOM.lyricTracking, 50, 250),",
            "        lyricTracking: clampUnit(parsed.lyricTracking, DEFAULT_CUSTOM.lyricTracking, 50, 250),\n"
            "        gesture: (parsed as { gesture?: unknown }).gesture === true,\n"
            "        gestureSensitivity: clampUnit(\n"
            "          (parsed as { gestureSensitivity?: unknown }).gestureSensitivity,\n"
            "          DEFAULT_CUSTOM.gestureSensitivity,\n"
            "          20,\n"
            "          100,\n"
            "        ),",
        ),
        (
            "shell-sync",
            "    syncHotkeysUi();\n    syncSweepUi();",
            "    syncHotkeysUi();\n    syncGestureUi();\n    syncSweepUi();",
        ),
        (
            "shell-apply-custom",
            "    space?.setLyricFontFamily(custom.lyricFont || '');\n    applyLyricTypeStyle();",
            "    space?.setLyricFontFamily(custom.lyricFont || '');\n"
            "    applyLyricTypeStyle();\n"
            "    applyGestureSetting();",
        ),
        ("shell-handlers", hotkey_block, hotkey_block + "\n" + logic),
    ],
)

# ---------------- WebViewHost.cs ----------------
edit(
    "src/Zilux2/WebViewHost.cs",
    [
        (
            "host-hook",
            "            core.NewWindowRequested += OnNewWindowRequested;",
            "            core.NewWindowRequested += OnNewWindowRequested;\n"
            "            core.PermissionRequested += OnPermissionRequested;",
        ),
        (
            "host-unhook",
            "                core.NewWindowRequested -= OnNewWindowRequested;",
            "                core.NewWindowRequested -= OnNewWindowRequested;\n"
            "                core.PermissionRequested -= OnPermissionRequested;",
        ),
        (
            "host-handler",
            "    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)",
            "    private static void OnPermissionRequested(object? sender, CoreWebView2PermissionRequestedEventArgs e)\n"
            "    {\n"
            "        // 摄像头手势需要相机权限；其余权限保持默认（拒绝）\n"
            "        if (e.PermissionKind == CoreWebView2PermissionKind.Camera)\n"
            "        {\n"
            "            e.State = CoreWebView2PermissionState.Allow;\n"
            "            HostLog.Info(\"[web] camera permission allowed\");\n"
            "        }\n"
            "    }\n"
            "\n"
            "    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)",
        ),
    ],
)
print("DONE")
