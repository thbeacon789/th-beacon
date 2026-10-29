#!/usr/bin/env bash
# th-beacon 錯誤事件回報（服務執行期錯誤）。CI 測試結果請改用 heartbeat-to-beacon.sh。
# 用法：BEACON_URL=https://th-beacon.vercel.app/api/ingest \
#       BEACON_SERVICE=my-service BEACON_SECRET=xxx \
#       ./report-to-beacon.sh "payment provider request failed" "https://logs.example/req/42" payment_error
# 第 3 參數 errorType 省略時為 test_failure（相容舊用法）。message 要固定，變動值放 runUrl。
set -euo pipefail

BEACON_URL="${BEACON_URL:?BEACON_URL is required}"
BEACON_SERVICE="${BEACON_SERVICE:?BEACON_SERVICE is required}"
BEACON_SECRET="${BEACON_SECRET:?BEACON_SECRET is required}"
MESSAGE="${1:?usage: report-to-beacon.sh <message> [runUrl] [errorType]}"
RUN_URL="${2:-}"
ERROR_TYPE="${3:-test_failure}"

TS="$(date +%s)"
BODY="$(jq -cn --arg m "$MESSAGE" --arg u "$RUN_URL" --arg t "$ERROR_TYPE" \
  '{message:$m, errorType:$t, level:"error", metadata:(if $u == "" then {} else {runUrl:$u} end)}')"
SIG="$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$BEACON_SECRET" -hex | sed 's/^.* //')"

curl -sS --fail-with-body -X POST "$BEACON_URL" \
  -H "Content-Type: application/json" \
  -H "X-Beacon-Service: $BEACON_SERVICE" \
  -H "X-Beacon-Timestamp: $TS" \
  -H "X-Beacon-Signature: sha256=$SIG" \
  -d "$BODY"
