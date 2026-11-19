#!/usr/bin/env bash
# 回归总闸：先跑纯函数自检，再三组端到端验证各跑一遍（互不污染：每组独立的 MANAGE_API_HOME）。
#   bash .test/verify-all.sh
# 输出最后一行 SUMMARY 给出每组退出码。
cd /d/AgentWorkPlace/DSH/ManageAPI || exit 1

SUMMARY=""

cycle() {
  local name=$1
  local script=$2
  shift 2

  rm -rf "/tmp/ma-$name"
  MANAGE_API_HOME="/tmp/ma-$name" node daemon/index.js --port 4399 >"/tmp/d-$name.log" 2>&1 &
  local dp=$!
  sleep 3

  local pids=()
  local spec mode port
  for spec in "$@"; do
    mode=${spec%%:*}
    port=${spec##*:}
    MODE="$mode" PORT="$port" node .test/mock-upstream.mjs >"/tmp/m-$name-$port.log" 2>&1 &
    pids+=($!)
  done
  sleep 1

  timeout 180 node "$script" >"/tmp/t-$name.log" 2>&1
  local rc=$?

  kill "${pids[@]}" 2>/dev/null
  kill "$dp" 2>/dev/null
  wait "$dp" 2>/dev/null

  printf '%-12s exit=%s\n' "$name" "$rc"
  SUMMARY="$SUMMARY$name:$rc "
}

## 纯函数自检：脚本自己建临时数据目录，不需要 daemon 与 mock 上游。
## 放在最前面跑，是因为它最快、失败信息最直接——口径类的问题先在这里炸出来。
unit() {
  local name=$1
  local script=$2

  timeout 120 node "$script" >"/tmp/t-$name.log" 2>&1
  local rc=$?

  printf '%-12s exit=%s\n' "$name" "$rc"
  SUMMARY="$SUMMARY$name:$rc "
}

unit currency .test/check-currency.mjs

cycle e2e        .test/run-e2e.mjs         good:5101 good:5102 bogus:5103
cycle gateway    .test/run-gateway.mjs     good:5101 good:5102 bogus:5103
cycle commitgate .test/run-commit-gate.mjs good:5101 good:5102 roleonly:5104

echo "SUMMARY $SUMMARY"
