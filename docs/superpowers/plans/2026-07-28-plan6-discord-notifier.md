# Discord 通知器（ratchet + 冷卻去重 + 升級追發）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 實作 spec §4.6 Discord 通知器：severity 達門檻才發、同 fingerprint 冷卻期內只發一次、升級才追發、發送紀錄寫 `notifications` 表；並落實已拍板的 **severity ratchet（只升不降）**，讓「升級追發」語意在頻率規則超窗回落的情境下不洗版。

**Architecture:** 與前幾個計畫同構——`shouldNotify`（冷卻/門檻/升級決策）與 `buildDiscordMessage`（embed 組裝）是純函式；`sendDiscordWebhook`（真 fetch）只在 `src/notify/discord.ts`；`processAndNotify` 組合 `processEvent` ＋通知步驟成為**唯一入口**，ingest 與 poller 全部改走它。ratchet 落在 `processEvent`（Plan 3 review 建議的一行 rank 比較）。

**Tech Stack:** TypeScript strict、Vitest（單元 + stub Discord server 整合）、Discord webhook（embed JSON）。

## Global Constraints

- pnpm；TypeScript strict；**禁止 dev server**；時鐘一律注入。
- 真 `fetch` 只准在 `src/notify/discord.ts` 與 `src/poll/http.ts`；`process.env` 只准在 `src/store/server.ts`。
- **已拍板決策（值不得偏離）**：
  - **Ratchet**：severity 只升不降（rank P2<P1<P0）。未升級時 tags 也不寫回（凍結在最高判級當下）；新建 issue 時初判照寫。人工降級靠操作狀態（resolve/ignore），與 severity 正交。
  - **通知門檻**：severity ≥ **P1** 才發（P2 不發）。程式常數 `NOTIFY_MIN_SEVERITY = 'P1'`。
  - **冷卻期**：**30 分鐘**（常數 `COOLDOWN_MINUTES = 30`）。同 fingerprint 冷卻期內不重發；**升級無視冷卻立即追發**；冷卻期滿後有新事件再發（帶累計 count）。
  - **冷卻判斷只計 `status='sent'`** 的紀錄（發送失敗不消耗冷卻期，下次事件自動重試）。
  - **發送失敗絕不讓管線失敗**：ingest 仍回 201、poller 照常；失敗記 `status='failed'` 供稽核。
  - webhook 解析順序：`services.discord_webhook_url` → env `DISCORD_WEBHOOK_URL` fallback → 都沒有則跳過（`notifyReason: 'no_webhook'`）。
  - duplicate 事件（externalId 去重）不觸發通知評估。
- Discord embed 慣例：username `th-beacon`；title `[P0] service-name — error_type`；description = issue message 截 500 字；fields：次數/first seen/last seen；color P0 `0xe74c3c`、P1 `0xe67e22`、P2 `0x95a5a6`；`APP_URL` env 存在時附 dashboard 連結。
- `notifications` 表已存在（Plan 2）：insert 明確帶 `sent_at`（由呼叫端時鐘），不靠 DB default，維持可測性。
- 多頻道路由、批次摘要不在 MVP（spec 既定）。

## 本計畫涵蓋 vs. 後續計畫

**做（spec §4.6 全部 + §4.4 ratchet 補充）：** processEvent ratchet、ServiceRecord 加 `discordWebhookUrl`、Store 通知方法、`shouldNotify`/`buildDiscordMessage`、`sendDiscordWebhook`、`processAndNotify` 並接進 ingest/poller、stub Discord 整合測試、spec 定案更新。

**不做：** dashboard／Auth／Realtime（Plan 7）；通知重試佇列；多頻道路由。

---

### Task 1: processEvent ratchet（severity 只升不降）

**Files:**
- Modify: `src/pipeline/process-event.ts`
- Test: Modify `tests/pipeline/process-event.test.ts`

**Interfaces:**
- `ProcessResult` 簽章不變。行為變更：`evaluateSeverity` 結果只在**嚴格更嚴重**時寫回；未升級時 severity 與 tags 都維持原值；新建 issue 時初判照寫（含僅 tags 差異）。`previousSeverity` 語意不變（判級前的值）。

- [ ] **Step 1: 寫失敗測試（加進既有 describe('processEvent')）**

```typescript
  it('ratchet: severity never demotes when rules stop matching', async () => {
    // 頻率規則：1 分鐘窗內 >=2 次 → P0
    store.seedRule(null, {
      id: 'freq',
      priority: 10,
      severity: 'P0',
      tags: ['burst'],
      match: { minCountInWindow: 2, windowMinutes: 1 },
    })
    await processEvent(store, event({ occurredAt: '2026-07-28T10:00:00.000Z' }), now)
    const second = await processEvent(store, event({ occurredAt: '2026-07-28T10:00:30.000Z' }), now)
    expect(second.issue.severity).toBe('P0')

    // 第三次事件把 lastSeen-firstSeen 撐超過 1 分鐘窗 → 規則不再命中（evaluated P2）
    const third = await processEvent(store, event({ occurredAt: '2026-07-28T10:05:00.000Z' }), now)
    expect(third.issue.severity).toBe('P0') // 不降級
    expect(third.issue.tags).toEqual(['burst']) // tags 凍結
    expect(third.previousSeverity).toBe('P0')
    const open = await store.listOpenIssues('s-1')
    expect(open[0].severity).toBe('P0') // 持久化也未降
  })

  it('ratchet: created issue still gets initial tags for a P2 rule', async () => {
    store.seedRule(null, { id: 'tagger', priority: 1, severity: 'P2', tags: ['noise'], match: {} })
    const result = await processEvent(store, event(), now)
    expect(result.issue.severity).toBe('P2')
    expect(result.issue.tags).toEqual(['noise'])
  })
```

- [ ] **Step 2: 確認 RED**

Run: `pnpm vitest run tests/pipeline/process-event.test.ts`
Expected: 兩條新測試 FAIL（現行實作會把 P0 降回 P2）。

- [ ] **Step 3: 修改 `src/pipeline/process-event.ts` 的判級寫回段**

把原本的：

```typescript
  const { severity, tags } = evaluateSeverity(issue, rules)

  let triaged = issue
  if (severity !== issue.severity || !sameTags(tags, issue.tags)) {
    await store.updateIssueTriage(issue.id, severity, tags)
    triaged = { ...issue, severity, tags }
  }
```

改為：

```typescript
  const { severity: evaluated, tags } = evaluateSeverity(issue, rules)

  // Ratchet（已拍板）：severity 只升不降——頻率規則超窗回落時維持歷史最嚴重值，
  // 避免 P0↔P2 震盪讓「升級才追發」的通知洗版。未升級時 tags 一併凍結。
  const escalated = SEVERITY_RANK[evaluated] > SEVERITY_RANK[issue.severity]
  let triaged = issue
  if (escalated) {
    await store.updateIssueTriage(issue.id, evaluated, tags)
    triaged = { ...issue, severity: evaluated, tags }
  } else if (created && !sameTags(tags, issue.tags)) {
    await store.updateIssueTriage(issue.id, issue.severity, tags)
    triaged = { ...issue, tags }
  }
```

並在檔案頂部（imports 之後）加：

```typescript
const SEVERITY_RANK: Record<Severity, number> = { P2: 0, P1: 1, P0: 2 }
```

- [ ] **Step 4: GREEN + 回歸**

Run: `pnpm vitest run tests/pipeline/process-event.test.ts && pnpm test && pnpm typecheck`
Expected: 全 PASS（既有測試不受影響——它們都是升級或首判情境）。

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/process-event.ts tests/pipeline/process-event.test.ts
git commit -m "feat(pipeline): severity ratchet — never demote on rule fallback"
```

---

### Task 2: ServiceRecord.discordWebhookUrl + Store 通知方法

**Files:**
- Modify: `src/store/contracts.ts`、`src/store/mapping.ts`、`src/store/memory.ts`、`src/store/supabase.ts`
- Test: Modify `tests/store/mapping.test.ts`、`tests/store/memory.test.ts`、`tests/integration/supabase-store.test.ts`
- Modify（機械性 fixture 更新）: `tests/pipeline/process-event.test.ts`、`tests/pipeline/refresh-health.test.ts`、`tests/poll/poll-service.test.ts`、`tests/ingest/handle-ingest.test.ts`（各檔的 `ServiceRecord` literal 加 `discordWebhookUrl: null`）

**Interfaces:**
- `ServiceRecord` 加必填欄位 `discordWebhookUrl: string | null`（`rowToService` 映射 `discord_webhook_url`）。
- contracts 加：
  - `interface LatestNotification { severity: Severity; sentAt: string }`
  - `interface NotificationRecord { issueId: string; serviceId: string; fingerprint: string; severity: Severity; status: 'sent' | 'failed'; countAtSend: number; sentAt: string }`
  - `Store` 加：`getLatestSentNotification(serviceId: string, fingerprint: string): Promise<LatestNotification | null>`（**只查 status='sent'**，取 sentAt 最新一筆）；`recordNotification(record: NotificationRecord): Promise<void>`。

- [ ] **Step 1: contracts/mapping 修改**

`src/store/contracts.ts`：`ServiceRecord` 加 `discordWebhookUrl: string | null`；新增上述兩個 interface 與兩個 Store 方法。

`src/store/mapping.ts` 的 `rowToService` 加一行：

```typescript
    discordWebhookUrl: row.discord_webhook_url,
```

- [ ] **Step 2: 寫失敗測試**

`tests/store/mapping.test.ts`：`rowToService` 兩個測試的期望物件各加 `discordWebhookUrl: null`（serviceRow fixture 的 `discord_webhook_url` 本來就是 null）。

`tests/store/memory.test.ts` 加：

```typescript
  it('records notifications and returns latest sent only', async () => {
    const base = {
      issueId: 'i-1',
      serviceId: 's-1',
      fingerprint: 'fp-n',
      countAtSend: 1,
    }
    await store.recordNotification({ ...base, severity: 'P1', status: 'sent', sentAt: '2026-07-28T10:00:00.000Z' })
    await store.recordNotification({ ...base, severity: 'P0', status: 'failed', sentAt: '2026-07-28T10:05:00.000Z' })
    // failed 不計入冷卻判斷
    expect(await store.getLatestSentNotification('s-1', 'fp-n')).toEqual({
      severity: 'P1',
      sentAt: '2026-07-28T10:00:00.000Z',
    })
    await store.recordNotification({ ...base, severity: 'P0', status: 'sent', sentAt: '2026-07-28T10:06:00.000Z' })
    expect(await store.getLatestSentNotification('s-1', 'fp-n')).toEqual({
      severity: 'P0',
      sentAt: '2026-07-28T10:06:00.000Z',
    })
    expect(await store.getLatestSentNotification('s-1', 'nope')).toBeNull()
  })
```

`tests/integration/supabase-store.test.ts` 加：

```typescript
describe('SupabaseStore notifications', () => {
  it('records and reads back latest sent notification (failed excluded)', async () => {
    const { issue } = await store.upsertIssueWithEvent(event())
    const base = { issueId: issue.id, serviceId, fingerprint: issue.fingerprint, countAtSend: 1 }
    await store.recordNotification({ ...base, severity: 'P1', status: 'sent', sentAt: '2026-07-28T10:00:00.000Z' })
    await store.recordNotification({ ...base, severity: 'P0', status: 'failed', sentAt: '2026-07-28T10:05:00.000Z' })
    const latest = await store.getLatestSentNotification(serviceId, issue.fingerprint)
    expect(latest?.severity).toBe('P1')
    const { data } = await client.from('notifications').select('status,severity,count_at_send').order('sent_at')
    expect(data).toHaveLength(2)
    expect(data![1]).toMatchObject({ status: 'failed', severity: 'P0', count_at_send: 1 })
  })
})
```

Run: `pnpm typecheck`
Expected: FAIL（ServiceRecord 欄位與新方法未實作）——RED 證據。

- [ ] **Step 3: InMemoryStore 實作**

```typescript
  private notifications: NotificationRecord[] = []

  async getLatestSentNotification(
    serviceId: string,
    fingerprint: string,
  ): Promise<LatestNotification | null> {
    const sent = this.notifications
      .filter((n) => n.serviceId === serviceId && n.fingerprint === fingerprint && n.status === 'sent')
      .sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime())
    return sent.length === 0 ? null : { severity: sent[0].severity, sentAt: sent[0].sentAt }
  }

  async recordNotification(record: NotificationRecord): Promise<void> {
    this.notifications.push({ ...record })
  }
```

（import 型別；既有 `svc` fixture 們補 `discordWebhookUrl: null`。）

- [ ] **Step 4: SupabaseStore 實作**

```typescript
  async getLatestSentNotification(
    serviceId: string,
    fingerprint: string,
  ): Promise<LatestNotification | null> {
    const { data, error } = await this.client
      .from('notifications')
      .select('severity,sent_at')
      .eq('service_id', serviceId)
      .eq('fingerprint', fingerprint)
      .eq('status', 'sent')
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(`getLatestSentNotification failed: ${error.message}`)
    return data === null ? null : { severity: narrowSeverity(data.severity), sentAt: data.sent_at }
  }

  async recordNotification(record: NotificationRecord): Promise<void> {
    const { error } = await this.client.from('notifications').insert({
      issue_id: record.issueId,
      service_id: record.serviceId,
      fingerprint: record.fingerprint,
      severity: record.severity,
      status: record.status,
      count_at_send: record.countAtSend,
      sent_at: record.sentAt,
    })
    if (error) throw new Error(`recordNotification failed: ${error.message}`)
  }
```

- [ ] **Step 5: 機械性 fixture 更新**

以下測試檔中每個 `ServiceRecord` 物件 literal（含 spread 建立的變體來源）補 `discordWebhookUrl: null,`：`tests/pipeline/process-event.test.ts`、`tests/pipeline/refresh-health.test.ts`、`tests/poll/poll-service.test.ts`、`tests/ingest/handle-ingest.test.ts`、`tests/store/memory.test.ts`（svc）。以 `pnpm typecheck` 找漏網。

- [ ] **Step 6: GREEN + 回歸**

Run: `pnpm test && pnpm typecheck && pnpm test:integration`
Expected: 全綠。

- [ ] **Step 7: Commit**

```bash
git add src/store/contracts.ts src/store/mapping.ts src/store/memory.ts src/store/supabase.ts tests/store/mapping.test.ts tests/store/memory.test.ts tests/integration/supabase-store.test.ts tests/pipeline/process-event.test.ts tests/pipeline/refresh-health.test.ts tests/poll/poll-service.test.ts tests/ingest/handle-ingest.test.ts
git commit -m "feat(store): notification records and per-service Discord webhook"
```

---

### Task 3: 純邏輯——`shouldNotify` + `buildDiscordMessage`

**Files:**
- Create: `src/notify/decision.ts`
- Create: `src/notify/message.ts`
- Test: `tests/notify/decision.test.ts`、`tests/notify/message.test.ts`

**Interfaces:**
- Produces：
  - `NOTIFY_MIN_SEVERITY: Severity = 'P1'`、`COOLDOWN_MINUTES = 30`（`decision.ts` 匯出常數）
  - `interface ShouldNotifyParams { severity: Severity; duplicate: boolean; lastSent: LatestNotification | null; now: Date; cooldownMinutes?: number; minSeverity?: Severity }`
  - `type NotifyDecision = { notify: false; reason: 'duplicate' | 'below_threshold' | 'cooldown' } | { notify: true; reason: 'first' | 'escalation' | 'cooldown_expired' }`
  - `shouldNotify(params: ShouldNotifyParams): NotifyDecision`——判斷順序：duplicate → 門檻 → 無 lastSent（first）→ 升級（無視冷卻）→ 冷卻期滿 → cooldown。
  - `interface DiscordMessage { username: string; embeds: [{ title: string; description: string; color: number; url?: string; fields: Array<{ name: string; value: string; inline: boolean }> }] }`
  - `buildDiscordMessage(params: { serviceName: string; severity: Severity; errorType: string; message: string; count: number; firstSeen: string; lastSeen: string; dashboardUrl?: string }): DiscordMessage`

- [ ] **Step 1: 寫失敗測試 `tests/notify/decision.test.ts`**

```typescript
import { describe, it, expect } from 'vitest'
import { shouldNotify } from '@/notify/decision'
import type { LatestNotification } from '@/store/contracts'

const now = new Date('2026-07-28T10:30:00.000Z')
const sentRecently: LatestNotification = { severity: 'P1', sentAt: '2026-07-28T10:15:00.000Z' } // 15 分鐘前
const sentLongAgo: LatestNotification = { severity: 'P1', sentAt: '2026-07-28T09:30:00.000Z' } // 60 分鐘前

describe('shouldNotify', () => {
  it('skips duplicates outright', () => {
    expect(shouldNotify({ severity: 'P0', duplicate: true, lastSent: null, now })).toEqual({
      notify: false,
      reason: 'duplicate',
    })
  })

  it('skips below threshold (P2)', () => {
    expect(shouldNotify({ severity: 'P2', duplicate: false, lastSent: null, now })).toEqual({
      notify: false,
      reason: 'below_threshold',
    })
  })

  it('notifies first time at/above threshold', () => {
    expect(shouldNotify({ severity: 'P1', duplicate: false, lastSent: null, now })).toEqual({
      notify: true,
      reason: 'first',
    })
  })

  it('suppresses within cooldown at same severity', () => {
    expect(shouldNotify({ severity: 'P1', duplicate: false, lastSent: sentRecently, now })).toEqual({
      notify: false,
      reason: 'cooldown',
    })
  })

  it('escalation bypasses cooldown', () => {
    expect(shouldNotify({ severity: 'P0', duplicate: false, lastSent: sentRecently, now })).toEqual({
      notify: true,
      reason: 'escalation',
    })
  })

  it('re-notifies after cooldown expires', () => {
    expect(shouldNotify({ severity: 'P1', duplicate: false, lastSent: sentLongAgo, now })).toEqual({
      notify: true,
      reason: 'cooldown_expired',
    })
  })

  it('cooldown boundary: exactly 30 minutes counts as expired', () => {
    const boundary: LatestNotification = { severity: 'P1', sentAt: '2026-07-28T10:00:00.000Z' }
    expect(shouldNotify({ severity: 'P1', duplicate: false, lastSent: boundary, now })).toEqual({
      notify: true,
      reason: 'cooldown_expired',
    })
  })
})
```

- [ ] **Step 2: 寫失敗測試 `tests/notify/message.test.ts`**

```typescript
import { describe, it, expect } from 'vitest'
import { buildDiscordMessage } from '@/notify/message'

const base = {
  serviceName: 'svc-a',
  severity: 'P0' as const,
  errorType: 'DBError',
  message: 'db down: connection refused',
  count: 7,
  firstSeen: '2026-07-28T10:00:00.000Z',
  lastSeen: '2026-07-28T10:25:00.000Z',
}

describe('buildDiscordMessage', () => {
  it('builds an embed with title, color, fields', () => {
    const msg = buildDiscordMessage(base)
    expect(msg.username).toBe('th-beacon')
    expect(msg.embeds).toHaveLength(1)
    expect(msg.embeds[0].title).toBe('[P0] svc-a — DBError')
    expect(msg.embeds[0].color).toBe(0xe74c3c)
    expect(msg.embeds[0].description).toBe('db down: connection refused')
    expect(msg.embeds[0].url).toBeUndefined()
    expect(msg.embeds[0].fields).toEqual([
      { name: '次數', value: '7', inline: true },
      { name: 'First seen', value: '2026-07-28T10:00:00.000Z', inline: true },
      { name: 'Last seen', value: '2026-07-28T10:25:00.000Z', inline: true },
    ])
  })

  it('uses severity colors and attaches dashboard url when provided', () => {
    expect(buildDiscordMessage({ ...base, severity: 'P1' }).embeds[0].color).toBe(0xe67e22)
    expect(buildDiscordMessage({ ...base, severity: 'P2' }).embeds[0].color).toBe(0x95a5a6)
    expect(
      buildDiscordMessage({ ...base, dashboardUrl: 'https://beacon.example.com' }).embeds[0].url,
    ).toBe('https://beacon.example.com')
  })

  it('truncates description at 500 chars', () => {
    const long = 'x'.repeat(600)
    const description = buildDiscordMessage({ ...base, message: long }).embeds[0].description
    expect(description).toHaveLength(500)
    expect(description.endsWith('…')).toBe(true)
  })
})
```

- [ ] **Step 3: 確認 RED**

Run: `pnpm vitest run tests/notify`
Expected: FAIL（module not found）。

- [ ] **Step 4: 實作 `src/notify/decision.ts`**

```typescript
import type { Severity } from '@/core/types'
import type { LatestNotification } from '@/store/contracts'

export const NOTIFY_MIN_SEVERITY: Severity = 'P1'
export const COOLDOWN_MINUTES = 30

const RANK: Record<Severity, number> = { P2: 0, P1: 1, P0: 2 }

export interface ShouldNotifyParams {
  severity: Severity
  duplicate: boolean
  lastSent: LatestNotification | null
  now: Date
  cooldownMinutes?: number
  minSeverity?: Severity
}

export type NotifyDecision =
  | { notify: false; reason: 'duplicate' | 'below_threshold' | 'cooldown' }
  | { notify: true; reason: 'first' | 'escalation' | 'cooldown_expired' }

export function shouldNotify(params: ShouldNotifyParams): NotifyDecision {
  const cooldownMs = (params.cooldownMinutes ?? COOLDOWN_MINUTES) * 60_000
  const minSeverity = params.minSeverity ?? NOTIFY_MIN_SEVERITY

  if (params.duplicate) return { notify: false, reason: 'duplicate' }
  if (RANK[params.severity] < RANK[minSeverity]) return { notify: false, reason: 'below_threshold' }
  if (params.lastSent === null) return { notify: true, reason: 'first' }
  if (RANK[params.severity] > RANK[params.lastSent.severity]) {
    return { notify: true, reason: 'escalation' }
  }
  const elapsed = params.now.getTime() - new Date(params.lastSent.sentAt).getTime()
  if (elapsed >= cooldownMs) return { notify: true, reason: 'cooldown_expired' }
  return { notify: false, reason: 'cooldown' }
}
```

- [ ] **Step 5: 實作 `src/notify/message.ts`**

```typescript
import type { Severity } from '@/core/types'

export interface DiscordEmbedField {
  name: string
  value: string
  inline: boolean
}

export interface DiscordMessage {
  username: string
  embeds: [
    {
      title: string
      description: string
      color: number
      url?: string
      fields: DiscordEmbedField[]
    },
  ]
}

const SEVERITY_COLOR: Record<Severity, number> = {
  P0: 0xe74c3c,
  P1: 0xe67e22,
  P2: 0x95a5a6,
}

const DESCRIPTION_LIMIT = 500

export function buildDiscordMessage(params: {
  serviceName: string
  severity: Severity
  errorType: string
  message: string
  count: number
  firstSeen: string
  lastSeen: string
  dashboardUrl?: string
}): DiscordMessage {
  const description =
    params.message.length > DESCRIPTION_LIMIT
      ? `${params.message.slice(0, DESCRIPTION_LIMIT - 1)}…`
      : params.message
  return {
    username: 'th-beacon',
    embeds: [
      {
        title: `[${params.severity}] ${params.serviceName} — ${params.errorType}`,
        description,
        color: SEVERITY_COLOR[params.severity],
        ...(params.dashboardUrl !== undefined ? { url: params.dashboardUrl } : {}),
        fields: [
          { name: '次數', value: String(params.count), inline: true },
          { name: 'First seen', value: params.firstSeen, inline: true },
          { name: 'Last seen', value: params.lastSeen, inline: true },
        ],
      },
    ],
  }
}
```

- [ ] **Step 6: GREEN + 回歸**

Run: `pnpm vitest run tests/notify && pnpm test && pnpm typecheck`
Expected: 全 PASS。

- [ ] **Step 7: Commit**

```bash
git add src/notify/decision.ts src/notify/message.ts tests/notify/decision.test.ts tests/notify/message.test.ts
git commit -m "feat(notify): cooldown/escalation decision and Discord embed builder"
```

---

### Task 4: `sendDiscordWebhook` + `processAndNotify` + 接進 ingest/poller

**Files:**
- Create: `src/notify/discord.ts`
- Create: `src/pipeline/process-and-notify.ts`
- Modify: `src/store/server.ts`（`createServerNotifyDeps`）
- Modify: `src/ingest/handle-ingest.ts`、`app/api/ingest/route.ts`
- Modify: `src/poll/poll-service.ts`、`app/api/poll/services/route.ts`
- Test: `tests/pipeline/process-and-notify.test.ts`；Modify `tests/ingest/handle-ingest.test.ts`、`tests/poll/poll-service.test.ts`

**Interfaces:**
- Produces：
  - `type SendResult = { ok: true } | { ok: false; reason: string }`；`type DiscordSender = (webhookUrl: string, message: DiscordMessage) => Promise<SendResult>`（`src/notify/discord.ts` 匯出型別與 `sendDiscordWebhook` 實作：POST JSON，2xx → ok）
  - `interface NotifyDeps { sender: DiscordSender; fallbackWebhookUrl: string | null; dashboardUrl?: string }`
  - `interface ProcessAndNotifyResult extends ProcessResult { notified: boolean; notifyReason: string | null }`
  - `processAndNotify(store: Store, deps: NotifyDeps, event: CanonicalEvent, now: Date): Promise<ProcessAndNotifyResult>`
  - `createServerNotifyDeps(): NotifyDeps`（env：`DISCORD_WEBHOOK_URL`、`APP_URL`；放 `src/store/server.ts`）
  - **簽章變更**：`handleIngest(store, deps: NotifyDeps, request, now)`；`pollService(store, http, deps: NotifyDeps, pollable, now)`；`runPoll(store, http, deps: NotifyDeps, now)`——內部所有 `processEvent` 呼叫改 `processAndNotify`。ingest 201 body 加 `notified: boolean` 欄位（additive）。

- [ ] **Step 1: 寫失敗測試 `tests/pipeline/process-and-notify.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { processAndNotify } from '@/pipeline/process-and-notify'
import { InMemoryStore } from '@/store/memory'
import type { NotifyDeps } from '@/pipeline/process-and-notify'
import type { DiscordMessage } from '@/notify/message'
import type { ServiceRecord } from '@/store/contracts'
import type { CanonicalEvent } from '@/core/types'

const now = new Date('2026-07-28T10:10:00.000Z')

const svc: ServiceRecord = {
  id: 's-1',
  name: 'svc-a',
  healthWindowMinutes: 15,
  healthFailureThreshold: 2,
  healthStatus: 'healthy',
  poll: null,
  discordWebhookUrl: 'https://discord/webhook',
}

const event = (over: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  serviceId: 's-1',
  source: 'push',
  level: 'error',
  errorType: 'TypeError',
  message: 'boom',
  fingerprint: 'fp-1',
  occurredAt: '2026-07-28T10:09:00.000Z',
  metadata: {},
  ...over,
})

function fakeSender(result: { ok: true } | { ok: false; reason: string } = { ok: true }) {
  const sent: Array<{ url: string; message: DiscordMessage }> = []
  const deps: NotifyDeps = {
    sender: async (url, message) => {
      sent.push({ url, message })
      return result
    },
    fallbackWebhookUrl: null,
  }
  return { deps, sent }
}

describe('processAndNotify', () => {
  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc)
  })

  it('P2 issue: pipeline runs, nothing sent', async () => {
    const { deps, sent } = fakeSender()
    const result = await processAndNotify(store, deps, event(), now)
    expect(result.notified).toBe(false)
    expect(result.notifyReason).toBe('below_threshold')
    expect(sent).toHaveLength(0)
  })

  it('first P1: sends embed to per-service webhook and records sent', async () => {
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P1', match: {} })
    const { deps, sent } = fakeSender()
    const result = await processAndNotify(store, deps, event(), now)
    expect(result.notified).toBe(true)
    expect(result.notifyReason).toBe('first')
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe('https://discord/webhook')
    expect(sent[0].message.embeds[0].title).toBe('[P1] svc-a — TypeError')
    expect(await store.getLatestSentNotification('s-1', result.issue.fingerprint)).toEqual({
      severity: 'P1',
      sentAt: now.toISOString(),
    })
  })

  it('cooldown suppresses repeat; escalation resends', async () => {
    store.seedRule(null, { id: 'p1', priority: 10, severity: 'P1', match: {} })
    const { deps, sent } = fakeSender()
    await processAndNotify(store, deps, event(), now)
    const repeat = await processAndNotify(store, deps, event(), now)
    expect(repeat.notified).toBe(false)
    expect(repeat.notifyReason).toBe('cooldown')
    expect(sent).toHaveLength(1)

    store.seedRule(null, {
      id: 'p0',
      priority: 20,
      severity: 'P0',
      match: { minCountInWindow: 3, windowMinutes: 60 },
    })
    const escalated = await processAndNotify(store, deps, event(), now)
    expect(escalated.notified).toBe(true)
    expect(escalated.notifyReason).toBe('escalation')
    expect(sent).toHaveLength(2)
    expect(sent[1].message.embeds[0].title).toBe('[P0] svc-a — TypeError')
  })

  it('sender failure records failed, pipeline result intact, next event retries', async () => {
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P1', match: {} })
    const failing = fakeSender({ ok: false, reason: 'http 500' })
    const result = await processAndNotify(store, failing.deps, event(), now)
    expect(result.notified).toBe(false)
    expect(result.notifyReason).toBe('first')
    expect(result.issue.severity).toBe('P1') // 管線不受影響
    expect(await store.getLatestSentNotification('s-1', result.issue.fingerprint)).toBeNull() // failed 不計

    const ok = fakeSender()
    const retry = await processAndNotify(store, ok.deps, event(), now)
    expect(retry.notified).toBe(true)
    expect(retry.notifyReason).toBe('first') // 仍無 sent 紀錄 → first
  })

  it('falls back to global webhook; skips with no_webhook when neither set', async () => {
    store.seedService({ ...svc, id: 's-2', name: 'svc-b', discordWebhookUrl: null })
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P1', match: {} })
    const { deps, sent } = fakeSender()
    deps.fallbackWebhookUrl = 'https://discord/global'
    const viaFallback = await processAndNotify(store, deps, event({ serviceId: 's-2' }), now)
    expect(viaFallback.notified).toBe(true)
    expect(sent[0].url).toBe('https://discord/global')

    const none = fakeSender()
    store.seedService({ ...svc, id: 's-3', name: 'svc-c', discordWebhookUrl: null })
    const skipped = await processAndNotify(store, none.deps, event({ serviceId: 's-3', fingerprint: 'fp-3' }), now)
    expect(skipped.notified).toBe(false)
    expect(skipped.notifyReason).toBe('no_webhook')
    expect(none.sent).toHaveLength(0)
  })

  it('duplicate events skip notification evaluation', async () => {
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P1', match: {} })
    const { deps, sent } = fakeSender()
    await processAndNotify(store, deps, event({ source: 'poll', metadata: { externalId: 'x' } }), now)
    const dup = await processAndNotify(store, deps, event({ source: 'poll', metadata: { externalId: 'x' } }), now)
    expect(dup.notifyReason).toBe('duplicate')
    expect(sent).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 確認 RED**

Run: `pnpm vitest run tests/pipeline/process-and-notify.test.ts`
Expected: FAIL（module not found）。

- [ ] **Step 3: 實作 `src/notify/discord.ts` 與 `src/pipeline/process-and-notify.ts`**

`src/notify/discord.ts`：

```typescript
import type { DiscordMessage } from '@/notify/message'

export type SendResult = { ok: true } | { ok: false; reason: string }
export type DiscordSender = (webhookUrl: string, message: DiscordMessage) => Promise<SendResult>

export const sendDiscordWebhook: DiscordSender = async (webhookUrl, message) => {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
    })
    if (response.status >= 200 && response.status < 300) return { ok: true }
    return { ok: false, reason: `http ${response.status}` }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.name : 'fetch_failed' }
  }
}
```

`src/pipeline/process-and-notify.ts`：

```typescript
import { processEvent, type ProcessResult } from '@/pipeline/process-event'
import { shouldNotify } from '@/notify/decision'
import { buildDiscordMessage } from '@/notify/message'
import type { DiscordSender } from '@/notify/discord'
import type { CanonicalEvent } from '@/core/types'
import type { Store } from '@/store/contracts'

export interface NotifyDeps {
  sender: DiscordSender
  fallbackWebhookUrl: string | null
  dashboardUrl?: string
}

export interface ProcessAndNotifyResult extends ProcessResult {
  notified: boolean
  notifyReason: string | null
}

export async function processAndNotify(
  store: Store,
  deps: NotifyDeps,
  event: CanonicalEvent,
  now: Date,
): Promise<ProcessAndNotifyResult> {
  const result = await processEvent(store, event, now)

  const lastSent = await store.getLatestSentNotification(event.serviceId, result.issue.fingerprint)
  const decision = shouldNotify({
    severity: result.issue.severity,
    duplicate: result.duplicate,
    lastSent,
    now,
  })
  if (!decision.notify) return { ...result, notified: false, notifyReason: decision.reason }

  const service = await store.getService(event.serviceId)
  const webhookUrl = service?.discordWebhookUrl ?? deps.fallbackWebhookUrl
  if (service === null || webhookUrl === null) {
    return { ...result, notified: false, notifyReason: 'no_webhook' }
  }

  const message = buildDiscordMessage({
    serviceName: service.name,
    severity: result.issue.severity,
    errorType: result.issue.errorType,
    message: result.issue.message,
    count: result.issue.count,
    firstSeen: result.issue.firstSeen,
    lastSeen: result.issue.lastSeen,
    ...(deps.dashboardUrl !== undefined ? { dashboardUrl: deps.dashboardUrl } : {}),
  })
  const sendResult = await deps.sender(webhookUrl, message)
  await store.recordNotification({
    issueId: result.issue.id,
    serviceId: event.serviceId,
    fingerprint: result.issue.fingerprint,
    severity: result.issue.severity,
    status: sendResult.ok ? 'sent' : 'failed',
    countAtSend: result.issue.count,
    sentAt: now.toISOString(),
  })
  return { ...result, notified: sendResult.ok, notifyReason: decision.reason }
}
```

（註：`processEvent` 需在 `src/pipeline/process-event.ts` 確認 `ProcessResult` 已 export——已是。）

- [ ] **Step 4: GREEN（process-and-notify 測試）**

Run: `pnpm vitest run tests/pipeline/process-and-notify.test.ts`
Expected: PASS。

- [ ] **Step 5: 接線——server deps、ingest、poller、routes**

`src/store/server.ts` 加：

```typescript
import { sendDiscordWebhook } from '@/notify/discord'
import type { NotifyDeps } from '@/pipeline/process-and-notify'

export function createServerNotifyDeps(): NotifyDeps {
  return {
    sender: sendDiscordWebhook,
    fallbackWebhookUrl: process.env.DISCORD_WEBHOOK_URL ?? null,
    ...(process.env.APP_URL !== undefined ? { dashboardUrl: process.env.APP_URL } : {}),
  }
}
```

`src/ingest/handle-ingest.ts`：簽章改 `handleIngest(store: Store, deps: NotifyDeps, request: IngestRequest, now: Date)`；`processEvent(store, event, now)` 改 `processAndNotify(store, deps, event, now)`（import 對應調整）；201 body 加 `notified: result.notified`。

`app/api/ingest/route.ts`：`handleIngest(createServerStore(), createServerNotifyDeps(), {...}, new Date())`。

`src/poll/poll-service.ts`：`pollService(store, http, deps: NotifyDeps, pollable, now)`、`runPoll(store, http, deps: NotifyDeps, now)`；兩處 `processEvent(...)` 改 `processAndNotify(store, deps, ...)`（health-fail 與 polled errors）。

`app/api/poll/services/route.ts`：`runPoll(createServerStore(), httpGet, createServerNotifyDeps(), new Date())`。

- [ ] **Step 6: 更新既有測試的呼叫簽章**

`tests/ingest/handle-ingest.test.ts` 與 `tests/poll/poll-service.test.ts`：檔頭加共用 fake deps——

```typescript
const noopDeps = {
  sender: async () => ({ ok: true }) as const,
  fallbackWebhookUrl: null,
}
```

（型別以 `NotifyDeps` 註記；`as const` 若 typecheck 不合改 `{ ok: true as const }`。）所有 `handleIngest(store, ` 呼叫改為 `handleIngest(store, noopDeps, `；所有 `pollService(store, http, ` 改為 `pollService(store, http, noopDeps, `；`runPoll(store, http, now)` 改 `runPoll(store, http, noopDeps, now)`。斷言不動（noop sender 全部成功、通知不影響既有斷言的管線行為）。

- [ ] **Step 7: 全量回歸 + build**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: 全綠、兩個 route 編譯過。

- [ ] **Step 8: Commit**

```bash
git add src/notify/discord.ts src/pipeline/process-and-notify.ts src/store/server.ts src/ingest/handle-ingest.ts app/api/ingest/route.ts src/poll/poll-service.ts app/api/poll/services/route.ts tests/pipeline/process-and-notify.test.ts tests/ingest/handle-ingest.test.ts tests/poll/poll-service.test.ts
git commit -m "feat(notify): Discord notifications wired into ingest and poller"
```

---

### Task 5: 整合測試（stub Discord + 真 DB）+ spec 定案更新 + 全量回歸

**Files:**
- Test: `tests/integration/notify.test.ts`
- Modify: `tests/integration/poll-route.test.ts`（runPoll 簽章已變？——否，route 內部組裝，不需改；僅確認仍綠）
- Modify: `docs/superpowers/specs/2026-07-23-service-monitoring-dashboard-design.md`（§4.4 ratchet、§4.6 定案值、§4.1 201 body 加 notified）
- Modify: `.env.example`（加 `DISCORD_WEBHOOK_URL`、`APP_URL` 註解）

**Interfaces:**
- Consumes: ingest route 的 `POST`、stub Discord server（node:http 隨機 port 收 webhook POST）、真 DB。

- [ ] **Step 1: 寫 `tests/integration/notify.test.ts`**

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHmac } from 'node:crypto'
import { createServiceRoleClient, cleanDatabase, getLocalSupabaseEnv } from './helpers'
import { POST } from '@/../app/api/ingest/route'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/db/database.types'

let client: SupabaseClient<Database>
let serviceId: string
let discordStub: Server
let webhookUrl: string
const received: Array<Record<string, unknown>> = []
const secret = 'notify-secret'

function signedRequest(body: string): Request {
  const ts = String(Math.floor(Date.now() / 1000))
  const sig = `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`
  return new Request('http://localhost/api/ingest', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-beacon-service': 'svc-notify',
      'x-beacon-timestamp': ts,
      'x-beacon-signature': sig,
    },
    body,
  })
}

beforeAll(async () => {
  const { url, serviceRoleKey } = getLocalSupabaseEnv()
  process.env.SUPABASE_URL = url
  process.env.SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey
  client = createServiceRoleClient()

  discordStub = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      received.push(JSON.parse(raw))
      res.writeHead(204).end()
    })
  })
  await new Promise<void>((resolve) => discordStub.listen(0, '127.0.0.1', resolve))
  const address = discordStub.address() as AddressInfo
  webhookUrl = `http://127.0.0.1:${address.port}/webhook`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => discordStub.close((e) => (e ? reject(e) : resolve())))
})

beforeEach(async () => {
  await cleanDatabase(client)
  received.length = 0
  const { data, error } = await client
    .from('services')
    .insert({ name: 'svc-notify', webhook_secret: secret, discord_webhook_url: webhookUrl })
    .select('id')
    .single()
  if (error) throw error
  serviceId = data.id
  await client.from('triage_rules').insert([
    { service_id: null, priority: 10, severity: 'P1', tags: ['ci'], match: { errorType: 'test_failure' } as Json },
    {
      service_id: null,
      priority: 20,
      severity: 'P0',
      match: { errorType: 'test_failure', minCountInWindow: 3, windowMinutes: 60 } as Json,
    },
  ])
})

describe('Discord notifications end-to-end (ingest route → stub webhook)', () => {
  const body = JSON.stringify({ message: 'nightly tests failed', errorType: 'test_failure' })

  it('first P1 sends embed and records notification; cooldown suppresses repeat', async () => {
    const first = await POST(signedRequest(body))
    expect(first.status).toBe(201)
    expect((await first.json()).notified).toBe(true)
    expect(received).toHaveLength(1)
    expect((received[0].embeds as Array<{ title: string }>)[0].title).toBe(
      '[P1] svc-notify — test_failure',
    )

    const second = await POST(signedRequest(body))
    expect((await second.json()).notified).toBe(false)
    expect(received).toHaveLength(1) // 冷卻期內不重發

    const { data: rows } = await client
      .from('notifications')
      .select('severity,status,count_at_send')
      .eq('service_id', serviceId)
    expect(rows).toHaveLength(1)
    expect(rows![0]).toMatchObject({ severity: 'P1', status: 'sent', count_at_send: 1 })
  })

  it('escalation to P0 bypasses cooldown and re-sends', async () => {
    await POST(signedRequest(body)) // count 1 → P1, sent
    await POST(signedRequest(body)) // count 2 → still P1, cooldown
    const third = await POST(signedRequest(body)) // count 3 → P0 escalation
    expect((await third.json())).toMatchObject({ severity: 'P0', notified: true })
    expect(received).toHaveLength(2)
    expect((received[1].embeds as Array<{ title: string }>)[0].title).toBe(
      '[P0] svc-notify — test_failure',
    )
    const { data: rows } = await client
      .from('notifications')
      .select('severity')
      .eq('service_id', serviceId)
      .order('sent_at')
    expect(rows!.map((r) => r.severity)).toEqual(['P1', 'P0'])
  })
})
```

- [ ] **Step 2: 執行整合測試 + 確認 poll-route 不受影響**

Run: `pnpm test:integration`
Expected: 全綠（既有 + notify 新 2 個；poll-route 測試因 route 內部組裝 deps 不需改動）。

- [ ] **Step 3: spec 定案更新**

`docs/superpowers/specs/2026-07-23-service-monitoring-dashboard-design.md`：

§4.4 規則引擎末尾加一行 bullet：

```markdown
- **Ratchet（已拍板）**：severity 只升不降——規則回落（如頻率超窗）時 issue 維持歷史最嚴重值，tags 一併凍結；人工降級走操作狀態（resolve/ignore）。
```

§4.6 Discord 通知器末尾加：

```markdown
- **定案值**：門檻 P1（P2 不發）；冷卻 30 分鐘；升級無視冷卻立即追發；冷卻判斷只計 `status='sent'`；發送失敗記 `failed` 且不阻斷管線（下次事件自動重試）；webhook 解析 `services.discord_webhook_url` → env `DISCORD_WEBHOOK_URL`，皆無則跳過。
```

§4.1 Wire 契約的 201 說明由 `201 成功（回 issueId/severity/health/duplicate）` 改為 `201 成功（回 issueId/severity/health/duplicate/notified）`。

- [ ] **Step 4: `.env.example` 追加**

```bash
# Discord 通知（選填）：全域 fallback webhook 與 dashboard 連結
DISCORD_WEBHOOK_URL=
APP_URL=
```

- [ ] **Step 5: 全量回歸**

Run: `pnpm test && pnpm typecheck && pnpm test:integration && pnpm build`
Expected: 四綠。

- [ ] **Step 6: Commit**

```bash
git add tests/integration/notify.test.ts docs/superpowers/specs/2026-07-23-service-monitoring-dashboard-design.md .env.example
git commit -m "test(notify): end-to-end Discord notification flow; spec finalized"
```

---

## 完成後

Plan 6 交付完整告警鏈：事件 → 判級（ratchet）→ 門檻/冷卻/升級決策 → Discord embed → `notifications` 稽核，ingest 與 poller 共用同一 `processAndNotify` 入口。**spec 三大功能（健康度總覽資料、檢傷分類、重要錯誤即時告警）的後端全部就位**。下一份 **Plan 7｜Dashboard**（服務總覽 + 檢傷列表 + Supabase Auth + Realtime + dashboard 讀取 policy——注意 Plan 2 的交接：對 services 開放讀取時須以 column grant/view 排除 `webhook_secret` 與 `discord_webhook_url`）。
