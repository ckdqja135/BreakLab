#!/usr/bin/env bash
# Docker 없이 같은 바이너리를 로컬에서 실행한다. Ctrl+C로 모두 종료한다.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/.run/bin"; LOG="$ROOT/.run/logs"
mkdir -p "$BIN" "$LOG" "$ROOT/.run/data" "$ROOT/.tools/bin"

for port in 7700 7701 7710 7720 7721 8474; do
  if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then
    echo "포트 $port 가 이미 사용 중입니다. 먼저 해당 프로세스를 확인하세요."; exit 1
  fi
done

if [ ! -x "$ROOT/.tools/bin/toxiproxy-server" ]; then
  echo "Toxiproxy 2.13.0을 프로젝트 폴더에 빌드합니다"
  GOBIN="$ROOT/.tools/bin" go install github.com/Shopify/toxiproxy/v2/cmd/server@v2.13.0
  mv "$ROOT/.tools/bin/server" "$ROOT/.tools/bin/toxiproxy-server"
fi
(cd "$ROOT/server" && go build -o "$BIN/" ./cmd/...)
if [ ! -f "$ROOT/web/dist/index.html" ]; then
  (cd "$ROOT/web" && npm ci && npm run build)
fi

TOXIPROXY_AUTH_TOKEN="$(openssl rand -hex 16)"; export TOXIPROXY_AUTH_TOKEN
PIDS=()
cleanup() {
  trap - EXIT INT TERM
  # 관리 서버를 먼저 끝내 장애를 정리한 뒤 나머지를 끝낸다.
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

"$ROOT/.tools/bin/toxiproxy-server" -host 127.0.0.1 -port 8474 >"$LOG/toxiproxy.log" 2>&1 & TOXI=$!
sleep 0.5
LAB_DB="$ROOT/.run/data/lab.db" LAB_WEB_DIR="$ROOT/web/dist" "$BIN/labd" >"$LOG/labd.log" 2>&1 & LABD=$!
sleep 0.5
"$BIN/service-b" >"$LOG/service-b.log" 2>&1 & SVCB=$!
B_URL="${B_URL:-http://127.0.0.1:7721}" "$BIN/service-a" >"$LOG/service-a.log" 2>&1 & SVCA=$!
PIDS=("$LABD" "$SVCA" "$SVCB" "$TOXI")
echo "열기: http://127.0.0.1:7700  (로그: .run/logs)"
wait "$LABD"
