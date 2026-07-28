# 心跳存活證明（Heartbeat Liveness）設計

- 日期：2026-07-29
- 狀態：設計定案，待實作
- 關聯：`docs/superpowers/specs/2026-07-23-service-monitoring-dashboard-design.md`（主 spec，§4.1 入口①）

## 1. 問題

現行 `POST /api/ingest` 是**錯誤專用入口**：payload 一律經 `normalize → upsert issue → 判級 → 通知`，且 `events.issue_id` 為 `not null`——一筆 event 必須掛在某個 issue 底下。系統沒有「成功」的容身之處。

由此產生的盲點：**beacon 無法察覺「某個排程工作該跑卻沒跑」**。CI workflow 被停用、cron 設定壞掉、repo 被封存——這些情況下 beacon 收不到任何錯誤，dashboard 一片安靜地顯示健康。健康度推導（`src/core/health.ts`）只看「輪詢狀態 ＋ 近 N 分鐘內的未解 issue」，沒有任何一項能表達「預期中的訊號沒有出現」。

本設計新增**具名心跳**機制填補這個盲點，並順帶讓每次 CI 執行（成功或失敗）都留下可點擊的 run URL。

**明確不做**：完整測試執行歷史（通過率趨勢、逐次紀錄）。心跳只保留「最後一次」的狀態。

## 2. 核心概念

心跳是**具名的**：鍵為 `(service_id, name)`，例如 `daily-test`、`nightly-backup`。一個服務可以有多個各自獨立的排程工作，每個有自己的預期間隔，任一停擺都能被精確指認。

心跳**預先登記**：定義由維運者寫進 DB，回報端只送名字。未登記的名字回 404 而非自動建立——名字打錯要立刻炸給 CI 看，而不是靜靜長出一個沒人監控的幽靈心跳。間隔屬於監控設定，是 beacon 這邊的知識，不該由被監控方每次重申。

### 兩個時間戳，兩種語意（關鍵）

| 欄位 | 更新時機 | 語意 | 用途 |
|---|---|---|---|
| `last_run_at` | **每次**回報（pass 或 fail） | CI 還活著嗎 | **逾期判定的唯一依據** |
| `last_success_at` | 只有 `pass` | 上次綠燈是什麼時候 | 純顯示 |

逾期判定必須用 `last_run_at` 而非 `last_success_at`。若用後者，測試連續失敗時 CI 明明每天都有回報，系統卻會合成「Heartbeat missed」——訊息與事實不符（它有跑），且與已在告警的 `test_failure` issue 重複。

兩種失效因此正交、不重疊：

- **心跳逾期**（`heartbeat_missed`）＝ 完全沒回報 ＝ 排程本身死了。
- **測試失敗**（`test_failure`）＝ 有回報但結果是 fail。既有機制已涵蓋。

## 3. 資料模型

新增 `public.heartbeats`：

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | uuid pk | |
| `service_id` | uuid not null | fk → `services(id)` on delete cascade |
| `name` | text not null | 例：`daily-test` |
| `interval_seconds` | integer not null | 預期回報間隔 |
| `grace_seconds` | integer not null default 0 | 寬限期。CI 執行時間會漂，每日測試建議 1–2 小時 |
| `enabled` | boolean not null default true | 暫停監控用，不必刪資料 |
| `last_run_at` | timestamptz null | null ＝ 從未回報 |
| `last_success_at` | timestamptz null | |
| `last_run_status` | text null | `pass` \| `fail`，check constraint |
| `last_run_url` | text null | CI run URL（GitHub Actions run 連結） |
| `created_at` / `updated_at` | timestamptz not null | `updated_at` 掛 `moddatetime` trigger，比照現有表 |

- `unique (service_id, name)`
- index：`(enabled)` 供掃描用
- **從未回報**（`last_run_at` 為 null）時，以 `created_at` 作為到期基準。登記完卻忘了接 CI，超過一個間隔照樣告警——這是刻意的。

RLS 比照現有慣例：啟用但**不給 policy**（deny-by-default），dashboard 走 server-side service_role 讀取。不加進 `supabase_realtime` publication——心跳不需要即時推播，頁面重整就夠。

## 4. 純函式層 `src/core/heartbeat.ts`

零 I/O、時鐘由參數注入，符合 `src/core/**` 的硬性約束。

```
heartbeatDueAt(hb)             → (lastRunAt ?? createdAt) + intervalSeconds
isHeartbeatOverdue(hb, now)    → now > dueAt + graceSeconds
synthesizeHeartbeatMissedEvent(serviceId, hb, now) → CanonicalEvent
normalizeHeartbeatFailure(serviceId, hb, payload, now) → CanonicalEvent
```

### 合成事件的形狀

兩者都刻意貼齊既有的 `synthesizeHealthCheckFailedEvent`：**message 固定、變動細節進 metadata**。這是 fingerprint 聚合的前提——fingerprint 由 `serviceId + errorType + message` 算出，message 若含變動內容（時間、run 編號、失敗摘要），每次都會產生新 issue，聚合就壞了。

**`heartbeat_missed`**（掃描器合成）

- `source: 'poll'` — beacon 主動判定的事件，與 health 輪詢同性質。**不新增 `EventSource` 列舉值**，`events.source` 的 check constraint 不動。
- `level: 'error'`，`errorType: 'heartbeat_missed'`
- `message: "Heartbeat missed: {name}"` — 名稱必須進 message，同服務的不同心跳才會聚合成各自獨立的 issue。
- `metadata: { heartbeat, intervalSeconds, graceSeconds, lastRunAt, overdueSeconds }`

**`test_failure`**（回報 `status: fail` 時轉換）

- `source: 'push'`，`level: 'error'`，`errorType: 'test_failure'`
- `message: "Test failed: {name}"` — 固定，使同一心跳的連續失敗聚合成同一筆 issue，`pass` 時才能精確 resolve。
- `metadata: { heartbeat, runUrl, summary? }`

## 5. 回報入口 `POST /api/heartbeat`

CI 在 `if: always()` 下**只呼叫這一支**，成功失敗都回報。

認證完全重用 `verifyIngestSignature`（`src/ingest/hmac.ts`）：headers `x-beacon-service` / `x-beacon-timestamp` / `x-beacon-signature`，簽章為 `HMAC-SHA256(secret, "{timestamp}.{rawBody}")`。不新增第二套認證方式。

Body：

```json
{ "name": "daily-test", "status": "pass", "runUrl": "https://github.com/org/repo/actions/runs/123", "summary": "3 of 210 tests failed" }
```

`name` 與 `status` 必填，`runUrl` 與 `summary` 選填。

處理流程：

1. 驗簽 → 失敗 401
2. 解析 payload → 失敗 400 / 422
3. 查 `(service_id, name)` → 找不到回 **404** `{ error: "unknown heartbeat" }`
4. 更新 `last_run_at`、`last_run_status`、`last_run_url`；`status === 'pass'` 時**額外**更新 `last_success_at`
5. resolve `heartbeat_missed` issue（**pass 與 fail 皆執行**——只要有回報就證明 CI 活著）
6. `status === 'pass'` 時另外 resolve 該心跳的 `test_failure` issue（測試修好了）
7. `status === 'fail'` 時將 payload 轉成 canonical event，丟進 `processAndNotify`——issue 聚合、判級、Discord 去重全部沿用既有管線
8. 重算健康度，回應 `{ name, status, lastRunAt, lastSuccessAt, nextDueAt, issueId?, notified? }`

邏輯放 `src/heartbeat/handle-heartbeat.ts`，route 只做 HTTP 轉接——比照 `handle-ingest` 的分層。

### 與 `/api/ingest` 的分工

| | 適用對象 | 額外提供 |
|---|---|---|
| `/api/heartbeat` | 有固定節奏的排程工作 | 偵測靜默——該來沒來也告警 |
| `/api/ingest` | 事件驅動的 runtime 錯誤，無節奏預期 | 無，來了就處理 |

兩者**匯流到同一條管線**：heartbeat 的 fail 分支呼叫的就是 `processAndNotify`，共用 fingerprint 聚合、判級規則與 Discord 去重。不是兩套系統，是同一條管線的兩個入口，差別只在進來的事件有沒有「預期節奏」這個額外維度。`/api/ingest` 維持不變，仍是主 spec 的入口①。

## 6. 逾期掃描

`src/heartbeat/scan.ts` 的 `runHeartbeatScan(store, deps, now)`：

1. `store.listEnabledHeartbeats()` 取全部（跨服務）
2. 用純函式 `isHeartbeatOverdue` 篩出逾期者
3. 逐筆 `processAndNotify(synthesizeHeartbeatMissedEvent(...))`
4. 逐筆 try/catch，單一心跳出錯不中斷整輪——照 `runPoll` 現有做法

掛進現有 cron route `app/api/poll/services/route.ts`，回應多一個 `heartbeats` 欄位。心跳掃描**獨立於** `listPollableServices()`——服務沒設 poll URL 也能有心跳。

逾期期間每輪掃描都重新合成事件（同 fingerprint、聚合進同一筆 issue、count 累加）。Discord 有 30 分鐘冷卻（`COOLDOWN_MINUTES`），不會洗版。

### 判級

`supabase/seed.sql` 新增一條全域規則：

```sql
insert into public.triage_rules (service_id, priority, severity, tags, match)
values (null, 100, 'P1', array['heartbeat'], '{"errorType": "heartbeat_missed"}'::jsonb);
```

P1 而非 P0：排程工作沒跑不等於服務本體死亡（那是 `health_check_failed` 的 P0）。P1 已達 `NOTIFY_MIN_SEVERITY`，會發 Discord。

`test_failure` 已有 P1 seed 規則，heartbeat 轉換出的失敗事件命中同一條，無需新增。

## 7. 健康度：讀取端即時推導

**問題**：專案部署在 Vercel **Hobby** 方案，cron 最小間隔是一天一次、精度 ±59 分鐘（更頻繁的表達式會部署失敗）。現行排程為 `0 1 * * *`。在此頻率下，`heartbeat_missed` issue 的 `issues.last_seen` 一天只刷新一次，而 `health_window_minutes` 預設 15 分鐘——issue 15 分鐘後就滑出健康度視窗，`services.health_status` 自動變回 healthy，**心跳明明還在逾期，燈卻是綠的**。

**解法**：dashboard 判斷心跳時**不看 `health_status` 欄位**，改在 server-side 查詢時用同一支 `isHeartbeatOverdue` 即時計算。`getServicesOverview` 多回一個逾期心跳清單，有逾期就把顯示燈號取最差。

**刻意不把心跳塞進 `deriveHealth`**：那是寫進 DB 欄位的邏輯，一旦依賴它就需要有人在心跳到期的那一刻觸發重算，而 Hobby 沒有那個觸發器，結果只會是個經常過期的欄位。放在讀取端即時算比較誠實。

代價明確：**打開 dashboard 看到的狀態永遠是準的；Discord 主動推播最慢隔天早上 9 點**（01:00 UTC）。這是 Hobby 方案的固有限制。替代方案（Supabase pg_cron ＋ pg_net 觸發同一個 URL，掃描邏輯完全不動）已評估，優缺點見開發者 memory `pg-cron-vs-vercel-cron`；天級節奏用不上，不為尚未發生的需求引入 beta 階段的擴充。

## 8. Store port 擴充

`src/store/contracts.ts` 的 `Store` 介面新增：

```ts
listEnabledHeartbeats(): Promise<StoredHeartbeat[]>              // 掃描用，跨服務
listHeartbeatsByService(serviceId): Promise<StoredHeartbeat[]>   // dashboard 用
recordHeartbeatRun(serviceId, name, run): Promise<StoredHeartbeat | null>  // null = 未登記
resolveIssueByFingerprint(serviceId, fingerprint): Promise<boolean>
```

`resolveIssueByFingerprint` 用 fingerprint 精確比對（純函式算得出來），比 message 字串比對乾淨，且同時服務 `heartbeat_missed` 與 `test_failure` 兩種 resolve 需求。實作模式照抄現有的 `resolveHealthCheckIssue`。

Supabase 與 memory 兩個 store 實作同步補上。

## 9. Dashboard 顯示

- **服務卡片**：列出該服務的心跳，每筆顯示「最後執行時間 ＋ 狀態 ＋ run 連結」與「最後成功時間」，逾期者明顯標示。例：`daily-test — 最後執行 07/29 03:00 失敗 [查看 run] · 最後成功 07/28 03:00`。
- **issue 詳情頁**：`events.metadata` 中的 `runUrl` 渲染成可點連結，讓失敗側也能一鍵跳到 GitHub Actions。
- 視覺沿用既有 trading-stream 像素風。

## 10. CI 側

新增 `scripts/heartbeat-to-beacon.sh`（比照既有 `scripts/report-to-beacon.sh` 的 jq + openssl + curl 簽章寫法），供 GitHub Actions 在 `if: always()` 下呼叫，帶入 `${{ job.status }}` 與 `${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}`。

## 11. 測試策略

- **`tests/core/heartbeat.test.ts`**：到期計算、寬限期邊界（剛好等於到期時刻不算逾期）、`last_run_at` 為 null 時以 `created_at` 為基準、fail 回報後仍以 `last_run_at` 判定不逾期。
- **`tests/heartbeat/handle-heartbeat.test.ts`**：驗簽失敗 401、未登記名稱 404、payload 非法 422、pass 更新兩個時間戳並 resolve 兩類 issue、fail 只更新 `last_run_at` 且產生 `test_failure` issue。
- **`tests/heartbeat/scan.test.ts`**：僅逾期者合成事件、`enabled=false` 跳過、單筆丟例外不中斷整輪、連續掃描聚合進同一筆 issue。
- **整合測試**（需本地 stack）：打 `/api/heartbeat` → 驗證 DB 欄位更新與 issue 狀態轉換。

## 12. 已排除的替代方案

| 方案 | 排除理由 |
|---|---|
| 每服務單一心跳（`services` 加兩個欄位） | 一個服務只能有一種節奏，第二個排程工作無處可放，日後升級需資料遷移 |
| 首次回報自動登記心跳 | 名字 typo 產生幽靈心跳；間隔由外部控制，改監控設定要改 CI |
| 完整測試執行歷史表 | 需求已收斂為存活證明；歷史資料量大且需保留策略，YAGNI |
| Discord 恢復通知 | 通知量翻倍；`notifications.severity` 為 not null 且限定 P0/P1/P2，需改 schema |
| 成功／失敗打不同端點 | CI workflow 要維護兩段、兩處 HMAC 簽章 |
| 新增 `EventSource = 'heartbeat'` | 需改 DB check constraint 與核心型別；`'poll'` 已能表達「beacon 主動判定」 |
| 現在改用 pg_cron 排程 | pg_net 仍是 beta；天級節奏用不上，可日後無痛替換（掃描邏輯在 route 內，觸發來源無關） |
