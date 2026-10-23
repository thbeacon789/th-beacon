#!/usr/bin/env bash
# th-beacon 心跳回報。CI 在 if: always() 下呼叫，成功失敗都要送。
# 用法：BEACON_URL=https://beacon.example.com/api/heartbeat \
#       BEACON_SERVICE=my-service BEACON_SECRET=xxx \
#       ./heartbeat-to-beacon.sh daily-test pass "https://github.com/o/r/actions/runs/42" "summary" [diagnosisFile]
# diagnosisFile（選填）：diagnose-e2e-failure.sh 的輸出。含 .error → diagnosisError；含 .category → diagnosis；
#                        檔案不存在或無法解析則忽略。
set -euo pipefail

BEACON_URL="${BEACON_URL:?BEACON_URL is required}"
BEACON_SERVICE="${BEACON_SERVICE:?BEACON_SERVICE is required}"
BEACON_SECRET="${BEACON_SECRET:?BEACON_SECRET is required}"
NAME="${1:?usage: heartbeat-to-beacon.sh <name> <pass|fail> [runUrl] [summary]}"
STATUS="${2:?usage: heartbeat-to-beacon.sh <name> <pass|fail> [runUrl] [summary]}"
RUN_URL="${3:-}"
SUMMARY="${4:-}"
DIAG_FILE="${5:-}"

# 第 5 參數：只有檔案恰含一個 JSON 物件才採用；多值、非物件、壞 JSON 一律忽略（判讀絕不能弄壞心跳）
DIAG_JSON='{}'
if [ -n "$DIAG_FILE" ] && [ -f "$DIAG_FILE" ]; then
  DIAG_JSON="$(jq -cs 'if length == 1 and (.[0] | type) == "object" then .[0] else {} end' "$DIAG_FILE" 2>/dev/null)" || DIAG_JSON='{}'
  [ -n "$DIAG_JSON" ] || DIAG_JSON='{}'
fi

TS="$(date +%s)"
BODY="$(jq -cn --arg n "$NAME" --arg s "$STATUS" --arg u "$RUN_URL" --arg m "$SUMMARY" --argjson d "$DIAG_JSON" \
  '{name:$n, status:$s}
   + (if $u == "" then {} else {runUrl:$u} end)
   + (if $m == "" then {} else {summary:$m} end)
   + (if ($d.error | type) == "string" and $d.error != "" then {diagnosisError:$d.error} else {} end)
   + (if ($d.category | type) == "string" then {diagnosis:$d} else {} end)')"
SIG="$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$BEACON_SECRET" -hex | sed 's/^.* //')"

curl -sS --fail-with-body -X POST "$BEACON_URL" \
  -H "Content-Type: application/json" \
  -H "X-Beacon-Service: $BEACON_SERVICE" \
  -H "X-Beacon-Timestamp: $TS" \
  -H "X-Beacon-Signature: sha256=$SIG" \
  -d "$BODY"
