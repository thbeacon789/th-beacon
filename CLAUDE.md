# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 目前狀態：Plan 1–2 已完成，Plan 3 起尚未動工

**唯一真實來源（讀它，別憑本檔想像細節）：**
`docs/superpowers/specs/2026-07-23-service-monitoring-dashboard-design.md`

進度：Plan 1（`src/core/` 純邏輯）、Plan 2（本地 Supabase + schema/RLS/型別）、Plan 3（Store port + `processEvent` orchestrator + SupabaseStore）、Plan 4（Next.js scaffold + `POST /api/ingest` HMAC 全鏈 + CI 回報 script + wire 契約定案於 spec §4.1）已完成。後續：Plan 5 服務輪詢器 → Plan 6 Discord → Plan 7 dashboard。**寫 Plan 5/6 前必讀**：`docs/superpowers/plans/2026-07-27-plan3-persistence-pipeline.md` 的「Plan 4/5 必要事項」（poller 過期窗口、0-rows 語意；severity 降級策略前置決策歸 Discord 計畫）與 `docs/superpowers/plans/2026-07-28-plan4-ingest-api.md` 的「Plan 5+ 交接事項」。計畫都在 `docs/superpowers/plans/`，執行走 superpowers subagent-driven-development。

## 常用指令

- `pnpm test`（Vitest 單元，零 DB 依賴）／`pnpm test:integration`（需本地 stack）／`pnpm typecheck`／`pnpm build`（next build；**勿跑 `pnpm dev`**）
- 單檔測試：`pnpm vitest run tests/core/<name>.test.ts`
- 本地 Supabase（OrbStack Docker 需先開）：`supabase start`／`supabase status`／`supabase db reset`（重建並套用全部 migrations）
- Schema 變更：`supabase migration new <name>` → 編輯 SQL → `supabase db reset` → `supabase db advisors --local --type security` → `pnpm db:types`（重生 `src/db/database.types.ts`，自動產物勿手改）
- 涉及 Supabase 的任務先載入 `supabase:supabase` skill；本專案為**本地優先**開發（勿用遠端 MCP apply_migration 迭代）

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
