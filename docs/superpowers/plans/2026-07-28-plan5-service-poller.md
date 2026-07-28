# 服務輪詢器（health 偵測 + error 補漏 + Vercel Cron）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 實作 spec §4.2 服務輪詢器：Cron 觸發 `GET /api/poll/services`（內部 token），對每個到期服務做 health 存活偵測（失敗合成事件走管線、成功清 health issue）與 error 端點補漏（externalId 去重），並落實 Plan 3 移交的「poller 覆蓋健康度過期窗口」與「0 rows affected 語意統一」。

**Architecture:** 與 ingest 同構——route 極薄，邏輯在可注入測試的模組：`isPollDue`/`parsePolledErrors` 純函式；`pollService`/`runPoll` orchestrator 依賴 `Store` port 與注入的 `HttpGet` fetcher（InMemoryStore + fake fetcher 純 TDD）；真 fetch 只在 `src/poll/http.ts`。每次輪詢（無論成敗）都會重算服務健康度，系統性覆蓋 Plan 3 記錄的兩個過期窗口。

**Tech Stack:** TypeScript strict、Vitest（單元 + 整合 + node:http stub server）、fetch/AbortController、Vercel Cron。

## Global Constraints

- pnpm；TypeScript strict；**禁止 dev server**（驗證：tests + `pnpm build`）。
- `process.env` 只准在 `src/store/server.ts`（本計畫在此加 `getCronSecret()`）與測試；真 `fetch` 只准在 `src/poll/http.ts`；`src/core/**` 純函式不變；時鐘一律注入。
- **輪詢語意（值不得偏離）**：
  - 到期判定：`last_poll_at` 為 null → due；否則 `now - last_poll_at >= poll_interval_seconds`（null 預設 60 秒）。
  - health healthy 定義：HTTP 完成且 `status === poll_expected_status`。逾時（`poll_timeout_ms`）/連線失敗/非預期狀態 → unhealthy。
  - unhealthy：`poll_consecutive_failures + 1` **先寫回**，再 `synthesizeHealthCheckFailedEvent` → `processEvent`（如此 deriveHealth 讀到最新 PollState，達 `health_failure_threshold` 即 Down）。
  - healthy：寫回 `failures=0, healthy=true` → resolve 該服務 `error_type='health_check_failed'` 的 open/acknowledged issue（→resolved）→ 重算健康度。
  - error 端點回應格式（我方定義的慣例）：`{"errors": [{"message"(必填), "id"?, "errorType"?, "level"?, "occurredAt"?, "metadata"?}]}`；`id` 映射到 `externalId`（建議服務提供穩定 id 以去重）；帶 cursor 時請求加 `?since=<cursor>`；成功處理後 cursor 設為本次輪詢時刻 ISO（重疊由 externalId 去重吸收）。單次上限 100 筆，超出標記 truncated（不得靜默截斷）。
  - error 端點抓取失敗：不影響健康度（liveness 歸 health URL 管），不推進 cursor，outcome 標記 `errorFetchFailed`。
  - Cron 驗證：`Authorization: Bearer ${CRON_SECRET}`（Vercel Cron 設定 `CRON_SECRET` env 後自動帶此 header——此為 Vercel 文件慣例，**部署時需實地驗證，本地以整合測試為準**）；缺/錯 → 401。
- 輪詢逐一序列執行（MVP；Vercel function 時限內的服務數量上限屬部署考量，記交接）。
- poll URL 由管理者寫入 DB（信任邊界在 DB 寫入權），SSRF 防護不在 MVP。
- **不做**：spec §4.2 的「（可選）status JSON 判準」（維持 Plan 2 review 的 defer 決定，只看狀態碼）；並行輪詢；error 端點分頁。

## 本計畫涵蓋 vs. 後續計畫

**做（spec §4.2 + §6 Cron 部分 + §7）：** Store port 輪詢擴充與 0-rows 統一、`isPollDue`/`parsePolledErrors`、`refreshServiceHealth`、`pollService`/`runPoll`、`httpGet`、cron route、`vercel.json`、`health_check_failed → P0` seed 規則、stub-server 整合測試。

**不做：** Discord（Plan 6，severity 降級策略前置決策在彼）；dashboard（Plan 7）。

---

### Task 1: Store port 輪詢擴充 + 0-rows 語意統一

**Files:**
- Modify: `src/store/contracts.ts`
- Modify: `src/store/mapping.ts`
- Modify: `src/store/memory.ts`
- Modify: `src/store/supabase.ts`
- Test: Modify `tests/store/memory.test.ts`、`tests/integration/supabase-store.test.ts`

**Interfaces:**
- Produces（後續 task 依賴的精確簽章）：
  - `interface PollConfig { healthUrl: string | null; errorUrl: string | null; intervalSeconds: number | null; timeoutMs: number; expectedStatus: number; cursor: string | null }`
  - `interface PollableService { service: ServiceRecord; config: PollConfig; lastPollAt: string | null }`
  - `interface PollStateUpdate { lastPollAt: string; healthy: boolean | null; consecutiveFailures: number; cursor?: string }`
  - `Store` 加三方法：`listPollableServices(): Promise<PollableService[]>`（有 healthUrl 或 errorUrl 者）；`updatePollState(serviceId: string, state: PollStateUpdate): Promise<void>`（unknown id → throw）；`resolveHealthCheckIssue(serviceId: string): Promise<boolean>`（把該服務 `error_type='health_check_failed'` 且 open/acknowledged 的 issue 改 resolved；回傳是否有變更）。
  - mapping 加 `rowToPollConfig(row: ServiceRow): PollConfig`。
  - **0-rows 統一**：`SupabaseStore.updateIssueTriage`/`updateServiceHealth`/`updatePollState` 對 unknown id 一律 throw（`.select('id')` 檢查空結果），與 InMemoryStore 對齊（Plan 3 移交事項 #3）。
  - `InMemoryStore` 測試 seed：`seedPollConfig(serviceId: string, config: PollConfig): void`。
- 語意細節：
  - `ServiceRecord.poll`（PollState）維持「只反映 health 輪詢」——`rowToService` 的 poll 仍以 `poll_health_url === null ? null : {...}` 判定；error-only 服務的 `lastPollAt` 由 `PollableService.lastPollAt` 提供。
  - memory 的 `updatePollState`：一律記錄內部 lastPollAt/cursor；若該服務 seed 過含 `healthUrl` 的 config，另把 `service.poll` 更新為 `{ lastPollAt, healthy, consecutiveFailures }`。

- [ ] **Step 1: contracts 加型別與三方法**

`src/store/contracts.ts` 增：

```typescript
export interface PollConfig {
  healthUrl: string | null
  errorUrl: string | null
  intervalSeconds: number | null
  timeoutMs: number
  expectedStatus: number
  cursor: string | null
}

export interface PollableService {
  service: ServiceRecord
  config: PollConfig
  lastPollAt: string | null
}

export interface PollStateUpdate {
  lastPollAt: string
  healthy: boolean | null
  consecutiveFailures: number
  cursor?: string
}
```

`Store` interface 增：

```typescript
  listPollableServices(): Promise<PollableService[]>
  updatePollState(serviceId: string, state: PollStateUpdate): Promise<void>
  resolveHealthCheckIssue(serviceId: string): Promise<boolean>
```

- [ ] **Step 2: 寫失敗測試（typecheck RED＋新測試）**

`tests/store/memory.test.ts` 加（放在既有 describe('InMemoryStore') 內；`pollConfig` helper 放檔案頂層 const 區）：

```typescript
const pollConfig = (over: Partial<import('@/store/contracts').PollConfig> = {}) => ({
  healthUrl: 'https://a/health',
  errorUrl: null,
  intervalSeconds: 60,
  timeoutMs: 5000,
  expectedStatus: 200,
  cursor: null,
  ...over,
})

  it('listPollableServices returns only services with poll config', async () => {
    store.seedService({ ...svc, id: 's-p', name: 'svc-p' })
    store.seedPollConfig('s-p', pollConfig())
    const pollables = await store.listPollableServices()
    expect(pollables).toHaveLength(1)
    expect(pollables[0].service.id).toBe('s-p')
    expect(pollables[0].lastPollAt).toBeNull()
  })

  it('updatePollState updates lastPollAt/poll and rejects unknown id', async () => {
    store.seedService({ ...svc, id: 's-p', name: 'svc-p' })
    store.seedPollConfig('s-p', pollConfig())
    await store.updatePollState('s-p', {
      lastPollAt: '2026-07-28T10:00:00.000Z',
      healthy: false,
      consecutiveFailures: 2,
      cursor: 'c-1',
    })
    const pollables = await store.listPollableServices()
    expect(pollables[0].lastPollAt).toBe('2026-07-28T10:00:00.000Z')
    expect(pollables[0].config.cursor).toBe('c-1')
    expect((await store.getService('s-p'))?.poll).toEqual({
      lastPollAt: '2026-07-28T10:00:00.000Z',
      healthy: false,
      consecutiveFailures: 2,
    })
    await expect(
      store.updatePollState('nope', { lastPollAt: 'x', healthy: null, consecutiveFailures: 0 }),
    ).rejects.toThrow(/unknown service/)
  })

  it('resolveHealthCheckIssue resolves only health_check_failed open issues', async () => {
    const health = await store.upsertIssueWithEvent(event({ errorType: 'health_check_failed', fingerprint: 'fp-h' }))
    const other = await store.upsertIssueWithEvent(event({ fingerprint: 'fp-o' }))
    expect(await store.resolveHealthCheckIssue('s-1')).toBe(true)
    expect(await store.resolveHealthCheckIssue('s-1')).toBe(false) // 已無可 resolve
    const open = await store.listOpenIssues('s-1')
    expect(open).toHaveLength(1) // 只剩 other
    void health
    void other
  })
```

`tests/integration/supabase-store.test.ts` 加：

```typescript
describe('SupabaseStore poll extensions', () => {
  it('listPollableServices/updatePollState roundtrip incl. cursor', async () => {
    await client
      .from('services')
      .update({ poll_health_url: 'https://a/health', poll_error_url: 'https://a/errors' })
      .eq('id', serviceId)
    const before = await store.listPollableServices()
    expect(before).toHaveLength(1)
    expect(before[0].config).toMatchObject({
      healthUrl: 'https://a/health',
      errorUrl: 'https://a/errors',
      timeoutMs: 5000,
      expectedStatus: 200,
      cursor: null,
    })
    await store.updatePollState(serviceId, {
      lastPollAt: '2026-07-28T10:00:00.000Z',
      healthy: true,
      consecutiveFailures: 0,
      cursor: '2026-07-28T10:00:00.000Z',
    })
    const after = await store.listPollableServices()
    expect(after[0].lastPollAt).not.toBeNull()
    expect(after[0].config.cursor).not.toBeNull()
  })

  it('unknown ids reject across update methods (0-rows unified)', async () => {
    const ghost = '00000000-0000-0000-0000-000000000001'
    await expect(store.updateServiceHealth(ghost, 'down')).rejects.toThrow(/unknown service/)
    await expect(store.updateIssueTriage(ghost, 'P0', [])).rejects.toThrow(/unknown issue/)
    await expect(
      store.updatePollState(ghost, { lastPollAt: '2026-07-28T10:00:00.000Z', healthy: null, consecutiveFailures: 0 }),
    ).rejects.toThrow(/unknown service/)
  })

  it('resolveHealthCheckIssue resolves health issues only', async () => {
    await store.upsertIssueWithEvent(event({ errorType: 'health_check_failed', fingerprint: 'fp-h', source: 'poll' }))
    await store.upsertIssueWithEvent(event({ fingerprint: 'fp-o' }))
    expect(await store.resolveHealthCheckIssue(serviceId)).toBe(true)
    expect(await store.resolveHealthCheckIssue(serviceId)).toBe(false)
    const { data } = await client.from('issues').select('error_type,status').eq('service_id', serviceId)
    const byType = Object.fromEntries(data!.map((r) => [r.error_type, r.status]))
    expect(byType.health_check_failed).toBe('resolved')
    expect(byType.TypeError).toBe('open')
  })
})
```

Run: `pnpm typecheck`
Expected: FAIL（兩個 store 未實作三個新方法）——這是 RED 證據。

- [ ] **Step 3: mapping 加 `rowToPollConfig`**

`src/store/mapping.ts` 增：

```typescript
export function rowToPollConfig(row: ServiceRow): PollConfig {
  return {
    healthUrl: row.poll_health_url,
    errorUrl: row.poll_error_url,
    intervalSeconds: row.poll_interval_seconds,
    timeoutMs: row.poll_timeout_ms,
    expectedStatus: row.poll_expected_status,
    cursor: row.poll_cursor,
  }
}
```

（import `PollConfig` 自 `@/store/contracts`。）

- [ ] **Step 4: InMemoryStore 實作**

```typescript
  private pollConfigs = new Map<string, PollConfig>()
  private lastPollAts = new Map<string, string>()

  seedPollConfig(serviceId: string, config: PollConfig): void {
    this.pollConfigs.set(serviceId, { ...config })
  }

  async listPollableServices(): Promise<PollableService[]> {
    const result: PollableService[] = []
    for (const [serviceId, config] of this.pollConfigs) {
      const service = this.services.get(serviceId)
      if (service === undefined) continue
      if (config.healthUrl === null && config.errorUrl === null) continue
      result.push({
        service: { ...service, poll: service.poll ? { ...service.poll } : null },
        config: { ...config },
        lastPollAt: this.lastPollAts.get(serviceId) ?? null,
      })
    }
    return result
  }

  async updatePollState(serviceId: string, state: PollStateUpdate): Promise<void> {
    const service = this.services.get(serviceId)
    if (service === undefined) throw new Error(`unknown service: ${serviceId}`)
    this.lastPollAts.set(serviceId, state.lastPollAt)
    const config = this.pollConfigs.get(serviceId)
    if (state.cursor !== undefined && config !== undefined) {
      this.pollConfigs.set(serviceId, { ...config, cursor: state.cursor })
    }
    if (config?.healthUrl != null) {
      this.services.set(serviceId, {
        ...service,
        poll: {
          lastPollAt: state.lastPollAt,
          healthy: state.healthy,
          consecutiveFailures: state.consecutiveFailures,
        },
      })
    }
  }

  async resolveHealthCheckIssue(serviceId: string): Promise<boolean> {
    let changed = false
    for (const [key, issue] of this.issues) {
      if (
        issue.serviceId === serviceId &&
        issue.errorType === 'health_check_failed' &&
        (issue.status === 'open' || issue.status === 'acknowledged')
      ) {
        this.issues.set(key, { ...issue, status: 'resolved' })
        changed = true
      }
    }
    return changed
  }
```

（import `PollConfig`、`PollableService`、`PollStateUpdate`。）

- [ ] **Step 5: SupabaseStore 實作 + 0-rows 統一**

新方法：

```typescript
  async listPollableServices(): Promise<PollableService[]> {
    const { data, error } = await this.client
      .from('services')
      .select('*')
      .or('poll_health_url.not.is.null,poll_error_url.not.is.null')
    if (error) throw new Error(`listPollableServices failed: ${error.message}`)
    return data.map((row) => ({
      service: rowToService(row),
      config: rowToPollConfig(row),
      lastPollAt: row.last_poll_at,
    }))
  }

  async updatePollState(serviceId: string, state: PollStateUpdate): Promise<void> {
    const patch: Record<string, unknown> = {
      last_poll_at: state.lastPollAt,
      last_poll_healthy: state.healthy,
      poll_consecutive_failures: state.consecutiveFailures,
    }
    if (state.cursor !== undefined) patch.poll_cursor = state.cursor
    const { data, error } = await this.client
      .from('services')
      .update(patch)
      .eq('id', serviceId)
      .select('id')
    if (error) throw new Error(`updatePollState failed: ${error.message}`)
    if (data.length === 0) throw new Error(`unknown service: ${serviceId}`)
  }

  async resolveHealthCheckIssue(serviceId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from('issues')
      .update({ status: 'resolved' })
      .eq('service_id', serviceId)
      .eq('error_type', 'health_check_failed')
      .in('status', ['open', 'acknowledged'])
      .select('id')
    if (error) throw new Error(`resolveHealthCheckIssue failed: ${error.message}`)
    return data.length > 0
  }
```

既有兩方法統一 0-rows（改為 `.select('id')` 並檢查）：

```typescript
  async updateIssueTriage(issueId: string, severity: Severity, tags: string[]): Promise<void> {
    const { data, error } = await this.client
      .from('issues')
      .update({ severity, tags })
      .eq('id', issueId)
      .select('id')
    if (error) throw new Error(`updateIssueTriage failed: ${error.message}`)
    if (data.length === 0) throw new Error(`unknown issue: ${issueId}`)
  }

  async updateServiceHealth(serviceId: string, health: HealthStatus): Promise<void> {
    const { data, error } = await this.client
      .from('services')
      .update({ health_status: health })
      .eq('id', serviceId)
      .select('id')
    if (error) throw new Error(`updateServiceHealth failed: ${error.message}`)
    if (data.length === 0) throw new Error(`unknown service: ${serviceId}`)
  }
```

- [ ] **Step 6: GREEN + 回歸**

Run: `pnpm test && pnpm typecheck && pnpm test:integration`
Expected: 全綠（單元含新 memory 測試；整合含新 describe）。

- [ ] **Step 7: Commit**

```bash
git add src/store/contracts.ts src/store/mapping.ts src/store/memory.ts src/store/supabase.ts tests/store/memory.test.ts tests/integration/supabase-store.test.ts
git commit -m "feat(store): poll extensions and unified 0-rows semantics"
```

---

### Task 2: 純邏輯——`isPollDue` + `parsePolledErrors`

**Files:**
- Create: `src/poll/due.ts`
- Create: `src/poll/parse.ts`
- Test: `tests/poll/due.test.ts`、`tests/poll/parse.test.ts`

**Interfaces:**
- Produces：
  - `isPollDue(lastPollAt: string | null, intervalSeconds: number | null, now: Date): boolean`（null lastPollAt → true；interval null 預設 60；`>=` 到期）
  - `type PolledErrorsResult = { ok: true; value: RawPolledError[]; truncated: boolean } | { ok: false; errors: string[] }`
  - `parsePolledErrors(input: unknown, maxItems = 100): PolledErrorsResult`（`{errors:[...]}` 格式；`id` → `externalId`；message 必填、其餘選填且型別不符時**靜默略過該欄位**；超過 maxItems 截斷並標 truncated）

- [ ] **Step 1: 寫失敗測試 `tests/poll/due.test.ts`**

```typescript
import { describe, it, expect } from 'vitest'
import { isPollDue } from '@/poll/due'

const now = new Date('2026-07-28T10:01:00.000Z')

describe('isPollDue', () => {
  it('is due when never polled', () => {
    expect(isPollDue(null, 60, now)).toBe(true)
  })

  it('is due at/after the interval, not before', () => {
    expect(isPollDue('2026-07-28T10:00:00.000Z', 60, now)).toBe(true) // 恰 60s
    expect(isPollDue('2026-07-28T10:00:30.000Z', 60, now)).toBe(false) // 30s
    expect(isPollDue('2026-07-28T09:59:00.000Z', 60, now)).toBe(true) // 120s
  })

  it('defaults interval to 60 when null', () => {
    expect(isPollDue('2026-07-28T10:00:00.000Z', null, now)).toBe(true)
    expect(isPollDue('2026-07-28T10:00:30.000Z', null, now)).toBe(false)
  })
})
```

- [ ] **Step 2: 寫失敗測試 `tests/poll/parse.test.ts`**

```typescript
import { describe, it, expect } from 'vitest'
import { parsePolledErrors } from '@/poll/parse'

describe('parsePolledErrors', () => {
  it('parses the errors envelope and maps id to externalId', () => {
    const result = parsePolledErrors({
      errors: [
        { id: 'e-1', message: 'db down', errorType: 'DBError', level: 'fatal' },
        { message: 'minor glitch' },
      ],
    })
    expect(result).toEqual({
      ok: true,
      truncated: false,
      value: [
        { message: 'db down', externalId: 'e-1', errorType: 'DBError', level: 'fatal' },
        { message: 'minor glitch' },
      ],
    })
  })

  it('rejects non-envelope shapes', () => {
    for (const bad of [null, 'x', [1], {}, { errors: 'nope' }]) {
      expect(parsePolledErrors(bad).ok).toBe(false)
    }
  })

  it('requires message per item', () => {
    const result = parsePolledErrors({ errors: [{ id: 'x' }] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join()).toMatch(/errors\[0\]\.message/)
  })

  it('silently drops wrongly-typed optional fields', () => {
    const result = parsePolledErrors({
      errors: [{ message: 'x', id: 7, level: true, occurredAt: 'not-a-date', metadata: [1] }],
    })
    expect(result).toEqual({ ok: true, truncated: false, value: [{ message: 'x' }] })
  })

  it('caps at maxItems and flags truncation', () => {
    const many = { errors: Array.from({ length: 5 }, (_, i) => ({ message: `m${i}` })) }
    const result = parsePolledErrors(many, 3)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toHaveLength(3)
      expect(result.truncated).toBe(true)
    }
  })
})
```

- [ ] **Step 3: 確認 RED**

Run: `pnpm vitest run tests/poll`
Expected: FAIL（兩個 module not found）。

- [ ] **Step 4: 實作 `src/poll/due.ts`**

```typescript
export function isPollDue(
  lastPollAt: string | null,
  intervalSeconds: number | null,
  now: Date,
): boolean {
  if (lastPollAt === null) return true
  const interval = intervalSeconds ?? 60
  return (now.getTime() - new Date(lastPollAt).getTime()) / 1000 >= interval
}
```

- [ ] **Step 5: 實作 `src/poll/parse.ts`**

```typescript
import type { RawPolledError } from '@/core/normalize'

export type PolledErrorsResult =
  | { ok: true; value: RawPolledError[]; truncated: boolean }
  | { ok: false; errors: string[] }

// error 端點慣例：{"errors": [...]}；message 必填，其餘選填——
// 選填欄位型別不符時靜默略過該欄位（服務端資料品質不一，missing-lenient 較實用）。
export function parsePolledErrors(input: unknown, maxItems = 100): PolledErrorsResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['response must be a JSON object with an errors array'] }
  }
  const list = (input as Record<string, unknown>).errors
  if (!Array.isArray(list)) return { ok: false, errors: ['errors must be an array'] }

  const problems: string[] = []
  const value: RawPolledError[] = []
  const truncated = list.length > maxItems

  for (const [index, item] of list.slice(0, maxItems).entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      problems.push(`errors[${index}] must be an object`)
      continue
    }
    const obj = item as Record<string, unknown>
    if (typeof obj.message !== 'string' || obj.message.trim() === '') {
      problems.push(`errors[${index}].message is required and must be a non-empty string`)
      continue
    }
    const raw: RawPolledError = { message: obj.message }
    if (typeof obj.id === 'string') raw.externalId = obj.id
    if (typeof obj.errorType === 'string') raw.errorType = obj.errorType
    if (typeof obj.level === 'string') raw.level = obj.level
    if (typeof obj.occurredAt === 'string' && !Number.isNaN(Date.parse(obj.occurredAt))) {
      raw.occurredAt = obj.occurredAt
    }
    if (typeof obj.metadata === 'object' && obj.metadata !== null && !Array.isArray(obj.metadata)) {
      raw.metadata = obj.metadata as Record<string, unknown>
    }
    value.push(raw)
  }

  if (problems.length > 0) return { ok: false, errors: problems }
  return { ok: true, value, truncated }
}
```

- [ ] **Step 6: GREEN + 回歸**

Run: `pnpm vitest run tests/poll && pnpm test && pnpm typecheck`
Expected: 全 PASS。

- [ ] **Step 7: Commit**

```bash
git add src/poll/due.ts src/poll/parse.ts tests/poll/due.test.ts tests/poll/parse.test.ts
git commit -m "feat(poll): poll-due decision and polled-errors parsing"
```

---

### Task 3: `refreshServiceHealth` + `pollService`/`runPoll` orchestrator

**Files:**
- Create: `src/pipeline/refresh-health.ts`
- Create: `src/poll/poll-service.ts`
- Test: `tests/pipeline/refresh-health.test.ts`、`tests/poll/poll-service.test.ts`

**Interfaces:**
- Consumes: Task 1 port、Task 2 純函式、`synthesizeHealthCheckFailedEvent`/`normalizePolledError`、`processEvent`。
- Produces：
  - `refreshServiceHealth(store: Store, serviceId: string, now: Date): Promise<HealthStatus>`（getService → listOpenIssues → deriveHealth → 有變才寫回；unknown service throw）
  - `type HttpResult = { ok: true; status: number; bodyText: string } | { ok: false; reason: string }`
  - `type HttpGet = (url: string, timeoutMs: number) => Promise<HttpResult>`
  - `interface PollOutcome { serviceId: string; healthChecked: boolean; healthy: boolean | null; healthIssueResolved: boolean; errorsProcessed: number; errorsTruncated: boolean; errorFetchFailed: boolean }`
  - `pollService(store: Store, http: HttpGet, pollable: PollableService, now: Date): Promise<PollOutcome>`
  - `runPoll(store: Store, http: HttpGet, now: Date): Promise<PollOutcome[]>`（listPollableServices → isPollDue 過濾 → 逐一 pollService）

- [ ] **Step 1: 寫失敗測試 `tests/pipeline/refresh-health.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { refreshServiceHealth } from '@/pipeline/refresh-health'
import { InMemoryStore } from '@/store/memory'
import type { ServiceRecord } from '@/store/contracts'

const now = new Date('2026-07-28T10:10:00.000Z')

const svc: ServiceRecord = {
  id: 's-1',
  name: 'svc-a',
  healthWindowMinutes: 15,
  healthFailureThreshold: 2,
  healthStatus: 'down', // 故意設一個過期狀態
  poll: null,
}

describe('refreshServiceHealth', () => {
  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc)
  })

  it('recomputes stale health back to healthy when no open issues', async () => {
    expect(await refreshServiceHealth(store, 's-1', now)).toBe('healthy')
    expect((await store.getService('s-1'))?.healthStatus).toBe('healthy')
  })

  it('keeps derived health when open issues exist', async () => {
    const { issue } = await store.upsertIssueWithEvent({
      serviceId: 's-1',
      source: 'push',
      level: 'error',
      errorType: 'X',
      message: 'x',
      fingerprint: 'fp',
      occurredAt: '2026-07-28T10:09:00.000Z',
      metadata: {},
    })
    await store.updateIssueTriage(issue.id, 'P1', [])
    expect(await refreshServiceHealth(store, 's-1', now)).toBe('degraded')
    expect((await store.getService('s-1'))?.healthStatus).toBe('degraded')
  })

  it('throws on unknown service', async () => {
    await expect(refreshServiceHealth(store, 'nope', now)).rejects.toThrow(/unknown service/)
  })
})
```

- [ ] **Step 2: 寫失敗測試 `tests/poll/poll-service.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { pollService, runPoll, type HttpGet, type HttpResult } from '@/poll/poll-service'
import { InMemoryStore } from '@/store/memory'
import type { PollableService, ServiceRecord, PollConfig } from '@/store/contracts'

const now = new Date('2026-07-28T10:10:00.000Z')

const svc: ServiceRecord = {
  id: 's-1',
  name: 'svc-a',
  healthWindowMinutes: 15,
  healthFailureThreshold: 2,
  healthStatus: 'healthy',
  poll: { lastPollAt: null, healthy: null, consecutiveFailures: 0 },
}

const config = (over: Partial<PollConfig> = {}): PollConfig => ({
  healthUrl: 'https://a/health',
  errorUrl: null,
  intervalSeconds: 60,
  timeoutMs: 5000,
  expectedStatus: 200,
  cursor: null,
  ...over,
})

function fakeHttp(routes: Record<string, HttpResult>): { http: HttpGet; calls: string[] } {
  const calls: string[] = []
  const http: HttpGet = async (url) => {
    calls.push(url)
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))
    if (hit === undefined) return { ok: false, reason: 'unrouted' }
    return hit[1]
  }
  return { http, calls }
}

const pollable = (c: PollConfig, lastPollAt: string | null = null): PollableService => ({
  service: svc,
  config: c,
  lastPollAt,
})

describe('pollService — health', () => {
  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc)
    store.seedPollConfig('s-1', config())
  })

  // 每次呼叫都從 store 取最新 pollable（runPoll 的實際行為）；
  // 傳過期快照會讓 consecutiveFailures 讀到舊值。
  const currentPollable = async () => (await store.listPollableServices())[0]

  it('unhealthy poll synthesizes event and reaches Down at threshold', async () => {
    const { http } = fakeHttp({ 'https://a/health': { ok: true, status: 500, bodyText: '' } })
    const first = await pollService(store, http, await currentPollable(), now)
    expect(first.healthy).toBe(false)
    // 第一次未達 threshold(2)：健康度由 issue 推導（health_check_failed 預設 P2 → healthy）
    expect((await store.getService('s-1'))?.healthStatus).toBe('healthy')
    const second = await pollService(store, http, await currentPollable(), now)
    expect(second.healthy).toBe(false)
    expect((await store.getService('s-1'))?.healthStatus).toBe('down') // 達 threshold
    const open = await store.listOpenIssues('s-1')
    expect(open).toHaveLength(1) // 同 fingerprint 聚合一筆
  })

  it('timeout/connection failure counts as unhealthy', async () => {
    const { http } = fakeHttp({ 'https://a/health': { ok: false, reason: 'AbortError' } })
    const outcome = await pollService(store, http, await currentPollable(), now)
    expect(outcome.healthy).toBe(false)
  })

  it('healthy poll resets failures, resolves health issue, refreshes health', async () => {
    const bad = fakeHttp({ 'https://a/health': { ok: true, status: 500, bodyText: '' } })
    await pollService(store, bad.http, await currentPollable(), now)
    await pollService(store, bad.http, await currentPollable(), now)
    expect((await store.getService('s-1'))?.healthStatus).toBe('down')

    const good = fakeHttp({ 'https://a/health': { ok: true, status: 200, bodyText: 'ok' } })
    const outcome = await pollService(store, good.http, await currentPollable(), now)
    expect(outcome.healthy).toBe(true)
    expect(outcome.healthIssueResolved).toBe(true)
    expect((await store.getService('s-1'))?.poll?.consecutiveFailures).toBe(0)
    expect((await store.getService('s-1'))?.healthStatus).toBe('healthy')
    expect(await store.listOpenIssues('s-1')).toHaveLength(0)
  })
})

describe('pollService — errors endpoint', () => {
  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc)
    store.seedPollConfig('s-1', config({ healthUrl: null, errorUrl: 'https://a/errors' }))
  })

  it('processes errors with externalId dedup and advances cursor', async () => {
    const body = JSON.stringify({ errors: [{ id: 'e-1', message: 'db down' }, { id: 'e-2', message: 'io slow' }] })
    const { http } = fakeHttp({ 'https://a/errors': { ok: true, status: 200, bodyText: body } })
    const c = config({ healthUrl: null, errorUrl: 'https://a/errors' })
    const outcome = await pollService(store, http, pollable(c), now)
    expect(outcome.errorsProcessed).toBe(2)
    expect(await store.listOpenIssues('s-1')).toHaveLength(2)

    // 重跑：同 externalId 全部 dedup，issue 數不變
    const again = await pollService(store, http, pollable(c), now)
    expect(again.errorsProcessed).toBe(2)
    expect(await store.listOpenIssues('s-1')).toHaveLength(2)

    const pollables = await store.listPollableServices()
    expect(pollables[0].config.cursor).toBe(now.toISOString())
  })

  it('appends since=cursor to the request when cursor exists', async () => {
    const body = JSON.stringify({ errors: [] })
    const { http, calls } = fakeHttp({ 'https://a/errors': { ok: true, status: 200, bodyText: body } })
    await pollService(store, http, pollable(config({ healthUrl: null, errorUrl: 'https://a/errors', cursor: '2026-07-28T10:00:00.000Z' })), now)
    expect(calls[0]).toBe('https://a/errors?since=2026-07-28T10%3A00%3A00.000Z')
  })

  it('fetch failure flags errorFetchFailed and keeps cursor', async () => {
    const { http } = fakeHttp({ 'https://a/errors': { ok: false, reason: 'ECONNREFUSED' } })
    const outcome = await pollService(store, http, pollable(config({ healthUrl: null, errorUrl: 'https://a/errors' })), now)
    expect(outcome.errorFetchFailed).toBe(true)
    const pollables = await store.listPollableServices()
    expect(pollables[0].config.cursor).toBeNull()
  })
})

describe('runPoll', () => {
  it('polls only due services', async () => {
    const store = new InMemoryStore()
    store.seedService(svc)
    store.seedPollConfig('s-1', config())
    store.seedService({ ...svc, id: 's-2', name: 'svc-b' })
    store.seedPollConfig('s-2', config())
    // s-2 剛輪詢過（30 秒前，interval 60）
    await store.updatePollState('s-2', { lastPollAt: '2026-07-28T10:09:30.000Z', healthy: true, consecutiveFailures: 0 })
    const { http } = fakeHttp({ 'https://a/health': { ok: true, status: 200, bodyText: 'ok' } })
    const outcomes = await runPoll(store, http, now)
    expect(outcomes.map((o) => o.serviceId)).toEqual(['s-1'])
  })
})
```

- [ ] **Step 3: 確認 RED**

Run: `pnpm vitest run tests/pipeline/refresh-health.test.ts tests/poll/poll-service.test.ts`
Expected: FAIL（module not found）。

- [ ] **Step 4: 實作 `src/pipeline/refresh-health.ts`**

```typescript
import { deriveHealth } from '@/core/health'
import type { HealthStatus } from '@/core/types'
import type { Store } from '@/store/contracts'

export async function refreshServiceHealth(
  store: Store,
  serviceId: string,
  now: Date,
): Promise<HealthStatus> {
  const service = await store.getService(serviceId)
  if (service === null) throw new Error(`unknown service: ${serviceId}`)
  const openIssues = await store.listOpenIssues(serviceId)
  const health = deriveHealth({
    poll: service.poll,
    openIssues,
    now,
    windowMinutes: service.healthWindowMinutes,
    failureThreshold: service.healthFailureThreshold,
  })
  if (health !== service.healthStatus) {
    await store.updateServiceHealth(serviceId, health)
  }
  return health
}
```

- [ ] **Step 5: 實作 `src/poll/poll-service.ts`**

```typescript
import { synthesizeHealthCheckFailedEvent, normalizePolledError } from '@/core/normalize'
import { processEvent } from '@/pipeline/process-event'
import { refreshServiceHealth } from '@/pipeline/refresh-health'
import { isPollDue } from '@/poll/due'
import { parsePolledErrors } from '@/poll/parse'
import type { PollableService, Store } from '@/store/contracts'

export type HttpResult =
  | { ok: true; status: number; bodyText: string }
  | { ok: false; reason: string }

export type HttpGet = (url: string, timeoutMs: number) => Promise<HttpResult>

export interface PollOutcome {
  serviceId: string
  healthChecked: boolean
  healthy: boolean | null
  healthIssueResolved: boolean
  errorsProcessed: number
  errorsTruncated: boolean
  errorFetchFailed: boolean
}

export async function pollService(
  store: Store,
  http: HttpGet,
  pollable: PollableService,
  now: Date,
): Promise<PollOutcome> {
  const { service, config } = pollable
  const outcome: PollOutcome = {
    serviceId: service.id,
    healthChecked: false,
    healthy: null,
    healthIssueResolved: false,
    errorsProcessed: 0,
    errorsTruncated: false,
    errorFetchFailed: false,
  }
  let consecutiveFailures = service.poll?.consecutiveFailures ?? 0

  if (config.healthUrl !== null) {
    outcome.healthChecked = true
    const result = await http(config.healthUrl, config.timeoutMs)
    const healthy = result.ok && result.status === config.expectedStatus
    outcome.healthy = healthy
    if (healthy) {
      consecutiveFailures = 0
      await store.updatePollState(service.id, {
        lastPollAt: now.toISOString(),
        healthy: true,
        consecutiveFailures,
      })
      outcome.healthIssueResolved = await store.resolveHealthCheckIssue(service.id)
      await refreshServiceHealth(store, service.id, now)
    } else {
      consecutiveFailures += 1
      // 先寫回 PollState，processEvent 內的 deriveHealth 才讀得到最新失敗數
      await store.updatePollState(service.id, {
        lastPollAt: now.toISOString(),
        healthy: false,
        consecutiveFailures,
      })
      const reason = result.ok ? `unexpected status ${result.status}` : result.reason
      const event = synthesizeHealthCheckFailedEvent(
        service.id,
        {
          reason,
          ...(result.ok ? { statusCode: result.status } : {}),
          url: config.healthUrl,
        },
        now,
      )
      await processEvent(store, event, now)
    }
  } else {
    // error-only 服務也記錄輪詢時刻，並重算健康度（覆蓋過期窗口）
    await store.updatePollState(service.id, {
      lastPollAt: now.toISOString(),
      healthy: null,
      consecutiveFailures,
    })
    await refreshServiceHealth(store, service.id, now)
  }

  if (config.errorUrl !== null) {
    const url =
      config.cursor === null
        ? config.errorUrl
        : `${config.errorUrl}${config.errorUrl.includes('?') ? '&' : '?'}since=${encodeURIComponent(config.cursor)}`
    const result = await http(url, config.timeoutMs)
    if (!result.ok || result.status !== 200) {
      outcome.errorFetchFailed = true
    } else {
      let parsed: ReturnType<typeof parsePolledErrors> | null = null
      try {
        parsed = parsePolledErrors(JSON.parse(result.bodyText))
      } catch {
        parsed = null
      }
      if (parsed === null || !parsed.ok) {
        outcome.errorFetchFailed = true
      } else {
        for (const raw of parsed.value) {
          await processEvent(store, normalizePolledError(service.id, raw, now), now)
        }
        outcome.errorsProcessed = parsed.value.length
        outcome.errorsTruncated = parsed.truncated
        await store.updatePollState(service.id, {
          lastPollAt: now.toISOString(),
          healthy: outcome.healthy,
          consecutiveFailures,
          cursor: now.toISOString(),
        })
      }
    }
  }

  return outcome
}

export async function runPoll(store: Store, http: HttpGet, now: Date): Promise<PollOutcome[]> {
  const pollables = await store.listPollableServices()
  const due = pollables.filter((p) => isPollDue(p.lastPollAt, p.config.intervalSeconds, now))
  const outcomes: PollOutcome[] = []
  for (const pollable of due) {
    outcomes.push(await pollService(store, http, pollable, now))
  }
  return outcomes
}
```

- [ ] **Step 6: GREEN + 回歸**

Run: `pnpm vitest run tests/pipeline/refresh-health.test.ts tests/poll/poll-service.test.ts && pnpm test && pnpm typecheck`
Expected: 全 PASS。

- [ ] **Step 7: Commit**

```bash
git add src/pipeline/refresh-health.ts src/poll/poll-service.ts tests/pipeline/refresh-health.test.ts tests/poll/poll-service.test.ts
git commit -m "feat(poll): pollService/runPoll orchestrator with health refresh"
```

---

### Task 4: `httpGet` + cron route + `vercel.json` + seed 規則

**Files:**
- Create: `src/poll/http.ts`
- Modify: `src/store/server.ts`（加 `getCronSecret`）
- Create: `app/api/poll/services/route.ts`
- Create: `vercel.json`
- Modify: `supabase/seed.sql`（加 `health_check_failed → P0`）

**Interfaces:**
- Produces：
  - `httpGet: HttpGet`（fetch + AbortController 逾時；任何丟擲 → `{ ok: false, reason }`）
  - `getCronSecret(): string`（env `CRON_SECRET`，缺值 throw）
  - `GET /api/poll/services`：`Authorization: Bearer ${CRON_SECRET}` 驗證（缺/錯 401 `{"error":"unauthorized"}`；env 未設一律 401），通過 → `runPoll` → `200 { polled, outcomes }`
  - `vercel.json` crons：`*/5 * * * *` 打 `/api/poll/services`

- [ ] **Step 1: 實作 `src/poll/http.ts`**

```typescript
import type { HttpGet } from '@/poll/poll-service'

export const httpGet: HttpGet = async (url, timeoutMs) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    const bodyText = await response.text()
    return { ok: true, status: response.status, bodyText }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.name : 'fetch_failed' }
  } finally {
    clearTimeout(timer)
  }
}
```

- [ ] **Step 2: `src/store/server.ts` 加 `getCronSecret`**

```typescript
export function getCronSecret(): string {
  const secret = process.env.CRON_SECRET
  if (secret === undefined || secret === '') {
    throw new Error('CRON_SECRET must be set')
  }
  return secret
}
```

- [ ] **Step 3: 建 `app/api/poll/services/route.ts`**

```typescript
import { runPoll } from '@/poll/poll-service'
import { httpGet } from '@/poll/http'
import { createServerStore, getCronSecret } from '@/store/server'

export async function GET(request: Request): Promise<Response> {
  let secret: string
  try {
    secret = getCronSecret()
  } catch {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  const outcomes = await runPoll(createServerStore(), httpGet, new Date())
  return Response.json({ polled: outcomes.length, outcomes }, { status: 200 })
}
```

- [ ] **Step 4: 建 `vercel.json`**

```json
{
  "crons": [
    {
      "path": "/api/poll/services",
      "schedule": "*/5 * * * *"
    }
  ]
}
```

（部署註記：Vercel Cron 在設定 `CRON_SECRET` env 後會以 `Authorization: Bearer` 帶入——此行為部署時實地驗證；Hobby 方案 cron 頻率受限，正式部署以專案方案為準。）

- [ ] **Step 5: `supabase/seed.sql` 加 health 規則**

在檔尾加：

```sql
-- 服務失聯（health check 失敗）預設 P0：輪詢偵測到掛掉即為最高級
-- 服務級規則若要覆蓋，priority 需 > 100
insert into public.triage_rules (service_id, priority, severity, tags, match)
values (null, 100, 'P0', array['availability'], '{"errorType": "health_check_failed"}'::jsonb);
```

Run: `supabase db reset`
Expected: 乾淨套用、seed 兩條規則載入無錯。

- [ ] **Step 6: build + 回歸**

Run: `pnpm build && pnpm test && pnpm typecheck`
Expected: build 成功（新 route 編譯過）、單元與 typecheck 綠。

- [ ] **Step 7: Commit**

```bash
git add src/poll/http.ts src/store/server.ts app/api/poll/services/route.ts vercel.json supabase/seed.sql
git commit -m "feat(poll): cron route with bearer auth, http fetcher, vercel cron, P0 seed rule"
```

---

### Task 5: Poll route 整合測試（stub HTTP server + 真 DB）+ 全量回歸

**Files:**
- Test: `tests/integration/poll-route.test.ts`

**Interfaces:**
- Consumes: route 的 `GET`、integration helpers、node:http stub server（測試內起在 127.0.0.1 隨機 port，模擬被監控服務的 /health 與 /errors）。

- [ ] **Step 1: 寫 `tests/integration/poll-route.test.ts`**

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServiceRoleClient, cleanDatabase, getLocalSupabaseEnv } from './helpers'
import { GET } from '@/../app/api/poll/services/route'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/db/database.types'

let client: SupabaseClient<Database>
let serviceId: string
let stub: Server
let stubOrigin: string

// stub 行為由測試逐案設定
const stubState = {
  healthStatus: 200,
  errors: [] as Array<Record<string, unknown>>,
  lastErrorsUrl: null as string | null,
}

function cronRequest(token = 'test-cron-secret'): Request {
  return new Request('http://localhost/api/poll/services', {
    headers: { authorization: `Bearer ${token}` },
  })
}

beforeAll(async () => {
  const { url, serviceRoleKey } = getLocalSupabaseEnv()
  process.env.SUPABASE_URL = url
  process.env.SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey
  process.env.CRON_SECRET = 'test-cron-secret'
  client = createServiceRoleClient()

  stub = createServer((req, res) => {
    if (req.url?.startsWith('/health')) {
      res.writeHead(stubState.healthStatus).end('ok')
      return
    }
    if (req.url?.startsWith('/errors')) {
      stubState.lastErrorsUrl = req.url
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ errors: stubState.errors }))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  const address = stub.address() as AddressInfo
  stubOrigin = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => stub.close((e) => (e ? reject(e) : resolve())))
})

beforeEach(async () => {
  await cleanDatabase(client)
  stubState.healthStatus = 200
  stubState.errors = []
  stubState.lastErrorsUrl = null
  const { data, error } = await client
    .from('services')
    .insert({
      name: 'svc-poll',
      health_failure_threshold: 2,
      poll_health_url: `${stubOrigin}/health`,
      poll_error_url: `${stubOrigin}/errors`,
      poll_interval_seconds: 60,
    })
    .select('id')
    .single()
  if (error) throw error
  serviceId = data.id
  // 判級規則（cleanDatabase 會清 seed，這裡測試自備）
  await client.from('triage_rules').insert({
    service_id: null,
    priority: 100,
    severity: 'P0',
    tags: ['availability'],
    match: { errorType: 'health_check_failed' } as Json,
  })
})

describe('GET /api/poll/services', () => {
  it('401 without or with wrong bearer token', async () => {
    expect((await GET(new Request('http://localhost/api/poll/services'))).status).toBe(401)
    expect((await GET(cronRequest('wrong'))).status).toBe(401)
  })

  it('health failures reach Down at threshold and aggregate one P0 issue', async () => {
    stubState.healthStatus = 500

    const first = await GET(cronRequest())
    expect(first.status).toBe(200)
    expect((await first.json()).polled).toBe(1)

    // 第二次到期：把 last_poll_at 撥回過去
    await client
      .from('services')
      .update({ last_poll_at: new Date(Date.now() - 120_000).toISOString() })
      .eq('id', serviceId)
    await GET(cronRequest())

    const { data: svc } = await client
      .from('services')
      .select('health_status,poll_consecutive_failures,last_poll_healthy')
      .eq('id', serviceId)
      .single()
    expect(svc).toMatchObject({
      health_status: 'down',
      poll_consecutive_failures: 2,
      last_poll_healthy: false,
    })
    const { data: issues } = await client
      .from('issues')
      .select('error_type,severity,status,count')
      .eq('service_id', serviceId)
    expect(issues).toHaveLength(1)
    expect(issues![0]).toMatchObject({
      error_type: 'health_check_failed',
      severity: 'P0',
      status: 'open',
      count: 2,
    })
  })

  it('recovery resolves the health issue and returns to healthy', async () => {
    stubState.healthStatus = 500
    await GET(cronRequest())
    await client
      .from('services')
      .update({ last_poll_at: new Date(Date.now() - 120_000).toISOString() })
      .eq('id', serviceId)
    await GET(cronRequest())

    stubState.healthStatus = 200
    await client
      .from('services')
      .update({ last_poll_at: new Date(Date.now() - 120_000).toISOString() })
      .eq('id', serviceId)
    const res = await GET(cronRequest())
    const body = await res.json()
    expect(body.outcomes[0]).toMatchObject({ healthy: true, healthIssueResolved: true })

    const { data: svc } = await client
      .from('services')
      .select('health_status,poll_consecutive_failures')
      .eq('id', serviceId)
      .single()
    expect(svc).toMatchObject({ health_status: 'healthy', poll_consecutive_failures: 0 })
    const { data: issues } = await client
      .from('issues')
      .select('status')
      .eq('service_id', serviceId)
    expect(issues![0].status).toBe('resolved')
  })

  it('error endpoint backfill dedupes by externalId and advances cursor with since param', async () => {
    stubState.errors = [
      { id: 'e-1', message: 'db down' },
      { id: 'e-2', message: 'io slow' },
    ]
    await GET(cronRequest())

    const { data: afterFirst } = await client
      .from('issues')
      .select('id')
      .eq('service_id', serviceId)
      .neq('error_type', 'health_check_failed')
    expect(afterFirst).toHaveLength(2)

    // 第二輪：同 externalId 應 dedup；cursor 應以 since 參數帶出
    await client
      .from('services')
      .update({ last_poll_at: new Date(Date.now() - 120_000).toISOString() })
      .eq('id', serviceId)
    await GET(cronRequest())
    expect(stubState.lastErrorsUrl).toMatch(/\/errors\?since=/)

    const { data: afterSecond } = await client
      .from('issues')
      .select('count')
      .eq('service_id', serviceId)
      .neq('error_type', 'health_check_failed')
    expect(afterSecond!.every((r) => r.count === 1)).toBe(true)

    const { data: svc } = await client
      .from('services')
      .select('poll_cursor')
      .eq('id', serviceId)
      .single()
    expect(svc?.poll_cursor).not.toBeNull()
  })

  it('skips services polled within their interval', async () => {
    await GET(cronRequest()) // 第一次會輪詢並寫 last_poll_at
    const res = await GET(cronRequest()) // interval 60s 內
    expect((await res.json()).polled).toBe(0)
  })
})
```

- [ ] **Step 2: 執行整合測試**

Run: `pnpm test:integration`
Expected: 全綠（既有 + 本檔 5 個）。route import 若 alias 解析問題，比照 ingest-route 測試改相對路徑（報告註明）。

- [ ] **Step 3: 全量回歸**

Run: `pnpm test && pnpm typecheck && pnpm test:integration && pnpm build`
Expected: 四者全綠。

- [ ] **Step 4: Commit**

```bash
git add tests/integration/poll-route.test.ts
git commit -m "test(poll): cron route integration with stub service and real DB"
```

---

## 完成後

Plan 5 交付完整輪詢器：Cron 週期性 health 偵測（失敗走管線判級告警、恢復自動 resolve）、error 端點補漏（externalId 去重、cursor 推進）、每輪重算健康度（覆蓋 Plan 3 記錄的過期窗口）、0-rows 語意統一。加上 Plan 4 的 ingest，**spec 的兩條資料入口全部就位**。下一份 **Plan 6｜Discord 通知器**（開工前先拍板 severity 降級策略：ratchet vs 通知端淨升級——見 Plan 3 文件）。部署面待辦：Vercel 上驗證 Cron 的 `CRON_SECRET` Bearer 行為與 env 命名、方案的 cron 頻率限制。

### Plan 6/7 交接事項（來自 Plan 5 最終 whole-branch review 與 fix wave）

- **已修**（fix wave `b98c73a`）：health seed 規則改頻率條件（`minCountInWindow: 2` 對齊 threshold，第一輪失敗不 Down——整合測試中繼斷言鎖住）；runPoll 單服務失敗隔離（outcome 帶 `error` 欄位）；route 500 JSON；timing-safe Bearer；`as any` 消除。
- **Plan 6 前置決策（擴充）**：severity 降級策略現在多一個交互面——頻率規則超窗回落 P2 時，health 的 Down 仍由 poll-first 維持（燈號正確），但 severity 標籤會 P0↔P2 震盪，通知端判「升級追發」時必須把這個納入（見 Plan 3 文件的 ratchet vs 淨升級選項）。
- **error 補漏硬化（Plan 6/7 帶走）**：單筆壞 item 會讓整批 fail 且 cursor 不推進——服務端持續回傳壞資料時 backfill 永久卡死；建議改「略過壞 item、outcome 計數回報」。truncated 批次 cursor 跳到 now 會丟失尾端（>100 筆）且 truncated 旗標目前無人消費——隨 Plan 7 觀測面處理。
- **部署註記**：cursor 用我方時鐘，被監控服務時鐘落後時有遺漏窗口（建議服務端 `since` 語意用回報時間）；序列輪詢上界＝服務數×(timeout×2)，需評估 `maxDuration` 與 Vercel 方案時限。
