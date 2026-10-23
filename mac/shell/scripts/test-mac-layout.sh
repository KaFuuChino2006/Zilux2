#!/usr/bin/env bash
# 验证「macOS 打包布局」的路径解析（在 Windows 上用 win-test 的 electron 模拟）：
#   <electron>/resources/app/{package.json,main.js,preload.js}
#   <electron>/resources/web/      ← web/dist 内容
#   <electron>/resources/engine/   ← Zilux2MacEngine(.exe)
# 期望：main.js 从 <resources>/web 与 <resources>/engine 解析，页面正常启动。
# 跑完自动把 app/web、app/engine 挪回去（trap 恢复）。
set -u

cd "$(dirname "$0")/../../.." || exit 1
REPO=$(pwd)
APP="$REPO/mac/build/win-test/resources/app"
RES="$REPO/mac/build/win-test/resources"
NODE="C:/Users/13329/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"
OUT="$REPO/mac/build/mac-layout-userdata"

restore() {
  if [ -d "$RES/web" ] && [ ! -d "$APP/web" ]; then mv "$RES/web" "$APP/web"; fi
  if [ -d "$RES/engine" ] && [ ! -d "$APP/engine" ]; then mv "$RES/engine" "$APP/engine"; fi
}
trap restore EXIT INT TERM

restore
rm -rf "$OUT"

echo "== 挪成 mac 打包布局 =="
[ -d "$APP/web" ] && mv "$APP/web" "$RES/web"
[ -d "$APP/engine" ] && mv "$APP/engine" "$RES/engine"
echo "app:    $(ls "$APP")"
echo "resources: $(ls "$RES")"

echo "== 用该布局启动并跑 discover 步骤 =="
STEPS=mac/shell/dev/steps/discover.mjs \
USER_DATA="$OUT" \
"$NODE" mac/shell/dev/cdp-run.mjs 2>&1 | grep -E "PASS|FAIL|ERROR|steps"

echo "== 宿主解析结果 =="
grep -E "\[boot\] enginePath|\[boot\] webRoot" "$OUT/shell.log"
