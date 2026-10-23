#!/usr/bin/env bash
# CI e2e 失敗的 AI 判讀。canonical 在 th-beacon，各 CI repo 位元組一致地複製（以 cmp 檢查）。
# 用法：diagnose-e2e-failure.sh <platform> <known-issues-file> <output-file> <log-file>...
#
# 認證（擇一）：
#   WIF（CI）：ANTHROPIC_FEDERATION_RULE_ID / ANTHROPIC_ORGANIZATION_ID / ANTHROPIC_SERVICE_ACCOUNT_ID
#              （選填 ANTHROPIC_WORKSPACE_ID，空字串視為未設）＋ runner 提供的
#              ACTIONS_ID_TOKEN_REQUEST_URL / ACTIONS_ID_TOKEN_REQUEST_TOKEN
#   API key（僅限本機試跑）：ANTHROPIC_API_KEY（設了就跳過 WIF）
# 其他：ANTHROPIC_BASE_URL、DIAGNOSE_MODEL、DIAGNOSE_MAX_BYTES、DIAGNOSE_REDACT_VARS（空白分隔的變數名）
#
# 輸出檔：成功 {"category","severity","reason","suggestion","model"}；失敗 {"error":"..."}。一律 exit 0。
# 相容 bash 3.2（macOS）。JWT 與 access token 只存在變數與 0600 暫存檔，不會印出或寫入輸出檔。
set -uo pipefail

PLATFORM="${1:-unknown}"
KNOWN_FILE="${2:-}"
OUT="${3:-}"
if [ "$#" -lt 4 ] || [ -z "$OUT" ]; then
  echo "usage: diagnose-e2e-failure.sh <platform> <known-issues-file> <output-file> <log-file>..." >&2
  [ -n "$OUT" ] && echo '{"error":"usage"}' >"$OUT" 2>/dev/null
  exit 0
fi
shift 3

BASE_URL="${ANTHROPIC_BASE_URL:-https://api.anthropic.com}"
BASE_URL="${BASE_URL%/}"
MODEL="${DIAGNOSE_MODEL:-claude-sonnet-5-5}"
MAX_BYTES="${DIAGNOSE_MAX_BYTES:-150000}"
case "$MAX_BYTES" in ''|*[!0-9]*) MAX_BYTES=150000 ;; esac

WORK="$(mktemp -d "${TMPDIR:-/tmp}/diagnose.XXXXXX")" || exit 0
chmod 700 "$WORK"
cleanup() {
  if [ ! -s "$OUT" ]; then
    jq -cn '{error:"unexpected failure"}' >"$OUT" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
: >"$OUT" # 清掉自架 runner 上可能殘留的舊結果

fail() { # 寫 {"error": "<=200 字"} 並結束
  jq -cn --arg e "$1" '{error: ($e | .[0:200])}' >"$OUT"
  echo "diagnose: $1"
  exit 0
}

# ---------- 認證 ----------
AUTH_MODE=""
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  AUTH_MODE="key"
elif [ -n "${ANTHROPIC_FEDERATION_RULE_ID:-}" ] && [ -n "${ANTHROPIC_ORGANIZATION_ID:-}" ] \
  && [ -n "${ANTHROPIC_SERVICE_ACCOUNT_ID:-}" ] && [ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] \
  && [ -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]; then
  AUTH_MODE="wif"
else
  fail "no credentials"
fi

# ---------- 組 log ----------
FILES=()
for f in "$@"; do
  [ -f "$f" ] && [ -r "$f" ] && FILES+=("$f")
done
[ "${#FILES[@]}" -gt 0 ] || fail "no log files found"

LOG="$WORK/log.txt"
: >"$LOG"
PER=$((MAX_BYTES / ${#FILES[@]}))
for f in "${FILES[@]}"; do
  header="=== $(basename "$f") ==="
  budget=$((PER - ${#header} - 2))
  [ "$budget" -lt 0 ] && budget=0
  # 順序：整檔剔除非 UTF-8 -> 整檔遮蔽 -> 取尾段 -> 再清一次（尾段切口可能落在多位元組字元中間）。
  # 先遮蔽再截斷，秘密才不會被切口劈成兩半而漏出後半段。
  CLEAN="$WORK/clean.txt"
  iconv -c -f utf-8 -t utf-8 "$f" >"$CLEAN" 2>/dev/null || fail "log cleanup failed"
  # 逐字遮蔽：值經環境變數傳給 perl（不嵌進程式碼）；位元組層級比對（不用 -CSD），非 ASCII 秘密也能命中
  for var in ${DIAGNOSE_REDACT_VARS:-}; do
    case "$var" in *[!A-Za-z0-9_]*|'') continue ;; esac
    val="${!var:-}"
    [ -n "$val" ] || continue
    REDACT_VAL="$val" perl -0777 -pe 'BEGIN { $s = $ENV{REDACT_VAL} } s/\Q$s\E/***/g' "$CLEAN" >"$CLEAN.new" \
      && mv "$CLEAN.new" "$CLEAN" || fail "redaction failed"
  done
  {
    printf '%s\n' "$header"
    tail -c "$budget" "$CLEAN" 2>/dev/null | iconv -c -f utf-8 -t utf-8 2>/dev/null
    printf '\n'
  } >>"$LOG"
done

# ---------- system prompt ----------
SYS="$WORK/system.txt"
cat >"$SYS" <<'PROMPT_EOF'
你是行動 app 每日 e2e 測試的失敗判讀助手。使用者會附上一次 e2e 失敗的 log，請判斷失敗來自「測試環境」還是「app 本身」，並給出嚴重度與修正建議。

## 分類（category）
- env：測試環境干擾（emulator／simulator、runner、系統彈窗、網路、資源不足、已知環境問題等），與 app 程式無關。
- app：app 本身的問題。
- 多個段落失敗時，只要有任一段落屬於 app 問題，整次就判 app。
- 不確定時一律判 app。寧可多叫一次人，也不要漏掉真問題。

## 嚴重度（severity）
- P0：app 核心流程確定壞掉（登入、配對、播放主流程），使用者會直接受影響。
- P1：app 問題但影響有限；或環境問題使整個 e2e 無法跑完、完全失去監控價值（例如 emulator 起不來、磁碟爆滿）。
- P2：已知或可辨識的環境干擾，只影響部分段落（例如系統彈窗搶 focus、抽到鎖區影片）。

## 輸出
- 只輸出符合 schema 的 JSON：category、severity、reason、suggestion。
- 一律使用繁體中文。
- reason 不超過 150 字，說明判定依據（引用 log 中的關鍵線索）。
- suggestion 不超過 300 字，必須具體可執行，例如「在 ci-e2e-run.sh 開跑前加 adb shell settings put …」，不要泛泛而談。

## 已知環境問題（由各 repo 維護）
PROMPT_EOF
if [ -n "$KNOWN_FILE" ] && [ -f "$KNOWN_FILE" ]; then
  iconv -c -f utf-8 -t utf-8 "$KNOWN_FILE" >>"$SYS" 2>/dev/null
else
  echo "（未提供）" >>"$SYS"
fi

# ---------- 取得憑證 ----------
HDR="$WORK/hdr.cfg" # curl config，內含認證 header，權限 0600，不上命令列
umask 077
if [ "$AUTH_MODE" = "key" ]; then
  printf 'header = "x-api-key: %s"\n' "$ANTHROPIC_API_KEY" >"$HDR"
else
  OIDC_RESP="$WORK/oidc.json"
  printf 'header = "Authorization: Bearer %s"\n' "$ACTIONS_ID_TOKEN_REQUEST_TOKEN" >"$WORK/oidc.cfg"
  code="$(curl -sS --max-time 30 -K "$WORK/oidc.cfg" -o "$OIDC_RESP" -w '%{http_code}' \
    "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=https%3A%2F%2Fapi.anthropic.com" 2>/dev/null)" || code="000"
  [ "$code" = "200" ] || fail "oidc token request failed: $code"
  JWT="$(jq -r '.value // empty' "$OIDC_RESP" 2>/dev/null)"
  [ -n "$JWT" ] || fail "oidc token response has no value"

  jq -cn --arg jwt "$JWT" --arg fr "$ANTHROPIC_FEDERATION_RULE_ID" --arg org "$ANTHROPIC_ORGANIZATION_ID" \
    --arg sa "$ANTHROPIC_SERVICE_ACCOUNT_ID" --arg ws "${ANTHROPIC_WORKSPACE_ID:-}" \
    '{grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer", assertion:$jwt,
      federation_rule_id:$fr, organization_id:$org, service_account_id:$sa}
     + (if $ws == "" then {} else {workspace_id:$ws} end)' >"$WORK/oauth-req.json"
  unset JWT
  code="$(curl -sS --max-time 30 -X POST -H 'content-type: application/json' \
    --data-binary @"$WORK/oauth-req.json" -o "$WORK/oauth.json" -w '%{http_code}' \
    "$BASE_URL/v1/oauth/token" 2>/dev/null)" || code="000"
  [ "$code" = "200" ] || fail "wif exchange failed: $code"
  TOKEN="$(jq -r '.access_token // empty' "$WORK/oauth.json" 2>/dev/null)"
  [ -n "$TOKEN" ] || fail "wif exchange returned no access_token"
  printf 'header = "authorization: Bearer %s"\n' "$TOKEN" >"$HDR"
  unset TOKEN
fi

# ---------- 呼叫 Messages API ----------
SCHEMA='{
  "type":"object","additionalProperties":false,
  "required":["category","severity","reason","suggestion"],
  "properties":{
    "category":{"type":"string","enum":["env","app"]},
    "severity":{"type":"string","enum":["P0","P1","P2"]},
    "reason":{"type":"string"},
    "suggestion":{"type":"string"}
  }}'

REQ="$WORK/req.json"
{
  printf '平台：%s\n\n以下是這次 e2e 失敗的 log（各檔取尾段）：\n\n' "$PLATFORM"
  cat "$LOG"
} >"$WORK/user.txt"
jq -n --arg model "$MODEL" --rawfile system "$SYS" --rawfile user "$WORK/user.txt" --argjson schema "$SCHEMA" \
  '{model:$model, max_tokens:2000, system:$system,
    messages:[{role:"user", content:$user}],
    output_config:{format:{type:"json_schema", schema:$schema}}}' >"$REQ" || fail "failed to build request"

RESP="$WORK/resp.json"
code="$(curl -sS --max-time 120 -X POST -K "$HDR" \
  -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' \
  --data-binary @"$REQ" -o "$RESP" -w '%{http_code}' "$BASE_URL/v1/messages" 2>/dev/null)" || code="000"
[ "$code" = "200" ] || fail "messages request failed: HTTP $code"

jq -r '"usage: input_tokens=\(.usage.input_tokens // "?") output_tokens=\(.usage.output_tokens // "?")"' "$RESP" 2>/dev/null

STOP="$(jq -r '.stop_reason // "none"' "$RESP" 2>/dev/null)" || fail "unparseable response"
[ "$STOP" = "end_turn" ] || fail "stop_reason: $STOP"

TEXT="$(jq -r '[.content[]? | select(.type == "text")][0].text // empty' "$RESP" 2>/dev/null)"
[ -n "$TEXT" ] || fail "no text block in response"

printf '%s' "$TEXT" | jq -ce --arg model "$MODEL" '
  select((.category | IN("env","app")) and (.severity | IN("P0","P1","P2"))
         and (.reason | type == "string") and (.suggestion | type == "string"))
  | {category, severity, reason, suggestion, model:$model}' >"$WORK/final.json" 2>/dev/null \
  && [ -s "$WORK/final.json" ] || fail "diagnosis json invalid"

mv "$WORK/final.json" "$OUT"
exit 0
