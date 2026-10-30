#!/usr/bin/env bash
# 三组端到端验证各跑一遍（互不污染：每组独立的 MANAGE_API_HOME）。
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

cycle e2e        .test/run-e2e.mjs         good:5101 good:5102 bogus:5103
cycle gateway    .test/run-gateway.mjs     good:5101 good:5102 bogus:5103
cycle commitgate .test/run-commit-gate.mjs good:5101 good:5102 roleonly:5104

echo "SUMMARY $SUMMARY"
