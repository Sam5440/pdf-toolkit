#!/usr/bin/env bash
# 一键测试入口：unit → build → e2e → verify(+legacy)
# 用法: bash scripts/run_tests.sh [--verify-only|--e2e-only|--unit-only] [--no-build]
set -uo pipefail
cd "$(dirname "$0")/.."

MODE="all"
NO_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --verify-only) MODE="verify" ;;
    --e2e-only) MODE="e2e" ;;
    --unit-only) MODE="unit" ;;
    --no-build) NO_BUILD=1 ;;
    *) echo "未知参数: $arg"; exit 2 ;;
  esac
done

FAILED=""
step() { printf '\n\033[1;36m════════ %s ════════\033[0m\n' "$1"; }

run_step() { # 名称, 命令...
  local name="$1"; shift
  step "$name"
  if "$@"; then
    printf '\033[1;32m✔ %s 通过\033[0m\n' "$name"
  else
    printf '\033[1;31m✘ %s 失败\033[0m\n' "$name"
    FAILED="$FAILED $name"
  fi
}

if [ "$MODE" = "all" ] || [ "$MODE" = "unit" ]; then
  run_step "单元测试(vitest)" npx vitest run
fi

if [ "$MODE" = "all" ]; then
  if [ "$NO_BUILD" -eq 0 ]; then
    run_step "构建(vite build)" npx vite build
  fi
fi

if [ "$MODE" = "all" ] || [ "$MODE" = "e2e" ]; then
  mkdir -p tests/e2e/.artifacts
  run_step "e2e(Playwright)" npx playwright test
fi

if [ "$MODE" = "all" ] || [ "$MODE" = "verify" ]; then
  run_step "独立校验(pytest verify)" python3 -m pytest tests/verify -v
  run_step "旧版回归(pytest legacy)" python3 -m pytest tests/legacy -v
fi

step "汇总"
if [ -n "$FAILED" ]; then
  printf '\033[1;31m失败步骤:%s\033[0m\n' "$FAILED"
  exit 1
fi
printf '\033[1;32m全部通过 ✔\033[0m\n'
