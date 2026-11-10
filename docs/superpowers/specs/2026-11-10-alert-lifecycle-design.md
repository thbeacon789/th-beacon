# 告警生命週期：tag 負責人 → Discord 按鈕確認 → 解決／恢復

日期：2026-11-10　狀態：設計待核可

## 意圖與動機

現在的 Discord 通知只做到「發出告警並 tag 負責人」（`services.owner_discord_id`，commit `321190f`）。之後的流程全斷在 Discord 之外：

- 負責人看到告警後，要點進 dashboard `/issues/[id]` 才能改狀態；Discord 上沒人知道「已經有人在處理」。
- 確認之後冷卻 30 分鐘一到又會再發、再 tag，等於懲罰已經在處理的人。
- 問題解決（手動或系統自動恢復）時 Discord 毫無消息，頻道裡最後一則永遠是紅色告警。
- 系統不記錄誰、何時確認或解決。

目標是讓**整段事故生命週期在 Discord 頻道裡就看得完整、操作得了**：

```
告警（tag 負責人，附按鈕）→ 任何人按「確認」→ 按「已解決」或系統自動恢復 →（若復發）回覆原訊息再告警
```

## 已拍板（使用者決定）

1. **每服務一位負責人，所有等級都 tag**（已實作）。
2. **確認／解決直接在 Discord 訊息上按按鈕**，不必進 dashboard。
3. **「處理完成」與「服務恢復」收斂為同一件事**：不新增狀態，沿用 issue 狀態機 `open → acknowledged → resolved`。服務掛掉本身就是一筆 `health_check` issue，「服務恢復」＝該 issue 被自動 resolve。服務燈號仍由 issue 推導，不另存「已恢復」。
4. **同一問題（同 fingerprint）復發時，發一則新訊息，以 Discord「回覆」（message reference）指向原告警**；新訊息照常 tag 負責人並附按鈕；原訊息改標「🔁 已復發（第 N 次）」。不只編輯原訊息（編輯不推播、舊訊息已被洗上去），也不用 thread。
5. **任何看得到頻道的人都能按按鈕**，不限負責人、不對應 dashboard 白名單。

## Discord 平台限制（已查官方文件，2026-11-10）

- 一般 channel webhook **不能**送可互動按鈕（`with_components` 對非 application-owned webhook 只允許非互動元件）。https://docs.discord.com/developers/resources/webhook
- 互動按鈕需要 Discord Application ＋ **Interactions Endpoint URL**；每個請求必須以 application public key 驗 **Ed25519** 簽章（`X-Signature-Ed25519`、`X-Signature-Timestamp` ＋ raw body），失敗回 401；設定時 Discord 送 PING（type 1）須回 PONG；**初始回應須在 3 秒內**。回應型別：7 `UPDATE_MESSAGE`（直接改按鈕所在訊息）、6 `DEFERRED_UPDATE_MESSAGE`（先 ack，15 分鐘內用 interaction token PATCH `@original`）。https://docs.discord.com/developers/interactions/receiving-and-responding
- 伺服器頻道內點擊者在 `member.user.id`（DM 則 `user.id`）。**未確認**：`member.user.id` 的精確形狀——實作第一步先用最小 endpoint 實測。
- 發訊息改用 Bot token `POST /channels/{channel.id}/messages`（需 `SEND_MESSAGES`；回覆需 `READ_MESSAGE_HISTORY`），可帶 `message_reference` 做回覆、可帶 custom_id 按鈕；之後以 `PATCH /channels/{channel.id}/messages/{message.id}` 編輯（bot 自己發的訊息無 15 分鐘限制）。**未確認**：bot 是否必須在伺服器內（推定必須，實測確認）。

## 行為規格

### 1. 告警訊息（first／escalation／cooldown_expired）

- 沿用現有 embed（顏色依 severity）、`content: <@owner>`、`allowed_mentions: {parse: [], users: [owner]}`。
- 新增兩顆按鈕：「✋ 確認」「✅ 已解決」。`custom_id` 編入動作與 issue id（例 `ack:<issue_uuid>`）。
- 同一事故（見 §5）的後續訊息（escalation、cooldown 重發）都以「回覆」掛在**該事故的第一則告警**下。

### 2. 確認（acknowledged）

- 觸發：Discord「確認」按鈕，或 dashboard `/issues/[id]` 既有按鈕。
- 效果：issue → `acknowledged`，記 `acknowledged_at`、`acknowledged_by`（Discord user id；dashboard 來源記使用者 email）。
- 原告警訊息編輯為：embed 加一欄「✋ 已確認：<@user>（時間）」，移除「確認」按鈕、保留「已解決」。編輯時 `allowed_mentions: {parse: []}`（編輯本就不推播，避免誤觸）。
- **確認後的冷卻重發不再 tag、不再發新訊息**；改為靜默編輯原訊息的「次數／Last seen」欄位（我的判斷，見「我做的判斷」）。
- **確認後若 severity 升級（escalation），仍發回覆並 tag 負責人**——升級代表情況變了。
- 已是 acknowledged 再按「確認」：冪等，回 ephemeral 提示「已由 <@x> 確認」，不重複寫入。

### 3. 解決（resolved）——手動與自動走同一出口

- 觸發來源四條，**必須收斂到單一狀態轉換函式**（例如擴充 `src/pipeline/change-issue-status.ts`），由它負責寫 DB、`refreshServiceHealth`、更新 Discord：
  1. Discord「已解決」按鈕
  2. dashboard `/issues/[id]` 按鈕（`app/issues/actions.ts`）
  3. 輪詢恢復（`src/poll/poll-service.ts:57` → `resolveHealthCheckIssue`）
  4. 心跳回報（`src/heartbeat/handle-heartbeat.ts:63-66, 104-110` → `resolveIssueByFingerprint`）
- 效果：issue → `resolved`，記 `resolved_at`、`resolved_by`（Discord user id／email／`null`＝系統自動）。
- 原告警訊息編輯為綠色 embed，標題加「✅ 已解決」，欄位註明「手動：<@user>」或「自動恢復（輪詢／心跳）」，**移除所有按鈕**。
- 另發一則**不 tag 任何人**的短回覆（`allowed_mentions: {parse: []}`）：「✅ 已解決／已自動恢復」，讓頻道最新動態不是紅色告警。
- 若該 issue 從未成功送出 Discord 訊息（無 message id），只改 DB，不補發。

### 4. ignored

- 不新增 Discord 按鈕（使用者未要求）。dashboard 改為 ignored 時，原訊息編輯為灰色、標「已忽略」、移除按鈕，不發回覆。

### 5. 復發（resolved 後同 fingerprint 再來）

- 現況：upsert 已會把 resolved 改回 open 並回 `reopened=true`（`supabase/migrations/20261027120000_ai_triage.sql:51-65`）。ignored 維持 ignored（不變）。
- **一次復發＝新事故**：發新告警訊息（tag ＋ 按鈕），以「回覆」指向**上一個事故的第一則告警**；上一則原訊息編輯加註「🔁 已復發（第 N 次）→ 見最新回覆」。
- 新事故的冷卻／升級判斷從零開始（不受上個事故最後一次發送影響）：`shouldNotify` 對 reopen 的第一個事件應回 `first`。
- 確認／解決欄位（`acknowledged_*`、`resolved_*`）在 reopen 時清空。
- **severity 是否重置**：見「我做的判斷」第 3 點。

### 6. 互動 endpoint

- 新 route `app/api/discord/interactions/route.ts`（Node runtime）。
- 驗 Ed25519 → PING 回 PONG → 解析 `custom_id` → 呼叫 §3 的同一轉換函式 → 3 秒內回 type 7 帶更新後訊息。若轉換流程（含 `refreshServiceHealth`）無法穩定在 3 秒內，改回 type 6 並把後續工作延後執行（建造者選擇做法，見「留給建造者」）。
- issue 不存在、custom_id 格式錯：回 ephemeral 錯誤訊息，不改 DB。
- 這條 route 不走 `requireUser()`（使用者決定任何頻道成員都能按）；安全邊界＝Discord 簽章 ＋ 頻道可見性。

## 資料變更

- `issues`：新增 `acknowledged_at timestamptz`、`acknowledged_by text`、`resolved_at timestamptz`、`resolved_by text`、`reopen_count int not null default 0`。
- `notifications`：新增 `kind text`（`alert | ack_update | resolve_update | reopen` 等，建造者定列舉）、`discord_message_id text`、`discord_channel_id text`、`incident_seq int`（第幾次事故）。冷卻判斷只看 `kind='alert'` 的 sent 紀錄，且限同一 `incident_seq`。
- 新環境變數：`DISCORD_BOT_TOKEN`、`DISCORD_PUBLIC_KEY`、`DISCORD_APPLICATION_ID`、`DISCORD_ALERT_CHANNEL_ID`。
- Schema 變更照專案慣例：`supabase migration new` → `db push` → advisors → `pnpm db:types`。

## 降級與相容

- Bot 相關環境變數未設定時：退回現行 webhook 路徑（`DISCORD_WEBHOOK_URL`／per-service webhook），無按鈕、無編輯、無回覆，行為與今天完全相同。
- `services.discord_webhook_url`（per-service）目前四個服務都沒設。Bot 模式下改用單一頻道 `DISCORD_ALERT_CHANNEL_ID`；per-service 頻道列為非目標。
- Discord API 呼叫失敗（編輯、回覆）不得讓狀態轉換失敗：DB 是真相，Discord 是投影；失敗記 log／`notifications.status='failed'`。

## 目標／非目標／反目標

**目標**：Discord 內完成確認與解決；自動恢復可見；確認後停止騷擾；復發可追溯到原告警；記錄誰／何時。

**非目標**：per-issue 指派（負責人仍是服務層級）；多位負責人／角色 tag；per-service Discord 頻道；Discord 內的「忽略」按鈕；把 Discord user 對應到 dashboard 帳號；恢復通知以外的服務層級彙總訊息。

**反目標（技術上能跑但算失敗）**：
- 按鈕按了沒反應或顯示「此互動失敗」（超過 3 秒）。
- 自動恢復與手動解決的 Discord 呈現不一致，或某條 resolve 路徑漏發更新。
- 確認之後還被 tag。
- Discord 故障導致 issue 狀態改不了、或 ingest／cron 失敗。
- 外部錯誤內文觸發 `@everyone`。

## 我做的判斷（使用者未明說，請核對）

1. **確認後的冷卻重發改為靜默編輯原訊息計數**，不發新訊息。理由：使用者要的是「確認後別再吵」，但數字仍有參考價值。
2. **確認後若升級仍 tag**。理由：嚴重度上升代表需要重新注意。
3. **復發時 severity 重新判定、不沿用歷史最高**（Plan 6 交接 `docs/superpowers/plans/2026-07-28-plan6-discord-notifier.md:1038` 的建議方向）。理由：既然 Discord 上把復發當新事故呈現，嚴重度也應反映這次事故；否則一次瞬斷就頂著歷史 P0 再叫醒人。具體做法（重置為規則重新評估、頻率規則的時間窗改從事故開始算）留給建造者，但結果必須是「復發第一筆事件依它自己的情況判級」。
4. 解決時另發一則不 tag 的短回覆（不只編輯原訊息），讓頻道最新一則反映現況。
5. dashboard 的確認／解決也同步更新 Discord 訊息（同一出口自然達成）。

## 留給建造者

- 3 秒內回應的做法（同步 type 7，或 type 6 ＋ Next.js `after()` 延後處理）。
- 狀態轉換函式的確切介面與放置位置（遵守 `src/core/**` 純函式約束：訊息組裝與轉換規則放 core，I/O 放 pipeline／notify）。
- Discord 編輯／回覆的 rate limit 處理細節。
- `notifications.kind` 列舉與索引。
- Ed25519 驗證用 Node `crypto`（`crypto.verify` 支援 ed25519）或其他方式。
- 測試策略：Discord client 以 port 注入，單元測試用 fake；整合測試沿用本地 stack。

## 使用者需在 Discord 後台完成（非程式）

1. 建立 Discord Application，加 Bot 進伺服器（權限 `SEND_MESSAGES`、`READ_MESSAGE_HISTORY`、`VIEW_CHANNEL`）。
2. 部署 endpoint 後，在 Application 的 General Information 填 Interactions Endpoint URL（`https://<domain>/api/discord/interactions`）。
3. 在 Vercel 設定上列四個環境變數。
