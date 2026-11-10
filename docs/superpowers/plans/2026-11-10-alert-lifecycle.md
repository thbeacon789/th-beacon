# 告警生命週期 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discord 告警附「確認／已解決」按鈕，任何頻道成員可按；手動與自動 resolve 走單一出口並更新原訊息；復發以「回覆」掛回上一則告警。

**Architecture:** 狀態轉換收斂到 `transitionIssue`（pipeline），它寫 DB（含 actor／時間）並產生「根訊息」的編輯；Discord 訊息的變形全是 `src/notify/lifecycle-message.ts` 的純函式，作用在存進 `notifications.payload` 的原訊息上。Bot 模式（`DISCORD_BOT_TOKEN` 等四變數齊全）才有按鈕／編輯／回覆；否則完全沿用現行 webhook 路徑。按鈕回呼由新 route `app/api/discord/interactions` 驗 Ed25519 後同步改 DB、回 type 7，其餘工作 `after()`。

**Tech Stack:** Next.js App Router（route handler、`after` from `next/server`）、Supabase Postgres（migration + rpc）、Discord REST API v10、Node `crypto`（ed25519）、Vitest。

**Spec:** `docs/superpowers/specs/2026-11-10-alert-lifecycle-design.md`

## Global Constraints

- `src/core/**` 純函式：禁 I/O、禁 `Date.now`，時鐘由參數注入。
- Schema：`supabase migration new <name>` → 編 SQL → `supabase db push`（線上）→ MCP `get_advisors`（security）→ `pnpm db:types`。禁 MCP `apply_migration`；禁 `pnpm dev`；`pnpm test:integration` 只能對本地 stack。
- 新環境變數名稱固定：`DISCORD_BOT_TOKEN`、`DISCORD_PUBLIC_KEY`、`DISCORD_APPLICATION_ID`、`DISCORD_ALERT_CHANNEL_ID`。任一缺 → bot 模式關閉，行為與今天相同。
- 所有 Discord 送出／編輯一律帶 `allowed_mentions`；只有告警（含復發、升級、冷卻重發）可 `users: [owner]`，其餘（編輯、解決回覆）`{ parse: [] }`。
- Discord 呼叫失敗不得讓狀態轉換、ingest、cron 失敗：DB 是真相，Discord 是投影。
- 按鈕 `custom_id` 格式：`ack:<issueId>:<incidentSeq>`、`resolve:<issueId>:<incidentSeq>`。
- actor 儲存格式（`acknowledged_by`／`resolved_by`）：Discord → `discord:<userId>`；dashboard → 使用者 email；系統 → `null`。
- Interaction 初始回應 3 秒內；同步段只做「驗簽 → 一次條件式 UPDATE → 組訊息」。
- 文案（逐字）：按鈕「✋ 確認」「✅ 已解決」；確認欄位名「✋ 已確認」值 `<@id>（<ISO 時間>）` 或 email；解決標題前綴「✅ 已解決」；解決欄位名「處理方式」值 `手動：<@id>`／`手動：<email>`／`自動恢復（輪詢）`／`自動恢復（心跳）`；解決回覆內文 `✅ 已解決` 或 `✅ 已自動恢復`；復發欄位名「🔁 已復發」值 `第 N 次 → 見最新回覆`；忽略標題前綴「🚫 已忽略」；過期按鈕 ephemeral「此告警已過期，請看最新一則」；重複確認 ephemeral「已由 <actor> 確認」。
- commit 用明確路徑 `git add`，禁 `git add -A`；不 push。

## Review Focus

1. **同一顆按鈕被兩人幾乎同時按**：只有一人寫入成功，另一人拿到 ephemeral「已由 … 確認」，不得雙寫 actor。→ Task 2 `transitionIssueStatus` 條件式 UPDATE 測試＋ Task 7 route 測試。
2. **舊事故訊息上的按鈕在復發後被按**（編輯失敗沒移除按鈕）：`incidentSeq` 不符 → ephemeral 過期提示，不改 DB。→ Task 7。
3. **Discord API 在解決時 5xx／逾時**：issue 照樣 resolved、健康度照樣重算。→ Task 5。
4. **Bot 模式關閉（env 缺一）**：通知走 webhook、無 components，現有 412 測試全綠。→ Task 6。
5. **確認後同 issue 持續湧入事件**：不 tag、不發新訊息，計數編輯至多每 30 分鐘一次。→ Task 6。

---

### Task 1: Schema — 生命週期欄位、事故序號、通知 Discord 紀錄

**Files:**
- Create: `supabase/migrations/<timestamp>_alert_lifecycle.sql`
- Modify: `src/db/database.types.ts`（`pnpm db:types` 產生，勿手改）

**Interfaces:**
- Produces（DB）：
  - `issues` 新欄：`acknowledged_at timestamptz`、`acknowledged_by text`、`resolved_at timestamptz`、`resolved_by text`、`reopen_count int not null default 0`、`incident_first_seen timestamptz`、`incident_count int not null default 1`。回填：`incident_first_seen = first_seen`、`incident_count = count`，然後 `incident_first_seen` 設 `not null`。
  - `notifications` 新欄：`kind text not null default 'alert' check (kind in ('alert','count_edit','resolve_reply'))`、`incident_seq int not null default 0`、`discord_channel_id text`、`discord_message_id text`、`payload jsonb`。索引 `(issue_id, incident_seq, sent_at)`。
  - `upsert_issue_with_event`：`create or replace`，簽名與回傳不變。衝突更新時：若舊 status = `'resolved'` → `reopen_count = reopen_count + 1`、`incident_first_seen = p_occurred_at`、`incident_count = 1`、清空 `acknowledged_*`／`resolved_*`；否則 `incident_count = incident_count + 1`。新建時 `incident_first_seen = p_occurred_at`。

- [ ] **Step 1:** `supabase migration new alert_lifecycle`，寫入上述 DDL；`upsert_issue_with_event` 以 `supabase/migrations/20261027120000_ai_triage.sql:17-79` 為底改寫，保留 `security invoker`、`set search_path = ''`、只 grant `service_role`。
- [ ] **Step 2:** 本地驗證：`supabase start && supabase db reset`，Expected：無錯誤。再 `psql` 或 `supabase db` 對本地呼叫 rpc 兩次（第二次前把 status 改 resolved），Expected：`reopened=true`、`reopen_count=1`、`incident_count=1`。
- [ ] **Step 3:** `supabase db push`；MCP `get_advisors` security，Expected：與改動前相同（只有既有 `rls_enabled_no_policy` INFO 與 leaked password WARN）。
- [ ] **Step 4:** `pnpm db:types`；`pnpm typecheck`，Expected：PASS（新欄位可空或有預設，不破壞既有 insert）。
- [ ] **Step 5:** Commit migration 與 `src/db/database.types.ts`。

### Task 2: Store — 新欄位映射與生命週期查詢

**Files:**
- Modify: `src/store/contracts.ts`、`src/store/mapping.ts`、`src/store/memory.ts`、`src/store/supabase.ts`
- Test: `tests/store/memory.test.ts`、`tests/store/mapping.test.ts`；既有 fixture 補新欄位

**Interfaces:**
- Produces（`src/store/contracts.ts`）：
  ```ts
  // StoredIssue 新增
  acknowledgedAt: string | null; acknowledgedBy: string | null
  resolvedAt: string | null; resolvedBy: string | null
  reopenCount: number; incidentFirstSeen: string; incidentCount: number

  export type NotificationKind = 'alert' | 'count_edit' | 'resolve_reply'
  // NotificationRecord 新增
  kind: NotificationKind; incidentSeq: number
  discordChannelId: string | null; discordMessageId: string | null
  payload: DiscordMessage | null

  export interface IncidentRoot { channelId: string; messageId: string; payload: DiscordMessage }

  // Store 新增
  getIncidentRoot(issueId: string, incidentSeq: number): Promise<IncidentRoot | null>
  transitionIssueStatus(issueId: string, to: IssueStatus, allowedFrom: readonly IssueStatus[], actor: string | null, nowIso: string): Promise<{ issue: StoredIssue; changed: boolean } | null>
  findActiveIssueIds(serviceId: string, match: { fingerprint: string } | { errorType: 'health_check_failed' }): Promise<string[]>
  // 改簽名
  getLatestSentNotification(serviceId: string, fingerprint: string, incidentSeq: number): Promise<LatestNotification | null>
  ```
- `getIncidentRoot`：該 issue、該 seq、`kind='alert'`、`status='sent'`、`discord_message_id is not null` 中 `sent_at` 最早的一筆。
- `getLatestSentNotification`：只看 `kind in ('alert','count_edit')` 且同 `incident_seq`。
- `transitionIssueStatus`：單一條件式 UPDATE（`where id = ? and status in allowedFrom`）；`to='acknowledged'` 寫 `acknowledged_at/by`；`to='resolved'` 寫 `resolved_at/by`；`to='open'` 清空四欄。issue 不存在回 `null`；存在但 status 不在 allowedFrom 回 `{ issue: 現況, changed: false }`。
- `resolveHealthCheckIssue`、`resolveIssueByFingerprint`、`updateIssueStatus` 此 task **保留**（Task 5 才移除）。

- [ ] **Step 1: 失敗測試**（memory store）：
  - `transitionIssueStatus ack 從 open 成功並記 actor`：`changed=true`、`acknowledgedBy='discord:111'`、`acknowledgedAt=nowIso`。
  - `transitionIssueStatus 第二次 ack 回 changed=false 且不覆寫 actor`：第二次 actor `'discord:222'`，結果 `acknowledgedBy` 仍 `'discord:111'`。
  - `transitionIssueStatus 不存在的 issue 回 null`。
  - `reopen 時 reopenCount+1、incidentCount=1、清空 ack/resolved`（經 `upsertIssueWithEvent` 兩次，中間 resolve）。
  - `getLatestSentNotification 只看同 incidentSeq 的 alert/count_edit`：seq 0 有 alert、seq 1 無 → 查 seq 1 得 `null`；`resolve_reply` 不計。
  - `getIncidentRoot 取最早且有 messageId 的 alert`。
  - `findActiveIssueIds 只回 open/acknowledged`。
- [ ] **Step 2:** `pnpm vitest run tests/store` Expected：FAIL（方法不存在）。
- [ ] **Step 3:** 實作 contracts／mapping（snake↔camel，`payload` 以 `DiscordMessage` 型別轉換）／memory／supabase。supabase 版 `transitionIssueStatus` 用 `.update(...).eq('id').in('status', allowedFrom).select('*')`，0 列時再 `select` 一次判斷是 null 還是 changed=false。現有 `getLatestSentNotification` 呼叫端暫傳 `result.issue.reopenCount`。
- [ ] **Step 4:** `pnpm test && pnpm typecheck` Expected：PASS。
- [ ] **Step 5:** Commit。

### Task 3: 純函式 — 生命週期規則、custom_id、訊息變形

**Files:**
- Create: `src/core/lifecycle.ts`、`src/notify/lifecycle-message.ts`
- Modify: `src/notify/message.ts`（`DiscordMessage` 加 `components?`、`message_reference?`；`buildDiscordMessage` 加 `buttons?: { issueId: string; incidentSeq: number }`）
- Test: `tests/core/lifecycle.test.ts`、`tests/notify/lifecycle-message.test.ts`、`tests/notify/message.test.ts`

**Interfaces:**
- Produces（`src/core/lifecycle.ts`）：
  ```ts
  export type IssueActor =
    | { kind: 'discord'; userId: string }
    | { kind: 'dashboard'; email: string }
    | { kind: 'system'; source: 'poll' | 'heartbeat' }
  export function allowedFrom(to: IssueStatus): readonly IssueStatus[]
  //   acknowledged ← ['open']；resolved ← ['open','acknowledged']；ignored ← ['open','acknowledged','resolved']；open ← ['acknowledged','resolved','ignored']
  export function actorLabel(actor: IssueActor): string | null   // 'discord:<id>' | email | null
  export function displayActor(label: string): string             // 'discord:<id>' → '<@id>'，其餘原樣
  export type ButtonAction = 'ack' | 'resolve'
  export function encodeButtonId(action: ButtonAction, issueId: string, incidentSeq: number): string
  export function parseButtonId(customId: string): { action: ButtonAction; issueId: string; incidentSeq: number } | null
  ```
- Produces（`src/notify/lifecycle-message.ts`，全部純函式、不改輸入物件）：
  ```ts
  export function withAlertButtons(msg: DiscordMessage, issueId: string, incidentSeq: number, actions: readonly ButtonAction[]): DiscordMessage
  export function applyAcknowledged(msg: DiscordMessage, actorLabel: string, atIso: string, issueId: string, incidentSeq: number): DiscordMessage  // 加欄位、只留 resolve 按鈕、去 content、allowed_mentions {parse: []}
  export function applyResolved(msg: DiscordMessage, resolution: { actorLabel: string | null; source: 'manual' | 'poll' | 'heartbeat' }): DiscordMessage  // 綠色 0x2ecc71、標題前綴、處理方式欄位、移除 components、去 content
  export function applyIgnored(msg: DiscordMessage): DiscordMessage   // 灰 0x95a5a6、標題前綴、移除 components、去 content
  export function applyReopened(msg: DiscordMessage, reopenCount: number): DiscordMessage  // 加/取代「🔁 已復發」欄位、移除 components、去 content
  export function applyCount(msg: DiscordMessage, count: number, lastSeen: string): DiscordMessage  // 改「次數」「Last seen」欄位值，其餘不動
  export function buildResolveReply(source: 'manual' | 'poll' | 'heartbeat', replyToMessageId: string): DiscordMessage
  export function buildFollowUpAlert(alert: DiscordMessage, replyToMessageId: string): DiscordMessage  // 保留 content/allowed_mentions 的 tag，移除 components，加 message_reference
  ```
- 按鈕結構：`components: [{ type: 1, components: [{ type: 2, style: 2, label: '✋ 確認', custom_id }, { type: 2, style: 3, label: '✅ 已解決', custom_id }] }]`。
- `message_reference: { message_id: string; fail_if_not_exists: false }`。

- [ ] **Step 1: 失敗測試**：
  - `parseButtonId(encodeButtonId('ack', uuid, 3))` 等於 `{ action: 'ack', issueId: uuid, incidentSeq: 3 }`；`parseButtonId('ack:not-uuid:1')`、`'nuke:<uuid>:1'`、`'ack:<uuid>:-1'`、`'ack:<uuid>'` 皆 `null`；encode 結果長度 ≤ 100。
  - `allowedFrom('acknowledged')` 等於 `['open']`；`actorLabel({kind:'system',source:'poll'})` 為 `null`；`displayActor('discord:123')` 為 `'<@123>'`、`displayActor('a@b.c')` 為 `'a@b.c'`。
  - `applyAcknowledged` 後：無 `content`、`allowed_mentions` 為 `{ parse: [] }`、按鈕只剩 `resolve:` 開頭者、fields 含 `{ name: '✋ 已確認', value: '<@111>（2026-11-10T00:00:00.000Z）' }`；原物件未被改動（`structuredClone` 比對）。
  - `applyResolved({actorLabel:null, source:'poll'})`：color `0x2ecc71`、標題以 `✅ 已解決 ` 開頭、欄位「處理方式」= `自動恢復（輪詢）`、無 `components`。
  - `applyReopened(msg, 2)` 再 `applyReopened(…, 3)`：只有一個「🔁 已復發」欄位，值 `第 3 次 → 見最新回覆`。
  - `applyCount`：「次數」欄位變 `'42'`，其他欄位不變。
  - `buildResolveReply('heartbeat','m1')`：`content` = `✅ 已自動恢復`、`allowed_mentions` `{ parse: [] }`、`message_reference.message_id` = `'m1'`。
  - `buildDiscordMessage({..., buttons})` 有按鈕；不帶 `buttons` 時無 `components` 欄位（webhook 相容）。
- [ ] **Step 2:** `pnpm vitest run tests/core/lifecycle.test.ts tests/notify` Expected：FAIL。
- [ ] **Step 3:** 實作。欄位以 `name` 定位；`applyX` 用 `structuredClone` 後修改。
- [ ] **Step 4:** `pnpm test && pnpm typecheck` Expected：PASS。
- [ ] **Step 5:** Commit。

### Task 4: Discord Bot client 與 server deps 接線

**Files:**
- Create: `src/notify/discord-bot.ts`
- Modify: `src/pipeline/process-and-notify.ts`（只改 `NotifyDeps` 型別）、`src/store/server.ts`
- Test: `tests/notify/discord-bot.test.ts`

**Interfaces:**
- Produces：
  ```ts
  export type BotPostResult = { ok: true; channelId: string; messageId: string } | { ok: false; reason: string }
  export interface DiscordBot {
    post(message: DiscordMessage): Promise<BotPostResult>
    edit(channelId: string, messageId: string, message: DiscordMessage): Promise<SendResult>
  }
  export function createDiscordBot(config: { token: string; channelId: string }, fetchImpl?: typeof fetch): DiscordBot
  // NotifyDeps 新增
  bot?: DiscordBot | null
  ```
- `post`：`POST https://discord.com/api/v10/channels/{channelId}/messages`；`edit`：`PATCH …/channels/{channelId}/messages/{messageId}`；header `Authorization: Bot <token>`、`content-type: application/json`；送出前移除 `username`（webhook 專用）；timeout 5000ms（沿用 `src/notify/discord.ts` 的 `AbortSignal.timeout`）；非 2xx 回 `{ ok:false, reason:'http <status>' }`；例外回 `error.name`。
- `createServerNotifyDeps`：`DISCORD_BOT_TOKEN` 與 `DISCORD_ALERT_CHANNEL_ID` 皆有 → `bot: createDiscordBot(...)`，否則 `bot: null`。另 export `getDiscordInteractionConfig(): { publicKey: string; applicationId: string } | null`（兩者皆有才回）。

- [ ] **Step 0（查證）：** 以 context7 或 https://docs.discord.com/developers/resources/message 確認：Create/Edit Message 的路徑、`message_reference` 欄位、`components` button 結構（type 1/2、style 2/3）、bot 訊息編輯無時效。與上列不符則以文件為準並在 commit message 註明。
- [ ] **Step 1: 失敗測試**（注入 fake fetch）：`post 打對 URL 與 Authorization`、`post 送出的 body 無 username`、`post 回傳 response JSON 的 id 作 messageId`、`edit 用 PATCH`、`http 500 回 ok:false reason 'http 500'`、`fetch throw 回 ok:false`。
- [ ] **Step 2:** `pnpm vitest run tests/notify/discord-bot.test.ts` Expected：FAIL。
- [ ] **Step 3:** 實作。
- [ ] **Step 4:** `pnpm test && pnpm typecheck` Expected：PASS。
- [ ] **Step 5:** Commit。

### Task 5: `transitionIssue` 單一出口，四條 resolve 路徑收斂

**Files:**
- Create: `src/pipeline/transition-issue.ts`
- Delete: `src/pipeline/change-issue-status.ts`（呼叫端改用新函式）、`tests/pipeline/change-issue-status.test.ts`（測試移入新檔）
- Modify: `app/issues/actions.ts`、`src/poll/poll-service.ts:50-58`、`src/heartbeat/handle-heartbeat.ts:62-66,102-112`、`src/store/contracts.ts`／`memory.ts`／`supabase.ts`（移除 `resolveHealthCheckIssue`、`resolveIssueByFingerprint`、`updateIssueStatus`）
- Test: `tests/pipeline/transition-issue.test.ts`、更新 `tests/poll/poll-service.test.ts`、`tests/heartbeat/handle-heartbeat.test.ts`

**Interfaces:**
- Consumes：Task 2 `transitionIssueStatus`、`getIncidentRoot`、`recordNotification`；Task 3 `allowedFrom`、`actorLabel`、`applyAcknowledged/Resolved/Ignored`、`withAlertButtons`、`buildResolveReply`；Task 4 `DiscordBot`。
- Produces：
  ```ts
  export interface TransitionOptions { refreshHealth?: boolean; editRoot?: boolean }  // 皆預設 true
  export interface TransitionResult {
    outcome: 'changed' | 'unchanged' | 'not_found'
    issue: StoredIssue | null
    rootEdit: { channelId: string; messageId: string; payload: DiscordMessage } | null  // 新的根訊息內容；editRoot=false 時由呼叫端自行送出
    followUp: () => Promise<void>   // 健康度重算、解決回覆、Discord 編輯（editRoot=true 時）；已在函式內 await 完，或供 interaction route 交給 after()
  }
  export async function transitionIssue(store: Store, bot: DiscordBot | null, issueId: string, to: IssueStatus, actor: IssueActor, now: Date, options?: TransitionOptions & { deferFollowUp?: boolean }): Promise<TransitionResult>
  ```
  - `deferFollowUp` 預設 false：函式內直接 `await followUp()`；true 時不執行、交給呼叫端。
  - `followUp` 內：`refreshHealth` → `refreshServiceHealth`；bot 存在且有根訊息時：`editRoot` → `bot.edit(rootEdit)`；`to==='resolved'` → `bot.post(buildResolveReply(...))` 並 `recordNotification({kind:'resolve_reply', ...})`。每個 Discord 呼叫各自 try/catch，失敗只 `console.error`。
  - 根訊息變形：acknowledged → `applyAcknowledged`；resolved → `applyResolved`（source 由 actor 推：system→poll/heartbeat，其餘 manual）；ignored → `applyIgnored`；open → `withAlertButtons(…, ['ack','resolve'])`。
  - 根訊息取 `getIncidentRoot(issue.id, issue.reopenCount)`。
- 呼叫端：
  - `app/issues/actions.ts`：actor `{ kind:'dashboard', email: user.email }`（`requireUser()` 回傳值；若無 email 用 `'dashboard'`），bot 取 `createServerNotifyDeps().bot ?? null`。
  - poll：`findActiveIssueIds(service.id, { errorType:'health_check_failed' })` 逐一 `transitionIssue(..., 'resolved', {kind:'system',source:'poll'}, now, { refreshHealth: false })`；`outcome.healthIssueResolved` = 任一 `changed`；既有 `refreshServiceHealth` 呼叫保留。
  - heartbeat：三個 fingerprint 同上（source `'heartbeat'`），既有 `refreshServiceHealth` 保留。

- [ ] **Step 1: 失敗測試**（`InMemoryStore` ＋ fake `DiscordBot` 記錄 post/edit）：
  - `ack 從 open：changed、DB 記 actor、bot.edit 收到含「✋ 已確認」的 payload`。
  - `第二次 ack：unchanged、bot 不被呼叫`。
  - `resolved（system/poll）：bot.edit 收到綠色 payload 且 bot.post 收到「✅ 已自動恢復」回覆；notifications 多一筆 kind resolve_reply`。
  - `沒有根訊息（從未成功送出）：只改 DB，bot 完全不被呼叫`。
  - `bot.edit reject：outcome 仍 changed、健康度已重算`（Review Focus 3）。
  - `bot 為 null：行為等同舊 changeIssueStatus`。
  - `editRoot=false：rootEdit 有值但 bot.edit 未被呼叫`；`deferFollowUp=true：回傳後 refreshServiceHealth 尚未被呼叫，呼叫 followUp() 後才有`。
  - poll／heartbeat 既有「恢復即 resolve」測試改斷言 issue `status='resolved'` 且 `resolvedBy=null`。
- [ ] **Step 2:** `pnpm vitest run tests/pipeline/transition-issue.test.ts` Expected：FAIL。
- [ ] **Step 3:** 實作並改四個呼叫端、移除三個舊 store 方法與其測試。
- [ ] **Step 4:** `pnpm test && pnpm typecheck` Expected：PASS；`grep -rn "resolveHealthCheckIssue\|resolveIssueByFingerprint\|updateIssueStatus\|changeIssueStatus" src app tests` Expected：無結果。
- [ ] **Step 5:** Commit。

### Task 6: 告警發送走 bot：按鈕、跟進回覆、確認後靜默、復發回覆、復發重新判級

**Files:**
- Modify: `src/pipeline/process-event.ts`（`ProcessResult` 加 `reopened: boolean`；`applyTriage` 復發處理）、`src/pipeline/process-and-notify.ts`（`safeNotify`／`notifyStage`）
- Test: `tests/pipeline/process-and-notify.test.ts`、`tests/pipeline/process-event.test.ts`

**Interfaces:**
- Consumes：Task 2–5 全部。
- `applyTriage` 變更：
  - `event.severity` 分支：`reopened` 時 `final = event.severity`（不 ratchet）。
  - 規則評估改傳 `{ ...issue, count: issue.incidentCount, firstSeen: issue.incidentFirstSeen }` 給 `evaluateSeverity`。
- `notifyStage` 決策（`deps.bot` 為 null → 完全走現行 webhook 路徑，只是 `getLatestSentNotification` 多傳 `issue.reopenCount`）：
  1. `seq = issue.reopenCount`；`lastSent = getLatestSentNotification(serviceId, fingerprint, seq)`；`shouldNotify` 不變。
  2. 不通知 → 照舊回傳。
  3. `issue.status === 'acknowledged'` 且 `reason === 'cooldown_expired'`：不發新訊息；有根訊息就 `bot.edit(applyCount(root.payload, count, lastSeen))` 並 `recordNotification({ kind:'count_edit', ... })`；回 `{ notified:false, notifyReason:'acknowledged_silent' }`。
  4. `root = getIncidentRoot(issue.id, seq)`：
     - `root === null`（本事故第一則）：訊息 = `buildDiscordMessage({..., buttons:{issueId, incidentSeq: seq}})`；若 `result.reopened` 且 `prev = getIncidentRoot(issue.id, seq-1)` 存在 → 加 `message_reference: prev.messageId`，並 `bot.edit(prev, applyReopened(prev.payload, seq))`。
     - `root !== null`（升級或冷卻重發）：`buildFollowUpAlert(buildDiscordMessage(...), root.messageId)`（有 tag、無按鈕）。
  5. `bot.post` → `recordNotification({ kind:'alert', incidentSeq: seq, discordChannelId, discordMessageId, payload: 送出的訊息, ... })`。payload 存「不含 message_reference」的版本。
- `processAndNotify`／`finishEvent` 把 `reopened` 一路帶到 `notifyStage`（經 `ProcessResult.reopened`）。

- [ ] **Step 1: 失敗測試**（fake bot）：
  - `bot 模式首次告警帶按鈕並記 message id 與 payload`：notifications 該筆 `discordMessageId='m1'`、`payload.components` 存在。
  - `同事故升級發 reply、有 tag、無按鈕`：`message_reference.message_id='m1'`、`content` 含 `<@owner>`、無 `components`。
  - `確認後冷卻到期只編輯計數、不 post`（Review Focus 5）：`bot.post` 呼叫次數不變、`bot.edit` 一次、notifyReason `'acknowledged_silent'`；30 分鐘內再來事件不再 edit。
  - `確認後升級仍 post 並 tag`。
  - `復發：新告警 reply 到上一事故根訊息、上一則被編輯為已復發、冷卻從零（reason first）`。
  - `bot 為 null：送出的 message 無 components、走 sender(webhookUrl)`（Review Focus 4）。
  - process-event：`復發且 event 自帶 P2、歷史 P0：final 為 P2`；`頻率規則以 incidentCount/incidentFirstSeen 評估`。
- [ ] **Step 2:** `pnpm vitest run tests/pipeline` Expected：FAIL。
- [ ] **Step 3:** 實作。
- [ ] **Step 4:** `pnpm test && pnpm typecheck` Expected：PASS。
- [ ] **Step 5:** Commit。

### Task 7: Interactions endpoint（Ed25519 驗簽 ＋ 按鈕處理）與文件

**Files:**
- Create: `src/notify/discord-signature.ts`、`src/notify/handle-interaction.ts`、`app/api/discord/interactions/route.ts`
- Modify: `docs/api.md`（新增一節 Discord interactions 與四個環境變數）、`CLAUDE.md`（狀態段落補一行本功能與 bot 設定前提）
- Test: `tests/notify/discord-signature.test.ts`、`tests/notify/handle-interaction.test.ts`

**Interfaces:**
- Produces：
  ```ts
  // discord-signature.ts
  export function verifyDiscordSignature(publicKeyHex: string, signatureHex: string, timestamp: string, rawBody: string): boolean
  // handle-interaction.ts
  export type InteractionResponse = { status: number; body: unknown; after?: () => Promise<void> }
  export async function handleInteraction(store: Store, bot: DiscordBot | null, config: { publicKey: string }, request: { rawBody: string; signature: string | null; timestamp: string | null }, now: Date): Promise<InteractionResponse>
  ```
- `verifyDiscordSignature`：公鑰 32-byte raw hex → SPKI DER（前綴 `302a300506032b6570032100`）→ `crypto.verify(null, Buffer.from(timestamp + rawBody), { key, format:'der', type:'spki' }, Buffer.from(signatureHex,'hex'))`；任何解析錯誤回 `false`。
- `handleInteraction` 流程：
  1. 缺 header 或驗簽失敗 → `401`。
  2. `type === 1` → `200 { type: 1 }`。
  3. `type === 3`（component）：`parseButtonId(data.custom_id)`；null → `200 { type: 4, data: { content: '無法辨識的按鈕', flags: 64 } }`。
  4. 點擊者 `member?.user?.id ?? user?.id`；缺 → 同上錯誤。
  5. issue 的 `reopenCount !== incidentSeq` → ephemeral「此告警已過期，請看最新一則」（不改 DB）。
  6. `transitionIssue(store, bot, issueId, action==='ack'?'acknowledged':'resolved', {kind:'discord',userId}, now, { editRoot:false, deferFollowUp:true })`。
  7. `changed` → `200 { type: 7, data: rootEdit.payload（無 rootEdit 時以 interaction.message 為底套同一變形） }`，`after: followUp`。
  8. `unchanged` → ack：ephemeral「已由 <displayActor(acknowledgedBy)> 確認」；resolve：ephemeral「此問題已解決」。`not_found` → ephemeral「找不到此問題」。
- route：`POST`，讀 `await request.text()`，header `x-signature-ed25519`、`x-signature-timestamp`；`getDiscordInteractionConfig()` 為 null → `503`；`after(res.after)`（有才呼叫）；回 `Response.json(body, { status })`。

- [ ] **Step 1: 失敗測試**：
  - signature：用 `crypto.generateKeyPairSync('ed25519')` 產鑰（JWK `x` 轉 hex 當 publicKeyHex）簽 `timestamp+body` → `true`；改一個 body 字元 → `false`；非 hex 公鑰 → `false`（不 throw）。
  - handle-interaction：`缺簽章 401`、`PING 回 type 1`、`ack 按鈕 → type 7 且 DB acknowledged、after 存在`、`兩次 ack 第二次 ephemeral 含「已由 <@111> 確認」`（Review Focus 1）、`incidentSeq 不符 → 過期 ephemeral 且 DB 不變`（Review Focus 2）、`custom_id 亂碼 → ephemeral`、`DM 形式（user.id）也能取到點擊者`。
- [ ] **Step 2:** `pnpm vitest run tests/notify` Expected：FAIL。
- [ ] **Step 3:** 實作 signature、handler、route；更新 `docs/api.md`、`CLAUDE.md`。
- [ ] **Step 4:** `pnpm test && pnpm typecheck && pnpm build` Expected：全 PASS。
- [ ] **Step 5:** Commit。
- [ ] **Step 6（部署後、使用者設定 Discord 後台後）：實測未確認事項**：在 Discord Developer Portal 填 Interactions Endpoint URL，Expected：儲存成功（PING/PONG 與無效簽章測試通過）；按一次「確認」，Vercel log 印出 interaction 的 `member.user.id` 形狀與預期相符。結果回報使用者，不符則開修正 task。
