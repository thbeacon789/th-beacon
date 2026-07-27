# 服務監控 Dashboard 設計（th-beacon）

日期：2026-07-23
狀態：已核准設計，待撰寫實作計畫

## 1. 目標與動機

為公司維護的多項服務建立集中式監控平台，提供三件事：

1. **健康度總覽** — 一眼看出每個服務目前是否正常。
2. **錯誤檢傷分類（triage）** — 自動把湧入的錯誤分級（P0/P1/P2），讓人力聚焦在真正重要的問題。
3. **重要錯誤即時告警** — 達門檻的錯誤立即發送到公司 Discord 頻道，且不洗版。

## 2. 已確認決策

| 項目 | 決定 |
| --- | --- |
| 技術棧 | Next.js 全棧（App Router） |
| 儲存 | Supabase Postgres（＋ Auth ＋ Realtime） |
| 資料來源 | ① 服務主動推送事件到 ingest webhook；② 主動輪詢各服務（health 存活偵測 ＋ error 端點補漏） |
| 每日自動測試 | 有自動測試的專案：各專案 CI 自排程每日跑測試，失敗結果經入口①（push ingest）回報（`error_type=test_failure`）；無自動測試的服務：靠入口②的 health 輪詢。非新入口，是 push 入口的使用慣例 |
| 檢傷分級 | 規則引擎 → P0 / P1 / P2 |
| Discord | 依分級觸發 ＋ 依 fingerprint 去重聚合 |
| 存取控制 | Dashboard 走 Supabase Auth 登入；ingest webhook 用每服務金鑰（HMAC）驗證 |
| 健康度演算法 | 輪詢優先，取最差：health 輪詢失敗/不健康 → Down；否則取近 N 分鐘內「最嚴重的未解 issue」 |
| 部署 | Vercel（含 Vercel Cron）＋ Supabase |

## 3. 系統架構與資料流

所有來源都正規化成**單一 canonical event 模型**，匯流到同一條處理管線。

```
服務 ────────POST /api/ingest (HMAC 金鑰)──┐
輪詢 health ──Cron /api/poll/services ─────┤─▶ 正規化 ─▶ 依 fingerprint upsert issue
輪詢 error 端點 ──Cron /api/poll/services ─┘        ├─▶ 規則引擎判級 (P0/P1/P2)
                                                   ├─▶ 更新服務健康狀態 (輪詢優先，取最差)
                                                   ├─▶ Discord 通知器 (去重 / 冷卻聚合)
                                                   └─▶ Supabase Realtime ─▶ Dashboard 即時更新
```

**核心原則**：兩條入口（push ingest、主動輪詢）匯流到相同的 `normalize → upsert → rules → notify` 管線。日後新增來源（如自建 log 或第三方追蹤平台）只需再寫一個 normalizer，管線本體不動。輪詢失敗/不健康也會合成一筆 canonical event（`source=poll`、`error_type=health_check_failed`）進入同一管線，因此「服務掛掉」本身就能被判級並觸發 Discord 告警。

## 4. 主要模組

各模組單一職責、以清楚介面溝通、可獨立測試。

### 4.1 Ingest 入口
- 路由：`POST /api/ingest`
- 驗證：每服務一組 secret，請求帶 HMAC 簽章（如 `X-Signature` header），伺服器以該服務 secret 驗簽；驗不過回 401。
- 職責：解析 payload → 呼叫 normalizer 轉成 canonical event → 交給共用管線。
- 相依：`services` 表（取 secret）、正規化管線。
- **CI 每日測試回報（使用慣例）**：有自動測試的專案在自己的 CI（如 GitHub Actions cron）每日執行測試，失敗時 POST 到本入口，`error_type=test_failure`，metadata 建議附 CI run URL 與失敗摘要。專案側提供回報 script 範例（curl ＋ HMAC 簽章）。seed 規則含一條 `test_failure` 預設判級（如 P1），使測試失敗自動影響健康度並可觸發告警。
- **Wire 契約（已定案）**：
  - Headers：`X-Beacon-Service`（services.name）、`X-Beacon-Timestamp`（unix 秒）、`X-Beacon-Signature`（`sha256=<hex>`，HMAC-SHA256(secret, `"${timestamp}.${rawBody}"`)）。
  - 防重放：時戳偏差 > 300 秒即拒。驗證失敗一律 `401 {"error":"unauthorized"}`（不洩漏服務名是否存在）。
  - Payload：`{"message"(必填), "errorType"?, "level"?, "occurredAt"?, "metadata"?}` 單筆事件；`400` JSON 解析失敗、`422` schema 不符（附 details）、`201` 成功（回 issueId/severity/health/duplicate）。
  - 回報 script 範例：`scripts/report-to-beacon.sh`（jq + openssl + curl）；`test_failure → P1` 種子規則見 `supabase/seed.sql`。

### 4.2 服務輪詢器
- 路由：`GET /api/poll/services`（由 Vercel Cron 定時觸發）
- **health 存活偵測**：依各服務設定定期 GET 其 `/health`（或指定 URL），檢查回應碼與（可選）status JSON。逾時 / 非預期狀態碼 / status 判為不健康時，合成一筆 `source=poll`、`error_type=health_check_failed` 的 canonical event 進入共用管線；同時更新服務健康狀態。連續成功則清除該 health issue（回 open→resolved）。
- **error 端點補漏**：依設定定期拉各服務自曝的「近期錯誤」端點（如 `/errors`），把回傳錯誤正規化後走同一管線；以錯誤自身 id 或 fingerprint＋時間去重，避免與 push 來源重複計數。
- 每服務可設定：health URL、error URL、輪詢間隔、逾時、預期狀態碼 / status 判準。缺設定則該服務不參與該類輪詢。
- 相依：`services` 表（輪詢設定與游標）、正規化管線。

### 4.3 正規化 / Fingerprint 分組
- Canonical event 欄位（概念）：`service_id`、`source`(push|poll)、`level`、`error_type`、`message`、`fingerprint`、`occurred_at`、`metadata`(JSON)。
- Fingerprint = `hash(service_id + error_type + 正規化後 message)`。訊息正規化需去除變動部分（數字、UUID、路徑參數等）以利同類聚合。
- 同 fingerprint 的事件聚合成一筆 `issue`：累計 `count`、更新 `last_seen`、保留 `first_seen`。

### 4.4 規則引擎
- 規則來源：`triage_rules` 表（MVP 以 seed / 設定檔管理，不做視覺化編輯器）。
- 規則條件（可組合）：`service`、`level`、`error_type`、訊息關鍵字、**時間窗內頻率/影響量**。
- 輸出：`severity`(P0/P1/P2) ＋ `tags`。
- 評估時機：事件進入管線、upsert issue 後評估並寫回 issue 的 severity。
- 規則優先序：依規則設定的優先權由高到低比對，命中即定級；無規則命中時給預設級（如 P2）。

### 4.5 健康度計算
- **輪詢優先，取最差**：
  1. 若最近一次 health 輪詢失敗 / 判為不健康 → 🔴 **Down**（直接定案）。
  2. 否則依「近 N 分鐘內最嚴重的**未解**（status = open/acknowledged）issue」推導：未解 P0 → 🔴 **Down**；未解 P1 → 🟡 **Degraded**；否則 → 🟢 **Healthy**。
- 兩訊號取惡化者：只要任一判為更差，即以較差狀態呈現，確保真失聯一定拓紅。
- N 與「連續幾次輪詢失敗才算 Down」為可設定參數（預設值於實作計畫決定）。
- 未設定 health 輪詢的服務：退回純 issue 推導（等同原始行為）。

### 4.6 Discord 通知器
- 觸發：issue 的 severity 達設定門檻（如 P0/P1）才發。
- 去重 / 冷卻：同 fingerprint 在冷卻期內只發一次，期間累計 count；分級升級（如 P1→P0）時追發。
- 內容：Discord embed，含服務、severity、錯誤摘要、累計次數、first/last seen、連向 dashboard 的連結。
- 紀錄：發送結果寫入 `notifications` 表，供冷卻/去重判斷與稽核。
- 設定：Discord webhook URL 存於 env / 服務設定。多頻道路由不在 MVP。

### 4.7 Dashboard UI（Next.js）
- **服務總覽**：每服務一張卡，顯示健康狀態燈號 ＋ 各分級未解 issue 數。
- **檢傷列表**：可依 service / severity / status 篩選；列出聚合後的 issue。
- **事件詳情**：單一 issue 的 metadata、原始事件、發生趨勢；可手動改操作狀態。
- **即時更新**：透過 Supabase Realtime 訂閱 issue 變動，前端即時反映。

## 5. 資料模型（Supabase 表）

- `services` — 服務清單、webhook secret、Discord 路由設定、健康度視窗設定、**輪詢設定**（health URL、error URL、間隔、逾時、預期狀態碼 / status 判準、拉取游標、連續失敗計數）。
- `issues` — 依 fingerprint 聚合的問題；欄位含 `severity`、`status`、`count`、`first_seen`、`last_seen`。
- `events` — 原始事件，外鍵歸屬於某 `issue`。
- `triage_rules` — 檢傷規則設定。
- `notifications` — 已發送 Discord 紀錄（冷卻 / 去重 / 稽核）。

**操作狀態**（與 severity 正交）：`open / acknowledged / resolved / ignored`，可於 dashboard 手動變更；severity 仍由規則自動判定。

## 6. 存取控制

- **Dashboard**：Supabase Auth 登入，限公司成員（網域 / allowlist）。middleware 保護 dashboard 頁面與管理型 API。
- **Ingest webhook**：公開路由，但以每服務 secret 的 HMAC 簽章驗證。
- **Cron 路由**：以 Vercel Cron secret / 內部 token 驗證，避免被外部觸發。

## 7. 排程作業（Vercel Cron）

- 服務輪詢（health 存活偵測 ＋ error 端點補漏，定期）。
- 冷卻期聚合 flush（若採「低分級批次摘要」延伸時；MVP 以即時去重為主）。

## 8. MVP 範圍

**做**：
- ingest webhook（HMAC 驗證）
- 服務輪詢（health 存活偵測 ＋ error 端點補漏）
- CI 每日測試回報慣例：回報 script 範例（curl ＋ HMAC）＋ `test_failure` seed 判級規則
- 正規化 ＋ fingerprint 聚合
- 規則引擎判級（seed 規則）
- Discord 通知（去重 / 冷卻聚合）
- 服務總覽 ＋ 檢傷列表 dashboard（Realtime）
- Supabase Auth 登入

**先不做（YAGNI）**：
- 規則視覺化編輯器（先用 seed / 設定檔）
- 多 Discord 頻道路由
- 報表 / 統計圖表
- on-call 排班
- 服務主動回報 heartbeat（改由主動輪詢 health 偵測失聯，已納入 MVP）
- 第三方錯誤追蹤平台整合（如 Sentry）——管線已保留擴充點，需要時再加 normalizer

## 9. 測試策略

- **正規化 / fingerprint**：單元測試，確保同類錯誤聚合、變動部分被正規化。
- **規則引擎**：單元測試，涵蓋條件組合、優先序、預設級 fallback。
- **Discord 去重 / 冷卻**：單元測試冷卻期內只發一次、升級追發、累計正確。
- **Ingest HMAC 驗證**：測試合法簽章通過、竄改 / 錯 secret 被拒。
- **服務輪詢**：測試 health 逾時 / 非預期狀態 → 合成 health_check_failed event 且更新為 Down；連續成功 → 清除 health issue；error 端點去重不與 push 重複計數。
- **健康度推導**：測試「輪詢優先，取最差」——輪詢失敗直接 Down、無輪詢時退回 issue 推導、各 severity 組合對應正確燈號。
- **管線整合**：ingest → upsert → 判級 → 通知 的端到端測試（可對 Discord 發送做 mock）。
