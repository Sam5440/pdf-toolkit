#!/bin/bash
# 一键启动 PDF 万能工具箱
#   ./start.sh            服务已构建的 dist/ 并打开浏览器（默认端口 8137，被占用自动顺延）
#   ./start.sh 9000       指定起始端口
#   ./start.sh --dev      改用 Vite 开发模式（http://localhost:5173）
set -euo pipefail
cd "$(dirname "$0")"

MODE=""
PORT=8137
for arg in "$@"; do
  case "$arg" in
    --dev) MODE="--dev" ;;
    *) PORT="$arg" ;;
  esac
done

open_url() {  # 打开浏览器，非 macOS 退回 xdg-open
  if command -v open >/dev/null 2>&1; then open "$1"; else xdg-open "$1" 2>/dev/null || true; fi
}

port_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

if [ "$MODE" = "--dev" ]; then
  [ -d node_modules ] || npm install
  ( sleep 2; open_url "http://localhost:5173/" ) &
  exec npm run dev
fi

# 端口被占用则向后顺延，最多试 10 个
n=0
while ! port_free "$PORT"; do
  PORT=$((PORT + 1)); n=$((n + 1))
  if [ "$n" -ge 10 ]; then echo "错误: $((PORT - n))~$PORT 端口都被占用" >&2; exit 1; fi
done

# dist 缺失时自动构建
if [ ! -f dist/index.html ]; then
  echo "未发现 dist/，开始构建…"
  [ -d node_modules ] || npm install
  npm run build
fi

echo "PDF 万能工具箱: http://127.0.0.1:$PORT/"
( sleep 1; open_url "http://127.0.0.1:$PORT/" ) &
exec python3 scripts/serve.py dist "$PORT"
