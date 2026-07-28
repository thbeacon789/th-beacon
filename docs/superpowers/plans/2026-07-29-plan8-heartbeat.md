# 心跳存活證明 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 CI 每次執行（成功或失敗）都回報到 beacon，並在排程工作靜默失效（該回報卻沒回報）時自動告警。

**Architecture:** 新增具名心跳（`(service_id, name)`）資料表與 `POST /api/heartbeat` 單一回報入口。回報 `fail` 時轉成 canonical event 走既有 `processAndNotify` 管線；逾期偵測掛在現有 cron route 上，合成 `heartbeat_missed` event 走同一條管線。逾期判定用 `last_run_at`（有沒有回報）而非 `last_success_at`（有沒有成功），與 `test_failure` 正交。健康度在 dashboard 讀取端即時推導，不依賴 `services.health_status` 欄位。

**Tech Stack:** Next.js App Router、TypeScript、Supabase Postgres、Vitest、pnpm。

**Spec:** `docs/superpowers/specs/2026-07-29-heartbeat-liveness-design.md`（唯一真實來源，有疑義以 spec 為準）

## Global Constraints

- `src/core/**` 必須是**純函式**：禁 I/O、禁 `Date.now()`，時鐘一律由參數注入。這是硬性約束，測試依賴它。
- 套件管理器一律 `pnpm`。**不要執行 `pnpm dev`**（dev server 由使用者自管）。
- commit 只納入當次改動檔案，用明確路徑 `git add`，**禁 `git add -A`**。不開新 branch。
- 溝通與 commit message 用**繁體中文**。
- 所有 public 表啟用 RLS 且 deny-by-default（無 policy）。**不要**為了消 advisors 的 `rls_enabled_no_policy` INFO 而加 policy。
- `src/db/database.types.ts` 是 `pnpm db:types` 的自動產物，**禁止手改**。
- 路徑別名 `@/` 對應專案根目錄的 `src/`（例：`@/core/heartbeat` → `src/core/heartbeat.ts`）。
- 測試框架為 Vitest，單元測試零 DB 依賴（`pnpm test`）；整合測試需本地 stack（`pnpm test:integration`）。
- 既有的 `POST /api/ingest` 行為**完全不變**，本計畫不得修改 `src/ingest/**` 的既有邏輯。

---

## 檔案結構

**新建**

| 檔案 | 責任 |
|---|---|
| `src/core/heartbeat.ts` | 純函式：到期／逾期判定、指紋、兩種 canonical event 合成 |
| `src/heartbeat/payload.ts` | 回報 payload 的解析與驗證 |
| `src/heartbeat/handle-heartbeat.ts` | 回報入口的完整邏輯（驗簽 → 更新 → resolve → 轉管線） |
| `src/heartbeat/scan.ts` | 逾期掃描 |
| `app/api/heartbeat/route.ts` | HTTP 轉接層 |
| `scripts/heartbeat-to-beacon.sh` | CI 側呼叫範例 |
| `supabase/migrations/<ts>_heartbeats.sql` | 資料表 |

**修改**

| 檔案 | 改什麼 |
|---|---|
| `src/store/contracts.ts` | 新增 4 個 Store 方法與 2 個型別 |
| `src/store/memory.ts` / `src/store/supabase.ts` | 實作上述方法 |
| `src/store/mapping.ts` | 新增 `rowToHeartbeat` |
| `src/notify/message.ts` | `extractNotifyDetails` ＋ `buildDiscordMessage` 加 details |
| `src/pipeline/process-and-notify.ts` | 把 `event.metadata` 交給訊息組裝 |
| `app/api/poll/services/route.ts` | 掛上逾期掃描 |
| `src/web/queries.ts` / `app/page.tsx` | 心跳顯示 |
| `app/issues/[id]/page.tsx` | metadata 的 runUrl 渲染成連結 |
| `supabase/seed.sql` | `heartbeat_missed → P1` 規則 |

---

## Task 1: 核心純函式 `src/core/heartbeat.ts`

**Files:**
- Create: `src/core/heartbeat.ts`
- Test: `tests/core/heartbeat.test.ts`

**Interfaces:**
- Consumes: `computeFingerprint`（`src/core/fingerprint.ts`）、`CanonicalEvent`（`src/core/types.ts`）
- Produces:
  - `type HeartbeatRunStatus = 'pass' | 'fail'`
  - `interface HeartbeatDefinition { name: string; intervalSeconds: number; graceSeconds: number; lastRunAt: string | null; createdAt: string }`
  - `heartbeatFingerprint(serviceId: string, errorType: string, name: string): string`
  - `heartbeatDueAt(hb: HeartbeatDefinition): Date`
  - `isHeartbeatOverdue(hb: HeartbeatDefinition, now: Date): boolean`
  - `synthesizeHeartbeatMissedEvent(serviceId: string, hb: HeartbeatDefinition, occurredAt: Date): CanonicalEvent`
  - `interface HeartbeatFailurePayload { runUrl?: string; summary?: string }`
  - `normalizeHeartbeatFailure(serviceId: string, hb: HeartbeatDefinition, payload: HeartbeatFailurePayload, occurredAt: Date): CanonicalEvent`

**背景（實作者必讀）：** `computeFingerprint` 會對 message 做正規化，其中 `\b\d+\b` 會被換成 `<n>`。因此**心跳名稱絕對不能只透過 message 參與指紋計算**——否則 `daily-2` 與 `daily-3` 會產生相同指紋，兩個心跳的 issue 會被錯誤地聚合成一筆。解法是把名稱併進 `errorType` 參數（該參數不經正規化）。

- [ ] **Step 1: 寫失敗測試**

建立 `tests/core/heartbeat.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import {
  heartbeatFingerprint,
  heartbeatDueAt,
  isHeartbeatOverdue,
  synthesizeHeartbeatMissedEvent,
  normalizeHeartbeatFailure,
  type HeartbeatDefinition,
} from '@/core/heartbeat'

const base: HeartbeatDefinition = {
  name: 'daily-test',
  intervalSeconds: 86_400,
  graceSeconds: 3_600,
  lastRunAt: '2026-07-28T03:00:00.000Z',
  createdAt: '2026-07-01T00:00:00.000Z',
}

describe('heartbeatDueAt', () => {
  it('以 lastRunAt 加上 interval 為到期時刻', () => {
    expect(heartbeatDueAt(base).toISOString()).toBe('2026-07-29T03:00:00.000Z')
  })

  it('從未回報時以 createdAt 為基準', () => {
    const fresh = { ...base, lastRunAt: null }
    expect(heartbeatDueAt(fresh).toISOString()).toBe('2026-07-02T00:00:00.000Z')
  })
})

describe('isHeartbeatOverdue', () => {
  it('到期時刻加寬限期之前不算逾期', () => {
    // 到期 07-29T03:00 + grace 1h = 04:00，邊界值本身不算逾期
    expect(isHeartbeatOverdue(base, new Date('2026-07-29T04:00:00.000Z'))).toBe(false)
  })

  it('超過寬限期算逾期', () => {
    expect(isHeartbeatOverdue(base, new Date('2026-07-29T04:00:00.001Z'))).toBe(true)
  })

  it('grace 為 0 時到期即逾期', () => {
    const nograce = { ...base, graceSeconds: 0 }
    expect(isHeartbeatOverdue(nograce, new Date('2026-07-29T03:00:00.000Z'))).toBe(false)
    expect(isHeartbeatOverdue(nograce, new Date('2026-07-29T03:00:00.001Z'))).toBe(true)
  })
})

describe('heartbeatFingerprint', () => {
  it('名稱中的數字不被正規化吃掉——不同名稱必須產生不同指紋', () => {
    const a = heartbeatFingerprint('s-1', 'heartbeat_missed', 'daily-2')
    const b = heartbeatFingerprint('s-1', 'heartbeat_missed', 'daily-3')
    expect(a).not.toBe(b)
  })

  it('同名同 errorType 穩定，跨 errorType 不同', () => {
    const a = heartbeatFingerprint('s-1', 'heartbeat_missed', 'daily-test')
    const b = heartbeatFingerprint('s-1', 'heartbeat_missed', 'daily-test')
    const c = heartbeatFingerprint('s-1', 'test_failure', 'daily-test')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

describe('synthesizeHeartbeatMissedEvent', () => {
  const now = new Date('2026-07-29T09:00:00.000Z')

  it('message 固定含名稱，變動細節進 metadata', () => {
    const event = synthesizeHeartbeatMissedEvent('s-1', base, now)
    expect(event.message).toBe('Heartbeat missed: daily-test')
    expect(event.errorType).toBe('heartbeat_missed')
    expect(event.source).toBe('poll')
    expect(event.level).toBe('error')
    expect(event.occurredAt).toBe('2026-07-29T09:00:00.000Z')
    expect(event.metadata).toMatchObject({
      heartbeat: 'daily-test',
      intervalSeconds: 86_400,
      graceSeconds: 3_600,
      lastRunAt: '2026-07-28T03:00:00.000Z',
      overdueSeconds: 21_600, // 09:00 - 03:00 = 6h
    })
  })

  it('指紋與 normalizeHeartbeatFailure 不同（兩類 issue 必須分開）', () => {
    const missed = synthesizeHeartbeatMissedEvent('s-1', base, now)
    const failed = normalizeHeartbeatFailure('s-1', base, {}, now)
    expect(missed.fingerprint).not.toBe(failed.fingerprint)
  })
})

describe('normalizeHeartbeatFailure', () => {
  const now = new Date('2026-07-29T03:05:00.000Z')

  it('message 固定，runUrl 與 summary 進 metadata', () => {
    const event = normalizeHeartbeatFailure(
      's-1',
      base,
      { runUrl: 'https://github.com/o/r/actions/runs/1', summary: '3 of 210 failed' },
      now,
    )
    expect(event.message).toBe('Test failed: daily-test')
    expect(event.errorType).toBe('test_failure')
    expect(event.source).toBe('push')
    expect(event.metadata).toEqual({
      heartbeat: 'daily-test',
      runUrl: 'https://github.com/o/r/actions/runs/1',
      summary: '3 of 210 failed',
    })
  })

  it('未提供選填欄位時 metadata 不含該鍵', () => {
    const event = normalizeHeartbeatFailure('s-1', base, {}, now)
    expect(event.metadata).toEqual({ heartbeat: 'daily-test' })
  })

  it('同一心跳連續失敗聚合成同一指紋', () => {
    const a = normalizeHeartbeatFailure('s-1', base, { summary: 'x' }, now)
    const b = normalizeHeartbeatFailure('s-1', base, { summary: 'y' }, now)
    expect(a.fingerprint).toBe(b.fingerprint)
  })
})
```

- [ ] **Step 2: 執行測試確認失敗**

```bash
pnpm vitest run tests/core/heartbeat.test.ts
```

預期：FAIL，找不到模組 `@/core/heartbeat`。

- [ ] **Step 3: 實作**

建立 `src/core/heartbeat.ts`：

```typescript
import type { CanonicalEvent } from '@/core/types'
import { computeFingerprint } from '@/core/fingerprint'

export type HeartbeatRunStatus = 'pass' | 'fail'

export interface HeartbeatDefinition {
  name: string
  intervalSeconds: number
  graceSeconds: number
  lastRunAt: string | null
  createdAt: string
}

// 名稱走 errorType 位置參與雜湊：computeFingerprint 只正規化 message，
// 其中 \b\d+\b 會被換成 <n>，若名稱只從 message 進入，daily-2 與 daily-3
// 會產生相同指紋而被錯誤聚合成同一筆 issue。
export function heartbeatFingerprint(
  serviceId: string,
  errorType: string,
  name: string,
): string {
  return computeFingerprint({ serviceId, errorType: `${errorType}:${name}`, message: '' })
}

export function heartbeatDueAt(hb: HeartbeatDefinition): Date {
  const base = hb.lastRunAt ?? hb.createdAt
  return new Date(new Date(base).getTime() + hb.intervalSeconds * 1000)
}

export function isHeartbeatOverdue(hb: HeartbeatDefinition, now: Date): boolean {
  return now.getTime() > heartbeatDueAt(hb).getTime() + hb.graceSeconds * 1000
}

export function synthesizeHeartbeatMissedEvent(
  serviceId: string,
  hb: HeartbeatDefinition,
  occurredAt: Date,
): CanonicalEvent {
  const errorType = 'heartbeat_missed'
  // 訊息刻意只含名稱（不含逾期秒數等變動值），確保同一心跳的重複掃描聚合成同一 issue。
  const message = `Heartbeat missed: ${hb.name}`
  const overdueMs = occurredAt.getTime() - heartbeatDueAt(hb).getTime()
  return {
    serviceId,
    source: 'poll',
    level: 'error',
    errorType,
    message,
    fingerprint: heartbeatFingerprint(serviceId, errorType, hb.name),
    occurredAt: occurredAt.toISOString(),
    metadata: {
      heartbeat: hb.name,
      intervalSeconds: hb.intervalSeconds,
      graceSeconds: hb.graceSeconds,
      lastRunAt: hb.lastRunAt,
      overdueSeconds: Math.floor(overdueMs / 1000),
    },
  }
}

export interface HeartbeatFailurePayload {
  runUrl?: string
  summary?: string
}

export function normalizeHeartbeatFailure(
  serviceId: string,
  hb: HeartbeatDefinition,
  payload: HeartbeatFailurePayload,
  occurredAt: Date,
): CanonicalEvent {
  const errorType = 'test_failure'
  const message = `Test failed: ${hb.name}`
  return {
    serviceId,
    source: 'push',
    level: 'error',
    errorType,
    message,
    fingerprint: heartbeatFingerprint(serviceId, errorType, hb.name),
    occurredAt: occurredAt.toISOString(),
    metadata: {
      heartbeat: hb.name,
      ...(payload.runUrl !== undefined ? { runUrl: payload.runUrl } : {}),
      ...(payload.summary !== undefined ? { summary: payload.summary } : {}),
    },
  }
}
```

- [ ] **Step 4: 執行測試確認通過**

```bash
pnpm vitest run tests/core/heartbeat.test.ts && pnpm typecheck
```

預期：全數 PASS，typecheck 無錯誤。

- [ ] **Step 5: Commit**

```bash
git add src/core/heartbeat.ts tests/core/heartbeat.test.ts
git commit -m "feat(core): 心跳到期判定與事件合成純函式"
```

---

## Task 2: 資料表 migration ＋ seed 規則

**Files:**
- Create: `supabase/migrations/<timestamp>_heartbeats.sql`（用 CLI 產生檔名，勿手寫時戳）
- Modify: `supabase/seed.sql`
- Regenerate: `src/db/database.types.ts`

**Interfaces:**
- Produces: `public.heartbeats` 表；`Database['public']['Tables']['heartbeats']` 型別供 Task 3 使用。

**前置條件：** OrbStack Docker 已啟動，`supabase start` 已跑起本地 stack。若 `supabase status` 顯示未啟動，先執行 `supabase start`。

- [ ] **Step 1: 建立 migration 檔**

```bash
supabase migration new heartbeats
```

- [ ] **Step 2: 填入 SQL**

把以下內容寫進剛產生的 migration 檔：

```sql
-- heartbeats: 具名心跳（每個服務可有多個排程工作各自監控）
create table public.heartbeats (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references public.services(id) on delete cascade,
  name text not null,
  interval_seconds integer not null check (interval_seconds > 0),
  grace_seconds integer not null default 0 check (grace_seconds >= 0),
  enabled boolean not null default true,
  -- last_run_at：每次回報都更新，是逾期判定的唯一依據（回報＝CI 還活著）
  last_run_at timestamptz,
  -- last_success_at：只有 pass 才更新，純顯示用
  last_success_at timestamptz,
  last_run_status text check (last_run_status in ('pass', 'fail')),
  last_run_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (service_id, name)
);

-- 逾期掃描只看 enabled 的心跳
create index heartbeats_enabled_idx on public.heartbeats (enabled) where enabled;
create index heartbeats_service_idx on public.heartbeats (service_id);

-- 與其他 public 表一致：啟用 RLS 且不給 policy（deny-by-default）。
-- dashboard 由 server-side service_role 讀取，不走 anon/authenticated。
alter table public.heartbeats enable row level security;

create trigger heartbeats_set_updated_at
  before update on public.heartbeats
  for each row execute function extensions.moddatetime(updated_at);
```

- [ ] **Step 3: 新增 seed 判級規則**

在 `supabase/seed.sql` 的既有規則之後、`allowed_emails` 之前插入：

```sql
-- 心跳逾期：排程工作完全沒回報（workflow 被停用／cron 壞掉）。
-- P1 而非 P0——排程沒跑不等於服務本體死亡（那是 health_check_failed 的 P0）。
-- P1 已達 NOTIFY_MIN_SEVERITY，會發 Discord。
insert into public.triage_rules (service_id, priority, severity, tags, match)
values (null, 100, 'P1', array['heartbeat'], '{"errorType": "heartbeat_missed"}'::jsonb);
```

- [ ] **Step 4: 套用並驗證**

```bash
supabase db reset
supabase db advisors --local --type security
```

預期：reset 成功套用全部 migrations；advisors 除了既有的 `rls_enabled_no_policy` INFO 之外沒有新的 WARN/ERROR。**不要**為了消除該 INFO 而加 policy。

- [ ] **Step 5: 重生型別**

```bash
pnpm db:types && pnpm typecheck
```

預期：`src/db/database.types.ts` 出現 `heartbeats` 表定義；typecheck 通過。

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/ supabase/seed.sql src/db/database.types.ts
git commit -m "feat(db): heartbeats 表與心跳逾期判級規則"
```

---

## Task 3: Store port 擴充

**Files:**
- Modify: `src/store/contracts.ts`、`src/store/mapping.ts`、`src/store/memory.ts`、`src/store/supabase.ts`
- Test: `tests/store/memory.test.ts`（擴充）

**Interfaces:**
- Consumes: Task 1 的 `HeartbeatDefinition`、`HeartbeatRunStatus`；Task 2 的 `heartbeats` 表型別
- Produces（Task 5、6、7 都依賴這些簽名）：
  - `interface StoredHeartbeat extends HeartbeatDefinition { id: string; serviceId: string; enabled: boolean; lastSuccessAt: string | null; lastRunStatus: HeartbeatRunStatus | null; lastRunUrl: string | null }`
  - `interface HeartbeatRun { status: HeartbeatRunStatus; runUrl: string | null; at: string }`
  - `Store.listEnabledHeartbeats(): Promise<StoredHeartbeat[]>`
  - `Store.listHeartbeatsByService(serviceId: string): Promise<StoredHeartbeat[]>`
  - `Store.recordHeartbeatRun(serviceId: string, name: string, run: HeartbeatRun): Promise<StoredHeartbeat | null>`（`null` ＝ 該心跳未登記）
  - `Store.resolveIssueByFingerprint(serviceId: string, fingerprint: string): Promise<boolean>`
  - `InMemoryStore.seedHeartbeat(serviceId: string, hb: Omit<StoredHeartbeat, 'serviceId'>): void`
  - `rowToHeartbeat(row: Database['public']['Tables']['heartbeats']['Row']): StoredHeartbeat`

- [ ] **Step 1: 寫失敗測試**

在 `tests/store/memory.test.ts` 檔尾追加（保留既有 import 與測試，只新增下列內容；若既有 import 未包含所需符號請一併補上）：

```typescript
import { InMemoryStore } from '@/store/memory'
import type { ServiceRecord, StoredHeartbeat } from '@/store/contracts'

describe('InMemoryStore 心跳', () => {
  const svc: ServiceRecord = {
    id: 's-1',
    name: 'svc-a',
    healthWindowMinutes: 15,
    healthFailureThreshold: 2,
    healthStatus: 'healthy',
    poll: null,
    discordWebhookUrl: null,
  }
  const hb: Omit<StoredHeartbeat, 'serviceId'> = {
    id: 'hb-1',
    name: 'daily-test',
    intervalSeconds: 86_400,
    graceSeconds: 3_600,
    enabled: true,
    lastRunAt: null,
    lastSuccessAt: null,
    lastRunStatus: null,
    lastRunUrl: null,
    createdAt: '2026-07-01T00:00:00.000Z',
  }

  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc)
    store.seedHeartbeat('s-1', hb)
  })

  it('pass 回報同時更新 last_run_at 與 last_success_at', async () => {
    const updated = await store.recordHeartbeatRun('s-1', 'daily-test', {
      status: 'pass',
      runUrl: 'https://ci/run/1',
      at: '2026-07-29T03:00:00.000Z',
    })
    expect(updated?.lastRunAt).toBe('2026-07-29T03:00:00.000Z')
    expect(updated?.lastSuccessAt).toBe('2026-07-29T03:00:00.000Z')
    expect(updated?.lastRunStatus).toBe('pass')
    expect(updated?.lastRunUrl).toBe('https://ci/run/1')
  })

  it('fail 回報只更新 last_run_at，不動 last_success_at', async () => {
    await store.recordHeartbeatRun('s-1', 'daily-test', {
      status: 'pass',
      runUrl: null,
      at: '2026-07-28T03:00:00.000Z',
    })
    const updated = await store.recordHeartbeatRun('s-1', 'daily-test', {
      status: 'fail',
      runUrl: null,
      at: '2026-07-29T03:00:00.000Z',
    })
    expect(updated?.lastRunAt).toBe('2026-07-29T03:00:00.000Z')
    expect(updated?.lastSuccessAt).toBe('2026-07-28T03:00:00.000Z')
    expect(updated?.lastRunStatus).toBe('fail')
  })

  it('未登記的心跳回傳 null', async () => {
    const result = await store.recordHeartbeatRun('s-1', 'nope', {
      status: 'pass',
      runUrl: null,
      at: '2026-07-29T03:00:00.000Z',
    })
    expect(result).toBeNull()
  })

  it('listEnabledHeartbeats 略過 enabled=false', async () => {
    store.seedHeartbeat('s-1', { ...hb, id: 'hb-2', name: 'off', enabled: false })
    const list = await store.listEnabledHeartbeats()
    expect(list.map((h) => h.name)).toEqual(['daily-test'])
  })

  it('resolveIssueByFingerprint 只關掉指定指紋的未解 issue', async () => {
    await store.upsertIssueWithEvent({
      serviceId: 's-1',
      source: 'poll',
      level: 'error',
      errorType: 'heartbeat_missed',
      message: 'Heartbeat missed: daily-test',
      fingerprint: 'fp-a',
      occurredAt: '2026-07-29T01:00:00.000Z',
      metadata: {},
    })
    await store.upsertIssueWithEvent({
      serviceId: 's-1',
      source: 'push',
      level: 'error',
      errorType: 'other',
      message: 'unrelated',
      fingerprint: 'fp-b',
      occurredAt: '2026-07-29T01:00:00.000Z',
      metadata: {},
    })

    expect(await store.resolveIssueByFingerprint('s-1', 'fp-a')).toBe(true)
    const open = await store.listOpenIssues('s-1')
    expect(open).toHaveLength(1)
    expect(await store.resolveIssueByFingerprint('s-1', 'fp-a')).toBe(false)
  })
})
```

- [ ] **Step 2: 執行測試確認失敗**

```bash
pnpm vitest run tests/store/memory.test.ts
```

預期：FAIL，`store.seedHeartbeat is not a function`。

- [ ] **Step 3: 擴充 `src/store/contracts.ts`**

在 import 區加入 Task 1 的型別，並在 `Store` 介面尾端加入四個方法：

```typescript
import type { HeartbeatDefinition, HeartbeatRunStatus } from '@/core/heartbeat'

export interface StoredHeartbeat extends HeartbeatDefinition {
  id: string
  serviceId: string
  enabled: boolean
  lastSuccessAt: string | null
  lastRunStatus: HeartbeatRunStatus | null
  lastRunUrl: string | null
}

export interface HeartbeatRun {
  status: HeartbeatRunStatus
  runUrl: string | null
  at: string // ISO 8601
}
```

`Store` 介面新增（放在 `recordNotification` 之後）：

```typescript
  listEnabledHeartbeats(): Promise<StoredHeartbeat[]>
  listHeartbeatsByService(serviceId: string): Promise<StoredHeartbeat[]>
  recordHeartbeatRun(serviceId: string, name: string, run: HeartbeatRun): Promise<StoredHeartbeat | null>
  resolveIssueByFingerprint(serviceId: string, fingerprint: string): Promise<boolean>
```

- [ ] **Step 4: 擴充 `src/store/mapping.ts`**

在檔尾加入（並在頂部的 type 別名區補上 `type HeartbeatRow = Database['public']['Tables']['heartbeats']['Row']`）：

```typescript
const RUN_STATUSES: readonly HeartbeatRunStatus[] = ['pass', 'fail']

export function rowToHeartbeat(row: HeartbeatRow): StoredHeartbeat {
  return {
    id: row.id,
    serviceId: row.service_id,
    name: row.name,
    intervalSeconds: row.interval_seconds,
    graceSeconds: row.grace_seconds,
    enabled: row.enabled,
    lastRunAt: row.last_run_at,
    lastSuccessAt: row.last_success_at,
    lastRunStatus:
      row.last_run_status === null
        ? null
        : narrow(row.last_run_status, RUN_STATUSES, 'heartbeat run status'),
    lastRunUrl: row.last_run_url,
    createdAt: row.created_at,
  }
}
```

需在頂部 import 補上 `HeartbeatRunStatus`（來自 `@/core/heartbeat`）與 `StoredHeartbeat`（來自 `@/store/contracts`）。

- [ ] **Step 5: 實作 `src/store/memory.ts`**

在 class 內新增欄位與方法：

```typescript
  private heartbeats: StoredHeartbeat[] = []

  seedHeartbeat(serviceId: string, hb: Omit<StoredHeartbeat, 'serviceId'>): void {
    this.heartbeats.push({ ...hb, serviceId })
  }

  async listEnabledHeartbeats(): Promise<StoredHeartbeat[]> {
    return this.heartbeats.filter((h) => h.enabled).map((h) => ({ ...h }))
  }

  async listHeartbeatsByService(serviceId: string): Promise<StoredHeartbeat[]> {
    return this.heartbeats.filter((h) => h.serviceId === serviceId).map((h) => ({ ...h }))
  }

  async recordHeartbeatRun(
    serviceId: string,
    name: string,
    run: HeartbeatRun,
  ): Promise<StoredHeartbeat | null> {
    const index = this.heartbeats.findIndex((h) => h.serviceId === serviceId && h.name === name)
    if (index === -1) return null
    const current = this.heartbeats[index]
    const updated: StoredHeartbeat = {
      ...current,
      lastRunAt: run.at,
      lastRunStatus: run.status,
      lastRunUrl: run.runUrl,
      // pass 才推進 last_success_at；fail 保留舊值
      lastSuccessAt: run.status === 'pass' ? run.at : current.lastSuccessAt,
    }
    this.heartbeats[index] = updated
    return { ...updated }
  }

  async resolveIssueByFingerprint(serviceId: string, fingerprint: string): Promise<boolean> {
    let changed = false
    for (const [key, issue] of this.issues) {
      if (
        issue.serviceId === serviceId &&
        issue.fingerprint === fingerprint &&
        (issue.status === 'open' || issue.status === 'acknowledged')
      ) {
        this.issues.set(key, { ...issue, status: 'resolved' })
        changed = true
      }
    }
    return changed
  }
```

import 需補 `HeartbeatRun`、`StoredHeartbeat`。

- [ ] **Step 6: 實作 `src/store/supabase.ts`**

在 class 內新增（`recordHeartbeatRun` 用 `.eq` 條件更新後回傳單筆；找不到列時 `data` 為空陣列）：

```typescript
  async listEnabledHeartbeats(): Promise<StoredHeartbeat[]> {
    const { data, error } = await this.client.from('heartbeats').select('*').eq('enabled', true)
    if (error) throw new Error(`listEnabledHeartbeats failed: ${error.message}`)
    return data.map(rowToHeartbeat)
  }

  async listHeartbeatsByService(serviceId: string): Promise<StoredHeartbeat[]> {
    const { data, error } = await this.client
      .from('heartbeats')
      .select('*')
      .eq('service_id', serviceId)
      .order('name')
    if (error) throw new Error(`listHeartbeatsByService failed: ${error.message}`)
    return data.map(rowToHeartbeat)
  }

  async recordHeartbeatRun(
    serviceId: string,
    name: string,
    run: HeartbeatRun,
  ): Promise<StoredHeartbeat | null> {
    const patch = {
      last_run_at: run.at,
      last_run_status: run.status,
      last_run_url: run.runUrl,
      // pass 才推進 last_success_at；fail 不帶這個鍵，保留舊值
      ...(run.status === 'pass' ? { last_success_at: run.at } : {}),
    }
    const { data, error } = await this.client
      .from('heartbeats')
      .update(patch)
      .eq('service_id', serviceId)
      .eq('name', name)
      .select('*')
    if (error) throw new Error(`recordHeartbeatRun failed: ${error.message}`)
    return data.length === 0 ? null : rowToHeartbeat(data[0])
  }

  async resolveIssueByFingerprint(serviceId: string, fingerprint: string): Promise<boolean> {
    const { data, error } = await this.client
      .from('issues')
      .update({ status: 'resolved' })
      .eq('service_id', serviceId)
      .eq('fingerprint', fingerprint)
      .in('status', ['open', 'acknowledged'])
      .select('id')
    if (error) throw new Error(`resolveIssueByFingerprint failed: ${error.message}`)
    return data.length > 0
  }
```

import 需補 `HeartbeatRun`、`StoredHeartbeat`、`rowToHeartbeat`。

- [ ] **Step 7: 執行測試確認通過**

```bash
pnpm test && pnpm typecheck
```

預期：全部 PASS（含既有測試），typecheck 無錯誤。

- [ ] **Step 8: Commit**

```bash
git add src/store/contracts.ts src/store/mapping.ts src/store/memory.ts src/store/supabase.ts tests/store/memory.test.ts
git commit -m "feat(store): 心跳讀寫與依指紋 resolve issue"
```

---

## Task 4: Discord 通知帶上細節

**Files:**
- Modify: `src/notify/message.ts`、`src/pipeline/process-and-notify.ts`
- Test: `tests/notify/message.test.ts`（擴充）

**Interfaces:**
- Produces:
  - `interface NotifyDetails { summary?: string; runUrl?: string; reason?: string; lastRunAt?: string }`
  - `extractNotifyDetails(metadata: Record<string, unknown>): NotifyDetails`
  - `buildDiscordMessage` 參數新增選填 `details?: NotifyDetails`

**背景：** issue 的 `message` 必須固定才能聚合，所以變動細節只能從 event metadata 取。`notifyStage` 手上已持有當前 `CanonicalEvent`（`src/pipeline/process-and-notify.ts:56`），不需回查 DB。metadata 是外部輸入，必須白名單萃取而非整包倒出。

Discord 限制（官方文件）：field value 上限 1024、單一 embed 至多 25 個 field、單則訊息所有 embed 文字總和 6000。故截斷至 1000 留 buffer。

- [ ] **Step 1: 寫失敗測試**

在 `tests/notify/message.test.ts` 檔尾追加（`extractNotifyDetails` 需加進既有 import）：

```typescript
import { extractNotifyDetails } from '@/notify/message'

describe('extractNotifyDetails', () => {
  it('只取白名單鍵，忽略其他', () => {
    const details = extractNotifyDetails({
      summary: '3 of 210 failed',
      reason: 'timeout',
      lastRunAt: '2026-07-28T03:00:00.000Z',
      heartbeat: 'daily-test',
      secretToken: 'should-not-appear',
    })
    expect(details).toEqual({
      summary: '3 of 210 failed',
      reason: 'timeout',
      lastRunAt: '2026-07-28T03:00:00.000Z',
    })
  })

  it('忽略非字串值與空字串', () => {
    expect(extractNotifyDetails({ summary: 42, reason: null, lastRunAt: '' })).toEqual({})
  })

  it('丟棄非 http(s) 的 runUrl', () => {
    expect(extractNotifyDetails({ runUrl: 'javascript:alert(1)' })).toEqual({})
    expect(extractNotifyDetails({ runUrl: 'https://ci/run/1' })).toEqual({
      runUrl: 'https://ci/run/1',
    })
  })

  it('過長的值截斷至 1000 字元並補省略號', () => {
    const details = extractNotifyDetails({ summary: 'x'.repeat(2000) })
    expect(details.summary).toHaveLength(1000)
    expect(details.summary?.endsWith('…')).toBe(true)
  })
})

describe('buildDiscordMessage details', () => {
  const base = {
    serviceName: 'svc-a',
    severity: 'P1' as const,
    errorType: 'test_failure',
    message: 'Test failed: daily-test',
    count: 3,
    firstSeen: '2026-07-28T03:00:00.000Z',
    lastSeen: '2026-07-29T03:00:00.000Z',
  }

  it('無 details 時欄位與既有行為一致', () => {
    const msg = buildDiscordMessage(base)
    expect(msg.embeds[0].fields.map((f) => f.name)).toEqual(['次數', 'First seen', 'Last seen'])
  })

  it('summary 與 runUrl 附加成欄位，runUrl 為 markdown 連結', () => {
    const msg = buildDiscordMessage({
      ...base,
      details: { summary: '3 of 210 failed', runUrl: 'https://ci/run/1' },
    })
    const fields = msg.embeds[0].fields
    expect(fields.find((f) => f.name === '失敗摘要')?.value).toBe('3 of 210 failed')
    expect(fields.find((f) => f.name === 'CI Run')?.value).toBe('[查看 run](https://ci/run/1)')
  })

  it('欄位總數不超過 Discord 的 25 個上限', () => {
    const msg = buildDiscordMessage({
      ...base,
      details: {
        summary: 's',
        runUrl: 'https://ci/run/1',
        reason: 'r',
        lastRunAt: '2026-07-28T03:00:00.000Z',
      },
    })
    expect(msg.embeds[0].fields.length).toBeLessThanOrEqual(25)
  })
})
```

- [ ] **Step 2: 執行測試確認失敗**

```bash
pnpm vitest run tests/notify/message.test.ts
```

預期：FAIL，`extractNotifyDetails` 未匯出。

- [ ] **Step 3: 實作 `src/notify/message.ts`**

在既有內容中加入（`DESCRIPTION_LIMIT` 之後）：

```typescript
export interface NotifyDetails {
  summary?: string
  runUrl?: string
  reason?: string
  lastRunAt?: string
}

// Discord field value 上限為 1024，留 buffer 截到 1000。
const FIELD_LIMIT = 1000
const TEXT_DETAIL_KEYS = ['summary', 'reason', 'lastRunAt'] as const

function pickString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key]
  if (typeof value !== 'string' || value === '') return undefined
  return value.length > FIELD_LIMIT ? `${value.slice(0, FIELD_LIMIT - 1)}…` : value
}

// metadata 來自外部（CI 回報／輪詢目標），一律白名單萃取，不整包倒進通知。
export function extractNotifyDetails(metadata: Record<string, unknown>): NotifyDetails {
  const details: NotifyDetails = {}
  for (const key of TEXT_DETAIL_KEYS) {
    const value = pickString(metadata, key)
    if (value !== undefined) details[key] = value
  }
  const runUrl = pickString(metadata, 'runUrl')
  if (runUrl !== undefined && /^https?:\/\//i.test(runUrl)) details.runUrl = runUrl
  return details
}

const DETAIL_LABELS: Array<[key: (typeof TEXT_DETAIL_KEYS)[number], label: string]> = [
  ['summary', '失敗摘要'],
  ['reason', '原因'],
  ['lastRunAt', '最後回報'],
]
```

`buildDiscordMessage` 的參數型別加上 `details?: NotifyDetails`，並在回傳的 `fields` 後面附加：

```typescript
  const detailFields: DiscordEmbedField[] = []
  for (const [key, label] of DETAIL_LABELS) {
    const value = params.details?.[key]
    if (value !== undefined) detailFields.push({ name: label, value, inline: false })
  }
  if (params.details?.runUrl !== undefined) {
    detailFields.push({
      name: 'CI Run',
      value: `[查看 run](${params.details.runUrl})`,
      inline: false,
    })
  }
```

並把 `fields` 改為 `fields: [...既有三個欄位, ...detailFields]`。

- [ ] **Step 4: 串進 `src/pipeline/process-and-notify.ts`**

在 `notifyStage` 內的 `buildDiscordMessage` 呼叫加入 details（`event` 已是該函式參數）：

```typescript
    details: extractNotifyDetails(event.metadata),
```

並在頂部 import 補上 `extractNotifyDetails`。

- [ ] **Step 5: 執行測試確認通過**

```bash
pnpm test && pnpm typecheck
```

預期：全部 PASS。特別確認 `tests/pipeline/process-and-notify.test.ts` 既有測試未被破壞。

- [ ] **Step 6: Commit**

```bash
git add src/notify/message.ts src/pipeline/process-and-notify.ts tests/notify/message.test.ts
git commit -m "feat(notify): Discord 通知附上失敗摘要與 CI run 連結"
```

---

## Task 5: 回報入口 `POST /api/heartbeat`

**Files:**
- Create: `src/heartbeat/payload.ts`、`src/heartbeat/handle-heartbeat.ts`、`app/api/heartbeat/route.ts`、`scripts/heartbeat-to-beacon.sh`
- Test: `tests/heartbeat/payload.test.ts`、`tests/heartbeat/handle-heartbeat.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `normalizeHeartbeatFailure`／`heartbeatFingerprint`；Task 3 的 `recordHeartbeatRun`／`resolveIssueByFingerprint`；既有 `verifyIngestSignature`（`@/ingest/hmac`）、`processAndNotify`（`@/pipeline/process-and-notify`）、`refreshServiceHealth`（`@/pipeline/refresh-health`）
- Produces:
  - `interface RawHeartbeatReport { name: string; status: HeartbeatRunStatus; runUrl?: string; summary?: string }`
  - `parseHeartbeatPayload(input: unknown): { ok: true; value: RawHeartbeatReport } | { ok: false; errors: string[] }`
  - `handleHeartbeat(store: Store, deps: NotifyDeps, request: IngestRequest, now: Date): Promise<IngestResponse>`（重用 `@/ingest/handle-ingest` 匯出的 `IngestRequest` / `IngestResponse` 型別）

- [ ] **Step 1: 寫 payload 失敗測試**

建立 `tests/heartbeat/payload.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { parseHeartbeatPayload } from '@/heartbeat/payload'

describe('parseHeartbeatPayload', () => {
  it('接受最小合法 payload', () => {
    const result = parseHeartbeatPayload({ name: 'daily-test', status: 'pass' })
    expect(result).toEqual({ ok: true, value: { name: 'daily-test', status: 'pass' } })
  })

  it('保留選填欄位', () => {
    const result = parseHeartbeatPayload({
      name: 'daily-test',
      status: 'fail',
      runUrl: 'https://ci/run/1',
      summary: '3 failed',
    })
    expect(result).toEqual({
      ok: true,
      value: { name: 'daily-test', status: 'fail', runUrl: 'https://ci/run/1', summary: '3 failed' },
    })
  })

  it('拒絕非物件', () => {
    expect(parseHeartbeatPayload([]).ok).toBe(false)
    expect(parseHeartbeatPayload(null).ok).toBe(false)
    expect(parseHeartbeatPayload('x').ok).toBe(false)
  })

  it('name 必填且非空', () => {
    const result = parseHeartbeatPayload({ status: 'pass' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join()).toContain('name')
  })

  it('status 只接受 pass 或 fail', () => {
    const result = parseHeartbeatPayload({ name: 'x', status: 'ok' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join()).toContain('status')
  })

  it('選填欄位型別錯誤時拒絕', () => {
    const result = parseHeartbeatPayload({ name: 'x', status: 'pass', runUrl: 42 })
    expect(result.ok).toBe(false)
  })
})
```

- [ ] **Step 2: 執行測試確認失敗**

```bash
pnpm vitest run tests/heartbeat/payload.test.ts
```

預期：FAIL，找不到模組。

- [ ] **Step 3: 實作 `src/heartbeat/payload.ts`**

```typescript
import type { HeartbeatRunStatus } from '@/core/heartbeat'

export interface RawHeartbeatReport {
  name: string
  status: HeartbeatRunStatus
  runUrl?: string
  summary?: string
}

export type HeartbeatParseResult =
  | { ok: true; value: RawHeartbeatReport }
  | { ok: false; errors: string[] }

const STATUSES: readonly string[] = ['pass', 'fail']

// 註：input 來自 JSON.parse，故所有值必為 JSON-safe。
export function parseHeartbeatPayload(input: unknown): HeartbeatParseResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['payload must be a JSON object'] }
  }
  const obj = input as Record<string, unknown>
  const errors: string[] = []

  if (typeof obj.name !== 'string' || obj.name.trim() === '') {
    errors.push('name is required and must be a non-empty string')
  }
  if (typeof obj.status !== 'string' || !STATUSES.includes(obj.status)) {
    errors.push('status is required and must be "pass" or "fail"')
  }
  for (const key of ['runUrl', 'summary'] as const) {
    if (obj[key] !== undefined && typeof obj[key] !== 'string') errors.push(`${key} must be a string`)
  }

  if (errors.length > 0) return { ok: false, errors }

  const value: RawHeartbeatReport = {
    name: obj.name as string,
    status: obj.status as HeartbeatRunStatus,
  }
  if (obj.runUrl !== undefined) value.runUrl = obj.runUrl as string
  if (obj.summary !== undefined) value.summary = obj.summary as string
  return { ok: true, value }
}
```

- [ ] **Step 4: 執行測試確認通過**

```bash
pnpm vitest run tests/heartbeat/payload.test.ts
```

預期：PASS。

- [ ] **Step 5: 寫 handler 失敗測試**

建立 `tests/heartbeat/handle-heartbeat.test.ts`：

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { handleHeartbeat } from '@/heartbeat/handle-heartbeat'
import { InMemoryStore } from '@/store/memory'
import { heartbeatFingerprint, synthesizeHeartbeatMissedEvent } from '@/core/heartbeat'
import type { ServiceRecord, StoredHeartbeat } from '@/store/contracts'
import type { NotifyDeps } from '@/pipeline/process-and-notify'

const now = new Date('2026-07-29T03:00:00.000Z')
const nowSec = String(Math.floor(now.getTime() / 1000))
const secret = 'svc-secret'

const noopDeps: NotifyDeps = {
  sender: async () => ({ ok: true }) as const,
  fallbackWebhookUrl: null,
}

const svc: ServiceRecord = {
  id: 's-1',
  name: 'svc-a',
  healthWindowMinutes: 15,
  healthFailureThreshold: 2,
  healthStatus: 'healthy',
  poll: null,
  discordWebhookUrl: null,
}

const hb: Omit<StoredHeartbeat, 'serviceId'> = {
  id: 'hb-1',
  name: 'daily-test',
  intervalSeconds: 86_400,
  graceSeconds: 3_600,
  enabled: true,
  lastRunAt: '2026-07-27T03:00:00.000Z',
  lastSuccessAt: '2026-07-27T03:00:00.000Z',
  lastRunStatus: 'pass',
  lastRunUrl: null,
  createdAt: '2026-07-01T00:00:00.000Z',
}

function sign(ts: string, raw: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}`
}

function request(rawBody: string, over: Record<string, unknown> = {}) {
  return {
    rawBody,
    serviceName: 'svc-a',
    timestamp: nowSec,
    signature: sign(nowSec, rawBody),
    ...over,
  } as Parameters<typeof handleHeartbeat>[2]
}

describe('handleHeartbeat', () => {
  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc, secret)
    store.seedHeartbeat('s-1', hb)
    store.seedRule(null, {
      id: 'r-1',
      priority: 100,
      severity: 'P1',
      tags: ['ci'],
      match: { errorType: 'test_failure' },
    })
  })

  it('缺少任一驗證標頭回 401', async () => {
    const body = '{"name":"daily-test","status":"pass"}'
    for (const over of [{ serviceName: null }, { timestamp: null }, { signature: null }]) {
      const res = await handleHeartbeat(store, noopDeps, request(body, over), now)
      expect(res.status).toBe(401)
    }
  })

  it('簽章錯誤回 401', async () => {
    const body = '{"name":"daily-test","status":"pass"}'
    const res = await handleHeartbeat(store, noopDeps, request(body, { signature: 'sha256=' + '0'.repeat(64) }), now)
    expect(res.status).toBe(401)
  })

  it('非法 JSON 回 400、payload 不合格回 422', async () => {
    const bad = await handleHeartbeat(store, noopDeps, request('not json'), now)
    expect(bad.status).toBe(400)
    const invalid = await handleHeartbeat(store, noopDeps, request('{"name":"x"}'), now)
    expect(invalid.status).toBe(422)
  })

  it('未登記的心跳名稱回 404', async () => {
    const body = '{"name":"nope","status":"pass"}'
    const res = await handleHeartbeat(store, noopDeps, request(body), now)
    expect(res.status).toBe(404)
  })

  it('pass 更新兩個時間戳且不建立 issue', async () => {
    const body = '{"name":"daily-test","status":"pass","runUrl":"https://ci/run/9"}'
    const res = await handleHeartbeat(store, noopDeps, request(body), now)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      name: 'daily-test',
      status: 'pass',
      lastRunAt: now.toISOString(),
      lastSuccessAt: now.toISOString(),
    })
    expect(await store.listOpenIssues('s-1')).toHaveLength(0)
  })

  it('fail 只推進 lastRunAt 並建立 test_failure issue', async () => {
    const body = '{"name":"daily-test","status":"fail","summary":"3 of 210 failed"}'
    const res = await handleHeartbeat(store, noopDeps, request(body), now)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'fail', lastSuccessAt: '2026-07-27T03:00:00.000Z' })
    const open = await store.listOpenIssues('s-1')
    expect(open).toHaveLength(1)
    expect(open[0].severity).toBe('P1')
  })

  it('任何回報都 resolve heartbeat_missed issue（有回報即證明還活著）', async () => {
    await store.upsertIssueWithEvent(
      synthesizeHeartbeatMissedEvent('s-1', { ...hb }, new Date('2026-07-29T01:00:00.000Z')),
    )
    expect(await store.listOpenIssues('s-1')).toHaveLength(1)

    const body = '{"name":"daily-test","status":"fail"}'
    await handleHeartbeat(store, noopDeps, request(body), now)

    const missedFp = heartbeatFingerprint('s-1', 'heartbeat_missed', 'daily-test')
    const stillOpen = await store.listOpenIssues('s-1')
    // heartbeat_missed 已被 resolve，只剩 fail 產生的 test_failure
    expect(stillOpen).toHaveLength(1)
    expect(await store.resolveIssueByFingerprint('s-1', missedFp)).toBe(false)
  })

  it('pass 額外 resolve 先前的 test_failure issue', async () => {
    await handleHeartbeat(store, noopDeps, request('{"name":"daily-test","status":"fail"}'), now)
    expect(await store.listOpenIssues('s-1')).toHaveLength(1)

    const later = new Date('2026-07-30T03:00:00.000Z')
    const laterSec = String(Math.floor(later.getTime() / 1000))
    const body = '{"name":"daily-test","status":"pass"}'
    await handleHeartbeat(
      store,
      noopDeps,
      { rawBody: body, serviceName: 'svc-a', timestamp: laterSec, signature: sign(laterSec, body) },
      later,
    )
    expect(await store.listOpenIssues('s-1')).toHaveLength(0)
  })
})
```

- [ ] **Step 6: 執行測試確認失敗**

```bash
pnpm vitest run tests/heartbeat/handle-heartbeat.test.ts
```

預期：FAIL，找不到模組 `@/heartbeat/handle-heartbeat`。

- [ ] **Step 7: 實作 `src/heartbeat/handle-heartbeat.ts`**

```typescript
import { verifyIngestSignature } from '@/ingest/hmac'
import type { IngestRequest, IngestResponse } from '@/ingest/handle-ingest'
import { parseHeartbeatPayload } from '@/heartbeat/payload'
import { heartbeatFingerprint, normalizeHeartbeatFailure } from '@/core/heartbeat'
import { processAndNotify } from '@/pipeline/process-and-notify'
import type { NotifyDeps } from '@/pipeline/process-and-notify'
import { refreshServiceHealth } from '@/pipeline/refresh-health'
import type { Store } from '@/store/contracts'

const UNAUTHORIZED: IngestResponse = { status: 401, body: { error: 'unauthorized' } }

export async function handleHeartbeat(
  store: Store,
  deps: NotifyDeps,
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

  const parsed = parseHeartbeatPayload(json)
  if (!parsed.ok) return { status: 422, body: { error: 'invalid payload', details: parsed.errors } }

  const serviceId = auth.service.id
  const report = parsed.value
  const heartbeat = await store.recordHeartbeatRun(serviceId, report.name, {
    status: report.status,
    runUrl: report.runUrl ?? null,
    at: now.toISOString(),
  })
  // 登記制：未登記的名稱要立刻炸給 CI 看，而不是靜靜長出幽靈心跳。
  if (heartbeat === null) return { status: 404, body: { error: 'unknown heartbeat' } }

  // 只要有回報就證明排程還活著——pass 與 fail 都關掉逾期 issue。
  await store.resolveIssueByFingerprint(
    serviceId,
    heartbeatFingerprint(serviceId, 'heartbeat_missed', report.name),
  )

  const body: Record<string, unknown> = {
    name: heartbeat.name,
    status: report.status,
    lastRunAt: heartbeat.lastRunAt,
    lastSuccessAt: heartbeat.lastSuccessAt,
  }

  if (report.status === 'fail') {
    const event = normalizeHeartbeatFailure(
      serviceId,
      heartbeat,
      { ...(report.runUrl !== undefined ? { runUrl: report.runUrl } : {}),
        ...(report.summary !== undefined ? { summary: report.summary } : {}) },
      now,
    )
    const result = await processAndNotify(store, deps, event, now)
    body.issueId = result.issue.id
    body.severity = result.issue.severity
    body.notified = result.notified
  } else {
    // 測試修好了，關掉先前的失敗 issue
    await store.resolveIssueByFingerprint(
      serviceId,
      heartbeatFingerprint(serviceId, 'test_failure', report.name),
    )
    await refreshServiceHealth(store, serviceId, now)
  }

  return { status: 200, body }
}
```

- [ ] **Step 8: 執行測試確認通過**

```bash
pnpm vitest run tests/heartbeat && pnpm typecheck
```

預期：全數 PASS。

- [ ] **Step 9: 建立 route**

建立 `app/api/heartbeat/route.ts`：

```typescript
import { handleHeartbeat } from '@/heartbeat/handle-heartbeat'
import { createServerStore, createServerNotifyDeps } from '@/store/server'

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text()
  const result = await handleHeartbeat(
    createServerStore(),
    createServerNotifyDeps(),
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

- [ ] **Step 10: 建立 CI 回報 script**

建立 `scripts/heartbeat-to-beacon.sh`（比照既有 `scripts/report-to-beacon.sh` 的簽章寫法）：

```bash
#!/usr/bin/env bash
# th-beacon 心跳回報。CI 在 if: always() 下呼叫，成功失敗都要送。
# 用法：BEACON_URL=https://beacon.example.com/api/heartbeat \
#       BEACON_SERVICE=my-service BEACON_SECRET=xxx \
#       ./heartbeat-to-beacon.sh daily-test pass "https://github.com/o/r/actions/runs/42" "summary"
set -euo pipefail

BEACON_URL="${BEACON_URL:?BEACON_URL is required}"
BEACON_SERVICE="${BEACON_SERVICE:?BEACON_SERVICE is required}"
BEACON_SECRET="${BEACON_SECRET:?BEACON_SECRET is required}"
NAME="${1:?usage: heartbeat-to-beacon.sh <name> <pass|fail> [runUrl] [summary]}"
STATUS="${2:?usage: heartbeat-to-beacon.sh <name> <pass|fail> [runUrl] [summary]}"
RUN_URL="${3:-}"
SUMMARY="${4:-}"

TS="$(date +%s)"
BODY="$(jq -cn --arg n "$NAME" --arg s "$STATUS" --arg u "$RUN_URL" --arg m "$SUMMARY" \
  '{name:$n, status:$s}
   + (if $u == "" then {} else {runUrl:$u} end)
   + (if $m == "" then {} else {summary:$m} end)')"
SIG="$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$BEACON_SECRET" -hex | sed 's/^.* //')"

curl -sS --fail-with-body -X POST "$BEACON_URL" \
  -H "Content-Type: application/json" \
  -H "X-Beacon-Service: $BEACON_SERVICE" \
  -H "X-Beacon-Timestamp: $TS" \
  -H "X-Beacon-Signature: sha256=$SIG" \
  -d "$BODY"
```

設定可執行權限：

```bash
chmod +x scripts/heartbeat-to-beacon.sh
```

- [ ] **Step 11: 驗證建置**

```bash
pnpm test && pnpm typecheck && pnpm build
```

預期：全數通過，build 產出包含 `/api/heartbeat` 路由。

- [ ] **Step 12: Commit**

```bash
git add src/heartbeat/payload.ts src/heartbeat/handle-heartbeat.ts app/api/heartbeat/route.ts scripts/heartbeat-to-beacon.sh tests/heartbeat/
git commit -m "feat(heartbeat): POST /api/heartbeat 單一回報入口"
```

---

## Task 6: 逾期掃描掛上 cron

**Files:**
- Create: `src/heartbeat/scan.ts`
- Modify: `app/api/poll/services/route.ts`
- Test: `tests/heartbeat/scan.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `isHeartbeatOverdue`／`synthesizeHeartbeatMissedEvent`；Task 3 的 `listEnabledHeartbeats`
- Produces:
  - `interface HeartbeatScanOutcome { heartbeatId: string; serviceId: string; name: string; issueId?: string; severity?: Severity; notified?: boolean; error?: string }`
  - `runHeartbeatScan(store: Store, deps: NotifyDeps, now: Date): Promise<HeartbeatScanOutcome[]>`（只回傳**逾期**心跳的 outcome）

- [ ] **Step 1: 寫失敗測試**

建立 `tests/heartbeat/scan.test.ts`：

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { runHeartbeatScan } from '@/heartbeat/scan'
import { InMemoryStore } from '@/store/memory'
import type { ServiceRecord, StoredHeartbeat } from '@/store/contracts'
import type { NotifyDeps } from '@/pipeline/process-and-notify'

const noopDeps: NotifyDeps = {
  sender: async () => ({ ok: true }) as const,
  fallbackWebhookUrl: null,
}

const svc: ServiceRecord = {
  id: 's-1',
  name: 'svc-a',
  healthWindowMinutes: 15,
  healthFailureThreshold: 2,
  healthStatus: 'healthy',
  poll: null,
  discordWebhookUrl: null,
}

const hb: Omit<StoredHeartbeat, 'serviceId'> = {
  id: 'hb-1',
  name: 'daily-test',
  intervalSeconds: 86_400,
  graceSeconds: 3_600,
  enabled: true,
  lastRunAt: '2026-07-27T03:00:00.000Z',
  lastSuccessAt: '2026-07-27T03:00:00.000Z',
  lastRunStatus: 'pass',
  lastRunUrl: null,
  createdAt: '2026-07-01T00:00:00.000Z',
}

describe('runHeartbeatScan', () => {
  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc)
    store.seedRule(null, {
      id: 'r-hb',
      priority: 100,
      severity: 'P1',
      tags: ['heartbeat'],
      match: { errorType: 'heartbeat_missed' },
    })
  })

  it('未逾期時不產生任何 outcome', async () => {
    store.seedHeartbeat('s-1', hb)
    // 到期 07-28T03:00 + grace 1h = 04:00
    const outcomes = await runHeartbeatScan(store, noopDeps, new Date('2026-07-28T03:30:00.000Z'))
    expect(outcomes).toHaveLength(0)
    expect(await store.listOpenIssues('s-1')).toHaveLength(0)
  })

  it('逾期時合成事件並判為 P1', async () => {
    store.seedHeartbeat('s-1', hb)
    const outcomes = await runHeartbeatScan(store, noopDeps, new Date('2026-07-29T09:00:00.000Z'))
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ name: 'daily-test', severity: 'P1' })
    const open = await store.listOpenIssues('s-1')
    expect(open).toHaveLength(1)
    expect(open[0].severity).toBe('P1')
  })

  it('enabled=false 的心跳被略過', async () => {
    store.seedHeartbeat('s-1', { ...hb, enabled: false })
    const outcomes = await runHeartbeatScan(store, noopDeps, new Date('2026-07-29T09:00:00.000Z'))
    expect(outcomes).toHaveLength(0)
  })

  it('重複掃描聚合成同一筆 issue 而非新增', async () => {
    store.seedHeartbeat('s-1', hb)
    await runHeartbeatScan(store, noopDeps, new Date('2026-07-29T09:00:00.000Z'))
    await runHeartbeatScan(store, noopDeps, new Date('2026-07-29T10:00:00.000Z'))
    expect(await store.listOpenIssues('s-1')).toHaveLength(1)
  })

  it('單一心跳出錯不中斷整輪', async () => {
    store.seedHeartbeat('s-1', hb)
    store.seedHeartbeat('missing-service', { ...hb, id: 'hb-2', name: 'orphan' })
    const outcomes = await runHeartbeatScan(store, noopDeps, new Date('2026-07-29T09:00:00.000Z'))
    expect(outcomes).toHaveLength(2)
    expect(outcomes.filter((o) => o.error !== undefined)).toHaveLength(1)
    expect(outcomes.filter((o) => o.issueId !== undefined)).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 執行測試確認失敗**

```bash
pnpm vitest run tests/heartbeat/scan.test.ts
```

預期：FAIL，找不到模組 `@/heartbeat/scan`。

- [ ] **Step 3: 實作 `src/heartbeat/scan.ts`**

```typescript
import { isHeartbeatOverdue, synthesizeHeartbeatMissedEvent } from '@/core/heartbeat'
import { processAndNotify } from '@/pipeline/process-and-notify'
import type { NotifyDeps } from '@/pipeline/process-and-notify'
import type { Severity } from '@/core/types'
import type { Store } from '@/store/contracts'

export interface HeartbeatScanOutcome {
  heartbeatId: string
  serviceId: string
  name: string
  issueId?: string
  severity?: Severity
  notified?: boolean
  error?: string
}

export async function runHeartbeatScan(
  store: Store,
  deps: NotifyDeps,
  now: Date,
): Promise<HeartbeatScanOutcome[]> {
  const heartbeats = await store.listEnabledHeartbeats()
  const overdue = heartbeats.filter((hb) => isHeartbeatOverdue(hb, now))
  const outcomes: HeartbeatScanOutcome[] = []

  for (const hb of overdue) {
    const base = { heartbeatId: hb.id, serviceId: hb.serviceId, name: hb.name }
    try {
      const event = synthesizeHeartbeatMissedEvent(hb.serviceId, hb, now)
      const result = await processAndNotify(store, deps, event, now)
      outcomes.push({
        ...base,
        issueId: result.issue.id,
        severity: result.issue.severity,
        notified: result.notified,
      })
    } catch (error) {
      // 單一心跳失敗不得中斷整輪：記為 outcome，繼續下一個（照 runPoll 做法）
      outcomes.push({
        ...base,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return outcomes
}
```

- [ ] **Step 4: 執行測試確認通過**

```bash
pnpm vitest run tests/heartbeat/scan.test.ts
```

預期：全數 PASS。

- [ ] **Step 5: 掛進 cron route**

修改 `app/api/poll/services/route.ts` 的 `GET` 內 try 區塊，把單一 `runPoll` 呼叫換成兩者都跑（共用同一個 store／deps／now，確保時間一致）：

```typescript
    const store = createServerStore()
    const deps = createServerNotifyDeps()
    const now = new Date()
    const outcomes = await runPoll(store, httpGet, deps, now)
    const heartbeats = await runHeartbeatScan(store, deps, now)
    return Response.json(
      { polled: outcomes.length, outcomes, heartbeatsOverdue: heartbeats.length, heartbeats },
      { status: 200 },
    )
```

頂部 import 補上 `import { runHeartbeatScan } from '@/heartbeat/scan'`。

- [ ] **Step 6: 驗證**

```bash
pnpm test && pnpm typecheck && pnpm build
```

預期：全數通過。

- [ ] **Step 7: Commit**

```bash
git add src/heartbeat/scan.ts app/api/poll/services/route.ts tests/heartbeat/scan.test.ts
git commit -m "feat(heartbeat): 逾期掃描掛進既有 cron route"
```

---

## Task 7: Dashboard 顯示

**Files:**
- Modify: `src/web/queries.ts`、`app/page.tsx`、`app/issues/[id]/page.tsx`、`app/globals.css`
- Test: `tests/web/heartbeat-view.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `isHeartbeatOverdue`、Task 3 的 `rowToHeartbeat`
- Produces:
  - `interface HeartbeatSummary { name: string; overdue: boolean; lastRunAt: string | null; lastSuccessAt: string | null; lastRunStatus: HeartbeatRunStatus | null; lastRunUrl: string | null }`
  - `ServiceOverview` 新增欄位 `heartbeats: HeartbeatSummary[]`
  - `extractRunUrl(metadata: unknown): string | null`（issue 詳情頁用）

**背景：** Vercel Hobby cron 一天只跑一次，`heartbeat_missed` issue 的 `issues.last_seen` 因此一天只刷新一次，15 分鐘的健康度視窗會讓 `services.health_status` 錯誤地轉回 healthy。所以 dashboard 的心跳逾期狀態**必須即時推導**，不能讀 `health_status` 欄位。

- [ ] **Step 1: 寫失敗測試**

建立 `tests/web/heartbeat-view.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { extractRunUrl } from '@/web/queries'

describe('extractRunUrl', () => {
  it('取出 metadata 中的 http(s) runUrl', () => {
    expect(extractRunUrl({ runUrl: 'https://ci/run/1' })).toBe('https://ci/run/1')
    expect(extractRunUrl({ runUrl: 'http://ci/run/1' })).toBe('http://ci/run/1')
  })

  it('非 http(s)、非字串、缺鍵時回 null', () => {
    expect(extractRunUrl({ runUrl: 'javascript:alert(1)' })).toBeNull()
    expect(extractRunUrl({ runUrl: 42 })).toBeNull()
    expect(extractRunUrl({})).toBeNull()
    expect(extractRunUrl(null)).toBeNull()
    expect(extractRunUrl('nope')).toBeNull()
  })
})
```

- [ ] **Step 2: 執行測試確認失敗**

```bash
pnpm vitest run tests/web/heartbeat-view.test.ts
```

預期：FAIL，`extractRunUrl` 未匯出。

- [ ] **Step 3: 擴充 `src/web/queries.ts`**

在頂部 import 補上：

```typescript
import { isHeartbeatOverdue, type HeartbeatRunStatus } from '@/core/heartbeat'
import { rowToHeartbeat } from '@/store/mapping'
```

新增型別並擴充 `ServiceOverview`：

```typescript
export interface HeartbeatSummary {
  name: string
  overdue: boolean
  lastRunAt: string | null
  lastSuccessAt: string | null
  lastRunStatus: HeartbeatRunStatus | null
  lastRunUrl: string | null
}
```

`ServiceOverview` 介面加一行 `heartbeats: HeartbeatSummary[]`。

`getServicesOverview` 簽名改為 `(client: Client, now: Date)`，在既有兩次查詢之後加入第三次查詢，並在 `services.map` 內組出 `heartbeats`：

```typescript
  const { data: heartbeatRows, error: hbError } = await client
    .from('heartbeats')
    .select('*')
    .eq('enabled', true)
    .order('name')
  if (hbError) throw new Error(`getServicesOverview heartbeats failed: ${hbError.message}`)
```

在 map 的回傳物件中加入：

```typescript
      // 逾期狀態即時推導：Hobby cron 一天一次，health_status 欄位不足以反映心跳狀態
      heartbeats: heartbeatRows
        .filter((row) => row.service_id === service.id)
        .map((row) => {
          const hb = rowToHeartbeat(row)
          return {
            name: hb.name,
            overdue: isHeartbeatOverdue(hb, now),
            lastRunAt: hb.lastRunAt,
            lastSuccessAt: hb.lastSuccessAt,
            lastRunStatus: hb.lastRunStatus,
            lastRunUrl: hb.lastRunUrl,
          }
        }),
```

在檔尾加入：

```typescript
// event metadata 是外部輸入：只接受 http(s) 連結，避免渲染任意 scheme
export function extractRunUrl(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null
  const value = (metadata as Record<string, unknown>).runUrl
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return null
  return value
}
```

- [ ] **Step 4: 更新 `app/page.tsx`**

`getServicesOverview` 呼叫改為傳入時鐘，並在卡片內渲染心跳：

```typescript
  const overview = await getServicesOverview(createServerStore().rawClient(), new Date())
```

在 `<Link href={...}>看 issues →</Link>` 之前插入：

```tsx
            {service.heartbeats.length > 0 && (
              <ul className="heartbeats">
                {service.heartbeats.map((hb) => (
                  <li key={hb.name} className={hb.overdue ? 'heartbeat overdue' : 'heartbeat'}>
                    <strong>{hb.name}</strong>
                    {hb.overdue && <span className="badge badge-P1">逾期</span>}
                    <span>
                      {hb.lastRunAt === null
                        ? '從未回報'
                        : `最後執行 ${new Date(hb.lastRunAt).toLocaleString('zh-TW')} ${
                            hb.lastRunStatus === 'fail' ? '失敗' : '成功'
                          }`}
                    </span>
                    {hb.lastRunUrl !== null && (
                      <a href={hb.lastRunUrl} target="_blank" rel="noreferrer noopener">
                        查看 run
                      </a>
                    )}
                    {hb.lastSuccessAt !== null && (
                      <span className="hint">
                        最後成功 {new Date(hb.lastSuccessAt).toLocaleString('zh-TW')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
```

- [ ] **Step 5: 更新 `app/issues/[id]/page.tsx`**

在 import 補上 `extractRunUrl`（從 `@/web/queries`），並把事件表格中的 metadata 儲存格改為在 `<pre>` 之前先渲染連結：

```tsx
              <td>
                {event.message}
                {extractRunUrl(event.metadata) !== null && (
                  <>
                    {' '}
                    <a
                      href={extractRunUrl(event.metadata) as string}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      查看 CI run
                    </a>
                  </>
                )}
                {event.metadata !== null && Object.keys(event.metadata as object).length > 0 && (
                  <pre>{JSON.stringify(event.metadata, null, 2)}</pre>
                )}
              </td>
```

- [ ] **Step 6: 補樣式**

在 `app/globals.css` 檔尾加入（沿用既有像素風的既有變數與風格，若既有樣式已定義同名 class 則調整而非重複宣告）：

```css
.heartbeats {
  list-style: none;
  padding: 0;
  margin: 0.5rem 0;
  font-size: 0.85em;
}

.heartbeat {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: center;
  padding: 0.2rem 0;
}

.heartbeat.overdue strong {
  color: #e67e22;
}
```

- [ ] **Step 7: 驗證**

```bash
pnpm test && pnpm typecheck && pnpm build
```

預期：全數通過。注意 `tests/integration/queries.test.ts` 若呼叫了 `getServicesOverview`，需一併補上第二個參數——執行時若該檔報型別錯誤，補上 `new Date()` 即可。

- [ ] **Step 8: Commit**

```bash
git add src/web/queries.ts app/page.tsx "app/issues/[id]/page.tsx" app/globals.css tests/web/heartbeat-view.test.ts
git commit -m "feat(dashboard): 心跳狀態與 CI run 連結顯示"
```

---

## Task 8: 整合測試

**Files:**
- Create: `tests/integration/heartbeat-route.test.ts`
- Modify: `tests/integration/helpers.ts`（如需新增心跳 seed helper）

**Interfaces:**
- Consumes: 前面所有 task 的產出
- 前置條件：本地 stack 已啟動（`supabase start`），且已跑過 `supabase db reset` 套用 Task 2 的 migration。

- [ ] **Step 1: 把 heartbeats 加進清理流程**

修改 `tests/integration/helpers.ts` 的 `cleanDatabase`，在 `issues` 之後、`triage_rules` 之前插入 `heartbeats`（FK 順序：子表先刪）：

```typescript
  for (const table of ['events', 'notifications', 'issues', 'heartbeats', 'triage_rules', 'services'] as const) {
```

- [ ] **Step 2: 寫整合測試**

建立 `tests/integration/heartbeat-route.test.ts`：

```typescript
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { createServiceRoleClient, cleanDatabase, getLocalSupabaseEnv } from './helpers'
import { POST } from '@/../app/api/heartbeat/route'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/db/database.types'

let client: SupabaseClient<Database>
let serviceId: string
const secret = 'hb-secret'

function signedRequest(body: string, over: Record<string, string> = {}): Request {
  const ts = String(Math.floor(Date.now() / 1000))
  const sig = `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`
  return new Request('http://localhost/api/heartbeat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-beacon-service': 'svc-hb',
      'x-beacon-timestamp': ts,
      'x-beacon-signature': sig,
      ...over,
    },
    body,
  })
}

beforeAll(() => {
  const { url, secretKey } = getLocalSupabaseEnv()
  process.env.NEXT_PUBLIC_SUPABASE_URL = url
  process.env.SUPABASE_SECRET_KEY = secretKey
  client = createServiceRoleClient()
})

beforeEach(async () => {
  await cleanDatabase(client)
  const { data, error } = await client
    .from('services')
    .insert({ name: 'svc-hb', webhook_secret: secret })
    .select('id')
    .single()
  if (error) throw error
  serviceId = data.id

  await client.from('triage_rules').insert({
    service_id: null,
    priority: 100,
    severity: 'P1',
    tags: ['ci'],
    match: { errorType: 'test_failure' } as Json,
  })
  const { error: hbError } = await client.from('heartbeats').insert({
    service_id: serviceId,
    name: 'daily-test',
    interval_seconds: 86_400,
    grace_seconds: 3_600,
    last_run_at: '2026-07-27T03:00:00.000Z',
    last_success_at: '2026-07-27T03:00:00.000Z',
    last_run_status: 'pass',
  })
  if (hbError) throw hbError
})

describe('POST /api/heartbeat (route-level, real DB)', () => {
  it('pass 同時推進 last_run_at 與 last_success_at，且不建立 issue', async () => {
    const body = JSON.stringify({
      name: 'daily-test',
      status: 'pass',
      runUrl: 'https://github.com/o/r/actions/runs/7',
    })
    const res = await POST(signedRequest(body))
    expect(res.status).toBe(200)

    const { data: hb } = await client
      .from('heartbeats')
      .select('last_run_at,last_success_at,last_run_status,last_run_url')
      .eq('service_id', serviceId)
      .single()
    expect(hb?.last_run_status).toBe('pass')
    expect(hb?.last_run_url).toBe('https://github.com/o/r/actions/runs/7')
    expect(hb?.last_run_at).not.toBe('2026-07-27T03:00:00+00:00')
    expect(new Date(hb!.last_success_at as string).getTime()).toBe(
      new Date(hb!.last_run_at as string).getTime(),
    )

    const { data: issues } = await client.from('issues').select('id').eq('service_id', serviceId)
    expect(issues).toHaveLength(0)
  })

  it('fail 只推進 last_run_at，並產生 P1 test_failure issue 與帶 metadata 的 event', async () => {
    const body = JSON.stringify({
      name: 'daily-test',
      status: 'fail',
      runUrl: 'https://github.com/o/r/actions/runs/8',
      summary: '3 of 210 tests failed',
    })
    const res = await POST(signedRequest(body))
    expect(res.status).toBe(200)

    const { data: hb } = await client
      .from('heartbeats')
      .select('last_run_status,last_success_at')
      .eq('service_id', serviceId)
      .single()
    expect(hb?.last_run_status).toBe('fail')
    // last_success_at 必須停在 seed 的時間，不被失敗回報推進
    expect(new Date(hb!.last_success_at as string).toISOString()).toBe('2026-07-27T03:00:00.000Z')

    const { data: issue } = await client
      .from('issues')
      .select('id,severity,error_type,message,status')
      .eq('service_id', serviceId)
      .single()
    expect(issue).toMatchObject({
      severity: 'P1',
      error_type: 'test_failure',
      message: 'Test failed: daily-test',
      status: 'open',
    })

    const { data: event } = await client
      .from('events')
      .select('metadata')
      .eq('issue_id', issue!.id)
      .single()
    expect(event?.metadata).toMatchObject({
      heartbeat: 'daily-test',
      runUrl: 'https://github.com/o/r/actions/runs/8',
      summary: '3 of 210 tests failed',
    })
  })

  it('先 fail 後 pass：test_failure issue 被自動 resolve', async () => {
    await POST(signedRequest(JSON.stringify({ name: 'daily-test', status: 'fail' })))
    const { data: before } = await client
      .from('issues')
      .select('status')
      .eq('service_id', serviceId)
      .single()
    expect(before?.status).toBe('open')

    await POST(signedRequest(JSON.stringify({ name: 'daily-test', status: 'pass' })))
    const { data: after } = await client
      .from('issues')
      .select('status')
      .eq('service_id', serviceId)
      .single()
    expect(after?.status).toBe('resolved')
  })

  it('未登記的心跳名稱回 404 且不產生任何 issue', async () => {
    const res = await POST(signedRequest(JSON.stringify({ name: 'nope', status: 'pass' })))
    expect(res.status).toBe(404)
    const { data: issues } = await client.from('issues').select('id').eq('service_id', serviceId)
    expect(issues).toHaveLength(0)
  })

  it('錯誤簽章回 401', async () => {
    const body = JSON.stringify({ name: 'daily-test', status: 'pass' })
    const res = await POST(signedRequest(body, { 'x-beacon-signature': `sha256=${'0'.repeat(64)}` }))
    expect(res.status).toBe(401)
  })
})
```

**注意**：`last_run_at` 等 timestamptz 欄位從 PostgREST 回來的字串格式是 `2026-07-27T03:00:00+00:00`（非 `.000Z`），所以比較時間一律經 `new Date(...)` 轉換後再比，不要直接比字串。

- [ ] **Step 3: 執行整合測試**

```bash
pnpm test:integration
```

預期：全數 PASS。若因本地 stack 未啟動而失敗，先 `supabase start` 再重跑；**不得**因為環境問題就把測試標為 skip 並宣稱通過。

- [ ] **Step 4: 最終全套驗證**

```bash
pnpm test && pnpm typecheck && pnpm build && pnpm test:integration
```

四項全過才算完成。

- [ ] **Step 5: Commit**

```bash
git add tests/integration/heartbeat-route.test.ts tests/integration/helpers.ts
git commit -m "test(heartbeat): 心跳入口整合測試"
```

---

## 完成後待辦（不在本計畫範圍）

實作完成後需人工處理，記錄於此避免遺漏：

1. **登記心跳資料**：在 Supabase Studio 或以 SQL 為各服務插入 `heartbeats` 列（`interval_seconds` 86400、`grace_seconds` 建議 3600–7200）。沒有登記就不會有任何監控。
2. **CI workflow 接線**：在各專案的 GitHub Actions 加上 `if: always()` 的回報步驟，呼叫 `scripts/heartbeat-to-beacon.sh`，帶入 `${{ job.status }}`（需自行映射為 `pass`/`fail`）與 run URL。
3. **既有 `report-to-beacon.sh` 的去留**：改用心跳入口後，原本只回報失敗的 script 對「有節奏的排程工作」不再需要；但它仍是 runtime 錯誤上報（入口①）的範例，建議保留。
