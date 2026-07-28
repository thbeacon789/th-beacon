#!/usr/bin/env bash
# th-beacon 心跳回報。CI 在 if: always() 下呼叫，成功失敗都要送。
# 用法：BEACON_URL=https://beacon.example.com/api/heartbeat \
#       BEACON_SERVICE=my-service BEACON_SECRET=xxx \
#       ./heartbeat-to-beacon.sh daily-test pass "https://github.com/o/r/actions/runs/42" "summary"
set -euo pipefail

BEACON_URL="${BEACON_URL:?BEACON_URL is required}"
BEACON_SERVICE="${BEACON_SERVICE:?BEACON_SERVICE is required}"
BEACON_SECRET="${BEACON_SECRET:?BEACON_SECRET is required}"
NAME="${1:?usage: heartbeat-to-beacon.sh <name> <pass|fail> [runUrl] [summary]}"
STATUS="${2:?usage: heartbeat-to-beacon.sh <name> <pass|fail> [runUrl] [summary]}"
RUN_URL="${3:-}"
SUMMARY="${4:-}"

TS="$(date +%s)"
BODY="$(jq -cn --arg n "$NAME" --arg s "$STATUS" --arg u "$RUN_URL" --arg m "$SUMMARY" \
  '{name:$n, status:$s}
   + (if $u == "" then {} else {runUrl:$u} end)
   + (if $m == "" then {} else {summary:$m} end)')"
SIG="$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$BEACON_SECRET" -hex | sed 's/^.* //')"

curl -sS --fail-with-body -X POST "$BEACON_URL" \
  -H "Content-Type: application/json" \
  -H "X-Beacon-Service: $BEACON_SERVICE" \
  -H "X-Beacon-Timestamp: $TS" \
  -H "X-Beacon-Signature: sha256=$SIG" \
  -d "$BODY"
