# 持久層與管線接線（Store port + orchestrator + SupabaseStore）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **REQUIRED SUB-SKILL for DB task（Task 4/5）：** `supabase:supabase` skill。整合測試需本地 stack 在跑（OrbStack + `supabase start`）。

**Goal:** 把 Plan 1 的純函式串成實際管線：定義 `Store` port，提供 `InMemoryStore`（純 TDD）與 `SupabaseStore`（本地整合測試），實作 `processEvent` orchestrator（`upsert issue → 判級 → 更新健康度`），並落實 Plan 2 最終 review 指定的持久化契約。

**Architecture:** Hexagonal——`src/pipeline/process-event.ts`（orchestrator）只依賴 `src/store/contracts.ts` 的 `Store` 介面與注入時鐘，不知道 DB 存在；`InMemoryStore` 讓 orchestrator 全程純 TDD；`SupabaseStore` 用 supabase-js（service_role）實作同一 port，其中 upsert 以 Postgres function（rpc）保證原子性。單元測試不碰 DB；整合測試打本地 Supabase。

**Tech Stack:** TypeScript（strict）、Vitest、@supabase/supabase-js、Supabase 本地 stack（CLI 2.98.1 / OrbStack）、Postgres function（plpgsql）。

## Global Constraints

- 套件管理一律 **pnpm**；TypeScript strict。
- `src/core/**` 維持**純函式**（本計畫只在 `src/core/types.ts` 增欄位，不加 I/O）。supabase-js 只准出現在 `src/store/supabase.ts` 與 `tests/integration/**`。
- 時間一律注入（參數傳 `Date`），任何 `src/**` 不得呼叫 `Date.now()`/無參數 `new Date()`（DB 端 `now()` 除外）。
- 單元測試（`pnpm test`）**不需要** DB；整合測試獨立指令 `pnpm test:integration`（需本地 stack 在跑），vitest 主設定必須排除 `tests/integration/**`。
- migration 檔名一律由 `supabase migration new <name>` 產生；變更後 `supabase db reset` → advisors 無 ERROR → `pnpm db:types` 重生型別（自動產物勿手改）。
- **Plan 2 最終 review 的必要驗收條件（原文，逐條落實）：**
  1. **externalId lift 契約**：`normalizePolledError` 把 `externalId` 放在 `metadata.externalId`，但 poll 去重靠 `events.external_id` 欄位的 partial unique index。adapter **必須**把 `externalId` 提升到 `events.external_id` 欄位（否則去重靜默失效），並測試：重複 externalId 落地時 issue.count 不重複累計。
  2. **triage_rules 的 service_id 單一權威來源**：規則引擎只認 `match.serviceId`；DB 另有 `triage_rules.service_id` 欄位（null=全域）。載入規則時以查詢端過濾（`service_id = $1 or service_id is null`）為權威，jsonb `match` 內不重複放 serviceId（mapper 一律忽略），加測試防「規則意外全域套用」。
  3. 產生型別中 severity/status/source 為寬鬆 `string`：載回 domain 型別時必須 narrow/驗證，不可直接 cast。
  4. Plan 1 的 `Issue` 介面無 `tags` 欄位而 DB 有：擴充 `Issue.tags: string[]`。

## 本計畫涵蓋 vs. 後續計畫

**做（對應 spec §3 管線、§4.3–4.5 的持久化接線）：** Store port、row↔domain mapping（含 narrow 驗證）、InMemoryStore、`processEvent` orchestrator、`upsert_issue_with_event` Postgres function migration、SupabaseStore、整合測試。

**不做：** HTTP 入口／HMAC／Cron（Plan 4）；poll 成功清除 health issue 與 PollState 寫回（Plan 4，poller 職責）；Discord 通知（Plan 5，`processEvent` 已回傳 `previousSeverity` 供升級判斷）；dashboard／Auth／Realtime policy（Plan 6）；issue 操作狀態變更 API（Plan 6）。

---

### Task 1: Issue.tags 擴充 + row↔domain mapping（narrow 驗證）

**Files:**
- Modify: `src/core/types.ts`（`Issue` 加 `tags`）
- Create: `src/store/contracts.ts`（`StoredIssue`、`ServiceRecord`、`UpsertOutcome`、`Store`）
- Create: `src/store/mapping.ts`
- Test: `tests/store/mapping.test.ts`

**Interfaces:**
- Consumes: `Database`（`@/db/database.types`）、`Issue`/`Severity`/`IssueStatus`/`HealthStatus`/`EventSource`（`@/core/types`）、`TriageRule`/`RuleMatch`（`@/core/rules`）、`PollState`（`@/core/health`）。
- Produces（後續 task 依賴的精確簽章）：
  - `Issue` 新增欄位 `tags: string[]`。
  - `interface StoredIssue extends Issue { id: string }`
  - `interface ServiceRecord { id: string; name: string; healthWindowMinutes: number; healthFailureThreshold: number; healthStatus: HealthStatus; poll: PollState | null }`
  - `interface UpsertOutcome { issue: StoredIssue; created: boolean; duplicate: boolean }`
  - `interface Store { getService(serviceId: string): Promise<ServiceRecord | null>; upsertIssueWithEvent(event: CanonicalEvent): Promise<UpsertOutcome>; loadRules(serviceId: string): Promise<TriageRule[]>; updateIssueTriage(issueId: string, severity: Severity, tags: string[]): Promise<void>; listOpenIssues(serviceId: string): Promise<OpenIssue[]>; updateServiceHealth(serviceId: string, health: HealthStatus): Promise<void> }`
  - mapping：`narrowSeverity/narrowIssueStatus/narrowHealthStatus/narrowEventSource(v: string)`（非法值 throw）、`rowToIssue(row): StoredIssue`、`rowToService(row): ServiceRecord`、`ruleRowToTriageRule(row): TriageRule`。

- [ ] **Step 1: 修改 `src/core/types.ts` —— `Issue` 加 `tags`**

在 `Issue` interface 的 `message: string` 之後加一行：

```typescript
  tags: string[]
```

Run: `pnpm test && pnpm typecheck`
Expected: 既有 25 tests 全過、typecheck 乾淨（`IssueForEval`/`OpenIssue` 是 Pick，不含 tags，不受影響）。

- [ ] **Step 2: 建立 `src/store/contracts.ts`**

```typescript
import type { CanonicalEvent, HealthStatus, Issue, Severity } from '@/core/types'
import type { TriageRule } from '@/core/rules'
import type { OpenIssue, PollState } from '@/core/health'

export interface StoredIssue extends Issue {
  id: string
}

export interface ServiceRecord {
  id: string
  name: string
  healthWindowMinutes: number
  healthFailureThreshold: number
  healthStatus: HealthStatus
  poll: PollState | null
}

export interface UpsertOutcome {
  issue: StoredIssue
  created: boolean
  duplicate: boolean
}

export interface Store {
  getService(serviceId: string): Promise<ServiceRecord | null>
  upsertIssueWithEvent(event: CanonicalEvent): Promise<UpsertOutcome>
  loadRules(serviceId: string): Promise<TriageRule[]>
  updateIssueTriage(issueId: string, severity: Severity, tags: string[]): Promise<void>
  listOpenIssues(serviceId: string): Promise<OpenIssue[]>
  updateServiceHealth(serviceId: string, health: HealthStatus): Promise<void>
}
```

- [ ] **Step 3: 寫失敗測試 `tests/store/mapping.test.ts`**

```typescript
import { describe, it, expect } from 'vitest'
import {
  narrowSeverity,
  narrowIssueStatus,
  narrowHealthStatus,
  narrowEventSource,
  rowToIssue,
  rowToService,
  ruleRowToTriageRule,
} from '@/store/mapping'
import type { Database } from '@/db/database.types'

type IssueRow = Database['public']['Tables']['issues']['Row']
type ServiceRow = Database['public']['Tables']['services']['Row']
type RuleRow = Database['public']['Tables']['triage_rules']['Row']

const issueRow: IssueRow = {
  id: 'i-1',
  service_id: 's-1',
  fingerprint: 'fp',
  severity: 'P1',
  status: 'acknowledged',
  count: 3,
  first_seen: '2026-07-27T10:00:00+00:00',
  last_seen: '2026-07-27T10:05:00+00:00',
  level: 'error',
  error_type: 'TypeError',
  message: 'boom',
  tags: ['db'],
  created_at: '2026-07-27T10:00:00+00:00',
  updated_at: '2026-07-27T10:05:00+00:00',
}

const serviceRow: ServiceRow = {
  id: 's-1',
  name: 'svc-a',
  webhook_secret: null,
  discord_webhook_url: null,
  health_window_minutes: 15,
  health_failure_threshold: 2,
  poll_health_url: 'https://a/health',
  poll_error_url: null,
  poll_interval_seconds: 60,
  poll_timeout_ms: 5000,
  poll_expected_status: 200,
  poll_cursor: null,
  poll_consecutive_failures: 1,
  last_poll_at: '2026-07-27T10:04:00+00:00',
  last_poll_healthy: false,
  health_status: 'degraded',
  created_at: '2026-07-27T09:00:00+00:00',
  updated_at: '2026-07-27T10:04:00+00:00',
}

const ruleRow: RuleRow = {
  id: 'r-1',
  service_id: 's-1',
  priority: 10,
  severity: 'P0',
  tags: ['db'],
  match: { errorType: 'TypeError', minCountInWindow: 5, serviceId: 'SHOULD-BE-IGNORED' },
  enabled: true,
  created_at: '2026-07-27T09:00:00+00:00',
}

describe('narrow validators', () => {
  it('pass through valid values and throw on invalid', () => {
    expect(narrowSeverity('P0')).toBe('P0')
    expect(narrowIssueStatus('resolved')).toBe('resolved')
    expect(narrowHealthStatus('down')).toBe('down')
    expect(narrowEventSource('poll')).toBe('poll')
    expect(() => narrowSeverity('P9')).toThrow(/invalid severity/)
    expect(() => narrowIssueStatus('closed')).toThrow(/invalid issue status/)
    expect(() => narrowHealthStatus('ok')).toThrow(/invalid health status/)
    expect(() => narrowEventSource('sentry')).toThrow(/invalid event source/)
  })
})

describe('rowToIssue', () => {
  it('maps snake_case row to StoredIssue with narrowed unions', () => {
    expect(rowToIssue(issueRow)).toEqual({
      id: 'i-1',
      serviceId: 's-1',
      fingerprint: 'fp',
      severity: 'P1',
      status: 'acknowledged',
      count: 3,
      firstSeen: '2026-07-27T10:00:00+00:00',
      lastSeen: '2026-07-27T10:05:00+00:00',
      level: 'error',
      errorType: 'TypeError',
      message: 'boom',
      tags: ['db'],
    })
  })

  it('throws on invalid severity in row', () => {
    expect(() => rowToIssue({ ...issueRow, severity: 'P9' })).toThrow(/invalid severity/)
  })
})

describe('rowToService', () => {
  it('maps poll state when poll_health_url is configured', () => {
    expect(rowToService(serviceRow)).toEqual({
      id: 's-1',
      name: 'svc-a',
      healthWindowMinutes: 15,
      healthFailureThreshold: 2,
      healthStatus: 'degraded',
      poll: { lastPollAt: '2026-07-27T10:04:00+00:00', healthy: false, consecutiveFailures: 1 },
    })
  })

  it('maps poll to null when health polling is not configured', () => {
    expect(rowToService({ ...serviceRow, poll_health_url: null }).poll).toBeNull()
  })
})

describe('ruleRowToTriageRule', () => {
  it('maps columns and validated match, ignoring any serviceId inside jsonb', () => {
    const rule = ruleRowToTriageRule(ruleRow)
    expect(rule).toEqual({
      id: 'r-1',
      priority: 10,
      severity: 'P0',
      tags: ['db'],
      match: { errorType: 'TypeError', minCountInWindow: 5 },
    })
    expect('serviceId' in rule.match).toBe(false)
  })

  it('rejects non-object match', () => {
    expect(() => ruleRowToTriageRule({ ...ruleRow, match: 'nope' })).toThrow(/must be a JSON object/)
    expect(() => ruleRowToTriageRule({ ...ruleRow, match: [1] })).toThrow(/must be a JSON object/)
  })

  it('rejects wrongly-typed match fields', () => {
    expect(() => ruleRowToTriageRule({ ...ruleRow, match: { errorType: 7 } })).toThrow(/match\.errorType/)
    expect(() => ruleRowToTriageRule({ ...ruleRow, match: { windowMinutes: 'x' } })).toThrow(/match\.windowMinutes/)
  })
})
```

- [ ] **Step 4: 執行測試確認失敗**

Run: `pnpm vitest run tests/store/mapping.test.ts`
Expected: FAIL（`Cannot find module '@/store/mapping'`）。

- [ ] **Step 5: 實作 `src/store/mapping.ts`**

```typescript
import type { Database } from '@/db/database.types'
import type { EventSource, HealthStatus, IssueStatus, Severity } from '@/core/types'
import type { RuleMatch, TriageRule } from '@/core/rules'
import type { ServiceRecord, StoredIssue } from '@/store/contracts'

type IssueRow = Database['public']['Tables']['issues']['Row']
type ServiceRow = Database['public']['Tables']['services']['Row']
type RuleRow = Database['public']['Tables']['triage_rules']['Row']

const SEVERITIES: readonly Severity[] = ['P0', 'P1', 'P2']
const ISSUE_STATUSES: readonly IssueStatus[] = ['open', 'acknowledged', 'resolved', 'ignored']
const HEALTH_STATUSES: readonly HealthStatus[] = ['down', 'degraded', 'healthy']
const EVENT_SOURCES: readonly EventSource[] = ['push', 'poll']

function narrow<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T
  throw new Error(`invalid ${label}: ${value}`)
}

export const narrowSeverity = (v: string): Severity => narrow(v, SEVERITIES, 'severity')
export const narrowIssueStatus = (v: string): IssueStatus => narrow(v, ISSUE_STATUSES, 'issue status')
export const narrowHealthStatus = (v: string): HealthStatus => narrow(v, HEALTH_STATUSES, 'health status')
export const narrowEventSource = (v: string): EventSource => narrow(v, EVENT_SOURCES, 'event source')

export function rowToIssue(row: IssueRow): StoredIssue {
  return {
    id: row.id,
    serviceId: row.service_id,
    fingerprint: row.fingerprint,
    severity: narrowSeverity(row.severity),
    status: narrowIssueStatus(row.status),
    count: row.count,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    level: row.level,
    errorType: row.error_type,
    message: row.message,
    tags: row.tags,
  }
}

export function rowToService(row: ServiceRow): ServiceRecord {
  return {
    id: row.id,
    name: row.name,
    healthWindowMinutes: row.health_window_minutes,
    healthFailureThreshold: row.health_failure_threshold,
    healthStatus: narrowHealthStatus(row.health_status),
    poll:
      row.poll_health_url === null
        ? null
        : {
            lastPollAt: row.last_poll_at,
            healthy: row.last_poll_healthy,
            consecutiveFailures: row.poll_consecutive_failures,
          },
  }
}

const MATCH_STRING_KEYS = ['level', 'errorType', 'messageIncludes'] as const
const MATCH_NUMBER_KEYS = ['minCountInWindow', 'windowMinutes'] as const

export function ruleRowToTriageRule(row: RuleRow): TriageRule {
  const raw = row.match
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`triage_rules.match must be a JSON object (rule ${row.id})`)
  }
  const source = raw as Record<string, unknown>
  const match: RuleMatch = {}
  for (const key of MATCH_STRING_KEYS) {
    const value = source[key]
    if (value !== undefined) {
      if (typeof value !== 'string') throw new Error(`match.${key} must be a string (rule ${row.id})`)
      match[key] = value
    }
  }
  for (const key of MATCH_NUMBER_KEYS) {
    const value = source[key]
    if (value !== undefined) {
      if (typeof value !== 'number') throw new Error(`match.${key} must be a number (rule ${row.id})`)
      match[key] = value
    }
  }
  // serviceId 的權威是 triage_rules.service_id 欄位（載入時查詢端過濾）；
  // jsonb 內出現 serviceId 一律忽略，避免雙重來源（Plan 2 review 驗收條件 #2）。
  return {
    id: row.id,
    priority: row.priority,
    severity: narrowSeverity(row.severity),
    tags: row.tags,
    match,
  }
}
```

- [ ] **Step 6: 執行測試確認通過 + 全量回歸**

Run: `pnpm vitest run tests/store/mapping.test.ts && pnpm test && pnpm typecheck`
Expected: 全 PASS、typecheck 乾淨。

- [ ] **Step 7: Commit**

```bash
git add src/core/types.ts src/store/contracts.ts src/store/mapping.ts tests/store/mapping.test.ts
git commit -m "feat(store): Store port, Issue.tags, row-domain mapping with narrowing"
```

---

### Task 2: InMemoryStore

**Files:**
- Create: `src/store/memory.ts`
- Test: `tests/store/memory.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Store`/`StoredIssue`/`ServiceRecord`/`UpsertOutcome`、`CanonicalEvent`、`TriageRule`、`OpenIssue`。
- Produces：`class InMemoryStore implements Store`，另含測試用 seed helpers：`seedService(service: ServiceRecord): void`、`seedRule(serviceId: string | null, rule: TriageRule): void`、`setIssueStatus(issueId: string, status: IssueStatus): void`（test seam，非 port 成員）。
- Upsert 語意（與 Task 4 的 SQL function 行為一致，是雙實作的共同契約）：
  - `metadata.externalId` 為 string 且（serviceId, externalId）已見過 → `duplicate: true`，count 不變，回既有 issue。
  - 新 fingerprint → 建 issue：`severity 'P2'`、`status 'open'`、`count 1`、first/last seen = `occurredAt`、`tags []`，`created: true`。
  - 既有 fingerprint → `count + 1`、`lastSeen = max(舊, occurredAt)`、`level` 取最新；`status === 'resolved'` → 回 `'open'`（regression 重開）；`'ignored'` 不變。

- [ ] **Step 1: 寫失敗測試 `tests/store/memory.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryStore } from '@/store/memory'
import type { ServiceRecord } from '@/store/contracts'
import type { CanonicalEvent } from '@/core/types'

const svc: ServiceRecord = {
  id: 's-1',
  name: 'svc-a',
  healthWindowMinutes: 15,
  healthFailureThreshold: 2,
  healthStatus: 'healthy',
  poll: null,
}

const event = (over: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  serviceId: 's-1',
  source: 'push',
  level: 'error',
  errorType: 'TypeError',
  message: 'boom',
  fingerprint: 'fp-1',
  occurredAt: '2026-07-27T10:00:00.000Z',
  metadata: {},
  ...over,
})

describe('InMemoryStore', () => {
  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc)
  })

  it('creates a new issue with defaults on first event', async () => {
    const { issue, created, duplicate } = await store.upsertIssueWithEvent(event())
    expect(created).toBe(true)
    expect(duplicate).toBe(false)
    expect(issue).toMatchObject({
      serviceId: 's-1',
      fingerprint: 'fp-1',
      severity: 'P2',
      status: 'open',
      count: 1,
      firstSeen: '2026-07-27T10:00:00.000Z',
      lastSeen: '2026-07-27T10:00:00.000Z',
      tags: [],
    })
  })

  it('increments count and advances lastSeen on same fingerprint', async () => {
    await store.upsertIssueWithEvent(event())
    const { issue, created } = await store.upsertIssueWithEvent(
      event({ occurredAt: '2026-07-27T10:05:00.000Z' }),
    )
    expect(created).toBe(false)
    expect(issue.count).toBe(2)
    expect(issue.lastSeen).toBe('2026-07-27T10:05:00.000Z')
    expect(issue.firstSeen).toBe('2026-07-27T10:00:00.000Z')
  })

  it('does not move lastSeen backwards for late-arriving events', async () => {
    await store.upsertIssueWithEvent(event({ occurredAt: '2026-07-27T10:05:00.000Z' }))
    const { issue } = await store.upsertIssueWithEvent(event({ occurredAt: '2026-07-27T10:01:00.000Z' }))
    expect(issue.count).toBe(2)
    expect(issue.lastSeen).toBe('2026-07-27T10:05:00.000Z')
  })

  it('dedupes by (serviceId, externalId): no count increment', async () => {
    const first = await store.upsertIssueWithEvent(event({ metadata: { externalId: 'x-1' } }))
    const second = await store.upsertIssueWithEvent(event({ metadata: { externalId: 'x-1' } }))
    expect(second.duplicate).toBe(true)
    expect(second.issue.id).toBe(first.issue.id)
    expect(second.issue.count).toBe(1)
  })

  it('never dedupes events without externalId', async () => {
    await store.upsertIssueWithEvent(event())
    const { issue, duplicate } = await store.upsertIssueWithEvent(event())
    expect(duplicate).toBe(false)
    expect(issue.count).toBe(2)
  })

  it('reopens a resolved issue on new event; ignored stays ignored', async () => {
    const { issue } = await store.upsertIssueWithEvent(event())
    store.setIssueStatus(issue.id, 'resolved')
    const reopened = await store.upsertIssueWithEvent(event())
    expect(reopened.issue.status).toBe('open')

    store.setIssueStatus(issue.id, 'ignored')
    const still = await store.upsertIssueWithEvent(event())
    expect(still.issue.status).toBe('ignored')
  })

  it('loadRules returns global + matching service rules only', async () => {
    const rule = (id: string) => ({ id, priority: 1, severity: 'P1' as const, match: {} })
    store.seedRule('s-1', rule('mine'))
    store.seedRule('s-2', rule('other'))
    store.seedRule(null, rule('global'))
    const rules = await store.loadRules('s-1')
    expect(rules.map((r) => r.id).sort()).toEqual(['global', 'mine'])
  })

  it('updateIssueTriage persists severity and tags', async () => {
    const { issue } = await store.upsertIssueWithEvent(event())
    await store.updateIssueTriage(issue.id, 'P0', ['db'])
    const open = await store.listOpenIssues('s-1')
    expect(open).toEqual([
      { severity: 'P0', status: 'open', lastSeen: '2026-07-27T10:00:00.000Z' },
    ])
  })

  it('listOpenIssues excludes resolved/ignored', async () => {
    const { issue } = await store.upsertIssueWithEvent(event())
    store.setIssueStatus(issue.id, 'resolved')
    expect(await store.listOpenIssues('s-1')).toEqual([])
  })

  it('updateServiceHealth + getService roundtrip', async () => {
    await store.updateServiceHealth('s-1', 'down')
    expect((await store.getService('s-1'))?.healthStatus).toBe('down')
    expect(await store.getService('nope')).toBeNull()
  })
})
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm vitest run tests/store/memory.test.ts`
Expected: FAIL（`Cannot find module '@/store/memory'`）。

- [ ] **Step 3: 實作 `src/store/memory.ts`**

```typescript
import type { CanonicalEvent, HealthStatus, IssueStatus, Severity } from '@/core/types'
import type { TriageRule } from '@/core/rules'
import type { OpenIssue } from '@/core/health'
import type { ServiceRecord, Store, StoredIssue, UpsertOutcome } from '@/store/contracts'

interface SeededRule {
  serviceId: string | null
  rule: TriageRule
}

export class InMemoryStore implements Store {
  private services = new Map<string, ServiceRecord>()
  private issues = new Map<string, StoredIssue>() // key: `${serviceId}:${fingerprint}`
  private dedup = new Map<string, string>() // key: `${serviceId}:${externalId}` → issueId
  private rules: SeededRule[] = []
  private nextId = 1

  seedService(service: ServiceRecord): void {
    this.services.set(service.id, service)
  }

  seedRule(serviceId: string | null, rule: TriageRule): void {
    this.rules.push({ serviceId, rule })
  }

  setIssueStatus(issueId: string, status: IssueStatus): void {
    for (const [key, issue] of this.issues) {
      if (issue.id === issueId) {
        this.issues.set(key, { ...issue, status })
        return
      }
    }
    throw new Error(`unknown issue: ${issueId}`)
  }

  async getService(serviceId: string): Promise<ServiceRecord | null> {
    return this.services.get(serviceId) ?? null
  }

  async upsertIssueWithEvent(event: CanonicalEvent): Promise<UpsertOutcome> {
    const externalId =
      typeof event.metadata.externalId === 'string' ? event.metadata.externalId : null

    if (externalId !== null) {
      const issueId = this.dedup.get(`${event.serviceId}:${externalId}`)
      if (issueId !== undefined) {
        const issue = this.findIssueById(issueId)
        return { issue, created: false, duplicate: true }
      }
    }

    const key = `${event.serviceId}:${event.fingerprint}`
    const existing = this.issues.get(key)
    let issue: StoredIssue
    let created = false

    if (existing === undefined) {
      issue = {
        id: `issue-${this.nextId++}`,
        serviceId: event.serviceId,
        fingerprint: event.fingerprint,
        severity: 'P2',
        status: 'open',
        count: 1,
        firstSeen: event.occurredAt,
        lastSeen: event.occurredAt,
        level: event.level,
        errorType: event.errorType,
        message: event.message,
        tags: [],
      }
      created = true
    } else {
      issue = {
        ...existing,
        count: existing.count + 1,
        lastSeen:
          new Date(existing.lastSeen) >= new Date(event.occurredAt)
            ? existing.lastSeen
            : event.occurredAt,
        level: event.level,
        status: existing.status === 'resolved' ? 'open' : existing.status,
      }
    }

    this.issues.set(key, issue)
    if (externalId !== null) this.dedup.set(`${event.serviceId}:${externalId}`, issue.id)
    return { issue, created, duplicate: false }
  }

  async loadRules(serviceId: string): Promise<TriageRule[]> {
    return this.rules
      .filter((r) => r.serviceId === null || r.serviceId === serviceId)
      .map((r) => r.rule)
  }

  async updateIssueTriage(issueId: string, severity: Severity, tags: string[]): Promise<void> {
    for (const [key, issue] of this.issues) {
      if (issue.id === issueId) {
        this.issues.set(key, { ...issue, severity, tags })
        return
      }
    }
    throw new Error(`unknown issue: ${issueId}`)
  }

  async listOpenIssues(serviceId: string): Promise<OpenIssue[]> {
    return [...this.issues.values()]
      .filter(
        (i) =>
          i.serviceId === serviceId && (i.status === 'open' || i.status === 'acknowledged'),
      )
      .map((i) => ({ severity: i.severity, status: i.status, lastSeen: i.lastSeen }))
  }

  async updateServiceHealth(serviceId: string, health: HealthStatus): Promise<void> {
    const service = this.services.get(serviceId)
    if (service === undefined) throw new Error(`unknown service: ${serviceId}`)
    this.services.set(serviceId, { ...service, healthStatus: health })
  }

  private findIssueById(issueId: string): StoredIssue {
    for (const issue of this.issues.values()) {
      if (issue.id === issueId) return issue
    }
    throw new Error(`inconsistent store: dedup entry without issue ${issueId}`)
  }
}
```

- [ ] **Step 4: 執行測試確認通過 + 回歸**

Run: `pnpm vitest run tests/store/memory.test.ts && pnpm test && pnpm typecheck`
Expected: 全 PASS、typecheck 乾淨。

- [ ] **Step 5: Commit**

```bash
git add src/store/memory.ts tests/store/memory.test.ts
git commit -m "feat(store): InMemoryStore with upsert/dedup/reopen semantics"
```

---

### Task 3: `processEvent` orchestrator

**Files:**
- Create: `src/pipeline/process-event.ts`
- Test: `tests/pipeline/process-event.test.ts`

**Interfaces:**
- Consumes: `Store`/`StoredIssue`（`@/store/contracts`）、`evaluateSeverity`（`@/core/rules`）、`deriveHealth`（`@/core/health`）、`InMemoryStore`（測試）。
- Produces：
  - `interface ProcessResult { issue: StoredIssue; created: boolean; duplicate: boolean; previousSeverity: Severity | null; health: HealthStatus }`
  - `processEvent(store: Store, event: CanonicalEvent, now: Date): Promise<ProcessResult>`
  - 語意：unknown service → throw；duplicate → 短路（不判級、不重算健康度，回當前 `service.healthStatus`）；否則 upsert → `evaluateSeverity`（severity/tags 有變才寫回）→ `listOpenIssues`（已含新 severity）→ `deriveHealth` → 健康度有變才寫回。`previousSeverity`：新建為 `null`，否則為本次判級前的 severity（Plan 5 靠它判斷升級追發）。

- [ ] **Step 1: 寫失敗測試 `tests/pipeline/process-event.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { processEvent } from '@/pipeline/process-event'
import { InMemoryStore } from '@/store/memory'
import type { ServiceRecord } from '@/store/contracts'
import type { CanonicalEvent } from '@/core/types'

const now = new Date('2026-07-27T10:10:00.000Z')

const svc: ServiceRecord = {
  id: 's-1',
  name: 'svc-a',
  healthWindowMinutes: 15,
  healthFailureThreshold: 2,
  healthStatus: 'healthy',
  poll: null,
}

const event = (over: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  serviceId: 's-1',
  source: 'push',
  level: 'error',
  errorType: 'TypeError',
  message: 'boom',
  fingerprint: 'fp-1',
  occurredAt: '2026-07-27T10:09:00.000Z',
  metadata: {},
  ...over,
})

describe('processEvent', () => {
  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc)
  })

  it('throws on unknown service', async () => {
    await expect(processEvent(store, event({ serviceId: 'nope' }), now)).rejects.toThrow(
      /unknown service/,
    )
  })

  it('new event with no rules: P2 issue, service stays healthy', async () => {
    const result = await processEvent(store, event(), now)
    expect(result.created).toBe(true)
    expect(result.previousSeverity).toBeNull()
    expect(result.issue.severity).toBe('P2')
    expect(result.health).toBe('healthy')
    expect((await store.getService('s-1'))?.healthStatus).toBe('healthy')
  })

  it('P0 rule drives severity, tags and service health to down (persisted)', async () => {
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P0', tags: ['crit'], match: {} })
    const result = await processEvent(store, event(), now)
    expect(result.issue.severity).toBe('P0')
    expect(result.issue.tags).toEqual(['crit'])
    expect(result.health).toBe('down')
    expect((await store.getService('s-1'))?.healthStatus).toBe('down')
  })

  it('escalation is visible via previousSeverity', async () => {
    await processEvent(store, event(), now) // P2
    store.seedRule(null, {
      id: 'freq',
      priority: 10,
      severity: 'P0',
      match: { minCountInWindow: 2, windowMinutes: 60 },
    })
    const result = await processEvent(store, event({ occurredAt: '2026-07-27T10:09:30.000Z' }), now)
    expect(result.previousSeverity).toBe('P2')
    expect(result.issue.severity).toBe('P0')
    expect(result.issue.count).toBe(2)
  })

  it('duplicate externalId short-circuits: no triage, no health recompute', async () => {
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P0', match: {} })
    await processEvent(store, event({ source: 'poll', metadata: { externalId: 'x' } }), now)
    // 讓 service 健康度回到 healthy，若 duplicate 有重算就會再變 down
    await store.updateServiceHealth('s-1', 'healthy')
    const result = await processEvent(
      store,
      event({ source: 'poll', metadata: { externalId: 'x' } }),
      now,
    )
    expect(result.duplicate).toBe(true)
    expect(result.issue.count).toBe(1)
    expect(result.health).toBe('healthy')
    expect((await store.getService('s-1'))?.healthStatus).toBe('healthy')
  })

  it('poll-failing service is down regardless of issue severity (take worst)', async () => {
    store.seedService({
      ...svc,
      id: 's-2',
      poll: { lastPollAt: '2026-07-27T10:09:00.000Z', healthy: false, consecutiveFailures: 2 },
    })
    const result = await processEvent(store, event({ serviceId: 's-2' }), now)
    expect(result.health).toBe('down')
  })
})
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm vitest run tests/pipeline/process-event.test.ts`
Expected: FAIL（`Cannot find module '@/pipeline/process-event'`）。

- [ ] **Step 3: 實作 `src/pipeline/process-event.ts`**

```typescript
import { evaluateSeverity } from '@/core/rules'
import { deriveHealth } from '@/core/health'
import type { CanonicalEvent, HealthStatus, Severity } from '@/core/types'
import type { Store, StoredIssue } from '@/store/contracts'

export interface ProcessResult {
  issue: StoredIssue
  created: boolean
  duplicate: boolean
  previousSeverity: Severity | null
  health: HealthStatus
}

export async function processEvent(
  store: Store,
  event: CanonicalEvent,
  now: Date,
): Promise<ProcessResult> {
  const service = await store.getService(event.serviceId)
  if (service === null) throw new Error(`unknown service: ${event.serviceId}`)

  const { issue, created, duplicate } = await store.upsertIssueWithEvent(event)
  if (duplicate) {
    return {
      issue,
      created: false,
      duplicate: true,
      previousSeverity: issue.severity,
      health: service.healthStatus,
    }
  }

  const previousSeverity = created ? null : issue.severity
  const rules = await store.loadRules(event.serviceId)
  const { severity, tags } = evaluateSeverity(issue, rules)

  let triaged = issue
  if (severity !== issue.severity || !sameTags(tags, issue.tags)) {
    await store.updateIssueTriage(issue.id, severity, tags)
    triaged = { ...issue, severity, tags }
  }

  const openIssues = await store.listOpenIssues(event.serviceId)
  const health = deriveHealth({
    poll: service.poll,
    openIssues,
    now,
    windowMinutes: service.healthWindowMinutes,
    failureThreshold: service.healthFailureThreshold,
  })
  if (health !== service.healthStatus) {
    await store.updateServiceHealth(event.serviceId, health)
  }

  return { issue: triaged, created, duplicate: false, previousSeverity, health }
}

function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((tag, index) => tag === b[index])
}
```

- [ ] **Step 4: 執行測試確認通過 + 回歸**

Run: `pnpm vitest run tests/pipeline/process-event.test.ts && pnpm test && pnpm typecheck`
Expected: 全 PASS、typecheck 乾淨。

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/process-event.ts tests/pipeline/process-event.test.ts
git commit -m "feat(pipeline): processEvent orchestrator (upsert, triage, health)"
```

---

### Task 4: `upsert_issue_with_event` migration + SupabaseStore + 整合測試

**Files:**
- Create: `supabase/migrations/<timestamp>_upsert_issue_with_event.sql`（`supabase migration new upsert_issue_with_event` 產生）
- Modify: `src/db/database.types.ts`（`pnpm db:types` 重生，含新 function 型別）
- Create: `src/store/supabase.ts`
- Create: `tests/integration/helpers.ts`
- Test: `tests/integration/supabase-store.test.ts`
- Modify: `vitest.config.ts`（排除 integration）、Create: `vitest.integration.config.ts`、Modify: `package.json`（`test:integration` script、`@supabase/supabase-js` 依賴）

**Interfaces:**
- Consumes: Task 1 契約與 mapping、Plan 2 schema、本地 Supabase stack。
- Produces：`class SupabaseStore implements Store`（constructor 收 `SupabaseClient<Database>`）；rpc `upsert_issue_with_event` 回 `{ issue_id: uuid, created: boolean, duplicate: boolean }`；`createServiceRoleClient(): SupabaseClient<Database>`（integration helper）；`pnpm test:integration`。
- 前置：**本地 stack 必須在跑**（`supabase status` 正常；沒跑先 `supabase start`）。

- [ ] **Step 1: 安裝 supabase-js**

Run: `pnpm add @supabase/supabase-js`
Expected: 安裝成功、lockfile 更新（版本由 pnpm 解析，lockfile 鎖定）。

- [ ] **Step 2: 建 migration 檔並寫入 SQL**

Run: `supabase migration new upsert_issue_with_event`

寫入產生的檔案：

```sql
-- 原子 upsert：dedup(externalId) → issue upsert(count/last_seen/reopen) → event insert。
-- 集中成單一 function 以避免 TS 端 read-modify-write 的競態；
-- PostgREST 的 upsert 無法對 partial unique index 指定 on_conflict，故 event 去重也在此處理。
create or replace function public.upsert_issue_with_event(
  p_service_id uuid,
  p_fingerprint text,
  p_source text,
  p_level text,
  p_error_type text,
  p_message text,
  p_occurred_at timestamptz,
  p_metadata jsonb,
  p_external_id text
) returns table (issue_id uuid, created boolean, duplicate boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_issue_id uuid;
  v_created boolean := false;
begin
  -- poll 來源去重：同服務同 external_id 只計一次（Plan 2 review 驗收條件 #1）
  if p_external_id is not null then
    select e.issue_id into v_issue_id
    from public.events e
    where e.service_id = p_service_id and e.external_id = p_external_id;
    if found then
      return query select v_issue_id, false, true;
      return;
    end if;
  end if;

  insert into public.issues as i
    (service_id, fingerprint, count, first_seen, last_seen, level, error_type, message)
  values
    (p_service_id, p_fingerprint, 1, p_occurred_at, p_occurred_at, p_level, p_error_type, p_message)
  on conflict (service_id, fingerprint) do update
    set count = i.count + 1,
        last_seen = greatest(i.last_seen, excluded.last_seen),
        level = excluded.level,
        -- resolved 遇新事件視為 regression 重開；ignored 維持人工決定
        status = case when i.status = 'resolved' then 'open' else i.status end
  returning id, (count = 1) into v_issue_id, v_created;

  insert into public.events
    (issue_id, service_id, source, level, error_type, message, occurred_at, metadata, external_id)
  values
    (v_issue_id, p_service_id, p_source, p_level, p_error_type, p_message, p_occurred_at, p_metadata, p_external_id)
  on conflict (service_id, external_id) where external_id is not null do nothing;

  return query select v_issue_id, v_created, false;
end;
$$;

-- deny-by-default：僅伺服器端（service_role）可呼叫
revoke execute on function public.upsert_issue_with_event(uuid, text, text, text, text, text, timestamptz, jsonb, text) from public, anon, authenticated;
grant execute on function public.upsert_issue_with_event(uuid, text, text, text, text, text, timestamptz, jsonb, text) to service_role;
```

- [ ] **Step 3: 套用 + advisors + 重生型別**

Run: `supabase db reset && supabase db advisors --local --type security && pnpm db:types && pnpm typecheck`
Expected: reset 乾淨（4 支 migration）；advisors 無 ERROR（rls INFO 為預期）；`database.types.ts` 的 `Functions` 出現 `upsert_issue_with_event`；typecheck 乾淨。若 SQL 錯誤：修檔重跑；同一錯誤修 2 次仍失敗 → BLOCKED。

- [ ] **Step 4: 實作 `src/store/supabase.ts`**

```typescript
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/db/database.types'
import type { CanonicalEvent, HealthStatus, Severity } from '@/core/types'
import type { TriageRule } from '@/core/rules'
import type { OpenIssue } from '@/core/health'
import type { ServiceRecord, Store, StoredIssue, UpsertOutcome } from '@/store/contracts'
import {
  narrowIssueStatus,
  narrowSeverity,
  rowToIssue,
  rowToService,
  ruleRowToTriageRule,
} from '@/store/mapping'

export class SupabaseStore implements Store {
  constructor(private readonly client: SupabaseClient<Database>) {}

  async getService(serviceId: string): Promise<ServiceRecord | null> {
    const { data, error } = await this.client
      .from('services')
      .select('*')
      .eq('id', serviceId)
      .maybeSingle()
    if (error) throw new Error(`getService failed: ${error.message}`)
    return data === null ? null : rowToService(data)
  }

  async upsertIssueWithEvent(event: CanonicalEvent): Promise<UpsertOutcome> {
    const externalId =
      typeof event.metadata.externalId === 'string' ? event.metadata.externalId : null
    const { data, error } = await this.client.rpc('upsert_issue_with_event', {
      p_service_id: event.serviceId,
      p_fingerprint: event.fingerprint,
      p_source: event.source,
      p_level: event.level,
      p_error_type: event.errorType,
      p_message: event.message,
      p_occurred_at: event.occurredAt,
      p_metadata: event.metadata as Json,
      p_external_id: externalId ?? undefined,
    })
    if (error) throw new Error(`upsert_issue_with_event failed: ${error.message}`)
    const outcome = data?.[0]
    if (outcome === undefined) throw new Error('upsert_issue_with_event returned no row')

    const { data: issueRow, error: issueError } = await this.client
      .from('issues')
      .select('*')
      .eq('id', outcome.issue_id)
      .single()
    if (issueError) throw new Error(`fetch issue failed: ${issueError.message}`)
    return { issue: rowToIssue(issueRow), created: outcome.created, duplicate: outcome.duplicate }
  }

  async loadRules(serviceId: string): Promise<TriageRule[]> {
    // service_id 欄位是規則作用域的唯一權威（Plan 2 review 驗收條件 #2）
    const { data, error } = await this.client
      .from('triage_rules')
      .select('*')
      .eq('enabled', true)
      .or(`service_id.eq.${serviceId},service_id.is.null`)
      .order('priority', { ascending: false })
    if (error) throw new Error(`loadRules failed: ${error.message}`)
    return data.map(ruleRowToTriageRule)
  }

  async updateIssueTriage(issueId: string, severity: Severity, tags: string[]): Promise<void> {
    const { error } = await this.client
      .from('issues')
      .update({ severity, tags })
      .eq('id', issueId)
    if (error) throw new Error(`updateIssueTriage failed: ${error.message}`)
  }

  async listOpenIssues(serviceId: string): Promise<OpenIssue[]> {
    const { data, error } = await this.client
      .from('issues')
      .select('severity,status,last_seen')
      .eq('service_id', serviceId)
      .in('status', ['open', 'acknowledged'])
    if (error) throw new Error(`listOpenIssues failed: ${error.message}`)
    return data.map((row) => ({
      severity: narrowSeverity(row.severity),
      status: narrowIssueStatus(row.status),
      lastSeen: row.last_seen,
    }))
  }

  async updateServiceHealth(serviceId: string, health: HealthStatus): Promise<void> {
    const { error } = await this.client
      .from('services')
      .update({ health_status: health })
      .eq('id', serviceId)
    if (error) throw new Error(`updateServiceHealth failed: ${error.message}`)
  }
}
```

註：rpc 參數與回傳的實際產生型別以重生後的 `database.types.ts` 為準——若 `p_external_id` 產生型別要求 `string | undefined` 以外的形式（如 nullable），依產生型別調整呼叫端寫法並在報告註明。

- [ ] **Step 5: 測試設定分離（單元 vs 整合）**

`vitest.config.ts` 的 `test` 區塊加 `exclude`：

```typescript
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**', '**/node_modules/**'],
  },
```

新增 `vitest.integration.config.ts`：

```typescript
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    fileParallelism: false, // 共用本地 DB，避免跨檔清庫互踩
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
```

`package.json` scripts 加：

```json
    "test:integration": "vitest run --config vitest.integration.config.ts"
```

- [ ] **Step 6: 建整合測試 helper `tests/integration/helpers.ts`**

```typescript
import { execSync } from 'node:child_process'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/db/database.types'

const NIL_UUID = '00000000-0000-0000-0000-000000000000'

export function createServiceRoleClient(): SupabaseClient<Database> {
  const env = execSync('supabase status -o env', { encoding: 'utf8' })
  const url = readVar(env, 'API_URL')
  const key = readVar(env, 'SERVICE_ROLE_KEY')
  return createClient<Database>(url, key, { auth: { persistSession: false } })
}

function readVar(output: string, name: string): string {
  const match = output.match(new RegExp(`^${name}="?([^"\\n]+)"?$`, 'm'))
  if (match === null) {
    throw new Error(`supabase status output missing ${name} — is the local stack running? (supabase start)`)
  }
  return match[1]
}

export async function cleanDatabase(client: SupabaseClient<Database>): Promise<void> {
  // FK 順序：子表先刪
  for (const table of ['events', 'notifications', 'issues', 'triage_rules', 'services'] as const) {
    const { error } = await client.from(table).delete().neq('id', NIL_UUID)
    if (error) throw new Error(`clean ${table} failed: ${error.message}`)
  }
}
```

註：`supabase status -o env` 的變數名以實跑輸出為準（CLI 2.98.1）——若鍵名不是 `API_URL`/`SERVICE_ROLE_KEY`（例如帶前綴），依實際輸出調整 `readVar` 呼叫並在報告註明。

- [ ] **Step 7: 寫整合測試 `tests/integration/supabase-store.test.ts`**

```typescript
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createServiceRoleClient, cleanDatabase } from './helpers'
import { SupabaseStore } from '@/store/supabase'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/db/database.types'
import type { CanonicalEvent } from '@/core/types'

let client: SupabaseClient<Database>
let store: SupabaseStore
let serviceId: string

const event = (over: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  serviceId,
  source: 'push',
  level: 'error',
  errorType: 'TypeError',
  message: 'boom',
  fingerprint: 'fp-1',
  occurredAt: '2026-07-27T10:00:00.000Z',
  metadata: {},
  ...over,
})

beforeAll(() => {
  client = createServiceRoleClient()
  store = new SupabaseStore(client)
})

beforeEach(async () => {
  await cleanDatabase(client)
  const { data, error } = await client
    .from('services')
    .insert({ name: 'svc-int' })
    .select('id')
    .single()
  if (error) throw error
  serviceId = data.id
})

describe('SupabaseStore.upsertIssueWithEvent', () => {
  it('creates issue with defaults and persists the event row', async () => {
    const { issue, created, duplicate } = await store.upsertIssueWithEvent(event())
    expect(created).toBe(true)
    expect(duplicate).toBe(false)
    expect(issue).toMatchObject({ severity: 'P2', status: 'open', count: 1, tags: [] })

    const { count } = await client
      .from('events')
      .select('*', { count: 'exact', head: true })
      .eq('issue_id', issue.id)
    expect(count).toBe(1)
  })

  it('increments count and keeps first_seen on repeat fingerprint', async () => {
    await store.upsertIssueWithEvent(event())
    const { issue, created } = await store.upsertIssueWithEvent(
      event({ occurredAt: '2026-07-27T10:05:00.000Z' }),
    )
    expect(created).toBe(false)
    expect(issue.count).toBe(2)
    expect(new Date(issue.lastSeen).toISOString()).toBe('2026-07-27T10:05:00.000Z')
    expect(new Date(issue.firstSeen).toISOString()).toBe('2026-07-27T10:00:00.000Z')
  })

  it('dedupes by externalId: count stays, single event row (驗收條件 #1)', async () => {
    const first = await store.upsertIssueWithEvent(
      event({ source: 'poll', metadata: { externalId: 'x-1' } }),
    )
    const second = await store.upsertIssueWithEvent(
      event({ source: 'poll', metadata: { externalId: 'x-1' } }),
    )
    expect(second.duplicate).toBe(true)
    expect(second.issue.id).toBe(first.issue.id)
    expect(second.issue.count).toBe(1)

    const { count } = await client
      .from('events')
      .select('*', { count: 'exact', head: true })
      .eq('service_id', serviceId)
    expect(count).toBe(1)
    // externalId 必須被 lift 到欄位（而非只留在 metadata）
    const { data: rows } = await client
      .from('events')
      .select('external_id')
      .eq('service_id', serviceId)
    expect(rows?.[0]?.external_id).toBe('x-1')
  })

  it('does not dedupe events without externalId', async () => {
    await store.upsertIssueWithEvent(event())
    const { issue, duplicate } = await store.upsertIssueWithEvent(event())
    expect(duplicate).toBe(false)
    expect(issue.count).toBe(2)
  })

  it('reopens resolved issue; ignored stays', async () => {
    const { issue } = await store.upsertIssueWithEvent(event())
    await client.from('issues').update({ status: 'resolved' }).eq('id', issue.id)
    const reopened = await store.upsertIssueWithEvent(event())
    expect(reopened.issue.status).toBe('open')

    await client.from('issues').update({ status: 'ignored' }).eq('id', issue.id)
    const still = await store.upsertIssueWithEvent(event())
    expect(still.issue.status).toBe('ignored')
  })
})

describe('SupabaseStore.loadRules', () => {
  it('returns only global + own-service rules, priority desc, jsonb serviceId ignored (驗收條件 #2)', async () => {
    const { data: other } = await client
      .from('services')
      .insert({ name: 'svc-other' })
      .select('id')
      .single()
    const rules = [
      { service_id: serviceId, priority: 5, severity: 'P1', match: {} as Json },
      { service_id: other!.id, priority: 99, severity: 'P0', match: {} as Json },
      { service_id: null, priority: 1, severity: 'P2', match: { serviceId: other!.id } as Json },
    ]
    const { error } = await client.from('triage_rules').insert(rules)
    expect(error).toBeNull()

    const loaded = await store.loadRules(serviceId)
    expect(loaded.map((r) => r.priority)).toEqual([5, 1]) // 不含 other 服務的 99
    // jsonb 內的 serviceId 被忽略，不會讓全域規則變成別服務專屬（或反之）
    expect(loaded.every((r) => !('serviceId' in r.match))).toBe(true)
  })

  it('excludes disabled rules', async () => {
    await client
      .from('triage_rules')
      .insert({ service_id: null, priority: 1, severity: 'P0', match: {} as Json, enabled: false })
    expect(await store.loadRules(serviceId)).toEqual([])
  })
})

describe('SupabaseStore service/issue updates', () => {
  it('updateIssueTriage + listOpenIssues + updateServiceHealth roundtrip', async () => {
    const { issue } = await store.upsertIssueWithEvent(event())
    await store.updateIssueTriage(issue.id, 'P0', ['crit'])
    const open = await store.listOpenIssues(serviceId)
    expect(open).toHaveLength(1)
    expect(open[0].severity).toBe('P0')

    await store.updateServiceHealth(serviceId, 'down')
    expect((await store.getService(serviceId))?.healthStatus).toBe('down')
    expect(await store.getService('00000000-0000-0000-0000-000000000001')).toBeNull()
  })
})
```

- [ ] **Step 8: 跑整合測試（RED→GREEN 視情況）＋單元回歸**

Run: `pnpm test:integration`
Expected: 全 PASS（本地 stack 需在跑）。若 helper 的 env 鍵名或 rpc 產生型別與預設不符，依實際輸出調整（報告註明），不改測試斷言本身。

Run: `pnpm test && pnpm typecheck`
Expected: 單元測試全過（不碰 DB）、typecheck 乾淨。

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations src/db/database.types.ts src/store/supabase.ts tests/integration package.json pnpm-lock.yaml vitest.config.ts vitest.integration.config.ts
git commit -m "feat(store): SupabaseStore with atomic upsert rpc and integration tests"
```

---

### Task 5: 端到端管線整合測試 + 全量回歸

**Files:**
- Test: `tests/integration/pipeline-e2e.test.ts`

**Interfaces:**
- Consumes: `processEvent`、`SupabaseStore`、`normalizePushEvent`/`normalizePolledError`（`@/core/normalize`）、integration helpers。
- Produces: 對真實 DB 的端到端驗證：`normalize → processEvent → DB 落地（issue/severity/health）`。

- [ ] **Step 1: 寫端到端測試 `tests/integration/pipeline-e2e.test.ts`**

```typescript
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createServiceRoleClient, cleanDatabase } from './helpers'
import { SupabaseStore } from '@/store/supabase'
import { processEvent } from '@/pipeline/process-event'
import { normalizePushEvent, normalizePolledError } from '@/core/normalize'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/db/database.types'

let client: SupabaseClient<Database>
let store: SupabaseStore
let serviceId: string

const now = new Date('2026-07-27T10:10:00.000Z')
const receivedAt = new Date('2026-07-27T10:09:00.000Z')

beforeAll(() => {
  client = createServiceRoleClient()
  store = new SupabaseStore(client)
})

beforeEach(async () => {
  await cleanDatabase(client)
  const { data, error } = await client
    .from('services')
    .insert({ name: 'svc-e2e' })
    .select('id')
    .single()
  if (error) throw error
  serviceId = data.id
})

describe('pipeline end-to-end against local Supabase', () => {
  it('push event flows: normalize → upsert → rule severity → service health persisted', async () => {
    await client.from('triage_rules').insert({
      service_id: null,
      priority: 10,
      severity: 'P0',
      tags: ['db'],
      match: { messageIncludes: 'db down' } as Json,
    })

    const canonical = normalizePushEvent(
      serviceId,
      { message: 'db down: connection refused', errorType: 'DBError' },
      receivedAt,
    )
    const result = await processEvent(store, canonical, now)

    expect(result.issue.severity).toBe('P0')
    expect(result.health).toBe('down')

    const { data: svc } = await client
      .from('services')
      .select('health_status')
      .eq('id', serviceId)
      .single()
    expect(svc?.health_status).toBe('down')

    const { data: issueRow } = await client
      .from('issues')
      .select('severity,tags,count')
      .eq('service_id', serviceId)
      .single()
    expect(issueRow).toMatchObject({ severity: 'P0', tags: ['db'], count: 1 })
  })

  it('polled errors with same externalId only count once end-to-end', async () => {
    const raw = { message: 'timeout', errorType: 'Timeout', externalId: 'ext-9' }
    await processEvent(store, normalizePolledError(serviceId, raw, receivedAt), now)
    const second = await processEvent(store, normalizePolledError(serviceId, raw, receivedAt), now)

    expect(second.duplicate).toBe(true)
    const { data: issueRow } = await client
      .from('issues')
      .select('count')
      .eq('service_id', serviceId)
      .single()
    expect(issueRow?.count).toBe(1)
  })

  it('unknown service id rejects', async () => {
    const canonical = normalizePushEvent(
      '00000000-0000-0000-0000-000000000001',
      { message: 'x' },
      receivedAt,
    )
    await expect(processEvent(store, canonical, now)).rejects.toThrow(/unknown service/)
  })
})
```

- [ ] **Step 2: 執行整合測試**

Run: `pnpm test:integration`
Expected: 全 PASS（含 Task 4 的測試）。

- [ ] **Step 3: 全量回歸**

Run: `pnpm test && pnpm typecheck && pnpm test:integration`
Expected: 單元 + typecheck + 整合全綠。

- [ ] **Step 4: Commit**

```bash
git add tests/integration/pipeline-e2e.test.ts
git commit -m "test(pipeline): end-to-end integration against local Supabase"
```

---

## 完成後

Plan 3 交付：可注入任何 `Store` 的 `processEvent` 管線、雙 Store 實作（記憶體／Supabase）、原子 upsert rpc、外加落實 Plan 2 review 的四項驗收條件。下一份 **Plan 4｜錯誤接收入口** 會實作 `POST /api/ingest`（HMAC 驗證、wire 格式定案含 CI 測試回報 script 範例）與服務輪詢 Cron（health 偵測 + PollState 寫回 + 連續成功清 health issue + error 端點補漏），皆呼叫本計畫的 `processEvent`。

**給 Plan 4 的既定事項**：poll 成功清除 health issue 需要新的 store 方法（如 `resolveIssueByFingerprint`）與 PollState 寫回方法——屆時擴充 `Store` port；`ProcessResult.previousSeverity` 已為 Plan 5 的升級追發準備好。

### Plan 4/5 必要事項（來自 Plan 3 最終 whole-branch review，勿遺漏）

**Plan 5 前置決策（唯一 Important）**：頻率規則的 window 用 `lastSeen - firstSeen`（單調遞增），超窗後永久不匹配 → severity 自動回落 P2 並清空 tags，之後又可能升回，P0↔P2 震盪會讓「升級才追發」洗版。開工前二選一：(a) severity 只升不降（ratchet，`processEvent` 加一行 rank 比較即可）；或 (b) 允許降級，通知端以 `notifications` 歷史判斷「淨升級」而非相鄰兩次比較。

**Plan 4 必要事項**：
1. ingest/poll 邊界必須先驗 serviceId 為合法 UUID 才可進 `loadRules`（`.or()` 字串插值的防護前提）。
2. poller 每週期重算健康度，需確認覆蓋兩個已知過期窗口：併發 read-compute-write 的 last-writer-wins 低報、duplicate 短路回傳的過期健康度快照。
3. 擴充 `Store` port 時統一「0 rows affected」語意（InMemoryStore throw vs SupabaseStore 靜默成功；建議 Supabase 端檢查 affected rows）。
4. 可於 ingest 邊界收緊 `CanonicalEvent.metadata` 為 JSON-safe 型別（消除 `as Json` 斷言風險）。
