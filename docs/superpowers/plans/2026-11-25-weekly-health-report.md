# 每週健康度週報 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每週一台北 09:00 由 Vercel cron 觸發，彙整全部服務一週健康度，以 `next/og` 渲染 1～4 張 PNG，附件發到既有 Discord 告警頻道。

**Architecture:** `load`（Supabase 讀取）→ `buildWeeklyReport`（純函式，判結論與清單）→ `paginateReport`（純函式，估高度分頁）→ `renderReportPage`（ImageResponse → PNG bytes）→ multipart 發送（bot 或 webhook）。協調流程 `runWeeklyReport` 以依賴注入撰寫，route 只做驗證與組裝。

**Tech Stack:** Next.js 16.2 App Router（Node runtime）、`next/og` ImageResponse、Supabase JS、Discord API v10、Vitest。

**Spec:** `docs/superpowers/specs/2026-11-25-weekly-health-report-design.md`（每個 task 都要先讀 spec 對應章節）

## Global Constraints

- `src/core/**` 純函式：禁 I/O、禁 `Date.now()`／`new Date()` 無參數；時鐘一律由參數注入。
- 時區固定 `Asia/Taipei`（UTC+8，無夏令時間），可用固定 offset `+8h` 計算。
- 報告週期：上週一 00:00 ～ 本週一 00:00（台北），半開區間 `[start, end)`；圖上標籤格式 `11/17–11/23`（en dash `–`）。
- 長期未處理門檻 `LONG_STANDING_DAYS = 7`；張數上限 `MAX_PAGES = 4`；圖寬 `1200`；單張高度上限 `PAGE_MAX_HEIGHT = 1600`。
- Satori 版面**只用 flexbox**；不用 grid、不用 CSS 變數。每個有多個子元素的 `<div>` 都要明寫 `display: 'flex'`（Satori 要求）。
- 中文字型用 Noto Sans TC 靜態字型（Regular 400＋Bold 700），**不得**呼叫 Google Fonts 或任何外部服務取字型。
- Discord 附件：multipart，`payload_json` ＋ `files[n]`，`attachments: [{ id: n, filename }]`；逾時 20000ms。
- 週報發到既有告警頻道（bot：`DISCORD_ALERT_CHANNEL_ID`；webhook：`DISCORD_WEBHOOK_URL`），不新增頻道變數。
- 週報不寫 `notifications` 表、不進 issue 管線。
- 套件管理 pnpm；**不跑 `pnpm dev`**（dev server 由使用者自管，已在本機啟動）；**不跑 `pnpm test:integration`**。
- commit 用明確路徑 `git add <path>`，禁 `git add -A`；不 push。commit 訊息結尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

## Review Focus

1. **台北時區邊界**：週一 01:00–01:59 UTC 觸發（台北週一 09:xx）、以及台北週日 23:30 手動觸發，都必須算出「最近一個已結束的完整週」，不得算成正在進行的這週。→ Task 1 測試。
2. **髒的 issue 訊息**：含換行、tab、超長、emoji、中英混合的 `message` 上圖必須是單行、截斷加 `…`，不爆版。→ Task 1 `toOneLine` 測試。
3. **服務沒有任何資安掃描**：`getSecurityView` 不回該服務的列；週報要顯示 `unknown`＋「無掃描」，並讓結論至少為「需關注」。→ Task 1 測試。
4. **清單超過 4 張圖**：最後一張末尾必須出現「另有 N 筆，詳見 dashboard」，N 正確，不靜默丟資料。→ Task 2 測試。
5. **渲染或發送失敗**：渲染炸掉要改發純文字版（標「圖片產生失敗」）；發送失敗要回非 2xx，不能吞掉回 200。→ Task 5 測試。

---

### Task 1: 週報模型純函式

**Files:**
- Create: `src/core/weekly-report.ts`
- Test: `tests/core/weekly-report.test.ts`

**Interfaces:**
- Consumes: `HealthStatus`, `Severity`, `IssueStatus` from `@/core/types`；`OverallStatus` from `@/core/security/view`（:20）、`FindingSeverity` from `@/core/security/types`（:9），只 import 型別。
- Produces（後續 task 依賴，名稱與型別不得更動）：

```ts
export const LONG_STANDING_DAYS = 7
export interface ReportWindow { start: Date; end: Date; label: string }
export function reportWindow(now: Date): ReportWindow
export function toOneLine(text: string, max: number): string

export interface WeeklyReportInput {
  now: Date
  services: Array<{ id: string; name: string; healthStatus: HealthStatus; openCounts: Record<Severity, number> }>
  issues: Array<{
    id: string; serviceId: string; severity: Severity; status: IssueStatus; message: string; count: number
    firstSeen: string; lastSeen: string; resolvedAt: string | null; acknowledgedBy: string | null; reopenCount: number
  }>
  healthFailEvents: Array<{ serviceId: string; occurredAt: string }>
  alertsSent: number
  securityRows: Array<{ serviceId: string; overall: OverallStatus; stale: boolean }>
  securityFindings: Array<{
    serviceId: string; severity: FindingSeverity; status: 'open' | 'resolved' | 'ignored'
    firstSeenAt: string; lastSeenAt: string; reopenCount: number
  }>
}

export type ReportVerdict = 'ok' | 'attention' | 'critical'
export interface IssueRow {
  kind: 'issue'; severity: Severity; serviceName: string; message: string
  daysOpen: number; count: number; acknowledgedBy: string | null; isNew: boolean
  reopenCount: number; status: IssueStatus
}
export interface SecurityGroupRow {
  kind: 'security'; serviceName: string; counts: Record<FindingSeverity, number>; oldestDays: number; isNew: boolean
}
export type ListRow = IssueRow | SecurityGroupRow
export interface WeeklyReport {
  window: ReportWindow
  generatedAt: string
  verdict: ReportVerdict
  headline: string
  stats: { pollFailures: number; pollFailureServices: number; newIssues: number; resolvedIssues: number; alertsSent: number }
  services: Array<{ name: string; health: HealthStatus; pollFailures: number; openIssues: number }>
  security: Array<{ serviceName: string; status: OverallStatus; note: 'stale' | 'none' | null; openFindings: Record<FindingSeverity, number> }>
  longStanding: ListRow[]   // issues 在前（依 spec §6.4 排序），security 群組在後
  recurring: ListRow[]      // 同上
}
export function buildWeeklyReport(input: WeeklyReportInput): WeeklyReport
export function formatReportText(report: WeeklyReport, opts: { dashboardUrl: string | null; imageFailed: boolean }): string
```

反覆出現列顯示 `reopenCount` 與 `status`（spec §6.5 的「本週次數」不做：`issues` 只有累計 `count`，要算週內次數得另查 events，對主管價值低）。

- [ ] **Step 1: 寫失敗測試** `tests/core/weekly-report.test.ts`，至少涵蓋以下 case（以固定 `now` 注入）：
  - `reportWindow(new Date('2026-11-24T01:30:00Z'))` → `start = 2026-11-16T16:00:00Z`、`end = 2026-11-23T16:00:00Z`、`label = '11/17–11/23'`。
  - `reportWindow(new Date('2026-11-23T15:30:00Z'))`（台北週日 23:30）→ `start = 2026-11-09T16:00:00Z`、`end = 2026-11-16T16:00:00Z`、`label = '11/10–11/16'`。
  - 跨月：`reportWindow(new Date('2026-12-07T01:00:00Z'))` → `label = '11/30–12/06'`（月日兩位數補零）。
  - `toOneLine('a\n\tb   c', 99)` → `'a b c'`；`toOneLine('x'.repeat(10), 5)` → `'xxxx…'`（含 `…` 共 5 字元）；emoji 不被切成半個（用 `Array.from` 以 code point 計）。
  - 結論 `critical`：任一服務 `healthStatus='down'`；或有 `status='acknowledged'` 的 P0；或任一 `securityRows.overall='bad'`。
  - 結論 `attention`：`degraded`；有反覆出現列；有本週新進長期未處理（`firstSeen` = `start − 7d + 1h`）；有 `firstSeenAt` 在窗內的 `medium` finding；有服務 `stale`；有服務完全沒有 `securityRows` 列（→ `security[].status='unknown'`、`note='none'`）。
  - 結論 `ok`：長期未處理僅有既有項（`firstSeen` = `start − 30d`）時仍為 `ok`，`headline` 為 `'5/5 服務正常 · 另有 1 筆既有待處理'`；全無項目時 `headline` 為 `'5/5 服務正常，無待處理事項'`。
  - 非 ok 的 `headline` 以 `、` 串接原因，順序與字樣固定：`{n} 個服務異常`、`{n} 個服務降級`、`{n} 筆未解 P0`、`資安異常 {n} 個服務`、`{n} 筆反覆出現`、`{n} 筆本週新進長期未處理`、`{n} 筆新資安發現`、`資安掃描過期或缺漏 {n} 個服務`；計數為 0 者省略。例：一個 degraded 加一筆新進 → `'1 個服務降級、1 筆本週新進長期未處理'`。
  - 長期未處理：`open` 與 `acknowledged` 都列、`acknowledgedBy` 帶出；`ignored`／`resolved` 不列；排序 P0→P2、同級 `daysOpen` 大到小；`daysOpen = floor((now − firstSeen)/1d)`。
  - 反覆出現：`reopenCount ≥ 1` 且 `lastSeen ∈ [start, end)` 才列；`reopenCount = 0` 不列。
  - 資安群組：同服務多筆 open finding 聚合成一列，`counts` 正確、`oldestDays` 取最舊、任一筆本週新進則 `isNew=true`；`ignored` 不計。
  - stats：`pollFailures` = 窗內 `healthFailEvents` 數、`pollFailureServices` = 去重服務數；`newIssues` = `firstSeen ∈ 窗`；`resolvedIssues` = `status='resolved'` 且 `resolvedAt ∈ 窗`。
  - `formatReportText`：首行為 `**TH-BEACON 週報 11/17–11/23** · 正常：5/5 服務正常，無待處理事項`（verdict 中文：ok=正常、attention=需關注、critical=異常）；`imageFailed=true` 時含 `（圖片產生失敗）`；有 `dashboardUrl` 時最後一行為該網址；並含 `長期未處理 {n} 筆 · 反覆出現 {n} 筆`。

- [ ] **Step 2: 跑測試確認失敗**
  Run: `pnpm vitest run tests/core/weekly-report.test.ts`
  Expected: FAIL（模組不存在）

- [ ] **Step 3: 實作 `src/core/weekly-report.ts`** 依上方 Interfaces。週期推算：把 `now` 加 8h 得台北牆鐘，取該週週一 00:00（台北）為 `end`，`start = end − 7d`，再減 8h 換回 UTC。`label` 的結束日是 `end − 1d`。

- [ ] **Step 4: 跑測試確認通過**
  Run: `pnpm vitest run tests/core/weekly-report.test.ts && pnpm typecheck`
  Expected: PASS、typecheck 無錯

- [ ] **Step 5: Commit**
  ```bash
  git add src/core/weekly-report.ts tests/core/weekly-report.test.ts
  git commit -m "feat(report): 週報模型純函式（週期、結論、長期與反覆清單）"
  ```

---

### Task 2: 分頁純函式

**Files:**
- Create: `src/core/weekly-report-pages.ts`
- Test: `tests/core/weekly-report-pages.test.ts`

**Interfaces:**
- Consumes: `WeeklyReport`, `ListRow` from `@/core/weekly-report`
- Produces:

```ts
export const PAGE_WIDTH = 1200
export const PAGE_MAX_HEIGHT = 1600
export const MAX_PAGES = 4
export const LAYOUT = {
  header: 96, verdict: 180, stats: 140, sectionTitle: 56, row: 48, serviceRow: 48, footer: 64, gap: 24,
} as const   // 數值為初值，Task 4 實測後可調，但只改這裡
export type ReportBlock =
  | { kind: 'verdict' } | { kind: 'stats' } | { kind: 'services' } | { kind: 'security' }
  | { kind: 'list'; list: 'longStanding' | 'recurring'; continued: boolean; rows: ListRow[] }
  | { kind: 'overflow'; remaining: number }
export interface ReportPage { index: number; total: number; height: number; blocks: ReportBlock[] }
export function paginateReport(report: WeeklyReport): ReportPage[]
```

規則（spec §8）：第 1 張固定依序放 `verdict`、`stats`、`services`（每列 2 個服務，列數 `ceil(n/2)`）、`security`（每服務一列）；接著 `longStanding` list、`recurring` list 依序流動填入。空清單仍輸出 `rows: []` 的 list block（渲染端顯示「本週無」，高度算一列）。塞不下的列順延下一張，續頁 `continued: true`。第 `MAX_PAGES` 張仍塞不下時，在最後一張末尾放 `overflow`（要預留一列高度），`remaining` = 未上圖的列數。`height` = 該頁實際內容高度（header＋blocks＋footer＋gap），不超過 `PAGE_MAX_HEIGHT`。

- [ ] **Step 1: 寫失敗測試**：
  - 5 服務、兩清單皆空 → 1 頁，blocks 種類依序為 `verdict, stats, services, security, list(longStanding, rows=[]), list(recurring, rows=[])`，`total=1`。
  - 長期未處理 60 列 → 多頁；第 2 頁首個 block 是 `list(longStanding, continued=true)`；所有頁 `height ≤ PAGE_MAX_HEIGHT`；`total` 在每頁一致。
  - 長期未處理 500 列 → 恰 `MAX_PAGES` 頁，最後一頁最後一個 block 為 `overflow`，`remaining` = 500 + 0 − 已上圖列數（以加總各頁 rows 長度驗證）。
  - 恰好填滿一頁的列數不產生空白第 2 頁。

- [ ] **Step 2: 跑測試確認失敗** — `pnpm vitest run tests/core/weekly-report-pages.test.ts`，Expected: FAIL

- [ ] **Step 3: 實作 `paginateReport`**

- [ ] **Step 4: 跑測試確認通過** — 同上指令＋`pnpm typecheck`，Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add src/core/weekly-report-pages.ts tests/core/weekly-report-pages.test.ts
  git commit -m "feat(report): 週報分頁（估高度、續頁、超量截斷）"
  ```

---

### Task 3: Discord 附件上傳（bot ＋ webhook）

**Files:**
- Create: `src/notify/discord-files.ts`
- Modify: `src/notify/discord-bot.ts`（`DiscordBot` 介面＋`createDiscordBot` 回傳物件，新增方法）
- Modify: `src/notify/discord.ts`（新增 webhook 送檔函式）
- Test: `tests/notify/discord-files.test.ts`

**Interfaces:**
- Consumes: `DiscordOutgoing`, `DiscordMessage` from `@/notify/message`；`SendResult` from `@/notify/discord`；`BotPostResult` from `@/notify/discord-bot`
- Produces:

```ts
// src/notify/discord-files.ts
export const FILE_SEND_TIMEOUT_MS = 20000
export interface DiscordFile { filename: string; data: Uint8Array; contentType: 'image/png' }
export function buildMultipartBody(payload: Record<string, unknown>, files: DiscordFile[]): FormData
// src/notify/discord-bot.ts — DiscordBot 新增
postFiles(message: DiscordOutgoing, files: DiscordFile[]): Promise<BotPostResult>   // 發到 config.channelId
// src/notify/discord.ts
export function sendDiscordWebhookFiles(
  webhookUrl: string, message: DiscordMessage, files: DiscordFile[], fetchImpl?: typeof fetch,
): Promise<SendResult>
```

`buildMultipartBody`：`payload_json` = `JSON.stringify({ ...payload, attachments: files.map((f, i) => ({ id: i, filename: f.filename })) })`；`files[i]` = `new Blob([f.data], { type: f.contentType })` 帶 filename。**不可手動設 `content-type` header**（讓 fetch 自帶 boundary）。bot 版沿用 `toBotBody` 的去 `username` 邏輯（payload 先去掉 `username` 再組）；`Authorization: Bot <token>`。兩者皆不 throw，錯誤回 `{ ok: false, reason }`，格式同既有函式。

- [ ] **Step 1: 寫失敗測試**（注入假 `fetch` 擷取 request）：
  - `buildMultipartBody({ content: 'hi' }, [a.png, b.png])`：`payload_json` 解析後 `attachments` 為 `[{id:0,filename:'a.png'},{id:1,filename:'b.png'}]`、`content='hi'`；`files[0]`、`files[1]` 存在且 `.name` 為檔名、`.type` 為 `image/png`。
  - bot `postFiles`：URL 為 `https://discord.com/api/v10/channels/<channelId>/messages`、method POST、headers 有 `Authorization: Bot <token>` 且**沒有** `content-type`；`payload_json` 不含 `username`；回應 `{id:'m1'}` → `{ ok: true, channelId, messageId: 'm1' }`；回 403 → `{ ok: false, reason: 'http 403' }`。
  - `sendDiscordWebhookFiles`：POST 到 webhookUrl、body 為 FormData；204 → `{ ok: true }`；fetch throw → `{ ok: false }`。

- [ ] **Step 2: 跑測試確認失敗** — `pnpm vitest run tests/notify/discord-files.test.ts`，Expected: FAIL

- [ ] **Step 3: 實作三個函式**

- [ ] **Step 4: 跑測試確認通過** — `pnpm vitest run tests/notify && pnpm typecheck`，Expected: PASS（含既有 `discord-bot.test.ts` 不壞；若既有測試的假 bot 物件因介面新增方法而 typecheck 失敗，補上 `postFiles` stub）

- [ ] **Step 5: Commit**
  ```bash
  git add src/notify/discord-files.ts src/notify/discord-bot.ts src/notify/discord.ts tests/notify/discord-files.test.ts
  # 若有修改既有測試的 stub，一併以明確路徑加入
  git commit -m "feat(notify): Discord multipart 附件上傳（bot 與 webhook）"
  ```

---

### Task 4: 週報圖片渲染

**Files:**
- Create: `src/fonts/NotoSansTC-Regular.otf`、`src/fonts/NotoSansTC-Bold.otf`（二進位字型檔）
- Create: `src/report/tokens.ts`、`src/report/fonts.ts`、`src/report/render.tsx`（區塊元件可拆到 `src/report/blocks.tsx`）
- Modify: `next.config.ts`（必要時加 `outputFileTracingIncludes`）
- Test: `tests/report/render.test.ts`

**Interfaces:**
- Consumes: `WeeklyReport`, `ListRow` from Task 1；`ReportPage`, `ReportBlock`, `PAGE_WIDTH`, `LAYOUT` from Task 2
- Produces:

```ts
// src/report/render.tsx
export function renderReportPage(report: WeeklyReport, page: ReportPage, opts: { dashboardUrl: string | null }): Promise<Uint8Array>  // PNG bytes
```

要點：
- 字型來源：Noto CJK 官方 repo `notofonts/noto-cjk` 的 `Sans/SubsetOTF/TC/NotoSansTC-Regular.otf` 與 `NotoSansTC-Bold.otf`（SIL OFL）。用 `curl -L` 從 `https://github.com/notofonts/noto-cjk/raw/main/Sans/SubsetOTF/TC/<file>` 下載；下載後以 `file` 指令確認是 OpenType 字型而非 HTML。若路徑不存在，停下回報，不得改用 Google Fonts API 或可變字型（variable font）。
- `src/report/fonts.ts`：module scope 以 `fs.readFile(path.join(process.cwd(), 'src/fonts', name))` 讀一次並快取 Promise。`fonts` 陣列順序：`New-Gen`（400）、`Aurora-BC`（700，標題用 name `'Aurora'`）、`Pixel`（`Pixel-12x10.ttf`，400）、`Noto Sans TC` 400、`Noto Sans TC` 700。元件 `fontFamily` 寫成 `'New-Gen, Noto Sans TC'` 之類的 fallback 鏈。
- `src/report/tokens.ts`：從 `app/globals.css:7-21` 照抄色票成常數物件，檔頭註明「來源 app/globals.css:7-21，改色票兩邊要一起改」。燈號色：healthy=`green`、degraded=`yellow`、down=`pink`（同 `app/globals.css:597-605`）；燈號形狀：healthy 圓、degraded 三角、down 八角（參考 `src/web/icons.tsx`，以 inline SVG 重畫）。資安 ok=green、warn=yellow、bad=pink、unknown=lilac。
- 版面依 spec §7 草圖；每頁寬 `PAGE_WIDTH`、高 `page.height`。結論區放儀表（漸層 `#ff7db2→#ffd561→#82ff9a`，linear-gradient＋絕對定位指針，指針位置用 `summarizeHealth` 同義的 score：healthy=100、degraded=50、down=0 平均）。清單列：IssueRow 顯示「嚴重度、服務名、`toOneLine(message, 48)`、`{daysOpen} 天`、`×{count}`、`已確認 · {acknowledgedBy}`（若有）、`NEW`（若 isNew）」；反覆出現列顯示 `重開 {reopenCount} 次` 與狀態（resolved→`已再次解決`，其他→`仍未解`）。SecurityGroupRow：`{serviceName}：{n} high／{n} medium／{n} low，最久 {oldestDays} 天`（0 者省略）。空清單列文字 `本週無`；續頁區塊標題加 `（續）`；overflow 列 `另有 {remaining} 筆，詳見 dashboard`；頁尾：`產生時間 {YYYY-MM-DD HH:mm}（台北）· {index+1}/{total} · {dashboardUrl}`。
- 取 bytes：`new Uint8Array(await new ImageResponse(jsx, { width, height, fonts }).arrayBuffer())`。

- [ ] **Step 1: 寫失敗測試** `tests/report/render.test.ts`：用一份含中文 message、acknowledged 列、security 群組、overflow 的假 `WeeklyReport`，跑 `paginateReport` 後渲染每頁：
  - 回傳 bytes 前 8 bytes 等於 PNG 簽章 `89 50 4E 47 0D 0A 1A 0A`。
  - 從 IHDR（offset 16–23，big-endian）讀出寬 = 1200、高 = `page.height`。
  - 測試 timeout 設 30000ms。

- [ ] **Step 2: 跑測試確認失敗** — `pnpm vitest run tests/report/render.test.ts`，Expected: FAIL

- [ ] **Step 3: 下載字型、實作 tokens／fonts／render**

- [ ] **Step 4: 跑測試確認通過** — 同上＋`pnpm typecheck`，Expected: PASS。若 `next/og` 在 Vitest 環境無法載入，回報錯誤原文，不要自行換成直接依賴 satori／resvg 套件。

- [ ] **Step 5: 目視驗收**：在 scratchpad 寫一支一次性腳本（或在測試中於 `process.env.REPORT_SNAPSHOT_DIR` 有值時把 PNG 寫到該目錄），產出 PNG，回報檔案絕對路徑供指揮官以 Read 檢視：中文不是方塊、像素字型出現在結論與大數字、燈號顏色形狀正確、沒有文字溢出。腳本不 commit。

- [ ] **Step 6: Commit**
  ```bash
  git add src/fonts/NotoSansTC-Regular.otf src/fonts/NotoSansTC-Bold.otf src/report/tokens.ts src/report/fonts.ts src/report/render.tsx tests/report/render.test.ts
  # 若有 src/report/blocks.tsx、next.config.ts 的修改，一併以明確路徑加入
  git commit -m "feat(report): 以 next/og 渲染週報圖片（沿用 trading-stream 視覺）"
  ```

---

### Task 5: 資料讀取、協調流程、route 與排程

**Files:**
- Create: `src/report/load.ts`、`src/report/run-weekly-report.ts`、`src/web/bearer.ts`、`app/api/report/weekly/route.ts`
- Modify: `app/api/poll/services/route.ts:12-15`（改 import 共用 `bearerMatches`）
- Modify: `src/store/server.ts`（新增 `createServerReportSender`）
- Modify: `vercel.json`
- Test: `tests/report/run-weekly-report.test.ts`

**Interfaces:**
- Consumes: Task 1–4 全部；`getServicesOverview` from `@/web/queries`；`getSecurityView` from `@/web/security-queries`；`createServerStore().rawClient()`；Task 3 的 `postFiles`／`sendDiscordWebhookFiles`
- Produces:

```ts
// src/web/bearer.ts
export function bearerMatches(header: string | null, secret: string): boolean   // 從 poll route 原樣搬出

// src/report/load.ts
export function loadWeeklyReportInput(client: SupabaseClient<Database>, now: Date): Promise<WeeklyReportInput>

// src/report/run-weekly-report.ts
export type ReportSender = (content: string, files: DiscordFile[]) => Promise<SendResult>
export interface RunWeeklyReportDeps {
  now: Date
  dashboardUrl: string | null
  load: (now: Date) => Promise<WeeklyReportInput>
  render: (report: WeeklyReport, page: ReportPage) => Promise<Uint8Array>
  send: ReportSender
}
export type RunWeeklyReportResult =
  | { ok: true; pages: number; imageFailed: boolean; verdict: ReportVerdict }
  | { ok: false; stage: 'load' | 'send'; reason: string }
export function runWeeklyReport(deps: RunWeeklyReportDeps): Promise<RunWeeklyReportResult>

// src/store/server.ts
export function createServerReportSender(): ReportSender | null
```

- `loadWeeklyReportInput`：以 `reportWindow(now)` 取窗。並行查詢：`getServicesOverview`；`getSecurityView`；`issues`（`status in (open, acknowledged)` 或 `first_seen ≥ start` 或 `last_seen ≥ start` 或 `resolved_at ≥ start`，用 `.or(...)`）；`events`（`error_type = 'health_check_failed'` 且 `occurred_at ∈ [start, end)`，只取 `service_id, occurred_at`）；`notifications`（`status='sent'` 且 `sent_at ∈ [start, end)`，`count: 'exact', head: true`）；`security_findings`（`status = 'open'` 或 `last_seen_at ≥ start`，排除 `ignored`）。任一錯誤 throw。`securityRows` 由 `SecurityView.rows` 映射。
- `runWeeklyReport`：load 失敗 → `{ ok:false, stage:'load' }` 且不 send。build → paginate → 逐頁 render；**任一頁 render throw** → 改送 `formatReportText(report, { imageFailed: true })`、`files = []`。成功時 content = `formatReportText(report, { imageFailed: false })`，檔名 `weekly-report-{n}.png`（n 從 1 起）。send 回 `ok:false` → `{ ok:false, stage:'send', reason }`。
- `createServerReportSender`：bot 模式判斷與 `createServerNotifyDeps` 相同（讀同一組變數、同一個條件）；bot 時用 `createDiscordBot({ token, channelId: DISCORD_ALERT_CHANNEL_ID }).postFiles({ content }, files)` 並把 `BotPostResult` 轉 `SendResult`；否則有 `DISCORD_WEBHOOK_URL` 用 `sendDiscordWebhookFiles`；都沒有回 `null`。
- Route `app/api/report/weekly/route.ts`：`export const runtime = 'nodejs'`、`export const maxDuration = 60`；GET；`CRON_SECRET` Bearer 驗證失敗 401（同 poll route 寫法）。`?preview=1`：不發送，`page` 參數（預設 0）指定頁，回 `image/png`；頁碼超出回 404。`?now=<ISO>` 可覆寫時鐘（preview 與正式皆可，解析失敗回 400）。正式模式：sender 為 `null` 回 500 `{ error: 'discord not configured' }`；`runWeeklyReport` 結果 `ok:false` 回 500 並帶 `stage`/`reason`；成功回 200 JSON `{ pages, imageFailed, verdict }`。`dashboardUrl` 取 `APP_URL`（去尾斜線），未設為 `null`。
- `vercel.json` crons 新增 `{ "path": "/api/report/weekly", "schedule": "0 1 * * 1" }`，保留既有那條。

- [ ] **Step 1: 寫失敗測試** `tests/report/run-weekly-report.test.ts`（全假依賴）：
  - 正常：send 收到 `files.length === pages`、檔名 `weekly-report-1.png`…、content 首行含 `TH-BEACON 週報`；結果 `ok:true, imageFailed:false`。
  - render 第 2 頁 throw → send 收到 `files=[]`、content 含 `（圖片產生失敗）`；結果 `ok:true, imageFailed:true`。
  - load throw → send 未被呼叫；結果 `{ ok:false, stage:'load' }`。
  - send 回 `{ ok:false, reason:'http 403' }` → 結果 `{ ok:false, stage:'send', reason:'http 403' }`。

- [ ] **Step 2: 跑測試確認失敗** — `pnpm vitest run tests/report/run-weekly-report.test.ts`，Expected: FAIL

- [ ] **Step 3: 實作 bearer 抽出、load、run、sender、route、vercel.json**

- [ ] **Step 4: 跑全部單元測試與型別** — `pnpm test && pnpm typecheck`，Expected: 全 PASS（既有 `tests/heartbeat/poll-route-isolation.test.ts` 不壞）

- [ ] **Step 5: 本機預覽實跑**（dev server 已由使用者啟動，勿自行啟動）：從 `.env.local` 讀 `CRON_SECRET`（不要印出它），
  `curl -s -H "Authorization: Bearer $CRON_SECRET" "http://localhost:3000/api/report/weekly?preview=1&page=0" -o <scratchpad>/weekly-0.png -w '%{http_code} %{content_type}\n'`
  Expected: `200 image/png`；回報 PNG 絕對路徑供指揮官目視。另測無 token → 401、`page=99` → 404、`now=abc` → 400。**不要**呼叫非 preview 的正式模式（會真的發到 Discord；由指揮官取得使用者同意後再做）。

- [ ] **Step 6: Commit**
  ```bash
  git add src/report/load.ts src/report/run-weekly-report.ts src/web/bearer.ts app/api/report/weekly/route.ts app/api/poll/services/route.ts src/store/server.ts vercel.json tests/report/run-weekly-report.test.ts
  git commit -m "feat(report): 週報 route、協調流程與每週一 cron"
  ```

---

### 收尾（指揮官執行，不派 task）

- 經使用者同意後，對本機 route 正式模式打一次，確認 Discord 告警頻道收到附件（同時驗證 bot 的 Attach Files 權限）。
- 線上 500KB 打包限制與字型 bundle 只能在部署後驗證：使用者 push 後打線上 `?preview=1` 確認；若失敗，依 spec §11 退路處理（Supabase Storage 讀字型）並回報。
