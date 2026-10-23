#!/usr/bin/env bash
# win-x64 冒烟：启动 publish 出来的引擎，curl 打关键接口与静态资源，最后验证 stdin EOF 优雅退出。
# 用法：bash mac/engine/tools/smoke_win.sh
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ENGINE="$ROOT/mac/engine/publish/win-x64/Zilux2MacEngine.exe"
WEBROOT="$ROOT/web/dist"
OUT="$(mktemp -d)"
FAIL=0

mask() { sed -E 's/"token":"[0-9a-f]+"/"token":"***"/'; }

# hit <expect> <label> <url> [extra curl args...]
hit() {
  local expect="$1" label="$2" url="$3"; shift 3
  local code size ctype
  code="$(curl -sS -m 30 -o "$OUT/body" -w '%{http_code}' "$@" "$url" 2>"$OUT/curlerr")" || code="curl-fail"
  size="$(wc -c < "$OUT/body" | tr -d ' ')"
  ctype="$(curl -sS -m 30 -o /dev/null -D - "$@" "$url" 2>/dev/null | tr -d '\r' | awk 'tolower($1)=="content-type:"{print $2; exit}')"
  echo "[$label] HTTP $code (expect $expect) bytes=$size content-type=${ctype:-?}"
  case "$ctype" in
    *font*|*image*|*octet-stream*) echo "  (binary body omitted)" ;;
    *) head -c 320 "$OUT/body"; echo ;;
  esac
  if [ "$code" != "$expect" ]; then
    echo "  -> FAIL: expected HTTP $expect, got $code"; FAIL=1
  fi
}

expect_code() { # expect_code <label> <expected> <url>
  local label="$1" expect="$2" url="$3" code
  code="$(curl -sS -m 20 -o "$OUT/body" -w '%{http_code}' "$url" 2>/dev/null)" || code="curl-fail"
  echo "[$label] HTTP $code (expect $expect)"
  [ "$code" = "$expect" ] || { echo "  -> FAIL: expected HTTP $expect, got $code"; FAIL=1; }
}

echo "== engine: $ENGINE"
echo "== web-root: $WEBROOT"
ls "$WEBROOT/index.html" >/dev/null 2>&1 || { echo "web/dist/index.html 不存在"; exit 1; }

# 用 sleep 撑住 stdin 管道，引擎在 sleep 结束后会读到 EOF 自行退出（同时验证优雅退出路径）。
sleep 20 | "$ENGINE" --web-root "$WEBROOT" > "$OUT/ready.out" 2> "$OUT/ready.err" &
PID=$!

for _ in $(seq 1 120); do
  grep -q '^ZILUX2_READY ' "$OUT/ready.out" 2>/dev/null && break
  sleep 0.25
done

READY="$(grep -m1 '^ZILUX2_READY ' "$OUT/ready.out" 2>/dev/null || true)"
if [ -z "$READY" ]; then
  echo "!! 没有收到 ZILUX2_READY"
  echo "--- stderr"; cat "$OUT/ready.err"
  echo "--- stdout"; cat "$OUT/ready.out"
  kill "$PID" 2>/dev/null
  exit 1
fi

JSON="${READY#ZILUX2_READY }"
PORT="$(printf '%s' "$JSON" | sed -E 's/^.*"port":([0-9]+).*$/\1/')"
TOKEN="$(printf '%s' "$JSON" | sed -E 's/^.*"token":"([0-9a-f]+)".*$/\1/')"
BASE="http://127.0.0.1:$PORT"

echo "== READY (token masked): $(printf '%s' "$JSON" | mask)"
echo "== pid=$PID port=$PORT"
echo

echo "---- 1) /api/health"
hit 200 health "$BASE/api/health?token=$TOKEN"
echo "---- 2) /api/sources"
hit 200 sources "$BASE/api/sources?token=$TOKEN"
echo "---- 3a) /api/search (正式契约参数 q，web/src/online/client.ts 用的就是 q)"
hit 200 "search-q(周杰伦)" "$BASE/api/search?token=$TOKEN&source=netease&limit=5&q=%E5%91%A8%E6%9D%B0%E4%BC%A6"
echo "---- 3b) /api/search?keyword=...（任务书写法；原实现只认 q，契约上返回 400）"
hit 400 "search-keyword" "$BASE/api/search?token=$TOKEN&source=netease&limit=5&keyword=%E5%91%A8%E6%9D%B0%E4%BC%A6"
echo "---- 4) 静态首页 /"
hit 200 index "$BASE/"
echo "---- 5) 静态资源（assets 的 js + fonts 的字体文件）"
ASSET="$(find "$WEBROOT/assets" -type f -name '*.js' 2>/dev/null | head -1)"
FONT="$(find "$WEBROOT/fonts" -type f \( -name '*.woff2' -o -name '*.woff' -o -name '*.ttf' -o -name '*.otf' \) 2>/dev/null | head -1)"
[ -n "$ASSET" ] && hit 200 "asset $(basename "$ASSET")" "$BASE/${ASSET#$WEBROOT/}"
[ -n "$FONT" ] && hit 200 "font $(basename "$FONT")" "$BASE/${FONT#$WEBROOT/}"
echo "---- 6) 路径穿越防护 /%2e%2e/%2e%2e/package.json（预期 404）"
hit 404 traversal "$BASE/%2e%2e/%2e%2e/package.json"
echo "---- 7) HEAD /（预期 200 且 size_download=0）"
HEAD_RESULT="$(curl -sS -m 10 -I -o /dev/null -w '%{http_code} size_download=%{size_download}' "$BASE/")"
echo "  HEAD -> $HEAD_RESULT"
case "$HEAD_RESULT" in 200*size_download=0) ;; *) echo "  -> FAIL"; FAIL=1;; esac
echo "---- 7b) HEAD /api/health（API 不支持 HEAD，预期 405）"
HEAD_API="$(curl -sS -m 10 -I -o /dev/null -w '%{http_code}' "$BASE/api/health?token=$TOKEN")"
echo "  HEAD /api/health -> HTTP $HEAD_API (expect 405)"
[ "$HEAD_API" = "405" ] || { echo "  -> FAIL"; FAIL=1; }
echo "---- 8) 未知 API /api/nope（预期 404 JSON）"
hit 404 unknown-api "$BASE/api/nope?token=$TOKEN"
echo "---- 9) 无 token /api/search（预期 401）"
expect_code no-token 401 "$BASE/api/search?source=netease&q=x"

echo
echo "---- 等待 stdin EOF 优雅退出（最多 25s）"
wait "$PID"; EXIT_CODE=$?
echo "engine exit code: $EXIT_CODE"
STDOUT_LINES="$(wc -l < "$OUT/ready.out" | tr -d ' ')"
echo "stdout 行数: $STDOUT_LINES（应为 1，即只有 READY 行）"
[ "$STDOUT_LINES" = "1" ] || FAIL=1
[ "$EXIT_CODE" = "0" ] || FAIL=1
echo "--- engine stderr:"; if [ -s "$OUT/ready.err" ]; then cat "$OUT/ready.err"; else echo "(empty)"; fi

echo
echo "---- 额外验证：stdin 收到 quit 行后立即退出"
printf 'quit\n' | "$ENGINE" --web-root "$WEBROOT" > "$OUT/quit.out" 2> "$OUT/quit.err" &
QPID=$!
wait "$QPID"; QCODE=$?
echo "quit-run exit code: $QCODE, stdout=$(wc -l < "$OUT/quit.out" | tr -d ' ') line(s): $(head -c 200 "$OUT/quit.out" | mask)"
[ "$QCODE" = "0" ] || FAIL=1

echo
echo "---- 额外验证：缺少 --web-root（预期非 0 + ZILUX2_ERROR）"
"$ENGINE" > "$OUT/bad.out" 2> "$OUT/bad.err"; BADCODE=$?
echo "no-arg exit code: $BADCODE"
[ "$BADCODE" -ne 0 ] || FAIL=1
cat "$OUT/bad.err"

echo
if [ "$FAIL" = "0" ]; then echo "SMOKE RESULT: PASS"; else echo "SMOKE RESULT: FAIL"; fi
echo "logs: $OUT"
exit "$FAIL"
