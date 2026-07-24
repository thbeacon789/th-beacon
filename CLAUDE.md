# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 目前狀態：設計已定案，尚未 scaffold

這個 repo **還沒有任何程式碼**——只有一份已核准的設計 spec。專案尚未初始化（無 `package.json`、無原始碼），因此目前**沒有可用的 build / lint / test 指令**；這些會在依 spec scaffold 出 Next.js 專案後，由 `package.json` 的 scripts 產生。

**唯一真實來源（讀它，別憑本檔想像細節）：**
`docs/superpowers/specs/2026-07-23-service-monitoring-dashboard-design.md`

實作前的工作流程走 superpowers：brainstorming（已完成，產出上述 spec）→ writing-plans（下一步，尚未執行）→ 實作。若要開始實作，先確認實作計畫是否已寫出。

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
