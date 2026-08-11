# th-beacon API 參考

對外接入者（各服務、各專案 CI）需要的完整契約。內容以 route 實作為準，非設計稿。

| 端點 | 方法 | 驗證 | 用途 |
| --- | --- | --- | --- |
| `/api/ingest` | POST | 每服務 HMAC | 推送錯誤事件 |
| `/api/heartbeat` | POST | 每服務 HMAC | 具名心跳（CI 存活證明） |
| `/api/poll/services` | GET | Cron Bearer token | 服務輪詢 ＋ 心跳逾期掃描（內部用） |

實作位置：`app/api/ingest/route.ts`、`app/api/heartbeat/route.ts`、`app/api/poll/services/route.ts`。

---

## 1. HMAC 驗證（ingest 與 heartbeat 共用）

兩個推送端點的驗證邏輯完全相同（`src/ingest/hmac.ts:16`）。

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
  "message": "nightly tests failed: 3 of 120",  // 必填，非空字串
  "errorType": "test_failure",                  // 選填，預設 "unknown"
  "level": "error",                             // 選填，預設 "error"
  "occurredAt": "2026-08-11T02:00:00Z",         // 選填，ISO 8601；預設為伺服器收到的時間
  "metadata": { "runUrl": "https://ci.example/run/42" }  // 選填，必須是 JSON 物件（非陣列）
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
  "notified": false                     // 本次是否實際發出 Discord 通知（受冷卻/去重影響）
}
```

### 錯誤回應

| 狀態 | Body | 情境 |
| --- | --- | --- |
| `401` | `{"error":"unauthorized"}` | 見上節 |
| `400` | `{"error":"invalid JSON"}` | body 不是合法 JSON |
| `422` | `{"error":"invalid payload","details":["message is required and must be a non-empty string"]}` | 欄位驗證失敗，`details` 逐條列出 |

### 範例

現成 script：`scripts/report-to-beacon.sh`

```bash
BEACON_URL=https://beacon.example.com/api/ingest \
BEACON_SERVICE=my-service BEACON_SECRET=xxx \
./scripts/report-to-beacon.sh "nightly tests failed: 3 of 120" "https://ci.example/run/42"
```

手寫版本：

```bash
TS="$(date +%s)"
BODY='{"message":"nightly tests failed","errorType":"test_failure","level":"error"}'
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

### ⚠️ 接 CI 之前必須先在 DB 登記

心跳採**登記制**：未登記的名稱回 `404`，不會自動建立（`src/heartbeat/handle-heartbeat.ts:53`）。順序反了 CI 只會一直收 404。

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
  "summary": "3 of 120 failed"                          // 選填，超過 500 字截斷
}
```

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
{ "issueId": "uuid", "severity": "P1", "notified": true }
```

若該心跳 `enabled = false`，run 仍記錄，但不建 issue、不通知：

```jsonc
{ "notified": false, "suppressed": "heartbeat disabled: run recorded but no issue was created" }
```

### 副作用

- **任何**回報（pass 或 fail）→ 關掉該心跳的 `heartbeat_missed` issue（有回報就證明排程活著）
- `pass` → 額外關掉 `test_failure` issue 並重算服務健康度
- `fail` → 建立/累計 `test_failure` issue，走通知管線

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
    BEACON_URL: https://beacon.example.com/api/heartbeat
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

1. 在 `services` 表建立服務，設定 `name` 與 `webhook_secret`
2. 把 secret 放進該專案 CI 的 secrets（`BEACON_SECRET`）
3. 要用心跳的話，**先** `insert into heartbeats` 登記名稱與 interval/grace
4. CI 加上回報步驟：測試失敗 → `/api/ingest`；存活證明 → `/api/heartbeat`（`if: always()`）
5. 先手動跑一次 curl 確認回 201/200，再交給排程

### 常見接入失敗

| 症狀 | 原因 |
| --- | --- |
| 一直 401 | 簽章對的是重新序列化後的 JSON，不是實際送出的 body；或 CI 機器時鐘偏移 > 5 分鐘 |
| 一直 404（heartbeat） | 名稱沒登記，或與 `heartbeats.name` 不完全相符 |
| issue 每天長一筆新的 | 變動值（次數、時間）寫進了 `message`，導致 fingerprint 每次都不同 |
| heartbeat 回 200 但沒建 issue / 沒通知 | 該心跳 `enabled = false`——run 有記錄，但刻意不建 issue、不通知（回應會帶 `suppressed`） |
