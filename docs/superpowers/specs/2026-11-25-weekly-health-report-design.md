# 每週健康度週報（Discord 圖片）設計

日期：2026-11-25
狀態：待使用者核准（已經過 builder check）

## 1. 目的與動機

每週一自動產生「全部服務一週健康度」週報，渲染成圖片發到 Discord 頻道。

**讀者是主管**，看完要能回答三件事：

1. **這週一切正常嗎？**——一眼看出結論，正常的週也要照發（沒消息分不出「真的正常」還是「系統壞了」）。
2. **有沒有未處理的問題長期存在？**
3. **有沒有重複出現多次的問題再次發生？**

## 2. 目標／非目標／反目標

**目標**
- 每週一台灣時間上午自動發一則 Discord 訊息，附 1～N 張 PNG。
- 圖片沿用 dashboard 的 trading-stream 像素視覺（色票、三支字型、燈號三重編碼）。
- 內容涵蓋：服務燈號、本週摘要數字、長期未處理清單、反覆出現清單、資安掃描結果。
- 可手動預覽（不發 Discord，直接回 PNG），方便調版面。

**非目標**
- 不新增每日健康度快照表（輪詢一天一次，快照資訊量有限；「掛過」已有 `health_check_failed` issue／event 可回推）。
- 不放 AI 用量／費用。
- 不做可用率百分比、趨勢曲線、跨週比較。
- 不做互動按鈕（週報是唯讀摘要；要處理的人去 dashboard）。
- 不做發送去重（Vercel cron 重複觸發的機率低，重複一則週報代價小）。

**反目標（技術上能跑但算失敗）**
- 結論被細節淹沒：主管要滑三張圖才知道「正常與否」。結論必須在第一張圖最上方。
- 燈號平均化：一台 down 被其他四台綠燈平均成「大致正常」。一律取最差（沿用 `summarizeHealth` 的 `worst` 語意）。
- 為了湊版面硬拆多張圖；或清單被截斷卻沒標示「另有 N 筆」。
- 週報結論與 dashboard 燈號不一致（例如 dashboard 因心跳逾期顯示黃燈，週報卻說正常）。

## 3. 限制

- 部署在 Vercel **Hobby**：cron 最小間隔一天，觸發時間精度約 ±59 分鐘（見 §11 查證）。
- `src/core/**` 純函式：禁 I/O、禁 `Date.now`，時鐘由參數注入。
- `src/core/security/**` 只用相對路徑加 `.ts` 副檔名 import（既有約束，新程式若 import 它要注意）。
- Discord 端目前只送 JSON（`src/notify/discord.ts:12`、`src/notify/discord-bot.ts:35` 寫死 `content-type: application/json`），沒有任何附件上傳程式碼。
- 通知有兩種模式：bot（四個 `DISCORD_*` 變數齊全）或 webhook fallback（`DISCORD_WEBHOOK_URL`）。週報兩種都要支援。

## 4. 做法比較（已決定：A）

| 做法 | 內容 | 取捨 |
|---|---|---|
| **A. `next/og` `ImageResponse`（採用）** | cron route 內用 JSX 組版面輸出 PNG | Next 內建、零新依賴、全部留在既有 cron／通知架構內。代價：Satori 排版引擎只支援 CSS 子集（flexbox，無 grid、無 CSS 變數），色票要另抄一份 TS token，版面以 inline style 重刻；recharts 不能用。 |
| B. Vercel 上跑 headless Chromium 截圖 | 截一個真的週報頁面 | CSS 100% 沿用，但 Chromium 套件約 50MB、冷啟動慢，Hobby 易超時超容量。 |
| C. GitHub Actions + Playwright 截線上頁面 | CI 截圖後發 DC | CSS 可完整沿用，但週報頁要開帶 token 的免登入通道，排程與發送分散到 CI，多一個資安面。 |

選 A 的理由：週報是固定版型，Satori 限制影響小；依賴最少。使用者已拍板。

## 5. 時間窗與排程

- 時區：`Asia/Taipei`。
- 報告週期：**上週一 00:00 ～ 本週一 00:00（台北時間）**，半開區間 `[start, end)`。圖上標示為「11/17–11/23」。
- 排程：`vercel.json` 新增 cron `0 1 * * 1`（UTC 週一 01:00 = 台北週一 09:00，Hobby 精度下約 09:00–09:59 之間觸發）。
- 週期由「觸發當下的 now」推算，不依賴觸發時刻精準：只要在週一台北時間內觸發，算出的都是上一個完整週。

## 6. 內容定義

所有「現況」類資料以**產生當下**為準；「本週」類資料以 §5 時間窗為準。

### 6.1 總結論（第一張圖最上方）

三級結論，取最差。**使用者決定：區分「本週新增／惡化」與「既有已知」**——既有的老問題照樣列在清單裡，但只有「本週出現變化」才會把結論拉到「需關注」，避免每週都是「需關注」讓主管麻木。「異常」不做此區分：真正的大事每週都要喊。

| 結論 | 條件（任一成立） |
|---|---|
| 異常 | 任一服務燈號 `down`；或有未解 P0 issue（`open` 或 `acknowledged`，與 dashboard 一致）；或任一服務資安 `overall = bad` |
| 需關注 | 任一服務燈號 `degraded`；或「反覆出現」清單非空（本週重開才算，見 6.5）；或有**本週新進**長期未處理清單的項目（見下）；或有本週新出現的 medium 以上資安 finding（`first_seen_at` 落在時間窗內）；或任一服務資安掃描過期（從未納入掃描的服務不算，見 6.6） |
| 正常 | 以上皆不成立 |

**「本週新進長期未處理」**：在時間窗內跨過 7 天門檻的項目，即 `first_seen ∈ [start − 7 天, end − 7 天)`。比它更早跨門檻的屬「既有」。此判定只靠現有時間戳，不需記錄上週週報狀態。清單中本週新進的項目加「NEW」標記。

旁邊附一句白話，例如：
- 「5/5 服務正常，無待處理事項」
- 「5/5 服務正常 · 另有 3 筆既有待處理」（結論為正常，但清單非空）
- 「1 個服務降級、1 筆本週新進長期未處理」

### 6.2 服務燈號

- 每個服務一個燈號，**與 dashboard 首頁完全一致**：直接沿用 `getServicesOverview`（`src/web/queries.ts:86`，已含心跳逾期取最差）與 `summarizeHealth`（同檔 :67）。
- 燈號三重編碼（顏色＋形狀＋文字），同 `src/web/icons.tsx`：healthy 綠圓、degraded 黃三角、down 粉八角。
- 每個服務旁加本週小計：本週掛掉次數（見 6.3）、目前未解 issue 數。

### 6.3 本週摘要數字

一排 4 個數字：

- **服務中斷**：時間窗內 `error_type = 'health_check_failed'` 的 event 數，顯示為「N 次輪詢失敗 · M 個服務」。每次 health 檢查失敗都會寫一筆 event（`src/poll/poll-service.ts`，失敗分支），輪詢一天一次，所以連續掛三天算 3 次；這個數字的意思是「被輪詢抓到掛掉的次數」，圖上照此字面標示，不宣稱是停機時長。（設計者決定）
- **新問題**：`first_seen` 落在窗內的 issue 數。
- **已解決**：`status = 'resolved'` 且 `resolved_at` 落在窗內的 issue 數，即「週內解決、產生當下仍是解決狀態」。重開時 `resolved_at` 會被清空（`src/store/supabase.ts:243`），所以週內解了又重開的不算，它會改出現在「反覆出現」清單。不另建轉換歷史。（設計者決定）
- **告警次數**：時間窗內 `notifications.status = 'sent'` 的筆數。

`events` 表目前沒有清理機制（只有 `security_scans` 有 90 天清理），一週的資料必定還在。

### 6.4 長期未處理清單

兩個來源合併，各自分組顯示：

- **Issue**：`status ∈ {open, acknowledged}`，且 `first_seen` 早於產生當下 7 天以上。**使用者決定：已確認但沒解決的也要列**，因為確認不等於解決。acknowledged 的項目標「已確認 · {acknowledged_by}」，看得出有人認領但卡住了。`ignored`、`resolved` 排除。每筆一行：嚴重度、服務名、訊息摘要（截斷）、已開天數、累計次數、本週新進者標 NEW。排序：嚴重度（P0→P2）→ 已開天數由多到少。
- **資安 finding**：`security_findings.status = 'open'`（即 `/security` 頁的「待處理」tab；`ignored`／`resolved` 排除）且 `first_seen_at` 早於 7 天以上。**依服務聚合成一行**（例如「chatxbuy-api：3 medium／1 low，最久 20 天」），不逐筆列，避免主管被 11 筆技術細節淹沒。

門檻 7 天定義成具名常數，之後可調。

### 6.5 反覆出現清單

**定義為「本週重開」**（2026-11-25 實作後修訂）：`reopen_count` 是累積值、永不歸零，原定義「`reopen_count ≥ 1` 且 `last_seen` 在窗內」會讓重開過一次又持續出事的老問題每週都觸發「需關注」，違反 6.1「區分新增與既有」。

- **Issue**：`status ≠ ignored`、`reopen_count ≥ 1`，且 `incident_first_seen`（重開時設為發生時間）落在窗內。每筆一行：嚴重度、服務名、訊息摘要、重開次數、累計次數（標「累計」，不做本週次數）、目前狀態（已再次解決／仍未解）。
- **資安 finding**：`status ≠ ignored`、`reopen_count ≥ 1`，且由系統重開（`status_changed_by = 'system'`）的 `status_changed_at` 落在窗內，同樣依服務聚合成一行。

### 6.6 資安

- 每個服務一個資安燈號：沿用 `getSecurityView`（`src/web/security-queries.ts:10`）取每服務最新一次掃描的 `overall`（ok／warn／bad／unknown），與 `/security` 頁一致。`overall` 由掃描檢查結果推導，不受 finding 的人工 ignored 狀態影響；這是既有行為，週報不改。
- 掃描過期（`stale = true`）的服務顯示 `unknown` 並標「資料過期」，過期算「需關注」。
- **從未有掃描紀錄的服務**顯示「未納入資安掃描」（中性圖示），**不**觸發需關注、不計入結論白話（2026-11-25 實作後修訂：線上 5 個服務中有 4 個本就不在掃描範圍，計入會讓結論每週常駐需關注）。90 天清理會保留每服務最新一筆快照，曾掃描過的服務只會變成過期，不會退化成「未納入」。
- 只有非 ok 的服務列出 open finding 的嚴重度計數；細節不上圖，附 dashboard `/security` 連結。

## 7. 視覺設計

- 圖寬固定 **1200px**，高度依內容（單張上限見 §8）。
- 色票：從 `app/globals.css:7-21` 抄出一份 TS token 物件（例如 `src/report/tokens.ts`），並在檔頭註明來源行號；不做自動同步（Satori 不吃 CSS 變數）。
- 字型：`src/fonts/` 三支 ttf 以 `fs.readFile` 讀成 ArrayBuffer 傳入 `ImageResponse`。像素字型 `Pixel-12x10` 用於結論與大數字（同 dashboard 只給儀表數字用的慣例），`Aurora-BC` 用標題，`New-Gen` 用內文。
- **中文字型（必要）**：上述三支只含拉丁字元（27～83KB）。dashboard 的中文是靠瀏覽器 fallback 到 `PingFang TC`／`Noto Sans TC`（`app/globals.css:37`），Satori 沒有系統字型可 fallback，不補字型中文會全變方塊。
  - 設計者決定：把 **Noto Sans TC**（SIL OFL）的 Regular 與 Bold 靜態 TTF 放進 `src/fonts/`，在 `fonts` 陣列中排在拉丁字型之後當 fallback（Satori 依序找有字形的字型）。
  - 不採 Google Fonts `text=` 動態子集：那會把 issue 訊息、資安標題用到的字元送到外部服務。
  - 不採常用字子集：issue 訊息內容不可控，罕用字會變方塊；完整字型約數 MB，Node runtime 可承受。
  - 部署時 `fs.readFile` 讀的字型檔必須進到 Vercel function bundle：若追蹤不到，需在 `next.config.ts` 設 `outputFileTracingIncludes`。實作者以線上預覽模式實際驗證。
- **CSS 一律只用 flexbox**：next/og 文件寫不支援 grid；新版 Satori README 寫支援 grid 與 CSS 變數，但 next/og 內附版本是否已含未確認。保守起見不用 grid、不用 CSS 變數。linear-gradient 需實測。
- 頂部可放 dashboard 的總體健康度儀表（`src/web/health-gauge.tsx` 的漸層 `#ff7db2→#ffd561→#82ff9a`），以 Satori 能畫的方式（linear-gradient + 絕對定位指針）重刻。
- 每張圖底部：產生時間、頁碼（2/3）、dashboard 網址。

版面草圖（第一張）：

```
┌ TH-BEACON 週報  11/17–11/23 ──────────── 1/1 ┐
│ [儀表]  正常                                  │
│        5/5 服務正常 · 另有 2 筆既有待處理     │
├ 本週 ───────────────────────────────────────┤
│  中斷 0   新問題 0   已解決 0   告警 2        │
├ 服務 ───────────────────────────────────────┤
│  ● altinvest              ● chatxbuy-api      │
│  ● chatxbuy-deploy        ● trustnel-ios …    │
├ 長期未處理 (1) ─────────────────────────────┤
│  ▲ P2 chatxbuy-api  xxxxx…   27 天  ×3        │
│  資安：chatxbuy-api 3 medium／1 low  最久 20天 │
├ 反覆出現 (0) ───────────────────────────────┤
│  本週無                                       │
├ 資安 ───────────────────────────────────────┤
│  ● altinvest ok  ▲ chatxbuy-api warn …        │
└ 2026-11-24 09:12 · th-beacon.vercel.app ──────┘
```

## 8. 分頁規則

先估內容，再決定張數：

- 以「列」為單位估高度：固定區塊（標題、結論、摘要、服務燈號、資安燈號）高度依服務數計算；清單每筆一列。
- 單張高度上限（建議 1600px，實作時依實際渲染微調）。第一張必放：結論、摘要、服務燈號、資安燈號，以及能塞下的清單列。
- 塞不下的清單列順延到第 2 張以後；續頁標題寫「長期未處理（續）」。
- 張數上限 4 張；超過時最後一張末尾寫「另有 N 筆，詳見 dashboard」。
- 清單為空時顯示「本週無」一行，不省略區塊（讓主管確認「有檢查過」）。

分頁是純函式（輸入報告模型，輸出 `Page[]`），可單元測試。

## 9. 架構

```
GET /api/report/weekly  (Bearer CRON_SECRET)
  → 讀取：getServicesOverview / getSecurityView / issues / events / notifications / security_findings
  → buildWeeklyReport(rawData, now)   純函式，src/core/weekly-report.ts
  → paginateReport(report)            純函式，同上
  → renderReportPage(page) × N         ImageResponse → ArrayBuffer
  → sendReport(images, text)           bot 或 webhook，multipart 上傳
```

- **新 route** `app/api/report/weekly/route.ts`：`runtime = 'nodejs'`；驗證沿用 `app/api/poll/services/route.ts:12` 的 `bearerMatches` 寫法（抽成共用或照抄皆可，由實作者決定）。
- **預覽模式**：`?preview=1&page=0` 時不發 Discord，直接回該頁 PNG；同樣要 Bearer。可選 `?now=<ISO>` 覆寫時鐘以預覽特定週。
- **純函式** `src/core/weekly-report.ts`：時間窗推算（台北時區）、結論判定、清單篩選排序、資安聚合、分頁。禁 I/O 與 `Date.now`。
- **渲染** `src/report/`：tokens、字型載入、每區塊的 JSX 元件、`renderReportPage`。
- **Discord 附件**：
  - bot：`src/notify/discord-bot.ts` 新增送檔方法（例如 `postFiles(channelId, body, files)`），走 multipart `payload_json` + `files[n]`；不能沿用寫死 json content-type 的 `requestRaw`。
  - webhook：`src/notify/discord.ts` 新增對應函式。
  - 逾時從 5 秒放寬（附件較大，建議 20 秒）。
  - 一則訊息附全部圖片；訊息文字放一句結論 + dashboard 連結（圖片載不出來時仍有資訊）。
- **頻道**：**使用者決定：發到既有告警頻道**（bot：`DISCORD_ALERT_CHANNEL_ID`；webhook：`DISCORD_WEBHOOK_URL`）。不新增頻道設定變數。
- **排程** `vercel.json` 新增一條 cron。
- **`maxDuration`**：先設 60 秒，以線上實跑（含冷啟動、中文字型載入、多張渲染）實測後再調。（設計者決定）

**上線前確認**：bot 在告警頻道需有「附加檔案（Attach Files）」權限，否則上傳會 403。只能實際發一次確認。

## 10. 失敗處理

- 資料查詢失敗：route 回 500，不發半份週報。
- 渲染失敗：改發純文字版週報（結論 + 各清單筆數 + dashboard 連結），並在訊息標明「圖片產生失敗」。避免主管以為「沒消息＝正常」。
- Discord 發送失敗：route 回 500，錯誤寫 log。不重試（Vercel cron 不自動重跑；人工可帶 Bearer 重打 route）。
- 週報本身不經 issue 管線、不寫 `notifications` 表（它不是告警）。

## 11. 外部事實查證

2026-11-25 查官方文件：

| 事項 | 結論 | 來源 |
|---|---|---|
| `ImageResponse` 在 Node.js runtime route handler 可用 | 已確認 | https://vercel.com/docs/og-image-generation |
| 字型傳入格式 `{name, data: ArrayBuffer, weight, style}`；支援 ttf／otf／woff | 已確認（woff2 未確認，不用） | https://nextjs.org/docs/app/api-reference/functions/image-response |
| CSS：只保證 flexbox，grid 不支援 | 已確認（新版 Satori 有 grid，next/og 內附版本未確認） | 同上；https://github.com/vercel/satori |
| 500KB 打包上限（JSX＋字型＋圖片） | 文件有寫；是否適用 Node runtime **未確認**。中文字型必超過，實作第一步就以預覽模式在線上驗證 | https://vercel.com/docs/og-image-generation |
| `await res.arrayBuffer()` 取得 PNG bytes | **未確認**（`ImageResponse` 繼承 `Response`，推論可行），單元／預覽時實測 | — |
| Discord multipart：`payload_json` + `files[n]`；`attachments[].id` 對應 n；每個 part 需 filename 且不重複 | 已確認 | https://docs.discord.com/developers/reference |
| bot Create Message 與 Execute Webhook 都支援附件 | 已確認 | https://docs.discord.com/developers/resources/message 、…/resources/webhook |
| embed 可用 `attachment://filename` 引用 png | 已確認 | https://docs.discord.com/developers/reference |
| 單則訊息附件數上限 | **未確認**（常見說法 10）；本設計上限 4 張，不受影響 | — |
| 請求大小上限 25 MiB（整個請求） | 已確認；單檔上限未確認。1200px 寬 PNG 預估遠小於此 | https://docs.discord.com/developers/resources/message |
| Hobby cron：每天最多一次，每週一次符合；每專案上限 100 個；精度 ±59 分鐘 | 已確認（每週一次為依規則推論） | https://vercel.com/docs/cron-jobs/usage-and-pricing |
| Vercel 將 Cron Jobs 標為 legacy，未來遷往 Schedules | 已確認；本設計仍用 `vercel.json` cron（與既有輪詢一致） | 同上 |

**若 500KB 上限在 Node runtime 也成立**：退路是字型改在執行時從自家來源讀取（例如 Supabase Storage 公開 bucket 的字型檔），不送任何內容字元到外部。實作者遇到時回報，不要自行改成 Google Fonts。

## 12. 測試

- `src/core/weekly-report.ts`：Vitest 單元測試。涵蓋時間窗（含跨月、台北時區邊界）、三級結論、長期／反覆清單篩選與排序、資安聚合、分頁（空清單、剛好滿頁、超過 4 張截斷）。
- Discord multipart：以注入的 `fetch` 驗證 body 格式（`payload_json` 與 `files[n]` 欄位、`attachments` 對應）。
- 渲染：不寫快照測試。以預覽模式實際產生 PNG 目視驗收。
- 實跑驗收：以預覽模式打線上資料產生圖片確認版面；再對 Discord 實發一次。

## 13. 留給實作者的決定

- 抽共用 `bearerMatches` 還是照抄。
- 渲染元件的切分方式、各區塊實際高度數字、單張高度上限的最終值。
- 訊息摘要的截斷長度。
- 清單篩選要在 SQL 端還是撈回來後在純函式內做（資料量小，兩者皆可；純函式內做比較好測）。
