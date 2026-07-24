# Foundation & 核心事件管線（純邏輯）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立專案基礎工具鏈，並以 TDD 實作服務監控的核心純邏輯：訊息正規化 + fingerprint 分組、事件正規化、檢傷規則引擎、健康度推導。

**Architecture:** 所有錯誤來源最終都變成單一 `CanonicalEvent`，聚合成 `Issue`，由規則引擎判 severity，由健康度函式推導服務燈號。本計畫只做**純函式**（無 DB、無網路、無 HTTP），全部可用單元測試涵蓋；後續計畫（持久層、HTTP 入口、Discord、Dashboard）會消費這些函式。

**Tech Stack:** TypeScript（strict）、Vitest、Node.js `node:crypto`、pnpm。

## Global Constraints

- 套件管理一律用 **pnpm**（禁 npm/yarn）。
- TypeScript **strict 模式**開啟。
- 所有時間戳以 **ISO 8601 字串**表示（`Date.prototype.toISOString()`）。
- `src/core/**` 內**不得**有任何 I/O（DB、網路、fs、環境變數）；純函式、可決定性輸出。
- 測試框架 Vitest；測試檔置於 `tests/**/*.test.ts`。
- 完整型別定義集中在 `src/core/types.ts`，其他模組 import 之，不重複定義。
- 依賴以 `pnpm add -D` 安裝最新版，**不在計畫中寫死版本號**（避免臆測外部版本）。

## 本計畫涵蓋 vs. 後續計畫

**本計畫做（對應 spec §4.3、§4.4、§4.5）：** CanonicalEvent 型別、`normalizeMessage` + `computeFingerprint`、事件正規化（push／合成 health-fail／輪詢 error）、規則引擎 `evaluateSeverity`、健康度 `deriveHealth`。

**本計畫不做（留待後續計畫）：** Supabase schema 與依 fingerprint upsert（Plan 2）、`POST /api/ingest` + HMAC 與輪詢 Cron（Plan 3）、Discord 去重通知（Plan 4）、Dashboard／Auth／Realtime（Plan 5）。

---

### Task 1: 專案工具鏈 scaffold（TypeScript + Vitest）

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Consumes: 無（起始任務）。
- Produces: 可執行的 `pnpm test`（Vitest）與 `pnpm typecheck`（tsc）；path alias `@/*` → `src/*`。

- [ ] **Step 1: 建立 `.gitignore`**

```gitignore
node_modules/
dist/
coverage/
.next/
.env
.env.*
!.env.example
```

- [ ] **Step 2: 建立 `package.json`**

```json
{
  "name": "th-beacon",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 3: 安裝 dev 依賴**

Run: `pnpm add -D typescript vitest @types/node`
Expected: 安裝成功，`package.json` 出現 `devDependencies`，產生 `pnpm-lock.yaml`。

- [ ] **Step 4: 建立 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"],
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] },
    "noEmit": true
  },
  "include": ["src", "tests", "vitest.config.ts"]
}
```

- [ ] **Step 5: 建立 `vitest.config.ts`（含 path alias）**

```typescript
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
```

- [ ] **Step 6: 寫 smoke 測試**

```typescript
// tests/smoke.test.ts
import { describe, it, expect } from 'vitest'

describe('toolchain smoke', () => {
  it('runs vitest', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 7: 執行測試確認工具鏈可用**

Run: `pnpm test`
Expected: PASS，1 passed。

- [ ] **Step 8: 執行 typecheck**

Run: `pnpm typecheck`
Expected: 無錯誤輸出（exit 0）。

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts .gitignore tests/smoke.test.ts
git commit -m "chore: scaffold TypeScript + Vitest toolchain"
```

---

### Task 2: 核心型別 + 訊息正規化 + fingerprint

**Files:**
- Create: `src/core/types.ts`
- Create: `src/core/fingerprint.ts`
- Test: `tests/core/fingerprint.test.ts`

**Interfaces:**
- Consumes: 無。
- Produces:
  - 型別：`Severity = 'P0' | 'P1' | 'P2'`、`HealthStatus = 'down' | 'degraded' | 'healthy'`、`IssueStatus = 'open' | 'acknowledged' | 'resolved' | 'ignored'`、`EventSource = 'push' | 'poll'`、`CanonicalEvent`、`Issue`。
  - `normalizeMessage(message: string): string`
  - `computeFingerprint(input: { serviceId: string; errorType: string; message: string }): string`（回 sha256 hex；內部呼叫 `normalizeMessage`）。

- [ ] **Step 1: 寫失敗測試**

```typescript
// tests/core/fingerprint.test.ts
import { describe, it, expect } from 'vitest'
import { normalizeMessage, computeFingerprint } from '@/core/fingerprint'

describe('normalizeMessage', () => {
  it('replaces digits, uuids and hex with placeholders', () => {
    expect(normalizeMessage('User 12345 not found')).toBe('User <n> not found')
    expect(normalizeMessage('id 550e8400-e29b-41d4-a716-446655440000 bad')).toBe('id <uuid> bad')
    expect(normalizeMessage('ptr 0xDEADBEEF freed')).toBe('ptr <hex> freed')
  })

  it('collapses whitespace and trims', () => {
    expect(normalizeMessage('  too   many\tspaces ')).toBe('too many spaces')
  })
})

describe('computeFingerprint', () => {
  const base = { serviceId: 'svc-a', errorType: 'TypeError', message: 'User 1 not found' }

  it('is stable across variable parts of the message', () => {
    const a = computeFingerprint(base)
    const b = computeFingerprint({ ...base, message: 'User 999 not found' })
    expect(a).toBe(b)
  })

  it('differs by service', () => {
    expect(computeFingerprint(base)).not.toBe(computeFingerprint({ ...base, serviceId: 'svc-b' }))
  })

  it('differs by errorType', () => {
    expect(computeFingerprint(base)).not.toBe(computeFingerprint({ ...base, errorType: 'RangeError' }))
  })

  it('returns a 64-char hex string', () => {
    expect(computeFingerprint(base)).toMatch(/^[0-9a-f]{64}$/)
  })
})
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm vitest run tests/core/fingerprint.test.ts`
Expected: FAIL（`Cannot find module '@/core/fingerprint'`）。

- [ ] **Step 3: 建立型別檔**

```typescript
// src/core/types.ts
export type Severity = 'P0' | 'P1' | 'P2'
export type HealthStatus = 'down' | 'degraded' | 'healthy'
export type IssueStatus = 'open' | 'acknowledged' | 'resolved' | 'ignored'
export type EventSource = 'push' | 'poll'

export interface CanonicalEvent {
  serviceId: string
  source: EventSource
  level: string
  errorType: string
  message: string
  fingerprint: string
  occurredAt: string // ISO 8601
  metadata: Record<string, unknown>
}

export interface Issue {
  fingerprint: string
  serviceId: string
  severity: Severity
  status: IssueStatus
  count: number
  firstSeen: string // ISO 8601
  lastSeen: string // ISO 8601
  level: string
  errorType: string
  message: string
}
```

- [ ] **Step 4: 實作 fingerprint**

```typescript
// src/core/fingerprint.ts
import { createHash } from 'node:crypto'

export function normalizeMessage(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
}

export function computeFingerprint(input: {
  serviceId: string
  errorType: string
  message: string
}): string {
  const normalized = normalizeMessage(input.message)
  return createHash('sha256')
    .update(`${input.serviceId}\n${input.errorType}\n${normalized}`)
    .digest('hex')
}
```

- [ ] **Step 5: 執行測試確認通過**

Run: `pnpm vitest run tests/core/fingerprint.test.ts`
Expected: PASS，全部綠燈。

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/fingerprint.ts tests/core/fingerprint.test.ts
git commit -m "feat(core): canonical types, message normalization and fingerprint"
```

---

### Task 3: 事件正規化（push／合成 health-fail／輪詢 error）

**Files:**
- Create: `src/core/normalize.ts`
- Test: `tests/core/normalize.test.ts`

**Interfaces:**
- Consumes: `CanonicalEvent`（`@/core/types`）、`computeFingerprint`（`@/core/fingerprint`）。
- Produces：
  - `interface RawPushEvent { message: string; errorType?: string; level?: string; occurredAt?: string; metadata?: Record<string, unknown> }`
  - `normalizePushEvent(serviceId: string, raw: RawPushEvent, receivedAt: Date): CanonicalEvent`
  - `interface HealthFailDetail { reason: string; statusCode?: number; url?: string }`
  - `synthesizeHealthCheckFailedEvent(serviceId: string, detail: HealthFailDetail, occurredAt: Date): CanonicalEvent`
  - `interface RawPolledError { message: string; errorType?: string; level?: string; externalId?: string; occurredAt?: string; metadata?: Record<string, unknown> }`
  - `normalizePolledError(serviceId: string, raw: RawPolledError, fetchedAt: Date): CanonicalEvent`

- [ ] **Step 1: 寫失敗測試**

```typescript
// tests/core/normalize.test.ts
import { describe, it, expect } from 'vitest'
import {
  normalizePushEvent,
  synthesizeHealthCheckFailedEvent,
  normalizePolledError,
} from '@/core/normalize'
import { computeFingerprint } from '@/core/fingerprint'

const at = new Date('2026-07-23T10:00:00.000Z')

describe('normalizePushEvent', () => {
  it('fills defaults and computes fingerprint', () => {
    const e = normalizePushEvent('svc-a', { message: 'boom' }, at)
    expect(e.source).toBe('push')
    expect(e.level).toBe('error')
    expect(e.errorType).toBe('unknown')
    expect(e.occurredAt).toBe('2026-07-23T10:00:00.000Z')
    expect(e.metadata).toEqual({})
    expect(e.fingerprint).toBe(
      computeFingerprint({ serviceId: 'svc-a', errorType: 'unknown', message: 'boom' }),
    )
  })

  it('honors provided fields', () => {
    const e = normalizePushEvent(
      'svc-a',
      { message: 'x', errorType: 'TypeError', level: 'fatal', occurredAt: '2026-07-01T00:00:00.000Z', metadata: { a: 1 } },
      at,
    )
    expect(e.errorType).toBe('TypeError')
    expect(e.level).toBe('fatal')
    expect(e.occurredAt).toBe('2026-07-01T00:00:00.000Z')
    expect(e.metadata).toEqual({ a: 1 })
  })
})

describe('synthesizeHealthCheckFailedEvent', () => {
  it('produces a poll-sourced health_check_failed event stable per service', () => {
    const a = synthesizeHealthCheckFailedEvent('svc-a', { reason: 'timeout', statusCode: 504, url: 'https://a/health' }, at)
    const b = synthesizeHealthCheckFailedEvent('svc-a', { reason: 'connection refused' }, new Date('2026-07-23T11:00:00.000Z'))
    expect(a.source).toBe('poll')
    expect(a.errorType).toBe('health_check_failed')
    expect(a.metadata).toMatchObject({ statusCode: 504, url: 'https://a/health' })
    // 同服務的 health 失敗要能聚合成同一 issue（fingerprint 相同）
    expect(a.fingerprint).toBe(b.fingerprint)
  })
})

describe('normalizePolledError', () => {
  it('is poll-sourced and preserves externalId in metadata', () => {
    const e = normalizePolledError('svc-a', { message: 'db down', errorType: 'DBError', externalId: 'ext-42' }, at)
    expect(e.source).toBe('poll')
    expect(e.errorType).toBe('DBError')
    expect(e.metadata).toMatchObject({ externalId: 'ext-42' })
  })
})
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm vitest run tests/core/normalize.test.ts`
Expected: FAIL（`Cannot find module '@/core/normalize'`）。

- [ ] **Step 3: 實作正規化**

```typescript
// src/core/normalize.ts
import type { CanonicalEvent } from '@/core/types'
import { computeFingerprint } from '@/core/fingerprint'

export interface RawPushEvent {
  message: string
  errorType?: string
  level?: string
  occurredAt?: string
  metadata?: Record<string, unknown>
}

export function normalizePushEvent(
  serviceId: string,
  raw: RawPushEvent,
  receivedAt: Date,
): CanonicalEvent {
  const errorType = raw.errorType ?? 'unknown'
  return {
    serviceId,
    source: 'push',
    level: raw.level ?? 'error',
    errorType,
    message: raw.message,
    fingerprint: computeFingerprint({ serviceId, errorType, message: raw.message }),
    occurredAt: raw.occurredAt ?? receivedAt.toISOString(),
    metadata: raw.metadata ?? {},
  }
}

export interface HealthFailDetail {
  reason: string
  statusCode?: number
  url?: string
}

export function synthesizeHealthCheckFailedEvent(
  serviceId: string,
  detail: HealthFailDetail,
  occurredAt: Date,
): CanonicalEvent {
  const errorType = 'health_check_failed'
  // 訊息刻意不含變動細節（reason 進 metadata），確保同服務的 health 失敗聚合成同一 issue。
  const message = 'Health check failed'
  return {
    serviceId,
    source: 'poll',
    level: 'error',
    errorType,
    message,
    fingerprint: computeFingerprint({ serviceId, errorType, message }),
    occurredAt: occurredAt.toISOString(),
    metadata: {
      reason: detail.reason,
      ...(detail.statusCode !== undefined ? { statusCode: detail.statusCode } : {}),
      ...(detail.url !== undefined ? { url: detail.url } : {}),
    },
  }
}

export interface RawPolledError {
  message: string
  errorType?: string
  level?: string
  externalId?: string
  occurredAt?: string
  metadata?: Record<string, unknown>
}

export function normalizePolledError(
  serviceId: string,
  raw: RawPolledError,
  fetchedAt: Date,
): CanonicalEvent {
  const errorType = raw.errorType ?? 'unknown'
  return {
    serviceId,
    source: 'poll',
    level: raw.level ?? 'error',
    errorType,
    message: raw.message,
    fingerprint: computeFingerprint({ serviceId, errorType, message: raw.message }),
    occurredAt: raw.occurredAt ?? fetchedAt.toISOString(),
    metadata: {
      ...(raw.metadata ?? {}),
      ...(raw.externalId !== undefined ? { externalId: raw.externalId } : {}),
    },
  }
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm vitest run tests/core/normalize.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/core/normalize.ts tests/core/normalize.test.ts
git commit -m "feat(core): event normalizers for push and poll sources"
```

---

### Task 4: 檢傷規則引擎

**Files:**
- Create: `src/core/rules.ts`
- Test: `tests/core/rules.test.ts`

**Interfaces:**
- Consumes: `Severity`、`Issue`（`@/core/types`）。
- Produces：
  - `interface TriageRule { id: string; priority: number; severity: Severity; tags?: string[]; match: RuleMatch }`
  - `interface RuleMatch { serviceId?: string; level?: string; errorType?: string; messageIncludes?: string; minCountInWindow?: number; windowMinutes?: number }`
  - `type IssueForEval = Pick<Issue, 'serviceId' | 'level' | 'errorType' | 'message' | 'count' | 'firstSeen' | 'lastSeen'>`
  - `evaluateSeverity(issue: IssueForEval, rules: TriageRule[]): { severity: Severity; tags: string[] }`
  - 無規則命中時預設 `{ severity: 'P2', tags: [] }`。

- [ ] **Step 1: 寫失敗測試**

```typescript
// tests/core/rules.test.ts
import { describe, it, expect } from 'vitest'
import { evaluateSeverity, type TriageRule, type IssueForEval } from '@/core/rules'

const issue = (over: Partial<IssueForEval> = {}): IssueForEval => ({
  serviceId: 'svc-a',
  level: 'error',
  errorType: 'TypeError',
  message: 'db connection lost',
  count: 1,
  firstSeen: '2026-07-23T10:00:00.000Z',
  lastSeen: '2026-07-23T10:00:30.000Z',
  ...over,
})

describe('evaluateSeverity', () => {
  it('defaults to P2 when no rule matches', () => {
    expect(evaluateSeverity(issue(), [])).toEqual({ severity: 'P2', tags: [] })
  })

  it('matches by errorType and returns severity + tags', () => {
    const rules: TriageRule[] = [
      { id: 'r1', priority: 10, severity: 'P0', tags: ['db'], match: { errorType: 'TypeError' } },
    ]
    expect(evaluateSeverity(issue(), rules)).toEqual({ severity: 'P0', tags: ['db'] })
  })

  it('honors priority: highest matching rule wins', () => {
    const rules: TriageRule[] = [
      { id: 'low', priority: 1, severity: 'P2', match: { serviceId: 'svc-a' } },
      { id: 'high', priority: 100, severity: 'P0', match: { serviceId: 'svc-a' } },
    ]
    expect(evaluateSeverity(issue(), rules).severity).toBe('P0')
  })

  it('matches messageIncludes case-insensitively', () => {
    const rules: TriageRule[] = [
      { id: 'r', priority: 5, severity: 'P1', match: { messageIncludes: 'CONNECTION LOST' } },
    ]
    expect(evaluateSeverity(issue(), rules).severity).toBe('P1')
  })

  it('frequency: matches when count >= minCountInWindow within windowMinutes', () => {
    const rules: TriageRule[] = [
      { id: 'freq', priority: 5, severity: 'P0', match: { minCountInWindow: 10, windowMinutes: 5 } },
    ]
    // 12 次、跨度 30 秒 → 命中
    expect(evaluateSeverity(issue({ count: 12 }), rules).severity).toBe('P0')
    // 12 次但跨度超過 5 分鐘 → 不命中 → 預設 P2
    const spread = issue({ count: 12, firstSeen: '2026-07-23T10:00:00.000Z', lastSeen: '2026-07-23T10:10:00.000Z' })
    expect(evaluateSeverity(spread, rules).severity).toBe('P2')
    // 次數不足 → 不命中
    expect(evaluateSeverity(issue({ count: 3 }), rules).severity).toBe('P2')
  })
})
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm vitest run tests/core/rules.test.ts`
Expected: FAIL（`Cannot find module '@/core/rules'`）。

- [ ] **Step 3: 實作規則引擎**

```typescript
// src/core/rules.ts
import type { Issue, Severity } from '@/core/types'

export interface RuleMatch {
  serviceId?: string
  level?: string
  errorType?: string
  messageIncludes?: string
  minCountInWindow?: number
  windowMinutes?: number
}

export interface TriageRule {
  id: string
  priority: number
  severity: Severity
  tags?: string[]
  match: RuleMatch
}

export type IssueForEval = Pick<
  Issue,
  'serviceId' | 'level' | 'errorType' | 'message' | 'count' | 'firstSeen' | 'lastSeen'
>

function matches(rule: TriageRule, issue: IssueForEval): boolean {
  const m = rule.match
  if (m.serviceId !== undefined && m.serviceId !== issue.serviceId) return false
  if (m.level !== undefined && m.level !== issue.level) return false
  if (m.errorType !== undefined && m.errorType !== issue.errorType) return false
  if (
    m.messageIncludes !== undefined &&
    !issue.message.toLowerCase().includes(m.messageIncludes.toLowerCase())
  ) {
    return false
  }
  if (m.minCountInWindow !== undefined) {
    if (issue.count < m.minCountInWindow) return false
    const windowMs = (m.windowMinutes ?? 60) * 60_000
    const spanMs = new Date(issue.lastSeen).getTime() - new Date(issue.firstSeen).getTime()
    if (spanMs > windowMs) return false
  }
  return true
}

export function evaluateSeverity(
  issue: IssueForEval,
  rules: TriageRule[],
): { severity: Severity; tags: string[] } {
  const ordered = [...rules].sort((a, b) => b.priority - a.priority)
  for (const rule of ordered) {
    if (matches(rule, issue)) {
      return { severity: rule.severity, tags: rule.tags ?? [] }
    }
  }
  return { severity: 'P2', tags: [] }
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm vitest run tests/core/rules.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/core/rules.ts tests/core/rules.test.ts
git commit -m "feat(core): triage rule engine with priority and frequency matching"
```

---

### Task 5: 健康度推導（輪詢優先，取最差）

**Files:**
- Create: `src/core/health.ts`
- Test: `tests/core/health.test.ts`

**Interfaces:**
- Consumes: `HealthStatus`、`Issue`、`Severity`（`@/core/types`）。
- Produces：
  - `interface PollState { lastPollAt: string | null; healthy: boolean | null; consecutiveFailures: number }`
  - `type OpenIssue = Pick<Issue, 'severity' | 'status' | 'lastSeen'>`
  - `interface DeriveHealthParams { poll: PollState | null; openIssues: OpenIssue[]; now: Date; windowMinutes: number; failureThreshold: number }`
  - `deriveHealth(params: DeriveHealthParams): HealthStatus`
  - 規則：health 輪詢連續失敗達 `failureThreshold` → `down`；否則取近 `windowMinutes` 內未解（`open`/`acknowledged`）issue 的最嚴重度（P0→down、P1→degraded、else healthy）；兩訊號**取最差**。`poll === null`（未設輪詢）則只看 issue。

- [ ] **Step 1: 寫失敗測試**

```typescript
// tests/core/health.test.ts
import { describe, it, expect } from 'vitest'
import { deriveHealth, type PollState, type OpenIssue } from '@/core/health'

const now = new Date('2026-07-23T10:10:00.000Z')
const recent = '2026-07-23T10:09:00.000Z' // 1 分鐘前
const old = '2026-07-23T09:00:00.000Z' // 70 分鐘前

const healthyPoll: PollState = { lastPollAt: recent, healthy: true, consecutiveFailures: 0 }
const failingPoll: PollState = { lastPollAt: recent, healthy: false, consecutiveFailures: 2 }

const base = { now, windowMinutes: 15, failureThreshold: 2 }

describe('deriveHealth', () => {
  it('is healthy with no issues and healthy poll', () => {
    expect(deriveHealth({ ...base, poll: healthyPoll, openIssues: [] })).toBe('healthy')
  })

  it('is down when poll fails past the threshold, regardless of issues', () => {
    expect(deriveHealth({ ...base, poll: failingPoll, openIssues: [] })).toBe('down')
  })

  it('does not go down when failures are below threshold', () => {
    const poll: PollState = { lastPollAt: recent, healthy: false, consecutiveFailures: 1 }
    expect(deriveHealth({ ...base, poll, openIssues: [] })).toBe('healthy')
  })

  it('is degraded on an open P1 within the window', () => {
    const issues: OpenIssue[] = [{ severity: 'P1', status: 'open', lastSeen: recent }]
    expect(deriveHealth({ ...base, poll: healthyPoll, openIssues: issues })).toBe('degraded')
  })

  it('is down on an open P0 even when poll is healthy (take worst)', () => {
    const issues: OpenIssue[] = [{ severity: 'P0', status: 'open', lastSeen: recent }]
    expect(deriveHealth({ ...base, poll: healthyPoll, openIssues: issues })).toBe('down')
  })

  it('ignores resolved/ignored issues and issues outside the window', () => {
    const issues: OpenIssue[] = [
      { severity: 'P0', status: 'resolved', lastSeen: recent },
      { severity: 'P0', status: 'open', lastSeen: old },
    ]
    expect(deriveHealth({ ...base, poll: healthyPoll, openIssues: issues })).toBe('healthy')
  })

  it('falls back to issue-only derivation when poll is null', () => {
    const issues: OpenIssue[] = [{ severity: 'P1', status: 'acknowledged', lastSeen: recent }]
    expect(deriveHealth({ ...base, poll: null, openIssues: issues })).toBe('degraded')
  })
})
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm vitest run tests/core/health.test.ts`
Expected: FAIL（`Cannot find module '@/core/health'`）。

- [ ] **Step 3: 實作健康度**

```typescript
// src/core/health.ts
import type { HealthStatus, Issue, Severity } from '@/core/types'

export interface PollState {
  lastPollAt: string | null
  healthy: boolean | null
  consecutiveFailures: number
}

export type OpenIssue = Pick<Issue, 'severity' | 'status' | 'lastSeen'>

export interface DeriveHealthParams {
  poll: PollState | null
  openIssues: OpenIssue[]
  now: Date
  windowMinutes: number
  failureThreshold: number
}

const RANK: Record<HealthStatus, number> = { healthy: 0, degraded: 1, down: 2 }
const SEVERITY_TO_HEALTH: Record<Severity, HealthStatus> = {
  P0: 'down',
  P1: 'degraded',
  P2: 'healthy',
}

function worst(a: HealthStatus, b: HealthStatus): HealthStatus {
  return RANK[a] >= RANK[b] ? a : b
}

export function deriveHealth(params: DeriveHealthParams): HealthStatus {
  const { poll, openIssues, now, windowMinutes, failureThreshold } = params

  const pollHealth: HealthStatus =
    poll && poll.healthy === false && poll.consecutiveFailures >= failureThreshold
      ? 'down'
      : 'healthy'

  const windowMs = windowMinutes * 60_000
  let issueHealth: HealthStatus = 'healthy'
  for (const issue of openIssues) {
    if (issue.status !== 'open' && issue.status !== 'acknowledged') continue
    const age = now.getTime() - new Date(issue.lastSeen).getTime()
    if (age > windowMs) continue
    issueHealth = worst(issueHealth, SEVERITY_TO_HEALTH[issue.severity])
  }

  return worst(pollHealth, issueHealth)
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm vitest run tests/core/health.test.ts`
Expected: PASS。

- [ ] **Step 5: 全套測試 + typecheck 回歸**

Run: `pnpm test && pnpm typecheck`
Expected: 全部 PASS，typecheck exit 0。

- [ ] **Step 6: Commit**

```bash
git add src/core/health.ts tests/core/health.test.ts
git commit -m "feat(core): service health derivation (poll-first, take worst)"
```

---

## 完成後

Plan 1 產出可完整單元測試的核心純邏輯（fingerprint／normalize／rules／health）。下一份計畫 **Plan 2｜持久層與管線接線** 會建立 Supabase schema，並把這些純函式串成 `normalize → 依 fingerprint upsert issue → evaluateSeverity → deriveHealth` 的實際管線。
