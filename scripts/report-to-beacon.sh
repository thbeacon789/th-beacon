#!/usr/bin/env bash
# th-beacon CI 測試失敗回報範例。
# 用法：BEACON_URL=https://beacon.example.com/api/ingest \
#       BEACON_SERVICE=my-service BEACON_SECRET=xxx \
#       ./report-to-beacon.sh "nightly tests failed: 3 of 120" "https://ci.example/run/42"
set -euo pipefail

BEACON_URL="${BEACON_URL:?BEACON_URL is required}"
BEACON_SERVICE="${BEACON_SERVICE:?BEACON_SERVICE is required}"
BEACON_SECRET="${BEACON_SECRET:?BEACON_SECRET is required}"
MESSAGE="${1:?usage: report-to-beacon.sh <message> [runUrl]}"
RUN_URL="${2:-}"

TS="$(date +%s)"
BODY="$(jq -cn --arg m "$MESSAGE" --arg u "$RUN_URL" \
  '{message:$m, errorType:"test_failure", level:"error", metadata:(if $u == "" then {} else {runUrl:$u} end)}')"
SIG="$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$BEACON_SECRET" -hex | sed 's/^.* //')"

curl -sS -X POST "$BEACON_URL" \
  -H "Content-Type: application/json" \
  -H "X-Beacon-Service: $BEACON_SERVICE" \
  -H "X-Beacon-Timestamp: $TS" \
  -H "X-Beacon-Signature: sha256=$SIG" \
  -d "$BODY"
