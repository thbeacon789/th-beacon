# AI 判級準確率與花費統計頁 — 設計

日期：2026-11-11
前作：`2026-10-23-e2e-failure-ai-triage-design.md`（CI 端判讀）、`2026-10-27-ai-severity-triage-design.md`（伺服器端判讀）

## 1. 為什麼

AI 判級已經上線（伺服器端判級＋各專案 CI 的 e2e 失敗診斷），但目前有兩件事看不到：

1. **AI 判得準不準**：沒有任何回饋，無從決定要不要換 model、怎麼調 prompt。
2. **AI 花了多少錢**：token 用量只印在 log（`src/triage/claude.ts:71-72`、`scripts/diagnose-e2e-failure.sh:229`），沒有存。之後 CI 還會讓 AI 自動開 PR，花費只會增加。

使用者要用這個頁面做三件事（都要）：
- 判斷要不要換 model 或調整 prompt
- 找出哪些服務常被 AI 判錯
- 向主管回報成本

## 2. 目標／非目標／反目標

**目標**
- 負責人在 issue 詳情頁替每次 AI 判定標記「嚴重度對不對」與「類型對不對」，判錯時填正確答案。
- 記錄每次 AI 呼叫的用量與花費，來源包括伺服器端判級、CI 的 e2e 診斷，以及未來 CI 的 AI 開 PR。
- 新增一個統計頁，一頁看完準確率與每月花費。

**非目標**
- 不實作「CI 由 AI 開 PR」的流程本身，只定好回報格式，讓它日後照格式回報。
- 不回補歷史資料：花費從上線起才有紀錄；上線前的判定沒有標記，不列入準確率。
- 不強制標記：resolve／ignore 不會因為沒標記被擋下。
- 不做人工改 issue 等級（沿用 ratchet 規則，見 `app/issues/[id]/page.tsx:107`）。

**反目標（技術上能動但算失敗）**
- 記錄用量失敗（寫入出錯或回報端點掛掉），導致判級、告警或 CI 失敗。用量紀錄只能是旁路（失敗就吞掉並記 log），不能擋主流程。
- 重新判級後，舊判定的標記被新判定覆蓋或誤套到新判定上。
- 準確率只顯示百分比，不顯示樣本數。只標了 2 筆就寫 100% 會誤導判斷。
- 改 symlink 共用的 script 後，已接入的 repo 壞掉。新參數一律選填，沒設就維持現在的行為。

## 3. 已定的部分（使用者拍板）

### 3.1 標記

- 地點：**issue 詳情頁**（`app/issues/[id]/page.tsx`），放在 AI 判定區塊旁。這是負責人平常改狀態的地方。
- **嚴重度與類型分開標**，各自有「判對／判錯」兩個選項。
- **判錯時必須選正確答案**：嚴重度選 P0／P1／P2，類型選 env（環境問題）／app（app 問題）。
- 標記可以改，以最後一次為準。
- **伺服器端判級與 CI 端 e2e 診斷的判定都要能標記**，兩者都列入準確率。
- 標記綁定「某一次判定」，不綁 issue。issue 重新判級後，舊判定的標記保留在舊判定上，新判定顯示為「尚未標記」。
- 只有成功產出 severity＋category 的判定可以標記。AI 判讀失敗、被略過或 AI 停用時沒有判定可標，也不列入統計。
- **合併規則**：同一個 issue 收到新判定時（例如同一個 e2e 測試每天失敗，CI 每天送一次診斷；或伺服器端重新判級），如果嚴重度和類型都跟該 issue 的上一筆判定相同，就併進上一筆，沿用原本的標記，不新增判定。只要有一項不同，就新增一筆判定，顯示為「尚未標記」。伺服器端在冷卻期內沿用舊結果（`decision.kind === 'reuse'`）本來就不算新判定。這條規則確保同一個壞掉的測試不會灌水準確率，負責人也不必每天重標。

### 3.2 花費

- 來源要涵蓋：伺服器端判級、CI 的 e2e 診斷，以及未來 CI 的 AI 開 PR。
- CI 端用量回報走**新的專用端點**（暫名 `POST /api/ai-usage`），沿用每個服務現有的 HMAC 金鑰與 header（`X-Beacon-Service`／`X-Beacon-Timestamp`／`X-Beacon-Signature`，簽章方式同 `docs/api.md`）。不塞進 heartbeat，因為開 PR 不一定搭配心跳。
- `scripts/diagnose-e2e-failure.sh` 呼叫完 AI 後打這個端點回報用量。

### 3.3 統計頁（版面 A：一頁看完）

導覽列（`src/web/nav.tsx`）新增一項，路徑與名稱由 builder 決定（例如 `/ai-stats`、`AI Stats`）。需登入（`requireUser()`），讀取模式同其他頁面（server component＋service_role）。

由上往下：

1. **四個數字**：本月花費、嚴重度準確率、類型準確率、標記率（已標記判定數／可標記判定數）。準確率旁邊要顯示樣本數（例如「43／50 已標記」）。
2. **每月趨勢**：長條是每月花費，折線是嚴重度和類型準確率。不同 model 的準確率分開畫線。準確率按「判定發生月份」歸類，不按標記月份，這樣換 prompt 或 model 前後的差異才看得出來。
3. **判太嚴／判太鬆**：在判錯的案例裡統計 AI 與正確答案的差異。嚴重度要分出「判太高」（例如判 P0、應為 P1）和「判太低」的次數，最好能看到 AI 判的級別 × 正確級別的對照（3×3）。類型要分出 env→app、app→env 各幾次。
4. **各服務表格**：判定數、已標記數、嚴重度準確率、類型準確率、花費。依嚴重度準確率由低到高排列。

花費也要能依來源拆開（伺服器判級／CI 診斷／CI 開 PR），放在哪一區由 builder 決定。

**視覺**
- 圖表套件用 **Recharts**，版本與 `~/Code/trustnel/apps/admin` 相同（`recharts@^3.9.1`）。Recharts 是 client component，資料在 server 端算好再當 props 傳進去。
- 顏色只用 th-beacon 現有 tokens（`app/globals.css`）：`--gold` 花費、`--green` 嚴重度準確率、`--pink` 類型準確率，`--lilac`／`--yellow` 給其他系列，格線與框線用 `--line`，文字用 `--fg`／`--fg-muted`。沿用 trading-stream 像素風格，不另外引入配色。
- 版面草圖：`.superpowers/brainstorm/19378-1794373974/content/layout.html` 的選項 A。

## 4. 現況（builder 需要知道的）

- **伺服器端判級**：`src/triage/claude.ts:46-72` 呼叫 Messages API，`message.usage` 已經拿到，但只 console.log 並放進 `TriageCallResult.usage`，`src/pipeline/process-and-notify.ts:164-186` 沒用到。結果寫入 `issues.ai_*` 七欄（`supabase/migrations/20261027120000_ai_triage.sql`），重新判級會覆蓋。
- **CI 端診斷**：`scripts/diagnose-e2e-failure.sh` 用 curl 呼叫 Messages API（:224-229），model 預設 `claude-sonnet-5-5`，可用 `DIAGNOSE_MODEL` 覆寫。結果經 `scripts/heartbeat-to-beacon.sh` 的第 5 個參數送到 `/api/heartbeat` 的 `diagnosis` 欄位，在 `src/core/heartbeat.ts:88-107` 轉成 event 的 `severity` 和 `metadata.diagnosis`。依 2026-10-27 spec，event 已帶 severity 時伺服器端**不再呼叫** Claude，所以一個 issue 的判定來源通常只有一種。
- **symlink 共用**：`skills/onboarding-th-beacon/scripts/` 內的三支 script 和 `api-reference.md`（→ `docs/api.md`）都 symlink 到其他 repo 使用。改 script、新增端點時要同步更新 `docs/api.md` 與 skill 說明。
- **單價**：目前沒有任何地方存單價。2026-10-27 spec §5 的估算為 Sonnet 5.5 $2／$10 per MTok，**未確認**，實作時要用 claude-api skill 或官方價目查證。

## 5. 撰寫者的判斷（使用者未逐條確認，可推翻）

- **判定的 model**：CI 診斷的 heartbeat payload 已有 `diagnosis.model`（`docs/api.md` heartbeat 一節），直接拿來用；缺值時記為 null，統計頁另列為「未知 model」。
- **用量與判定不互相關聯**：用量（`/api/ai-usage`、伺服器端呼叫紀錄）和判定是兩份資料，各自統計。花費依月份／服務／來源／model 加總，準確率依判定計算，不需要 request id 互相對應。
- **issue 詳情頁只顯示並標記「目前這筆」判定**。被新判定取代的舊判定保留在資料庫並列入統計，但頁面上不提供補標（有了合併規則，取代的情況會很少）。
- **標記驗證**：選「判錯」時，正確答案不能跟 AI 的答案相同，server action 要拒絕。
- **標記率分母**：所有可標記的判定，不論 issue 狀態（open／resolved 都算）。
- **未登記單價的 model**：照常記錄 tokens，金額記為 null，統計頁的花費要標示「有 N 筆未定價」，不能悄悄當成 0。
- **`/api/ai-usage` 一次回報一筆**，沿用 HMAC 與時間戳記檢查（同 ingest 的 replay 防護），不需要另外登記名稱。

## 6. 留給 builder 決定

- 資料表怎麼切。可以把每次判定獨立成一張表（含來源 server／ci、severity、category、model、時間、issue），標記掛在它上面；用量可以另開一張表，或和判定共用。只要滿足 §3.1「標記綁判定、不被重判覆蓋」和 §3.2 的來源分類即可。
- 金額怎麼算：存 tokens 再用單價常數換算，或寫入時就算好金額存起來。考量：單價會變，歷史金額應以當時的單價為準。未來的開 PR 流程若能直接拿到美元金額（例如 Claude Code 的輸出，**未確認**），端點也要接受直接回報金額。
- `/api/ai-usage` 的 payload 欄位細節、驗證方式與回應碼。要寫進 `docs/api.md`。
- CI 診斷的判定怎麼對應到 issue（從 heartbeat 進來的 event 會 upsert 成 issue，判定紀錄要能對到那筆 issue）。
- 統計邏輯放 `src/core/`，必須是純函式（禁 I/O、禁 Date.now，時間由參數注入），並寫單元測試。
- 標記 UI 的互動細節（按鈕、下拉、即時更新或 revalidate）。寫入一律走 server action 並經 `requireUser()`；要不要記錄標記人由 builder 決定。
- migration 流程照 CLAUDE.md：`supabase migration new` → `db push` → advisors → `pnpm db:types`。新表要啟用 RLS 且不加 policy。
