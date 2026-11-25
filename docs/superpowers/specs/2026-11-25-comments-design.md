# Issue 與資安發現留言（comments）設計

日期：2026-11-25

## 意圖

Issue 與資安發現目前只有狀態，沒有任何文字紀錄；`issues.resolved_by/at` 每次轉換都覆寫，reopen 後前一次「誰、為什麼」解決就消失。新增留言讓人能在 issue／發現上留下說明，並在 close（= `resolved`）時順手寫下處置，且這段 close 留言要同步到 Discord 討論串，讓看 Discord 的人也知道怎麼處理的。

## 目標

1. Issue 詳情頁（`app/issues/[id]/page.tsx`）可留多則留言，依時間排序顯示。
2. `/security` 每條資安發現（`security_findings` 一列）可留多則留言。
3. 把 issue 改成 `resolved`、或把資安發現 Close（→ `resolved`）時，可選填留言；不填照舊直接轉換。
4. Issue 的 close 留言併入既有的 Discord「已解決」討論串回覆（`buildResolveReply`），不另發一則。

## 非目標

- 留言編輯、刪除（第一版只增不改；**builder 決定之外的我方決定**，見「已定的取捨」）。
- 一般留言（非 close 時）同步 Discord。
- Discord 端按「解決」時填留言（不做 modal；想附留言就從 dashboard resolve）。
- 資安發現的留言／close 留言發 Discord（資安 spec 反目標：不進告警管線、不發 Discord）。
- acknowledged／ignored／reopen 時填留言。
- 留言 Realtime 推送、@mention、Markdown 渲染、附件。
- 狀態轉換歷史表（本設計只記「這則留言是 close 時寫的」，不補完整 audit trail）。

## 反目標

- 資安留言不得混進 issue 的表或查詢（資安 spec §反目標：資安資料不得混入 issue）。
- 留言內容不得能在 Discord 觸發 mention 或偽連結。
- 狀態轉換失敗（不存在、狀態已被別人改）時不得留下孤兒留言。

## 限制

- 新表走 RLS deny-by-default、無 policy，讀寫一律 server-side service_role（同既有慣例）。
- 寫入只經 server action，一律 `requireUser()`；作者記 `user.email`。
- 輸入驗證為 `src/core/` 純函式（trim、空字串視為「沒填」、長度上限）。
- Schema 變更走 `supabase migration new` → `db push` → advisors → `pnpm db:types`。
- `transitionIssue` 仍是 issue 狀態轉換唯一出口；改簽章須顧及 poll／heartbeat／Discord 呼叫端（都不帶留言）。

## Approaches（已選 A）

- **A. 兩張表 `issue_comments`、`security_finding_comments`（採用）**：各自 FK + `on delete cascade`，欄位同構，前端共用留言元件、store 各一組。符合資安隔離反目標。
- B. 一張 `comments` 表＋兩個 nullable FK 擇一（check constraint）：一套 store，但查詢要分流，且把 issue 與資安混同一表，抵觸隔離反目標。
- C. 多型 `(target_type, target_id)`：DB 無法保證引用完整，刪除留孤兒。否決。

## 資料模型

兩表欄位相同（以 `issue_comments` 為例）：

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | uuid pk default gen_random_uuid() | |
| `issue_id` | uuid not null references issues(id) on delete cascade | 資安表為 `finding_id references security_findings(id)` |
| `author` | text not null | 登入者 email |
| `body` | text not null，check 長度 1..上限 | |
| `kind` | text not null check in ('comment','resolve') | `resolve` = close 時寫的 |
| `created_at` | timestamptz not null default now() | |

索引：`(issue_id, created_at)`／`(finding_id, created_at)`。

## 行為

### Issue

- 詳情頁新增留言區：列表（作者、時間、內文，`kind='resolve'` 標「解決時備註」）＋新增留言表單。新增走新的 server action，成功後 `revalidatePath`。
- 狀態按鈕中的 `resolved`（Close）改為兩段式：點下後就地展開選填 textarea 與兩顆按鈕 `[確認關閉] [略過]`、外加取消。「略過」＝不帶留言直接關閉；「確認關閉」textarea 空白時等同略過。其他狀態按鈕維持一鍵。資安頁 Close 同一互動，共用同一元件。

```
[ 標記為 resolved ]  →  ┌ 備註（選填）──────────┐
                        └───────────────────────┘
                        [確認關閉] [略過] [取消]
```
- `changeIssueStatusAction` 多收選填留言 → 傳進 `transitionIssue` 的 options（如 `resolveNote`）。
- `transitionIssue`：`store.transitionIssueStatus` 回 `changed` 後，若 `to==='resolved'` 且有 note，**先寫入 `issue_comments`（kind=resolve）**，再進 followUp；`buildResolveReply` 帶入 note，附在既有回覆內文後。`not_found`／`unchanged` 時不寫留言（action 照舊回錯或靜默）。
- 狀態轉換與留言為兩次獨立寫入（不做 RPC/transaction）。留言寫入失敗：狀態不回滾，記 error；action 回傳新狀態「已關閉，但留言未儲存」讓 UI 明示（資安 action 的 state union 同步新增）；Discord 回覆仍發但不含 note（以 DB 為準，避免 Discord 有、dashboard 沒有）。
- Discord 內容：note 只用在 manual 分支（poll／heartbeat 自動恢復的固定文字不變）；以引用區塊 `> 備註：…` 附在既有回覆後（多行每行加 `> `）。沿用 `allowed_mentions: { parse: [] }` 擋 mention，套用既有偽連結中和（`lifecycle-message.ts:126` 一帶，必要時 export）；整則超過 Discord 2000 字元時截斷 note 並標「…（全文見 dashboard）」。
- Discord 同步前提：bot 模式且該事故有根訊息。線上已是 bot 模式（2026-11-25 查 `notifications` 近 14 天有 `resolve_reply` 且帶 message id）；無根訊息時 note 只存 DB，可接受。

### 資安發現

- `/security` 發現列表每列（`page.tsx:85` 一帶的 `<li>`）可展開留言串（如 `<details>`，summary 顯示留言數），含新增表單。留言於頁面載入時一次批次查回（`finding_id in (...)`）再分組，不做展開時才載入。
- Close 按鈕（`finding-actions.tsx`）改為上述兩段式互動；`setFindingStatusAction` 多收選填留言，條件更新成功後才寫 `security_finding_comments`（kind=resolve）。不發 Discord。
- 錨點用 `security_findings.id`（跨掃描穩定）。已知：`key_fallback=true` 的發現會把不同問題合成同一列，留言可能跨問題——接受，不處理。

## 已定的取捨（我方決定，可推翻）

- 只有 close（resolved）可附留言；其他轉換不加。
- 不提供編輯／刪除。
- 長度上限 2000 字元（DB check 與純函式驗證一致）。
- 不做 Realtime，靠 `revalidatePath`。
- Discord 解決按鈕維持一鍵，不加 modal。
- `author`：`user.email ?? user.id`（與資安 action 現行一致）。
- 一般留言（隨時可留）與 close 留言並存；只有 close 留言同步 Discord。

## 留給 builder

- 元件拆分、表單用 `useActionState` 或一般 form action、textarea 的展開互動與樣式（沿用既有 trading-stream 像素視覺）。
- store port 介面命名與放置。
- 測試：純函式驗證單元測試；transitionIssue 帶 note 的行為（含 unchanged 不寫留言）；整合測試覆蓋 cascade 與 check constraint。
