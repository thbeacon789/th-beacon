# th-beacon API 參考

對外接入者（各服務、各專案 CI）需要的完整契約。內容以 route 實作為準，非設計稿。

| 端點 | 方法 | 驗證 | 用途 |
| --- | --- | --- | --- |
| `/api/ingest` | POST | 每服務 HMAC | 推送錯誤事件 |
| `/api/heartbeat` | POST | 每服務 HMAC | 具名心跳（CI 存活證明） |
| `/api/ai-usage` | POST | 每服務 HMAC | 回報 AI 用量（token 或金額） |
| `/api/ai-fix` | POST | 每服務 HMAC | 回報 CI 的 AI 修復 PR 結果 |
| `/api/security-scan` | POST | 每服務 HMAC | 推送每日資安掃描快照（集中式掃描器用） |
| `/api/poll/services` | GET | Cron Bearer token | 服務輪詢 ＋ 心跳逾期掃描（內部用） |

實作位置：`app/api/ingest/route.ts`、`app/api/heartbeat/route.ts`、`app/api/ai-usage/route.ts`、`app/api/ai-fix/route.ts`、`app/api/security-scan/route.ts`、`app/api/poll/services/route.ts`。

---

## 1. HMAC 驗證（ingest 與 heartbeat 共用）

五個推送端點（ingest、heartbeat、ai-usage、ai-fix、security-scan）的驗證邏輯完全相同（`src/ingest/hmac.ts:16`）。

### 必要 headers

| Header | 值 |
| --- | --- |
| `X-Beacon-Service` | 服務名稱，對應 `services.name` |
| `X-Beacon-Timestamp` | Unix 秒（十進位整數字串，如 `1754870400`） |
| `X-Beacon-Signature` | `sha256=<64 位小寫 hex>` |
| `Content-Type` | `application/json` |

### 簽章計算

以該服務的 `webhook_secret` 為金鑰，對 **`{timestamp}.{原始 request body}`** 取 HMAC-SHA256：

```
signature = "sha256=" + hex(HMAC_SHA256(secret, timestamp + "." + rawBody))
```

簽的是**原始位元組**，不是重新序列化的 JSON——送出前先把 body 定版成字串，簽它、也送它，中間別再經過任何 JSON 格式化。

### 防重放

`|now - timestamp| > 300` 秒即拒絕（`src/ingest/hmac.ts:17-21`）。CI 機器時鐘偏移超過 5 分鐘會全數 401。

### 401 的所有成因

驗證失敗一律回 `401 {"error":"unauthorized"}`，不區分原因（刻意不洩漏）。可能是：

- 三個 header 任一缺漏
- `X-Beacon-Service` 查無此服務
- 該服務的 `webhook_secret` 為 NULL（未設定金鑰）
- timestamp 非純數字 / 超出 ±300 秒
- signature 不符 `sha256=<hex64>` 格式，或驗簽不符

---

## 2. `POST /api/ingest` — 推送錯誤事件

### Request body

```jsonc
{
  "message": "payment provider request failed", // 必填，非空字串
  "errorType": "payment_error",                 // 選填，預設 "unknown"
  "level": "error",                             // 選填，預設 "error"
  "occurredAt": "2026-08-11T02:00:00Z",         // 選填，ISO 8601；預設為伺服器收到的時間
  "metadata": { "requestId": "req_42", "status": 502 }  // 選填，必須是 JSON 物件（非陣列）
}
```

`message` 與 `errorType` 決定 fingerprint（`src/core/normalize.ts:24`）——同指紋的事件會**聚合成同一筆 issue** 並累計 count。因此把會變動的細節（次數、耗時、run URL）放進 `metadata`，別寫進 `message`，否則每次回報都會長出一筆新 issue。

### 成功回應 `201`

```jsonc
{
  "issueId": "uuid",
  "severity": "P0" | "P1" | "P2",       // 由規則引擎判定
  "health": "down" | "degraded" | "healthy",  // 該服務更新後的健康度
  "duplicate": true,                    // 是否命中既有 issue（非新建）
  "notified": false,                    // 本次是否實際發出 Discord 通知（受冷卻/去重影響）
  "triage": "sync" | "deferred"         // AI 判級是否延後到回應之後執行
}
```

`triage: "deferred"` 表示這筆事件需要呼叫 Claude 判級，已入庫，但判級與通知在回應送出後才執行（避免拖慢呼叫端 CI）。此時回應只含 `{ "issueId": "uuid", "triage": "deferred" }`，**不含** `severity`、`health`、`duplicate`、`notified`。`"sync"` 為即時完成，欄位如上。

### 錯誤回應

| 狀態 | Body | 情境 |
| --- | --- | --- |
| `401` | `{"error":"unauthorized"}` | 見上節 |
| `400` | `{"error":"invalid JSON"}` | body 不是合法 JSON |
| `422` | `{"error":"invalid payload","details":["message is required and must be a non-empty string"]}` | 欄位驗證失敗，`details` 逐條列出 |

### 範例

ingest 用來推**服務執行期的錯誤**（例如外部 API 呼叫失敗、背景工作炸掉）。**CI 測試結果請走 §3 的 `/api/heartbeat`**——heartbeat 的 fail 已會建 `test_failure` issue 並告警；兩邊都推會因 fingerprint 算法不同而長出兩筆 issue、發兩次告警。

現成 script：`scripts/report-to-beacon.sh`（第 3 參數為 `errorType`，省略時為 `test_failure`，為相容舊用法保留）

```bash
BEACON_URL=https://th-beacon.vercel.app/api/ingest \
BEACON_SERVICE=my-service BEACON_SECRET=xxx \
./scripts/report-to-beacon.sh "payment provider request failed" "https://logs.example/req/42" "payment_error"
```

手寫版本：

```bash
TS="$(date +%s)"
BODY='{"message":"payment provider request failed","errorType":"payment_error","level":"error"}'
SIG="$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$BEACON_SECRET" -hex | sed 's/^.* //')"

curl -sS --fail-with-body -X POST "$BEACON_URL" \
  -H "Content-Type: application/json" \
  -H "X-Beacon-Service: $BEACON_SERVICE" \
  -H "X-Beacon-Timestamp: $TS" \
  -H "X-Beacon-Signature: sha256=$SIG" \
  -d "$BODY"
```

---

## 3. `POST /api/heartbeat` — 具名心跳

證明排程還活著。與 ingest 正交：ingest 回答「有沒有出錯」，心跳回答「**有沒有跑**」。CI 必須在 `if: always()` 下呼叫，pass 與 fail 都要送——沒送才是問題。

### ⚠️ 接 CI 之前必須先登記心跳名稱

心跳採**登記制**：未登記的名稱回 `404`，不會自動建立（`src/heartbeat/handle-heartbeat.ts:53`）。順序反了 CI 只會一直收 404。

**登記方式：dashboard 的 `/services` 頁面**（登入後即可自助操作，同時產生服務金鑰）。

備援——直接對 DB 操作：

```sql
insert into public.heartbeats (service_id, name, interval_seconds, grace_seconds)
values (
  (select id from public.services where name = 'my-service'),
  'daily-test',
  86400,   -- 預期回報間隔（秒）
  3600     -- 寬限期（秒），超過 interval + grace 才算逾期
);
```

### Request body

```jsonc
{
  "name": "daily-test",   // 必填，非空字串；須與 heartbeats.name 完全相符
  "status": "pass",       // 必填，只接受 "pass" 或 "fail"
  "runUrl": "https://github.com/o/r/actions/runs/42",  // 選填
  "summary": "3 of 120 failed",                         // 選填，超過 500 字截斷
  "diagnosis": {                                        // 選填，僅 status=fail 時使用（AI 失敗判讀）
    "category": "env",          // 必填，"env"（環境問題）或 "app"（程式問題）
    "severity": "P2",           // 必填，"P0" | "P1" | "P2"
    "reason": "staging DB 連線逾時",       // 必填，非空字串，上限 500 字（超過截斷）
    "suggestion": "確認 staging 資料庫是否在線", // 必填，非空字串，上限 1000 字（超過截斷）
    "needsCodeChange": true,    // 判讀腳本輸出的布林；伺服器不處理（見下）
    "model": "claude-sonnet-5-5"           // 選填，字串
  },
  "diagnosisError": "AI 呼叫逾時"                         // 選填，診斷失敗的原因，上限 200 字（超過截斷）
}
```

**`diagnosis`／`diagnosisError` 同為附帶資訊，不合法絕不 422。** 格式不符（enum 值錯、必填欄位缺漏、型別不對）時只丟棄該欄位、回應帶 `warnings`，並退回一般 `test_failure`（P1 規則表判級）。

- `needsCodeChange`：`diagnose-e2e-failure.sh` 的輸出含此布林欄位（是否需改程式碼才能解決），供 CI 端決定要不要呼叫 AI 修復（§8）。**伺服器忽略此欄位**——`diagnosis` 只逐欄位取用上列欄位，其餘丟棄、不報錯、不入庫（程式碼內無任何讀取 `needsCodeChange` 之處），所以新舊版腳本的輸出都相容。
- `status: "pass"` 時這兩個欄位一律忽略。
- `category: "env"` 的失敗會建立**獨立的** `test_failure_env` issue（fingerprint 與 `test_failure` 分開），並採用 `diagnosis.severity` 作為嚴重度；`app` 仍是 `test_failure`，但同樣採用 `diagnosis.severity`。env 與 app 失敗因此分屬兩筆 issue，互不聚合。
- `diagnosis`／`diagnosisError` 會寫入 event 的 `metadata`，Discord 通知會附上判定原因與修正建議。

**`runUrl` 不合法不會擋掉整包回報。** 若不符 `^https?://` ＋ URL 字元白名單（`src/core/heartbeat.ts:12`），該欄位被丟棄、回應帶 `warnings`，其餘照常處理。理由：CI 端多用 `set -e` ＋ `curl --fail-with-body`，若因裝飾性欄位回 422，存活訊號送不出去，隔天反而觸發假的逾期告警。

### 成功回應 `200`

```jsonc
{
  "name": "daily-test",
  "status": "pass",
  "lastRunAt": "2026-08-11T02:00:00Z",     // 每次回報都更新——逾期判定的唯一依據
  "lastSuccessAt": "2026-08-11T02:00:00Z", // 只有 pass 更新，純顯示用
  "warnings": ["runUrl was rejected: must be an http(s) URL"]  // 僅在有 warning 時出現
}
```

`status: "fail"` 時額外帶（走 `processAndNotify` 建 issue、發通知）：

```jsonc
{ "issueId": "uuid", "severity": "P1", "eventSeverity": "P2", "errorType": "test_failure", "notified": true }
// severity 為 issue 的 severity（受 ratchet 影響只升不降）；eventSeverity 為本次事件自帶的嚴重度（如 AI 診斷判定），僅在事件帶有時出現
// errorType 為 "test_failure" 或 "test_failure_env"（診斷判為環境問題時）
```

`triage: "sync" | "deferred"` 一併出現。`"deferred"`（事件需 Claude 判級；CI 已自帶 diagnosis 的不會延後）時判級與通知在回應之後執行，回應**不含** `severity`、`eventSeverity`、`notified`，只有 `issueId`、`errorType`、`triage`。

若該心跳 `enabled = false`，run 仍記錄，但不建 issue、不通知：

```jsonc
{ "notified": false, "suppressed": "heartbeat disabled: run recorded but no issue was created" }
```

### 副作用

- **任何**回報（pass 或 fail）→ 關掉該心跳的 `heartbeat_missed` issue（有回報就證明排程活著）
- `pass` → 額外關掉 `test_failure` 與 `test_failure_env` issue 並重算服務健康度
- `fail` → 建立/累計 `test_failure`（或帶 env 診斷時為 `test_failure_env`）issue，走通知管線

### 錯誤回應

| 狀態 | Body | 情境 |
| --- | --- | --- |
| `401` | `{"error":"unauthorized"}` | 見 §1 |
| `400` | `{"error":"invalid JSON"}` | body 不是合法 JSON |
| `404` | `{"error":"unknown heartbeat"}` | `(service, name)` 未在 `heartbeats` 登記 |
| `422` | `{"error":"invalid payload","details":[...]}` | `name` 或 `status` 不合法 |

### 範例（GitHub Actions）

```yaml
- name: Report heartbeat
  if: always()
  env:
    BEACON_URL: https://th-beacon.vercel.app/api/heartbeat
    BEACON_SERVICE: my-service
    BEACON_SECRET: ${{ secrets.BEACON_SECRET }}
  run: |
    ./scripts/heartbeat-to-beacon.sh daily-test \
      "${{ job.status == 'success' && 'pass' || 'fail' }}" \
      "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
```

---

## 4. `GET /api/poll/services` — 輪詢 ＋ 逾期掃描（內部）

由 Vercel Cron 觸發，不對外開放。排程定義在 `vercel.json`：`0 23 * * *`（UTC，即台北 07:00；Hobby 方案一天限一次）。

### 驗證

```
Authorization: Bearer ${CRON_SECRET}
```

以 constant-time 比對。缺、錯、或伺服器端 `CRON_SECRET` 未設定，一律 `401 {"error":"unauthorized"}`。

### 成功回應 `200`

```jsonc
{
  "polled": 3,
  "outcomes": [
    {
      "serviceId": "uuid",
      "healthChecked": true,
      "healthy": true,          // null = 未做 health 檢查
      "healthIssueResolved": false,
      "errorsProcessed": 0,
      "errorsTruncated": false,
      "errorFetchFailed": false,
      "error": "..."            // 僅在該服務整輪拋錯時出現
    }
  ],
  "heartbeatsOverdue": 1,
  "heartbeats": [
    { "heartbeatId": "uuid", "serviceId": "uuid", "name": "daily-test",
      "issueId": "uuid", "severity": "P1", "notified": true }
  ],
  "heartbeatsError": "..."      // 僅在心跳掃描整段失敗時出現；輪詢結果仍照常回傳
}
```

單一服務或單一心跳失敗不會中斷整輪，會記在該筆的 `error` 欄位。心跳掃描整段炸掉也不會連累已寫入的輪詢結果變成 500（`app/api/poll/services/route.ts:37-46`）。

### 錯誤回應

| 狀態 | Body | 情境 |
| --- | --- | --- |
| `401` | `{"error":"unauthorized"}` | token 缺/錯，或伺服器未設 `CRON_SECRET` |
| `500` | `{"error":"<訊息>"}` | 輪詢階段整體失敗 |

---

## 5. 接入檢查清單

到 dashboard 的 **`/services`** 頁面（登入後）依序完成 1–3，不需要 DB 權限：

1. 登記服務名稱 → 取得 `BEACON_SECRET`（**只顯示一次**，忘了就按「重新產生」換一把）
2. 把 secret 放進該專案 CI 的 secrets（`BEACON_SECRET`）
3. 登記心跳名稱與 interval/grace（**必須早於** CI 接線，否則一律 404）
4. CI 加上回報步驟：測試結果（pass/fail）→ `/api/heartbeat`（`if: always()`；fail 會自動建 `test_failure` issue 並告警，不必再推 ingest）。服務執行期錯誤才走 `/api/ingest`
5. 先手動跑一次 curl 確認回 201/200，再交給排程
6. （選用）CI 有 AI 修復 PR 流程者，開完 PR 後回報 `/api/ai-fix`（§8）。前提是 §3 的 heartbeat 已登記且該次失敗已建出 `test_failure` issue

CI 端需要 `jq`、`openssl`、`curl`，且機器時鐘偏移不得超過 5 分鐘。

### 常見接入失敗

| 症狀 | 原因 |
| --- | --- |
| 一直 401 | 簽章對的是重新序列化後的 JSON，不是實際送出的 body；或 CI 機器時鐘偏移 > 5 分鐘 |
| 一直 404（heartbeat） | 名稱沒登記，或與 `heartbeats.name` 不完全相符 |
| issue 每天長一筆新的 | 變動值（次數、時間）寫進了 `message`，導致 fingerprint 每次都不同 |
| heartbeat 回 200 但沒建 issue / 沒通知 | 該心跳 `enabled = false`——run 有記錄，但刻意不建 issue、不通知（回應會帶 `suppressed`） |

## 6. `POST /api/discord/interactions` — Discord 按鈕回呼（內部）

告警訊息上的「✋ 確認」「✅ 已解決」按鈕被按下時，Discord 會 POST 到此端點。**接入的服務不需要呼叫它**；本節只說明部署時如何設定。

### 驗證與回應

- 以 Discord 的 Ed25519 簽章驗證（`x-signature-ed25519`、`x-signature-timestamp`，對 `timestamp + 原始 body` 驗簽，公鑰為 `DISCORD_PUBLIC_KEY`），**不走** HMAC、也不走 dashboard 登入。安全邊界就是 Discord 簽章；任何看得到告警頻道的人都能按按鈕。
- 缺 header 或驗簽失敗回 `401`；`DISCORD_PUBLIC_KEY`／`DISCORD_APPLICATION_ID` 未設回 `503`。
- Discord 要求 3 秒內回應：驗簽並解析 JSON 後**不碰 DB**，立即回 `{type: 6}`（DEFERRED_UPDATE_MESSAGE）。其餘全在回應後（Next `after`）執行：查 issue、狀態轉換、再以 interaction token 呼叫 `PATCH /webhooks/{application_id}/{token}/messages/@original` 更新原訊息的按鈕（內容不改；確認／解決改由根訊息討論串內另發的訊息呈現），或 `POST /webhooks/{application_id}/{token}` 發 ephemeral follow-up（已解決、已過期、找不到等提示），最後做健康度重算與討論串訊息。這兩個 webhook 端點以 interaction token 驗證（有效 15 分鐘），不需 bot Authorization。背景處理失敗會記 log 並盡量回「處理失敗，請稍後再試」。PING 同步回 `{type: 1}`；無法解析的按鈕（不碰 DB）同步回 ephemeral type 4。

### 環境變數（四個須齊全才啟用 bot 模式）

| 變數 | 用途 |
| --- | --- |
| `DISCORD_BOT_TOKEN` | bot 發送／編輯告警訊息 |
| `DISCORD_ALERT_CHANNEL_ID` | 告警發送的頻道 |
| `DISCORD_PUBLIC_KEY` | Application 的 Public Key（hex），驗 Interactions 簽章 |
| `DISCORD_APPLICATION_ID` | Application ID |

任一未設定時，通知退回既有的 `DISCORD_WEBHOOK_URL` webhook 模式（沒有按鈕、不編輯訊息）。

### Discord 後台設定

1. 到 Discord Developer Portal 建立 Application，記下 Application ID 與 Public Key。
2. 在 Bot 頁籤建立 Bot 並取得 token。
3. 用 OAuth2 URL 將 Bot 加入伺服器，頻道權限需有 `VIEW_CHANNEL`、`SEND_MESSAGES`、`READ_MESSAGE_HISTORY`、`CREATE_PUBLIC_THREADS`、`SEND_MESSAGES_IN_THREADS`（確認／已解決訊息發在以告警開出的討論串內；缺 thread 權限時退回在頻道回覆）。
4. 在 General Information 的 **Interactions Endpoint URL** 填 `https://<部署網域>/api/discord/interactions`。儲存時 Discord 會送 PING 與無效簽章測試，端點需已部署且四個環境變數已設好才會通過。

---

## 7. `POST /api/ai-usage` — AI 用量回報

CI 的 AI 診斷（`diagnose-e2e-failure.sh`）或 CI 開 PR 的 AI 呼叫，把這次用掉的 token 或金額回報給 th-beacon，供統計頁累計花費。**一次請求一筆紀錄**；不需要另外登記名稱，只要服務本身已登記且有金鑰。

驗證：headers 與簽章算法同 §1。

### Request body

```jsonc
{
  "source": "ci_diagnosis",            // 必填，僅 "ci_diagnosis" | "ci_pr" | "ci_security"
  "model": "claude-sonnet-5-5",        // 選填，1–100 字；有登記單價的 model 才會自動換算金額
  "inputTokens": 1234,                 // 選填，非負整數
  "outputTokens": 321,                 // 選填，非負整數
  "costUsd": 0.0123                    // 選填，非負數字（USD）
}
```

**`costUsd` 或 tokens 擇一**：必須帶 `costUsd`，或同時帶 `inputTokens` 與 `outputTokens`。沒帶 `costUsd` 時，必須同時帶 `inputTokens` 與 `outputTokens`。數值上限：`costUsd` < 1,000,000、tokens ≤ 2,147,483,647，超過回 422。同時帶時以 `costUsd` 為準；只帶 tokens 時由伺服器依 `model` 單價換算，金額在寫入時算好存入（之後改價不影響歷史金額）。

### 成功回應 `201`

```json
{ "id": "uuid", "costUsd": 0.0092, "priced": true }
```

`model` 未登記單價（或沒帶 `model`）且沒帶 `costUsd` 時，`costUsd` 為 `null`、`priced` 為 `false`：tokens 照常記錄，統計頁會標示「有 N 筆未定價」，不會當成 0。

### 錯誤回應

| 狀態 | Body | 情境 |
| --- | --- | --- |
| `401` | `{"error":"unauthorized"}` | 見 §1 |
| `400` | `{"error":"invalid JSON"}` | body 不是合法 JSON |
| `422` | `{"error":"invalid payload","details":[...]}` | 欄位驗證失敗（`source` 不合法、tokens 非整數、`costUsd` 與 tokens 都沒帶…） |

### 範例

`diagnose-e2e-failure.sh` 內建選填回報：三個 env 皆非空才會送，缺任一個就完全不發請求；回報失敗只在 stdout 註明，不影響診斷結果與 exit code。

```bash
BEACON_AI_USAGE_URL=https://th-beacon.vercel.app/api/ai-usage \
BEACON_SERVICE=my-service BEACON_SECRET=xxx \
bash scripts/diagnose-e2e-failure.sh android known-issues.md diagnosis.json e2e.log
```

手寫版本：

```bash
TS="$(date +%s)"
BODY='{"source":"ci_pr","model":"claude-sonnet-5-5","inputTokens":1234,"outputTokens":321}'
SIG="$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$BEACON_SECRET" -hex | sed 's/^.* //')"

curl -sS --fail-with-body -X POST https://th-beacon.vercel.app/api/ai-usage \
  -H "Content-Type: application/json" \
  -H "X-Beacon-Service: $BEACON_SERVICE" \
  -H "X-Beacon-Timestamp: $TS" \
  -H "X-Beacon-Signature: sha256=$SIG" \
  -d "$BODY"
```

---

## 8. `POST /api/ai-fix` — AI 修復 PR 結果回報

CI 在 E2E 失敗後若由 AI 嘗試修復（開 PR），把結果回報到對應的 `test_failure` issue：存進 `issues.ai_fix_*` 四欄（issue 詳情頁顯示），並在該告警的 Discord 討論串通知負責人（可多人）。**伺服器不呼叫 Claude、不持有 GitHub token**——開 PR 全在 CI 端完成，這個端點只收結果。

驗證：headers 與簽章算法同 §1。心跳名稱須已於 §3 登記。實作：`app/api/ai-fix/route.ts`、`src/ai-fix/handle-ai-fix.ts`、`src/ai-fix/payload.ts`。

### Request body

```jsonc
{
  "heartbeat": "android-e2e-prod",                      // 必填，非空字串；須為該服務已登記的心跳名稱
  "status": "pr_opened",                                // 必填，"pr_opened" | "no_fix" | "failed"
  "prUrl": "https://github.com/o/r/pull/1",             // status=pr_opened 時必填；其餘狀態忽略並存成 null
  "summary": "修正登入頁選擇器逾時",                      // 選填，超過 500 字截斷（結尾 …）；空字串視為未提供
  "runUrl": "https://github.com/o/r/actions/runs/42"    // 選填
}
```

- `status`：`pr_opened`（已開 PR）、`no_fix`（AI 判斷無需或無法修）、`failed`（修復流程失敗）。
- `prUrl` 只接受 `https://github.com/<owner>/<repo>/pull/<數字>`（owner／repo 字元限 `A-Za-z0-9._-`，且不得為 `.` 或 `..`；`src/core/ai-fix.ts:7-14`）。`http://`、偽造網域（如 `github.com.evil.com`）、缺漏皆回 422。
- `runUrl` 同 §3：不符白名單時**只丟棄該欄位**（存成 null），不擋整包回報。
- **找 issue 的規則**：以 `(服務, heartbeat)` 的 `test_failure` 指紋（`heartbeatFingerprint(serviceId, 'test_failure', heartbeat)`）找該服務狀態為 `open` 或 `acknowledged` 的 issue；只對應 `test_failure`，不含 `test_failure_env`。找不到這樣的 issue（尚未建立、或已 resolved／ignored）回 404 `no_active_issue`，不寫入。

### 成功回應 `201`

```json
{ "issueId": "uuid", "notified": true }
```

`notified` 表示本次是否實際在討論串發出通知。資料寫入（`ai_fix` 四欄：status、prUrl、summary、reportedAt）與通知是分開的：通知失敗不影響回應碼，資料已存即回 201，`notified` 為 `false`。同一 issue 重複回報會覆寫上一次的結果並更新 `reportedAt`。

### 通知規則

同時滿足才會在該 issue 告警的討論串發訊息（內含 PR 連結、摘要，並 @ 服務所有負責人）：

- `status` 為 `pr_opened`，且 `prUrl` 與該 issue 上次記錄的 `prUrl` **不同**（同一 PR 重複回報不重發；換新 PR 會再發一則）
- 伺服器為 Discord bot 模式（見 §6 的四個環境變數）；webhook 模式沒有討論串，不通知
- 找得到該 issue 這一輪告警的根訊息

`no_fix`、`failed` 一律不通知。此通知**不寫入 `notifications` 表**，不影響告警去重與冷卻。

### 錯誤回應

| 狀態 | Body | 情境 |
| --- | --- | --- |
| `401` | `{"error":"unauthorized"}` | 見 §1 |
| `400` | `{"error":"invalid JSON"}` | body 不是合法 JSON |
| `422` | `{"error":"invalid payload","details":[...]}` | payload 非物件（陣列、`null`、純值）、`heartbeat` 缺漏／空白、`status` 非三值、`status=pr_opened` 但 `prUrl` 缺漏或格式不符 |
| `404` | `{"error":"unknown heartbeat"}` | `(service, heartbeat)` 未在 `heartbeats` 登記 |
| `404` | `{"error":"no_active_issue"}` | 該心跳目前沒有 `open`／`acknowledged` 的 `test_failure` issue |

### 範例

```bash
TS="$(date +%s)"
BODY='{"heartbeat":"android-e2e-prod","status":"pr_opened","prUrl":"https://github.com/o/r/pull/1","summary":"修正登入頁選擇器逾時","runUrl":"https://github.com/o/r/actions/runs/42"}'
SIG="$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$BEACON_SECRET" -hex | sed 's/^.* //')"

curl -sS --fail-with-body -X POST https://th-beacon.vercel.app/api/ai-fix \
  -H "Content-Type: application/json" \
  -H "X-Beacon-Service: $BEACON_SERVICE" \
  -H "X-Beacon-Timestamp: $TS" \
  -H "X-Beacon-Signature: sha256=$SIG" \
  -d "$BODY"
```

---

## 9. `POST /api/security-scan` — 資安掃描快照

th-beacon 自己的每日資安掃描（`.github/workflows/security-scan.yml`）把一次掃描的**事實與 Claude 判讀結果**推到這裡，存成一筆 `security_scans` 快照，供 `/security` 頁面顯示。**一次請求一筆快照**；掃描器是集中式的，各服務 repo 不需要接入。服務須已登記且有金鑰（`X-Beacon-Service` 為受掃描服務的名稱）。

驗證：headers 與簽章算法同 §1。實作：`app/api/security-scan/route.ts`、`src/security-scan/handle-security-scan.ts`、`src/core/security/payload.ts`。

### Request body

```jsonc
{
  "scannedAt": "2026-11-18T22:03:11Z",   // 必填，帶時區的 ISO 8601；不可晚於現在超過 10 分鐘，也不可早於現在超過 2 小時
  "kind": "vm",                           // 必填，"vm" | "hosted"
  "checks": {                             // 必填；ports／updates／logins 三項必備，vm 另須帶 deps
    "ports":   { "status": "bad",  "summary": "3306 對外" },
    "updates": { "status": "warn", "summary": "12 項（3 安全性）" },
    "logins":  { "status": "ok",   "summary": "正常" },
    "deps":    { "status": "warn", "summary": "2 個映像檔有漏洞" }   // 只有 kind 為 vm 必帶；hosted 不得帶
    // 不適用：{ "status": "na", "summary": "" }；判讀失敗：{ "status": "unknown", "summary": "" }
  },
  "findings": [
    {
      "check": "ports",                   // "ports" | "updates" | "logins" | "deps"
      "severity": "high",                 // "high" | "medium" | "low"
      "title": "MySQL 3306 埠對全網開放",
      "recommendation": "改為僅內網或防火牆白名單"   // 可為空字串
    }
  ],
  "deps": [                               // vm 必填（可為空陣列）；hosted 不得帶
    {
      "image": "asia-east1-docker.pkg.dev/altinvest/backend/app",   // 不含 tag 與 digest
      "digest": "sha256:0123abcd...（64 位小寫十六進位）",              // 或 null
      "containers": ["app"],
      "counts": { "critical": 0, "high": 1, "moderate": 2, "low": 0, "unscored": 0 },
      "packages": [ { "name": "openssl", "version": "3.0.2", "ecosystem": "Ubuntu:22.04:LTS", "severity": "high", "ids": ["CVE-2025-0001"] } ]
      // 掃描失敗時改帶 "error": "原因"，且不可同時帶 counts／packages
    }
  ],
  "certs": [ { "domain": "example.com", "notAfter": "2027-01-18T00:00:00Z", "trusted": true } ],   // trusted（布林）、error（字串，≤ 120 字）選填
  "exposure": [
    {
      "domain": "example.com",
      "sensitivePaths": [ { "path": "/.env", "exposed": false } ],
      "headers": { "hsts": true, "contentTypeOptions": true, "frameProtection": false, "csp": false, "referrerPolicy": true },
      "legacyTls": false                  // true | false | null（無法判斷）
    }
  ],
  "logVolume": [                          // 選填（hosted 省略）
    { "source": "nginx-access", "hourly": [ { "hour": "2026-11-17T22:00:00Z", "count": 1820 } ] },
    { "source": "app", "error": true }    // 來源讀不到：帶 error:true 且不帶 hourly
  ],
  "inventory": {                          // 選填（hosted 省略）
    "users": ["ubuntu", "deploy"],
    "admins": ["ubuntu"],
    "sshKeys": [ { "user": "ubuntu", "fingerprint": "SHA256:abc123" } ],
    "scheduled": [ { "location": "/etc/cron.d/backup", "schedule": "0 3 * * *", "executable": "/usr/local/bin/backup.sh", "hash": "sha256:abc123" } ],
    "listeners": [ { "proto": "tcp", "port": 443, "process": "nginx" } ],
    "services": ["nginx.service"],
    "containers": [ { "name": "web", "image": "repo/web", "ports": ["0.0.0.0:443->443/tcp"] } ]   // 選填：無 Docker 的機器省略；image 不含版本與 digest，ports 只含發佈到主機的對應
  }
}
```

### 欄位限制

| 欄位 | 限制 |
| --- | --- |
| `checks.*.status` | `ok`／`warn`／`bad`／`unknown`／`na` |
| `checks.*.summary` | 字串，最長 80 字；`status` 為 `ok`／`warn`／`bad` 時不可為空 |
| `findings` | 最多 30 筆 |
| `findings[].title` | 1–120 字 |
| `findings[].recommendation` | 最長 300 字，可為空字串 |
| `findings[].key` | 選填。發現的穩定識別，完整指紋為 `<check>:<key>`（key 不含 check 前綴），用於跨次掃描追蹤同一個發現。規格：`ports` 為 `tcp/<1-65535>` 或 `udp/<1-65535>`；`updates` 為 `security`／`eol`／`reboot`／`auto-disabled`；`logins` 為 `password-auth`／`root-login`／`failed-spike` 或 `unexpected-success:<IPv4/IPv6>`。缺少或不合規格**不會被拒收**，改退回類別級指紋 `_fallback`（該筆標記為 key 退回） |
| `findings[].key`（`deps`） | `deps` 發現的 key 為 `image:<repository>`（`<repository>` 為映像檔名，不含 tag／digest），整體至多 310 字、字元為 `[A-Za-z0-9_./:-]` 且首字元為英數。不合規格同樣不拒收，退回 `_fallback`（標記為 key 退回） |
| `deps`（vm 必填，hosted 不得帶） | 陣列，最多 50 個映像檔。`image`：非空字串、至多 300 字，字元限 `[A-Za-z0-9_./:-]` 且首字元為英數；`digest`：`sha256:` 加 64 位小寫十六進位，或 `null`；`containers`：字串陣列，最多 50 個，每個至多 300 字、字元限 `[A-Za-z0-9_.-]` 且首字元為英數；`error`：選填字串，至多 300 字，有 `error` 時不可同時帶 `counts`／`packages`；`counts`：`critical`／`high`／`moderate`／`low`／`unscored` 五個非負整數；`packages`：最多 20 筆，每筆 `name`／`version`／`ecosystem`（`version`、`ecosystem` 可為空字串，各至多 300 字）、`severity`（`critical`／`high`／`moderate`／`low`／`unscored`）、`ids`（字串陣列，最多 5 個，每個至多 300 字）。hosted 快照帶 `deps` 或 `checks.deps` 回 422 |
| `exposure[].probeErrors` | 選填，非負整數：該網域敏感路徑請求失敗（逾時、連線錯誤）的數量。缺少則視為未涵蓋，敏感路徑發現不會被自動判為已解決；非整數或負數回 422 |
| `logVolume[]` | 每筆擇一：`error: true`（不可再帶 `hourly`），或 `hourly`（`count` 為非負整數） |
| `inventory.listeners[].port` | 1–65535 整數；`proto` 為 `tcp`／`udp` |
| `inventory.containers`（選填） | 陣列，最多 200 個；`name`／`image` 為非空字串（各至多 300 字），`ports` 為字串陣列（至多 50 個、每個至多 300 字） |
| `exposure[].sensitivePaths`、`exposure[].headers` | 必填；`headers` 的五個鍵（`hsts`、`contentTypeOptions`、`frameProtection`、`csp`、`referrerPolicy`）都必須是布林 |
| `exposure[].sensitivePaths[].path` | 必須以 `/` 開頭 |
| `scannedAt` | 須為嚴格 ISO 8601 且帶時區（`YYYY-MM-DDTHH:MM:SS(.fff)?` 後接 `Z` 或 `±HH:MM`）；不得晚於現在 10 分鐘，**不得早於現在 2 小時**（`MAX_SCAN_AGE_HOURS`，擋住回填過去快照來偽造變動比對基準）。超出回 422 |
| `certs[].notAfter`、`logVolume[].hourly[].hour` | 同上，須為帶時區的 ISO 8601；`"1"`、`"2026"` 這類寬鬆字串回 422 |
| `certs[].trusted`、`certs[].error` | 選填。`trusted` 為布林；`error` 為字串，最長 120 字。`trusted: false` 時 `cert` 狀態至少 `bad`（「憑證不受信任」）；未帶則只看到期日 |
| 整個 body | 原始內容超過 512 KB 回 413（驗簽後、解析前檢查） |

### 哪些狀態由 beacon 計算

payload **只送事實與 `ports`／`updates`／`logins` 三項判讀，加上 vm 快照的 `deps`**。`deps` 由排程端（th-beacon 自己的掃描 workflow，以 osv-scanner 掃描映像檔）確定性計算，不經 Claude；vm 必填、hosted 不得帶（beacon 補 `na`），舊快照在讀取端也視為 `na`。因此**快照只應由 th-beacon 自己的掃描 workflow 送出**。以下四項的狀態**不由 payload 提供**，送了也不採用：

- `logVolume`、`exposure`、`changes`：寫入時由 beacon 依規則計算（log 量對照近 7 天基準、暴露路徑與安全標頭、與 7 天窗內最舊一筆 `inventory` 的差異），結果併入回應的 `checks` 並存入快照。
- `cert`：讀取時依 `certs` 的到期日與 `trusted` 推導，不存。

快照保留 90 天，但**每個服務最新的一筆一律保留**，即使早於界線。

### 成功回應 `201`

```json
{ "id": "uuid", "checks": { "ports": { "status": "ok", "summary": "..." }, "updates": {}, "logins": {}, "deps": {}, "logVolume": {}, "exposure": {}, "changes": {} } }
```

`checks` 為合併後的結果：`ports`／`updates`／`logins` 來自判讀，`deps`（僅 vm）由排程端提供，`logVolume`／`exposure`／`changes` 由 beacon 計算。

### 重送 `200`

同一服務、同一 `scannedAt` 已有快照時回 `{ "duplicate": true }`，不重複寫入。

### 錯誤回應

| 狀態 | Body | 情境 |
| --- | --- | --- |
| `401` | `{"error":"unauthorized"}` | 見 §1（服務不存在或無金鑰、簽章錯誤、時間戳超出容許範圍） |
| `413` | `{"error":"payload too large"}` | body 超過 512 KB |
| `400` | `{"error":"invalid JSON"}` | body 不是合法 JSON |
| `422` | `{"error":"invalid payload","details":[...]}` | 欄位驗證失敗（`scannedAt` 太晚或早於現在超過 2 小時、日期格式不嚴格、`kind` 不合法、字串超長…） |

### 金鑰輪替

服務的 HMAC 金鑰若在 `/services` 輪替，th-beacon repo 的 GitHub secret（目標的 `secretEnv` 指定的名稱）必須手動同步，否則推送會 401；此時 `security-scan` 心跳也會因簽章錯誤而無法回報，最終以心跳逾期告警浮現。

### 範例

一般情況由 `scripts/security/scan.mts` 送出，不需手寫。手寫版本（最小合法 hosted 快照）。**勿對正式服務執行**：這會寫入一筆假的「全部正常」快照；請改用本地或測試服務名稱，並把 `scannedAt` 換成現在時間（不得早於現在 2 小時）：

```bash
TS="$(date +%s)"
BODY="$(printf '%s' '{"scannedAt":"SCANNED_AT","kind":"hosted","checks":{"ports":{"status":"na","summary":""},"updates":{"status":"ok","summary":"無已知漏洞"},"logins":{"status":"na","summary":""}},"findings":[],"certs":[{"domain":"example.com","notAfter":"2027-01-18T00:00:00Z"}],"exposure":[]}' | sed "s/SCANNED_AT/$(date -u +%Y-%m-%dT%H:%M:%SZ)/")"
SIG="$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$BEACON_SECRET" -hex | sed 's/^.* //')"

curl -sS --fail-with-body -X POST https://th-beacon.vercel.app/api/security-scan \
  -H "Content-Type: application/json" \
  -H "X-Beacon-Service: $BEACON_SERVICE" \
  -H "X-Beacon-Timestamp: $TS" \
  -H "X-Beacon-Signature: sha256=$SIG" \
  -d "$BODY"
```
