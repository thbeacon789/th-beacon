# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 目前狀態：Plan 1–8 已上線運作中（2026-08-12 核對線上 DB）

**唯一真實來源（讀它，別憑本檔想像細節）：**
`docs/superpowers/specs/2026-07-23-service-monitoring-dashboard-design.md`
心跳存活證明另有專屬 spec：`docs/superpowers/specs/2026-07-29-heartbeat-liveness-design.md`
**對外 API 契約（headers／payload／回應碼／接入陷阱）：`docs/api.md`**——三個端點的實作級參考，別再從 plan 裡挖。

進度：**MVP 全部完成**（Plan 1–7）：`src/core/` 純邏輯 → 本地 Supabase schema/RLS → Store port + `processEvent` → `POST /api/ingest`（HMAC）→ 服務輪詢器（cron）→ Discord 通知器（ratchet + 冷卻/升級，`processAndNotify` 唯一入口）→ dashboard（Google OAuth 登入 + `allowed_emails` 白名單經 before_user_created hook 把關、server-side service_role 讀取、Realtime、trading-stream 像素視覺）。

**Plan 8（心跳存活證明）已完成**：`POST /api/heartbeat` 單一入口，CI 在 `if: always()` 下回報 `{name, status: pass|fail, runUrl, summary}`；具名心跳表 `heartbeats` 預先登記（未登記名稱回 404）；逾期判定用 `last_run_at`（有沒有回報）而非 `last_success_at`（有沒有成功），與 `test_failure` 正交；逾期掃描掛在既有 cron route；dashboard 的心跳逾期在**讀取端即時推導**並把燈號取最差（Hobby cron 一天一次，`health_status` 欄位會過期）。

**服務登記已自助化**：`/services` 頁面（登入後）可直接登記服務、產生／輪替 HMAC 金鑰、登記心跳名稱，不必再手寫 SQL。寫入路徑只有 server action（`app/services/actions.ts`），一律經 `requireUser()` 白名單把關；輸入驗證是純函式 `src/core/registration.ts`。金鑰產生後只回傳一次（DB 仍存明文，但頁面刻意不回讀），忘了就用「重新產生」輪替。名稱重複交給 DB 的 unique 約束判定（`23505` → 回 `null`），不做 check-then-insert。

**未完事項**：reopen 復發語意與恢復通知另案（Plan 6 交接）；per-service `discord_webhook_url` 目前四個服務都未設，通知全走全域 `DISCORD_WEBHOOK_URL` fallback。部署清單見 `docs/superpowers/plans/2026-07-28-plan7-dashboard.md`。計畫都在 `docs/superpowers/plans/`，執行走 superpowers subagent-driven-development。

## 常用指令

- `pnpm test`（Vitest 單元，零 DB 依賴）／`pnpm test:integration`（**只跑本地 stack**——它的 `cleanDatabase` 會清空六張表，指向線上等於清空 production）／`pnpm typecheck`／`pnpm build`（next build；**勿跑 `pnpm dev`**）
- 單檔測試：`pnpm vitest run tests/core/<name>.test.ts`
- **開發資料庫＝線上專案**（`zyehvumbpciiqbuivnfw`）。本地 stack **只為整合測試存在**，不是開發環境。
- Schema 變更：`supabase migration new <name>` → 編輯 SQL → `supabase db push`（套上線上）→ `supabase db advisors --type security`（或 MCP `get_advisors`）→ `pnpm db:types`（從線上重生 `src/db/database.types.ts`，自動產物勿手改）
- **勿用 MCP `apply_migration`**：本專案的 migration 以檔案版控，一律走 `db push`；`apply_migration` 會自行寫入 migration history，與檔案脫節。查資料／驗證用 MCP `execute_sql`（唯讀查詢）沒問題。
- **`seed.sql` 不會隨 `db push` 上線上**（只在本地 `db reset` 載入）。新增 seed 資料（如 triage 規則）必須另外對線上執行一次 INSERT，否則規則在線上不存在，會靜默失效。
- 跑整合測試前才需要本地 stack（OrbStack Docker 需先開）：`supabase start` → `supabase db reset`（重建並套用全部 migrations，與線上 schema 對齊）→ `pnpm test:integration`
- 涉及 Supabase 的任務先載入 Supabase agent skill（全域安裝，非 plugin）
- MCP 由專案級 `.mcp.json` 鎖定 `project_ref=zyehvumbpciiqbuivnfw`（帳號下另有其他專案，鎖定是為了防手滑對錯的專案下指令）

## 程式碼架構要點

- `src/core/**` 為**純函式**（禁 I/O、禁 Date.now；時鐘一律由參數注入）——這是硬性約束，測試依賴它。
- 型別集中 `src/core/types.ts`；DB 型別 `src/db/database.types.ts`（gen types 自動產生）。
- 所有 public 表已啟用 RLS 且 **deny-by-default（無 policy）**；伺服器端走 service_role，dashboard policy 留待 Plan 6。勿為了消 advisors 的 rls_enabled_no_policy INFO 而加 policy。

## 產品定位

集中式服務監控平台（代號 th-beacon），監控公司維護的多項服務，做三件事：

1. **健康度總覽** — dashboard 一眼看出每個服務是否正常。
2. **錯誤檢傷分類（triage）** — 規則引擎自動把湧入錯誤分級為 P0 / P1 / P2。
3. **重要錯誤即時告警** — 達門檻者立即發 Discord，並去重避免洗版。

## 已拍板的技術決策（實作時遵循，勿再自行變更）

- **技術棧**：Next.js 全棧（App Router），套件管理用 **pnpm**。
- **儲存 / 平台**：Supabase Postgres（＋ Auth ＋ Realtime）。
- **部署**：Vercel（含 Vercel Cron）＋ Supabase。
- **錯誤接收有兩條入口**：① 服務推送到 `POST /api/ingest`（每服務 HMAC 金鑰驗證）；② 主動輪詢各服務（health 存活偵測 ＋ error 端點補漏，由 Vercel Cron 觸發）。**不做** Sentry 等第三方整合（列為未來擴充）。
- **每日自動測試**：有自動測試的專案由各自 CI 排程每日跑測試，失敗經入口①回報（`error_type=test_failure`）；無自動測試的服務靠入口②的 health 輪詢。這是 push 入口的使用慣例，不是第三條入口。
- **存取控制**：Dashboard 走 Supabase Auth 登入；ingest webhook 用 HMAC；Cron 路由用內部 token。

## 核心架構觀念（實作時的骨幹）

所有來源都正規化成**單一 canonical event 模型**，匯流到同一條管線：

```
normalize → 依 fingerprint upsert issue → 規則引擎判級 → 更新健康度 → Discord 通知 → Realtime 推 dashboard
```

理解與維護時的關鍵點（細節見 spec）：

- **新增資料來源 = 只寫一個 normalizer**，管線本體不動。這是刻意的擴充點。
- **fingerprint 聚合**：同指紋事件聚合成一筆 `issue`（累計 count、first/last seen），別把每筆原始 event 當獨立問題處理。
- **severity 由規則引擎自動判**，與**操作狀態**（`open / acknowledged / resolved / ignored`，人工可改）是正交的兩個維度，別混用。
- **健康度：輪詢優先，取最差**——health 輪詢失敗/不健康直接判 Down，否則看近 N 分鐘內最嚴重的未解 issue。輪詢失敗也會合成 `source=poll` 的 event 走同一管線，因此「服務掛掉」本身能被判級並告警。
- **Discord 去重/冷卻**：同 fingerprint 冷卻期內只發一次並累計，升級才追發；發送紀錄寫 `notifications` 表供去重判斷。

## 工作慣例（覆寫預設）

- 溝通用**繁體中文**。
- commit 只納入當次 session 改動的檔案，用明確路徑 `git add`，**禁 `git add -A`**；未指定不開新 branch。工作完成且驗證通過即可 commit，但 **push 需明確要求**。
- dev server 由使用者自管，**勿自行 `pnpm dev` 或重啟**。
