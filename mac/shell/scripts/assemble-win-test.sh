#!/usr/bin/env bash
# 组装 Windows 联调用的 Electron 应用目录（仅开发/联调，不进入交付产物）。
#
# 产物布局（Electron 的 resources/app 布局，electron.exe 会自动加载它）：
#   mac/build/win-test/resources/app/
#   ├── package.json        # mac/shell/package.json
#   ├── main.js             # mac/shell/main.js
#   ├── preload.js          # mac/shell/preload.js
#   ├── web/                # ← web/dist 的拷贝（打包时这里是 process.resourcesPath/web）
#   └── engine/             # ← mac/engine/publish/win-x64/*（打包时这里是 process.resourcesPath/engine）
#
# 用法：
#   bash mac/shell/scripts/assemble-win-test.sh
# 前置：mac/build/win-test/ 里已经解压好 electron-v33.2.1-win32-x64.zip（见 README）。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SHELL_DIR="$REPO_ROOT/mac/shell"
APP_DIR="$REPO_ROOT/mac/build/win-test/resources/app"
ENGINE_DIR="$REPO_ROOT/mac/engine/publish/win-x64"
WEB_DIST="$REPO_ROOT/web/dist"
ELECTRON_EXE="$REPO_ROOT/mac/build/win-test/electron.exe"

echo "== assemble win-test app =="
echo "repo   : $REPO_ROOT"
echo "target : $APP_DIR"

if [[ ! -f "$ELECTRON_EXE" ]]; then
  echo "!! 缺 electron.exe：$ELECTRON_EXE" >&2
  echo "   先把 mac/cache/electron-v33.2.1-win32-x64.zip 解压到 mac/build/win-test/" >&2
  exit 1
fi
if [[ ! -f "$WEB_DIST/index.html" ]]; then
  echo "!! 缺 web/dist/index.html，先用 Windows 版仓库脚本构建 web 前端" >&2
  exit 1
fi

mkdir -p "$APP_DIR"
rm -rf "$APP_DIR/web" "$APP_DIR/engine"
rm -f "$APP_DIR/package.json" "$APP_DIR/main.js" "$APP_DIR/preload.js"

cp "$SHELL_DIR/package.json" "$SHELL_DIR/main.js" "$SHELL_DIR/preload.js" "$APP_DIR/"
cp -R "$WEB_DIST" "$APP_DIR/web"

if [[ -f "$ENGINE_DIR/Zilux2MacEngine.exe" ]]; then
  mkdir -p "$APP_DIR/engine"
  cp -R "$ENGINE_DIR/." "$APP_DIR/engine/"
  echo "engine : 已拷入 $ENGINE_DIR"
else
  echo "engine : 还没有 $ENGINE_DIR/Zilux2MacEngine.exe"
  echo "         （壳仍可启动，但需要 mac/engine 先发布 win-x64 产物；"
  echo "           或联调时用 ZILUX2_ENGINE=mac/shell/dev/stub-engine.mjs 走桩引擎）"
fi

echo ""
echo "== app 目录内容 =="
du -sh "$APP_DIR" 2>/dev/null || true
find "$APP_DIR" -maxdepth 2 -mindepth 1 \( -name assets -o -name fonts \) -prune -o -maxdepth 2 -mindepth 1 -print 2>/dev/null | sed "s|$APP_DIR|  app|"
echo ""
echo "启动：\"$ELECTRON_EXE\""
echo "CDP ：node mac/shell/dev/cdp-run.mjs"
