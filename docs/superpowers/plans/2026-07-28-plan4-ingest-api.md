# Ingest API（Next.js scaffold + HMAC wire 契約 + CI 回報）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在既有 library（core/store/pipeline）之上建立 Next.js App Router 骨架與第一條 HTTP 入口 `POST /api/ingest`：定案 wire 契約（HMAC-SHA256 簽章、防重放）、接上 `processEvent` 管線，並交付 CI 測試失敗回報 script 範例與 `test_failure` seed 規則。

**Architecture:** route handler 保持極薄——`app/api/ingest/route.ts` 只做「讀 raw body、抽 header、注入時鐘與 store」，全部邏輯在 `src/ingest/handle-ingest.ts`（可用 InMemoryStore 純 TDD）。簽章驗證與 payload 驗證是獨立純函式。服務以 **name** 識別（header），serviceId 一律來自 DB 查回的 UUID——Plan 3 必要事項 #1（UUID 驗證）由此結構性滿足；metadata 經 JSON.parse 而來必為 JSON-safe——必要事項 #4 由邊界保證。

**Tech Stack:** Next.js（App Router，最新版）、TypeScript strict、Vitest、node:crypto（HMAC）、@supabase/supabase-js（僅 server store）。

**計畫編號調整**：原「Plan 4｜ingest + poller」拆為本計畫（ingest）與 Plan 5（服務輪詢器）；Discord 通知 → Plan 6、dashboard → Plan 7。Plan 3 文件「Plan 4/5 必要事項」中：#1/#4 由本計畫落實，#2（poller 健康度過期窗口）/#3（0-rows 語意統一）移交 Plan 5；「severity 降級策略」前置決策適用於 Discord 通知計畫（現 Plan 6）。

## Global Constraints

- 套件管理一律 **pnpm**；TypeScript strict。
- **禁止執行 `pnpm dev` 或啟動 dev server**（使用者自管）。scaffold 驗證用 `pnpm build`（next build）與測試。
- `src/core/**` 純函式不變；supabase-js 只准在 `src/store/supabase.ts`、`src/store/server.ts` 與 `tests/integration/**`；`process.env` 只准在 `src/store/server.ts`（與測試）。
- **Wire 契約（本計畫定案，值不得偏離）**：
  - Headers：`X-Beacon-Service`（services.name）、`X-Beacon-Timestamp`（unix 秒，十進位字串）、`X-Beacon-Signature`（`sha256=<64 hex>`）。
  - 簽章：`HMAC-SHA256(secret, "${timestamp}.${rawBody}")` 的 hex；rawBody 為請求原始 bytes 的字串。
  - 防重放：`|now - timestamp| > 300` 秒即拒絕（含格式不合法）。
  - 回應：驗證失敗一律 `401 {"error":"unauthorized"}`（不區分「服務不存在／無 secret／簽章錯／時戳過期」，避免服務名枚舉）；JSON 解析失敗 `400`；schema 不符 `422 {"error":"invalid payload","details":[...]}`；成功 `201 {"issueId","severity","health","duplicate"}`。
  - Payload（單筆事件）：`{"message": string(必填非空), "errorType"?: string, "level"?: string, "occurredAt"?: ISO8601, "metadata"?: object}`——即 Plan 1 的 `RawPushEvent`。
- CI 測試回報是本入口的使用慣例：`errorType: "test_failure"`，seed 一條全域 `test_failure → P1` 規則。
- 整合測試需本地 Supabase stack 在跑；單元測試不碰 DB 與 env。
- 本計畫**不動 schema**（無新 migration；`supabase/seed.sql` 非 migration）。

## 本計畫涵蓋 vs. 後續計畫

**做（spec §4.1 全部 + §6 的 ingest 部分）：** Next.js scaffold、HMAC 驗證、payload 驗證、`Store.getServiceByName` 擴充、`handleIngest` + route、route 層整合測試、CI 回報 script、`test_failure` seed 規則、spec wire 章節定案。

**不做：** 服務輪詢器與 Cron（Plan 5）；Discord（Plan 6）；dashboard／Auth／Realtime（Plan 7）；批次 payload、nonce 儲存式防重放（YAGNI，fingerprint 聚合已天然去重）。

---

### Task 1: Next.js scaffold

**Files:**
- Modify: `package.json`（依賴與 scripts）
- Create: `app/layout.tsx`、`app/page.tsx`、`next.config.ts`、`.env.example`
- Modify: `tsconfig.json`（由 `next build` 自動補丁後提交）
- Create: `next-env.d.ts`（next 產生，納入版控）

**Interfaces:**
- Consumes: 無。
- Produces: `pnpm build` 可過的 Next.js App Router 骨架；既有 `pnpm test`/`pnpm typecheck`/`pnpm test:integration` 不受影響。

- [ ] **Step 1: 安裝依賴**

Run: `pnpm add next react react-dom && pnpm add -D @types/react @types/react-dom`
Expected: 安裝成功（版本由 pnpm 解析最新、lockfile 鎖定）。

- [ ] **Step 2: 建立最小 App Router 骨架**

`app/layout.tsx`：

```tsx
import type { ReactNode } from 'react'

export const metadata = { title: 'th-beacon' }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  )
}
```

`app/page.tsx`：

```tsx
export default function Home() {
  return <main>th-beacon</main>
}
```

`next.config.ts`：

```typescript
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {}

export default nextConfig
```

`.env.example`：

```bash
# 伺服器端 Supabase 連線（service_role，勿放進任何 NEXT_PUBLIC_*）
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=<supabase status 取得>
```

- [ ] **Step 3: `package.json` scripts 加 build/start（不加也不跑 dev 以外的東西——dev script 可加但絕不執行）**

在 scripts 加：

```json
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
```

- [ ] **Step 4: 首次 build（允許 Next 自動補丁 tsconfig 與產生 next-env.d.ts）**

Run: `pnpm build`
Expected: build 成功。Next 會自動調整 `tsconfig.json`（jsx、plugin、include 等）並產生 `next-env.d.ts`——接受這些變更。若 build 對既有 `src/**` 報錯，STOP 回報（勿為過 build 而改 library 程式碼）。

- [ ] **Step 5: 既有測試鏈回歸**

Run: `pnpm test && pnpm typecheck`
Expected: 單元 55/55、typecheck 乾淨（含新增的 app/*.tsx）。

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml app next.config.ts .env.example tsconfig.json next-env.d.ts
git commit -m "chore(web): scaffold Next.js App Router shell"
```

---

### Task 2: Wire 純邏輯——HMAC 驗證 + payload 驗證

**Files:**
- Create: `src/ingest/hmac.ts`
- Create: `src/ingest/payload.ts`
- Test: `tests/ingest/hmac.test.ts`、`tests/ingest/payload.test.ts`

**Interfaces:**
- Consumes: `node:crypto`（純運算，比照 fingerprint 允許）、`RawPushEvent`（`@/core/normalize`）。
- Produces：
  - `interface VerifyArgs { secret: string; rawBody: string; timestamp: string; signature: string; now: Date; toleranceSeconds?: number }`
  - `type VerifyResult = { ok: true } | { ok: false; reason: 'timestamp_format' | 'timestamp_skew' | 'signature_format' | 'signature_mismatch' }`
  - `verifyIngestSignature(args: VerifyArgs): VerifyResult`（timing-safe 比較；tolerance 預設 300）
  - `type ParseResult = { ok: true; value: RawPushEvent } | { ok: false; errors: string[] }`
  - `parsePushPayload(input: unknown): ParseResult`（錯誤累積回報，不是遇錯即停）

- [ ] **Step 1: 寫失敗測試 `tests/ingest/hmac.test.ts`**

```typescript
import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifyIngestSignature } from '@/ingest/hmac'

const secret = 'test-secret'
const body = '{"message":"boom"}'
const now = new Date('2026-07-28T10:00:00.000Z')
const nowSec = Math.floor(now.getTime() / 1000)

function sign(sec: string, ts: string, raw: string): string {
  return `sha256=${createHmac('sha256', sec).update(`${ts}.${raw}`).digest('hex')}`
}

describe('verifyIngestSignature', () => {
  it('accepts a valid signature within tolerance', () => {
    const ts = String(nowSec)
    expect(
      verifyIngestSignature({ secret, rawBody: body, timestamp: ts, signature: sign(secret, ts, body), now }),
    ).toEqual({ ok: true })
  })

  it('accepts exactly at the tolerance boundary (300s)', () => {
    const ts = String(nowSec - 300)
    expect(
      verifyIngestSignature({ secret, rawBody: body, timestamp: ts, signature: sign(secret, ts, body), now }).ok,
    ).toBe(true)
  })

  it('rejects beyond tolerance (301s, both directions)', () => {
    for (const ts of [String(nowSec - 301), String(nowSec + 301)]) {
      expect(
        verifyIngestSignature({ secret, rawBody: body, timestamp: ts, signature: sign(secret, ts, body), now }),
      ).toEqual({ ok: false, reason: 'timestamp_skew' })
    }
  })

  it('rejects non-numeric timestamp', () => {
    expect(
      verifyIngestSignature({ secret, rawBody: body, timestamp: 'abc', signature: 'sha256=' + '0'.repeat(64), now }),
    ).toEqual({ ok: false, reason: 'timestamp_format' })
  })

  it('rejects malformed signature header', () => {
    const ts = String(nowSec)
    for (const bad of ['deadbeef', 'sha256=zz', 'sha1=' + '0'.repeat(64), 'sha256=' + '0'.repeat(63)]) {
      expect(
        verifyIngestSignature({ secret, rawBody: body, timestamp: ts, signature: bad, now }),
      ).toEqual({ ok: false, reason: 'signature_format' })
    }
  })

  it('rejects tampered body and wrong secret', () => {
    const ts = String(nowSec)
    expect(
      verifyIngestSignature({ secret, rawBody: body + ' ', timestamp: ts, signature: sign(secret, ts, body), now }),
    ).toEqual({ ok: false, reason: 'signature_mismatch' })
    expect(
      verifyIngestSignature({ secret: 'other', rawBody: body, timestamp: ts, signature: sign(secret, ts, body), now }),
    ).toEqual({ ok: false, reason: 'signature_mismatch' })
  })

  it('binds the timestamp into the signature (moving ts invalidates)', () => {
    const ts = String(nowSec)
    const other = String(nowSec - 10)
    expect(
      verifyIngestSignature({ secret, rawBody: body, timestamp: other, signature: sign(secret, ts, body), now }),
    ).toEqual({ ok: false, reason: 'signature_mismatch' })
  })
})
```

- [ ] **Step 2: 寫失敗測試 `tests/ingest/payload.test.ts`**

```typescript
import { describe, it, expect } from 'vitest'
import { parsePushPayload } from '@/ingest/payload'

describe('parsePushPayload', () => {
  it('accepts a minimal valid payload', () => {
    expect(parsePushPayload({ message: 'boom' })).toEqual({ ok: true, value: { message: 'boom' } })
  })

  it('accepts a full payload and passes fields through', () => {
    const full = {
      message: 'db down',
      errorType: 'test_failure',
      level: 'fatal',
      occurredAt: '2026-07-28T09:00:00.000Z',
      metadata: { runUrl: 'https://ci/run/1' },
    }
    const result = parsePushPayload(full)
    expect(result).toEqual({ ok: true, value: full })
  })

  it('rejects non-object payloads', () => {
    for (const bad of [null, 'x', 7, [1]]) {
      const result = parsePushPayload(bad)
      expect(result.ok).toBe(false)
    }
  })

  it('requires non-empty message', () => {
    for (const bad of [{}, { message: '' }, { message: '   ' }, { message: 7 }]) {
      const result = parsePushPayload(bad)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors.join()).toMatch(/message/)
    }
  })

  it('accumulates multiple errors', () => {
    const result = parsePushPayload({ errorType: 7, level: true, occurredAt: 'not-a-date', metadata: [1] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.length).toBeGreaterThanOrEqual(4)
  })

  it('rejects invalid occurredAt', () => {
    const result = parsePushPayload({ message: 'x', occurredAt: 'yesterday' })
    expect(result.ok).toBe(false)
  })
})
```

- [ ] **Step 3: 確認 RED**

Run: `pnpm vitest run tests/ingest`
Expected: FAIL（兩個 module not found）。

- [ ] **Step 4: 實作 `src/ingest/hmac.ts`**

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto'

export interface VerifyArgs {
  secret: string
  rawBody: string
  timestamp: string
  signature: string
  now: Date
  toleranceSeconds?: number
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'timestamp_format' | 'timestamp_skew' | 'signature_format' | 'signature_mismatch' }

export function verifyIngestSignature(args: VerifyArgs): VerifyResult {
  const tolerance = args.toleranceSeconds ?? 300

  if (!/^\d+$/.test(args.timestamp)) return { ok: false, reason: 'timestamp_format' }
  const skewSeconds = Math.abs(args.now.getTime() / 1000 - Number(args.timestamp))
  if (skewSeconds > tolerance) return { ok: false, reason: 'timestamp_skew' }

  const match = /^sha256=([0-9a-f]{64})$/.exec(args.signature)
  if (match === null) return { ok: false, reason: 'signature_format' }

  const expected = createHmac('sha256', args.secret)
    .update(`${args.timestamp}.${args.rawBody}`)
    .digest()
  const provided = Buffer.from(match[1], 'hex')
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'signature_mismatch' }
  }
  return { ok: true }
}
```

- [ ] **Step 5: 實作 `src/ingest/payload.ts`**

```typescript
import type { RawPushEvent } from '@/core/normalize'

export type ParseResult = { ok: true; value: RawPushEvent } | { ok: false; errors: string[] }

// 註：input 來自 JSON.parse，故所有值必為 JSON-safe——CanonicalEvent.metadata
// 的 JSON 安全性由這個邊界保證（Plan 3 必要事項 #4）。
export function parsePushPayload(input: unknown): ParseResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['payload must be a JSON object'] }
  }
  const obj = input as Record<string, unknown>
  const errors: string[] = []

  if (typeof obj.message !== 'string' || obj.message.trim() === '') {
    errors.push('message is required and must be a non-empty string')
  }
  for (const key of ['errorType', 'level'] as const) {
    if (obj[key] !== undefined && typeof obj[key] !== 'string') errors.push(`${key} must be a string`)
  }
  if (obj.occurredAt !== undefined) {
    if (typeof obj.occurredAt !== 'string' || Number.isNaN(Date.parse(obj.occurredAt))) {
      errors.push('occurredAt must be an ISO 8601 string')
    }
  }
  if (
    obj.metadata !== undefined &&
    (typeof obj.metadata !== 'object' || obj.metadata === null || Array.isArray(obj.metadata))
  ) {
    errors.push('metadata must be a JSON object')
  }

  if (errors.length > 0) return { ok: false, errors }

  const value: RawPushEvent = { message: obj.message as string }
  if (obj.errorType !== undefined) value.errorType = obj.errorType as string
  if (obj.level !== undefined) value.level = obj.level as string
  if (obj.occurredAt !== undefined) value.occurredAt = obj.occurredAt as string
  if (obj.metadata !== undefined) value.metadata = obj.metadata as Record<string, unknown>
  return { ok: true, value }
}
```

- [ ] **Step 6: 確認 GREEN + 回歸**

Run: `pnpm vitest run tests/ingest && pnpm test && pnpm typecheck`
Expected: 全 PASS。

- [ ] **Step 7: Commit**

```bash
git add src/ingest/hmac.ts src/ingest/payload.ts tests/ingest/hmac.test.ts tests/ingest/payload.test.ts
git commit -m "feat(ingest): HMAC signature verification and payload validation"
```

---

### Task 3: Store 擴充 `getServiceByName`

**Files:**
- Modify: `src/store/contracts.ts`（`ServiceAuth` + port 方法）
- Modify: `src/store/mapping.ts`（無需改——secret 直接取欄位）
- Modify: `src/store/memory.ts`（實作 + seed 支援 secret）
- Modify: `src/store/supabase.ts`（實作）
- Test: Modify `tests/store/memory.test.ts`、`tests/integration/supabase-store.test.ts`（各加一組測試）

**Interfaces:**
- Produces：
  - `interface ServiceAuth { service: ServiceRecord; webhookSecret: string | null }`
  - `Store` 加：`getServiceByName(name: string): Promise<ServiceAuth | null>`
  - `InMemoryStore.seedService(service: ServiceRecord, webhookSecret?: string | null): void`（第二參數新增，預設 null；既有呼叫不受影響）

- [ ] **Step 1: contracts 加型別與方法**

`src/store/contracts.ts` 增：

```typescript
export interface ServiceAuth {
  service: ServiceRecord
  webhookSecret: string | null
}
```

`Store` interface 增一行：

```typescript
  getServiceByName(name: string): Promise<ServiceAuth | null>
```

- [ ] **Step 2: 寫失敗測試（先跑確認 RED——typecheck 會先抓到兩個 store 未實作）**

`tests/store/memory.test.ts` 加：

```typescript
  it('getServiceByName returns service with secret; null when unknown', async () => {
    const withSecret = { ...svc, id: 's-sec', name: 'svc-sec' }
    store.seedService(withSecret, 'topsecret')
    expect(await store.getServiceByName('svc-sec')).toEqual({
      service: withSecret,
      webhookSecret: 'topsecret',
    })
    expect(await store.getServiceByName('svc-a')).toEqual({ service: svc, webhookSecret: null })
    expect(await store.getServiceByName('nope')).toBeNull()
  })
```

`tests/integration/supabase-store.test.ts` 加：

```typescript
describe('SupabaseStore.getServiceByName', () => {
  it('returns service with webhook secret; null when unknown', async () => {
    await client
      .from('services')
      .update({ webhook_secret: 'int-secret' })
      .eq('id', serviceId)
    const auth = await store.getServiceByName('svc-int')
    expect(auth?.service.id).toBe(serviceId)
    expect(auth?.webhookSecret).toBe('int-secret')
    expect(await store.getServiceByName('no-such-service')).toBeNull()
  })
})
```

Run: `pnpm typecheck`
Expected: FAIL（InMemoryStore / SupabaseStore 未實作新方法）。

- [ ] **Step 3: InMemoryStore 實作**

`seedService` 改簽章並存 secret：

```typescript
  private secrets = new Map<string, string | null>() // serviceId → webhookSecret

  seedService(service: ServiceRecord, webhookSecret: string | null = null): void {
    this.services.set(service.id, service)
    this.secrets.set(service.id, webhookSecret)
  }

  async getServiceByName(name: string): Promise<ServiceAuth | null> {
    for (const service of this.services.values()) {
      if (service.name === name) {
        return {
          service: { ...service, poll: service.poll ? { ...service.poll } : null },
          webhookSecret: this.secrets.get(service.id) ?? null,
        }
      }
    }
    return null
  }
```

（import `ServiceAuth`。）

- [ ] **Step 4: SupabaseStore 實作**

```typescript
  async getServiceByName(name: string): Promise<ServiceAuth | null> {
    const { data, error } = await this.client
      .from('services')
      .select('*')
      .eq('name', name)
      .maybeSingle()
    if (error) throw new Error(`getServiceByName failed: ${error.message}`)
    return data === null ? null : { service: rowToService(data), webhookSecret: data.webhook_secret }
  }
```

（import `ServiceAuth`。）

- [ ] **Step 5: GREEN + 回歸**

Run: `pnpm test && pnpm typecheck && pnpm test:integration`
Expected: 全綠（單元含新 memory 測試；整合含新 describe）。

- [ ] **Step 6: Commit**

```bash
git add src/store/contracts.ts src/store/memory.ts src/store/supabase.ts tests/store/memory.test.ts tests/integration/supabase-store.test.ts
git commit -m "feat(store): getServiceByName with webhook secret for ingest auth"
```

---

### Task 4: `handleIngest` core + route handler

**Files:**
- Create: `src/ingest/handle-ingest.ts`
- Create: `src/store/server.ts`
- Create: `app/api/ingest/route.ts`
- Test: `tests/ingest/handle-ingest.test.ts`

**Interfaces:**
- Consumes: Task 2/3 產物、`normalizePushEvent`、`processEvent`、`InMemoryStore`（測試）。
- Produces：
  - `interface IngestRequest { rawBody: string; serviceName: string | null; timestamp: string | null; signature: string | null }`
  - `interface IngestResponse { status: number; body: Record<string, unknown> }`
  - `handleIngest(store: Store, request: IngestRequest, now: Date): Promise<IngestResponse>`
  - `createServerStore(): SupabaseStore`（讀 `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`，缺值 throw）
  - `POST` route：`app/api/ingest/route.ts`（薄轉接）

- [ ] **Step 1: 寫失敗測試 `tests/ingest/handle-ingest.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { handleIngest } from '@/ingest/handle-ingest'
import { InMemoryStore } from '@/store/memory'
import type { ServiceRecord } from '@/store/contracts'

const now = new Date('2026-07-28T10:00:00.000Z')
const nowSec = String(Math.floor(now.getTime() / 1000))
const secret = 'svc-secret'

const svc: ServiceRecord = {
  id: 's-1',
  name: 'svc-a',
  healthWindowMinutes: 15,
  healthFailureThreshold: 2,
  healthStatus: 'healthy',
  poll: null,
}

function sign(sec: string, ts: string, raw: string): string {
  return `sha256=${createHmac('sha256', sec).update(`${ts}.${raw}`).digest('hex')}`
}

function request(rawBody: string, over: Partial<{ serviceName: string | null; timestamp: string | null; signature: string | null }> = {}) {
  return {
    rawBody,
    serviceName: 'svc-a',
    timestamp: nowSec,
    signature: sign(secret, nowSec, rawBody),
    ...over,
  }
}

describe('handleIngest', () => {
  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc, secret)
  })

  it('401 when any auth header is missing', async () => {
    const body = '{"message":"x"}'
    for (const over of [{ serviceName: null }, { timestamp: null }, { signature: null }]) {
      const res = await handleIngest(store, request(body, over), now)
      expect(res.status).toBe(401)
    }
  })

  it('401 for unknown service and service without secret (indistinguishable)', async () => {
    const body = '{"message":"x"}'
    const unknown = await handleIngest(store, request(body, { serviceName: 'nope' }), now)
    store.seedService({ ...svc, id: 's-2', name: 'svc-nosecret' }, null)
    const nosecret = await handleIngest(
      store,
      request(body, { serviceName: 'svc-nosecret', signature: sign(secret, nowSec, body) }),
      now,
    )
    expect(unknown).toEqual(nosecret)
    expect(unknown.status).toBe(401)
    expect(unknown.body).toEqual({ error: 'unauthorized' })
  })

  it('401 for bad signature and stale timestamp', async () => {
    const body = '{"message":"x"}'
    const bad = await handleIngest(store, request(body, { signature: 'sha256=' + '0'.repeat(64) }), now)
    expect(bad.status).toBe(401)
    const staleTs = String(Math.floor(now.getTime() / 1000) - 301)
    const stale = await handleIngest(
      store,
      request(body, { timestamp: staleTs, signature: sign(secret, staleTs, body) }),
      now,
    )
    expect(stale.status).toBe(401)
  })

  it('400 for invalid JSON (signature valid over the raw bytes)', async () => {
    const body = 'not json'
    const res = await handleIngest(store, request(body), now)
    expect(res.status).toBe(400)
  })

  it('422 for schema violations with details', async () => {
    const body = '{"level":7}'
    const res = await handleIngest(store, request(body), now)
    expect(res.status).toBe(422)
    expect(res.body.details).toBeDefined()
  })

  it('201 on success: event flows through processEvent and persists', async () => {
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P1', tags: ['ci'], match: { errorType: 'test_failure' } })
    const body = JSON.stringify({ message: 'unit tests failed', errorType: 'test_failure' })
    const res = await handleIngest(store, request(body), now)
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ severity: 'P1', health: 'degraded', duplicate: false })
    const open = await store.listOpenIssues('s-1')
    expect(open).toHaveLength(1)
    expect((await store.getService('s-1'))?.healthStatus).toBe('degraded')
  })

  it('repeat events aggregate into the same issue', async () => {
    const body = JSON.stringify({ message: 'User 1 not found' })
    const body2 = JSON.stringify({ message: 'User 999 not found' })
    await handleIngest(store, request(body), now)
    const res = await handleIngest(store, request(body2), now)
    expect(res.status).toBe(201)
    expect(await store.listOpenIssues('s-1')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 確認 RED**

Run: `pnpm vitest run tests/ingest/handle-ingest.test.ts`
Expected: FAIL（module not found）。

- [ ] **Step 3: 實作 `src/ingest/handle-ingest.ts`**

```typescript
import { verifyIngestSignature } from '@/ingest/hmac'
import { parsePushPayload } from '@/ingest/payload'
import { normalizePushEvent } from '@/core/normalize'
import { processEvent } from '@/pipeline/process-event'
import type { Store } from '@/store/contracts'

export interface IngestRequest {
  rawBody: string
  serviceName: string | null
  timestamp: string | null
  signature: string | null
}

export interface IngestResponse {
  status: number
  body: Record<string, unknown>
}

const UNAUTHORIZED: IngestResponse = { status: 401, body: { error: 'unauthorized' } }

export async function handleIngest(
  store: Store,
  request: IngestRequest,
  now: Date,
): Promise<IngestResponse> {
  if (request.serviceName === null || request.timestamp === null || request.signature === null) {
    return UNAUTHORIZED
  }

  const auth = await store.getServiceByName(request.serviceName)
  if (auth === null || auth.webhookSecret === null) return UNAUTHORIZED

  const verdict = verifyIngestSignature({
    secret: auth.webhookSecret,
    rawBody: request.rawBody,
    timestamp: request.timestamp,
    signature: request.signature,
    now,
  })
  if (!verdict.ok) return UNAUTHORIZED

  let json: unknown
  try {
    json = JSON.parse(request.rawBody)
  } catch {
    return { status: 400, body: { error: 'invalid JSON' } }
  }

  const parsed = parsePushPayload(json)
  if (!parsed.ok) return { status: 422, body: { error: 'invalid payload', details: parsed.errors } }

  const event = normalizePushEvent(auth.service.id, parsed.value, now)
  const result = await processEvent(store, event, now)
  return {
    status: 201,
    body: {
      issueId: result.issue.id,
      severity: result.issue.severity,
      health: result.health,
      duplicate: result.duplicate,
    },
  }
}
```

- [ ] **Step 4: 實作 `src/store/server.ts` 與 route**

`src/store/server.ts`：

```typescript
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/db/database.types'
import { SupabaseStore } from '@/store/supabase'

export function createServerStore(): SupabaseStore {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (url === undefined || key === undefined) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  }
  return new SupabaseStore(createClient<Database>(url, key, { auth: { persistSession: false } }))
}
```

`app/api/ingest/route.ts`：

```typescript
import { handleIngest } from '@/ingest/handle-ingest'
import { createServerStore } from '@/store/server'

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text()
  const result = await handleIngest(
    createServerStore(),
    {
      rawBody,
      serviceName: request.headers.get('x-beacon-service'),
      timestamp: request.headers.get('x-beacon-timestamp'),
      signature: request.headers.get('x-beacon-signature'),
    },
    new Date(),
  )
  return Response.json(result.body, { status: result.status })
}
```

- [ ] **Step 5: GREEN + 回歸（含 build）**

Run: `pnpm vitest run tests/ingest/handle-ingest.test.ts && pnpm test && pnpm typecheck && pnpm build`
Expected: 全 PASS、build 成功（route 編譯過）。

- [ ] **Step 6: Commit**

```bash
git add src/ingest/handle-ingest.ts src/store/server.ts app/api/ingest/route.ts tests/ingest/handle-ingest.test.ts
git commit -m "feat(ingest): POST /api/ingest with HMAC auth wired to processEvent"
```

---

### Task 5: Route 層整合測試（真 DB、真 Request/Response）

**Files:**
- Modify: `tests/integration/helpers.ts`（抽出 env 讀取）
- Test: `tests/integration/ingest-route.test.ts`

**Interfaces:**
- Produces：`getLocalSupabaseEnv(): { url: string; serviceRoleKey: string }`（helpers 新 export；`createServiceRoleClient` 改用之，行為不變）。

- [ ] **Step 1: helpers 抽出 env 讀取**

`tests/integration/helpers.ts` 把 `createServiceRoleClient` 內讀 env 的部分抽成：

```typescript
export function getLocalSupabaseEnv(): { url: string; serviceRoleKey: string } {
  const env = execSync('supabase status -o env', { encoding: 'utf8' })
  return { url: readVar(env, 'API_URL'), serviceRoleKey: readVar(env, 'SERVICE_ROLE_KEY') }
}

export function createServiceRoleClient(): SupabaseClient<Database> {
  const { url, serviceRoleKey } = getLocalSupabaseEnv()
  return createClient<Database>(url, serviceRoleKey, { auth: { persistSession: false } })
}
```

- [ ] **Step 2: 寫 `tests/integration/ingest-route.test.ts`**

```typescript
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { createServiceRoleClient, cleanDatabase, getLocalSupabaseEnv } from './helpers'
import { POST } from '@/../app/api/ingest/route'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/db/database.types'

let client: SupabaseClient<Database>
let serviceId: string
const secret = 'route-secret'

function signedRequest(body: string, over: Record<string, string> = {}): Request {
  const ts = String(Math.floor(Date.now() / 1000))
  const sig = `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`
  return new Request('http://localhost/api/ingest', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-beacon-service': 'svc-route',
      'x-beacon-timestamp': ts,
      'x-beacon-signature': sig,
      ...over,
    },
    body,
  })
}

beforeAll(() => {
  const { url, serviceRoleKey } = getLocalSupabaseEnv()
  process.env.SUPABASE_URL = url
  process.env.SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey
  client = createServiceRoleClient()
})

beforeEach(async () => {
  await cleanDatabase(client)
  const { data, error } = await client
    .from('services')
    .insert({ name: 'svc-route', webhook_secret: secret })
    .select('id')
    .single()
  if (error) throw error
  serviceId = data.id
})

describe('POST /api/ingest (route-level, real DB)', () => {
  it('201: signed CI test_failure lands as P1 issue and degrades health', async () => {
    await client.from('triage_rules').insert({
      service_id: null,
      priority: 100,
      severity: 'P1',
      tags: ['ci'],
      match: { errorType: 'test_failure' } as Json,
    })
    const body = JSON.stringify({
      message: 'nightly tests failed: 3 of 120',
      errorType: 'test_failure',
      metadata: { runUrl: 'https://ci.example/run/42' },
    })
    const res = await POST(signedRequest(body))
    expect(res.status).toBe(201)
    const payload = await res.json()
    expect(payload).toMatchObject({ severity: 'P1', health: 'degraded', duplicate: false })

    const { data: issue } = await client
      .from('issues')
      .select('severity,tags,count,error_type')
      .eq('service_id', serviceId)
      .single()
    expect(issue).toMatchObject({ severity: 'P1', tags: ['ci'], count: 1, error_type: 'test_failure' })
    const { data: svc } = await client
      .from('services')
      .select('health_status')
      .eq('id', serviceId)
      .single()
    expect(svc?.health_status).toBe('degraded')
  })

  it('401: tampered signature writes nothing', async () => {
    const body = JSON.stringify({ message: 'x' })
    const res = await POST(signedRequest(body, { 'x-beacon-signature': 'sha256=' + '0'.repeat(64) }))
    expect(res.status).toBe(401)
    const { count } = await client
      .from('issues')
      .select('*', { count: 'exact', head: true })
    expect(count).toBe(0)
  })

  it('422: schema violation reports details', async () => {
    const res = await POST(signedRequest('{"level":7}'))
    expect(res.status).toBe(422)
    const payload = await res.json()
    expect(payload.details).toBeDefined()
  })
})
```

註：route 的 `POST` 用 `new Date()` 與測試的 `Date.now()` 時戳同源、天然在容忍窗內；此為整合測試檔，允許真時鐘。import 路徑 `@/../app/...` 若 alias 解析不了，改用相對路徑 `../../app/api/ingest/route`（以實跑為準，報告註明）。

- [ ] **Step 3: 執行**

Run: `pnpm test:integration && pnpm test && pnpm typecheck`
Expected: 整合（既有 13 + 新 3 + Task 3 新增 1 = 17）全綠；單元、typecheck 綠。

- [ ] **Step 4: Commit**

```bash
git add tests/integration/helpers.ts tests/integration/ingest-route.test.ts
git commit -m "test(ingest): route-level integration against real DB"
```

---

### Task 6: CI 回報 script + seed 規則 + spec wire 定案

**Files:**
- Create: `scripts/report-to-beacon.sh`（chmod +x）
- Create: `supabase/seed.sql`
- Modify: `docs/superpowers/specs/2026-07-23-service-monitoring-dashboard-design.md`（§4.1 wire 契約定案）
- Test: Modify `tests/ingest/hmac.test.ts`（openssl 跨工具 fixture）

**Interfaces:**
- Produces：可直接複製進各專案 CI 的回報 script；`supabase db reset` 後自帶 `test_failure → P1` 全域規則；spec 記載最終 wire 契約。

- [ ] **Step 1: 建立 `scripts/report-to-beacon.sh`**

```bash
#!/usr/bin/env bash
# th-beacon CI 測試失敗回報範例。
# 用法：BEACON_URL=https://beacon.example.com/api/ingest \
#       BEACON_SERVICE=my-service BEACON_SECRET=xxx \
#       ./report-to-beacon.sh "nightly tests failed: 3 of 120" "https://ci.example/run/42"
set -euo pipefail

BEACON_URL="${BEACON_URL:?BEACON_URL is required}"
BEACON_SERVICE="${BEACON_SERVICE:?BEACON_SERVICE is required}"
BEACON_SECRET="${BEACON_SECRET:?BEACON_SECRET is required}"
MESSAGE="${1:?usage: report-to-beacon.sh <message> [runUrl]}"
RUN_URL="${2:-}"

TS="$(date +%s)"
BODY="$(jq -cn --arg m "$MESSAGE" --arg u "$RUN_URL" \
  '{message:$m, errorType:"test_failure", level:"error", metadata:(if $u == "" then {} else {runUrl:$u} end)}')"
SIG="$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$BEACON_SECRET" -hex | sed 's/^.* //')"

curl -sS -X POST "$BEACON_URL" \
  -H "Content-Type: application/json" \
  -H "X-Beacon-Service: $BEACON_SERVICE" \
  -H "X-Beacon-Timestamp: $TS" \
  -H "X-Beacon-Signature: sha256=$SIG" \
  -d "$BODY"
```

Run: `chmod +x scripts/report-to-beacon.sh && bash -n scripts/report-to-beacon.sh`
Expected: 語法檢查通過。

- [ ] **Step 2: openssl 跨工具 fixture 測試**

先實跑產生 fixture（確保 script 的 openssl 簽法與我們的驗證器互通）：

Run: `printf '%s.%s' "1785276000" '{"message":"fixture"}' | openssl dgst -sha256 -hmac "fixture-secret" -hex | sed 's/^.* //'`

把輸出的 64-hex 填進 `tests/ingest/hmac.test.ts` 新增測試（`<OPENSSL_HEX>` 換成實際值）：

```typescript
  it('accepts a signature produced by the CI script openssl pipeline', () => {
    // fixture 由 scripts/report-to-beacon.sh 相同的 openssl 指令產生：
    // printf '%s.%s' 1785276000 '{"message":"fixture"}' | openssl dgst -sha256 -hmac fixture-secret -hex
    const result = verifyIngestSignature({
      secret: 'fixture-secret',
      rawBody: '{"message":"fixture"}',
      timestamp: '1785276000',
      signature: 'sha256=<OPENSSL_HEX>',
      now: new Date(1785276000 * 1000),
    })
    expect(result).toEqual({ ok: true })
  })
```

Run: `pnpm vitest run tests/ingest/hmac.test.ts`
Expected: PASS（若不過，表示 script 簽法與驗證器不相容——這正是本測試要抓的，STOP 回報）。

- [ ] **Step 3: 建立 `supabase/seed.sql`**

```sql
-- Seed：全域檢傷規則（db reset 時載入）
-- CI 每日測試失敗（spec §4.1 使用慣例）：預設 P1
insert into public.triage_rules (service_id, priority, severity, tags, match)
values (null, 100, 'P1', array['ci'], '{"errorType": "test_failure"}'::jsonb);
```

Run: `supabase db reset && supabase migration list --local`
Expected: reset 乾淨且 seed 載入無錯；4 支 migration 不變。再跑 `pnpm test:integration` 確認整合測試不受 seed 影響（測試各自清庫）。

- [ ] **Step 4: spec §4.1 定案 wire 契約**

在 spec 的 §4.1（Ingest 入口）「CI 每日測試回報（使用慣例）」段落之後，加上：

```markdown
- **Wire 契約（已定案）**：
  - Headers：`X-Beacon-Service`（services.name）、`X-Beacon-Timestamp`（unix 秒）、`X-Beacon-Signature`（`sha256=<hex>`，HMAC-SHA256(secret, `"${timestamp}.${rawBody}"`)）。
  - 防重放：時戳偏差 > 300 秒即拒。驗證失敗一律 `401 {"error":"unauthorized"}`（不洩漏服務名是否存在）。
  - Payload：`{"message"(必填), "errorType"?, "level"?, "occurredAt"?, "metadata"?}` 單筆事件；`400` JSON 解析失敗、`422` schema 不符（附 details）、`201` 成功（回 issueId/severity/health/duplicate）。
  - 回報 script 範例：`scripts/report-to-beacon.sh`（jq + openssl + curl）；`test_failure → P1` 種子規則見 `supabase/seed.sql`。
```

- [ ] **Step 5: 全量回歸**

Run: `pnpm test && pnpm typecheck && pnpm test:integration`
Expected: 全綠。

- [ ] **Step 6: Commit**

```bash
git add scripts/report-to-beacon.sh supabase/seed.sql tests/ingest/hmac.test.ts docs/superpowers/specs/2026-07-23-service-monitoring-dashboard-design.md
git commit -m "feat(ingest): CI report script, test_failure seed rule, wire contract in spec"
```

---

## 完成後

Plan 4 交付可驗簽的 `POST /api/ingest` 全鏈（HMAC → 驗 payload → processEvent → DB 落地）、CI 回報 script 與 seed 規則、定案的 wire 契約。**各專案 CI 從此可以開始接入**。下一份 **Plan 5｜服務輪詢器** 實作 `GET /api/poll/services`（Cron 觸發、內部 token）：health 存活偵測、PollState 寫回、連續成功清 health issue、error 端點補漏，並處理 Plan 3 review 移交的兩件事（poller 覆蓋健康度過期窗口、Store port「0 rows affected」語意統一）。
