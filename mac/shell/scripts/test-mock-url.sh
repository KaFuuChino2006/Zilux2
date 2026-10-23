#!/usr/bin/env bash
# 验证不开引擎的逃生通道：ZILUX2_URL + ZILUX2_MOCK=1（static-server.mjs 直接服务 web/dist）。
# 用途：壳/页面联调时不依赖 .NET 引擎。
set -u

cd "$(dirname "$0")/../../.." || exit 1
REPO=$(pwd)
NODE="C:/Users/13329/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"
PORT=9347
OUT="$REPO/mac/build/mock-url-userdata"
LOG="$REPO/mac/build/mock-static.log"

cleanup() {
  if [ -n "${STATIC_PID:-}" ]; then
    taskkill //PID "$STATIC_PID" //T //F >/dev/null 2>&1 || kill "$STATIC_PID" 2>/dev/null
  fi
}
trap cleanup EXIT INT TERM

rm -rf "$OUT"
echo "== 启动静态服务器（web/dist）=="
"$NODE" mac/shell/dev/static-server.mjs --root "$REPO/web/dist" --port "$PORT" >"$LOG" 2>&1 &
STATIC_PID=$!
for _ in $(seq 1 30); do
  if grep -q STATIC_READY "$LOG" 2>/dev/null; then break; fi
  sleep 0.2
done
head -2 "$LOG"

echo "== 不启引擎，直接加载 URL + mock 数据 =="
STEPS=mac/shell/dev/steps/discover.mjs \
USER_DATA="$OUT" \
ZILUX2_URL="http://127.0.0.1:$PORT/index.html" \
ZILUX2_MOCK=1 \
"$NODE" mac/shell/dev/cdp-run.mjs 2>&1 | grep -E "PASS|FAIL|ERROR|steps"

echo "== 宿主日志确认 =="
grep -E "ZILUX2_URL override|ZILUX2_MOCK|\[engine\]" "$OUT/shell.log" | head -5
