# Dashboard（Auth + 總覽/檢傷 UI + Realtime + 讀取 policy）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **REQUIRED SUB-SKILL for DB/auth task（Task 3）：** `supabase:supabase` skill（RLS policy 安全清單、Realtime publication、advisors）。

**Goal:** 交付 MVP dashboard：Supabase Auth 登入（invite-only）、服務總覽卡（健康燈號＋各級未解數）、檢傷列表（篩選）、issue 詳情（事件列表＋操作狀態變更）、Realtime 即時刷新；落實 Plan 2/6 交接（services 敏感欄位不外洩、resolve/ignore 顯眼可操作）。

**Architecture:** 讀取走 **server components + service_role**（敏感欄位天然不出伺服器）；瀏覽器端只有 login、Realtime 訂閱與導航（anon key + 使用者 session）。RLS 僅為 Realtime 開 `issues` SELECT policy（authenticated）；`services`/`events` 無 policy＝瀏覽器端 deny（Plan 2 交接的落實方式）。狀態變更走 server action：驗 session → `changeIssueStatus`（Store port）→ **`refreshServiceHealth` 重算燈號**。查詢集中在 `src/web/queries.ts`（read-model，刻意不進 Store port——它是 dashboard 專用讀模型，無管線消費者），以整合測試覆蓋；頁面元件保持薄渲染層。

**Tech Stack:** Next.js App Router（server components + server actions）、@supabase/ssr、Supabase Auth/Realtime、手寫 CSS（內部工具，不引入 UI 框架）。

## Global Constraints

- pnpm；TypeScript strict；**禁止 dev server**（驗證：tests + `pnpm build`；UI 實際操作由使用者自行以 dev server 驗收）。
- env 邊界更新：service_role 相關維持只在 `src/store/server.ts`；**`NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` 允許在 `middleware.ts` 與 `src/web/**`**（本來就是要進瀏覽器的 publishable 值）。service_role key 絕不出現在任何 `NEXT_PUBLIC_*` 或 client component。
- **Auth 模式（本計畫定案）**：invite-only email/password——`supabase/config.toml` 關閉 signup（`[auth]` 區塊 `enable_signup = false`；鍵名以產生的 config.toml 內註解為準，若不同以檔內為準並回報）；成員由管理者於 Supabase 後台建立。網域 allowlist 列未來擴充。
- **讀取模型**：頁面資料一律 server-side service_role；瀏覽器端不得直接 select `services`/`events`。RLS 新 policy 僅 `issues` FOR SELECT TO authenticated USING (true)。
- 受保護路徑：除 `/login`、`/api/ingest`、`/api/poll/*` 外全部要求登入（middleware redirect `/login`）。
- 狀態變更（open/acknowledged/resolved/ignored）必須：驗 session → 更新 → `refreshServiceHealth`。UI 上 resolve/ignore 按鈕須直接可見（Plan 6 交接：ratchet 下人工降級是唯一出口）。
- Realtime：訂閱 `postgres_changes`（`public.issues`，event `*`）→ `router.refresh()`；migration 需把 `issues` 加入 `supabase_realtime` publication（若已在，以 `supabase db reset` 結果為準）。
- 整合測試需本地 stack；auth 整合測試以 `auth.admin.createUser` 建測試使用者。
- **視覺設計（使用者指定：參考 `~/Code/trading-stream` 的像素電子看板風格；tokens 不得偏離）**：
  - 主背景 `#312e81`（深靛紫）、主文字 `#fff`；標題/表頭金黃 `#F5DCA6`；裝飾/連結淡紫 `#E2C7FF`；邊框 `rgba(226,199,255,0.25)`；面板底 `rgba(255,255,255,0.05)`。
  - 狀態色沿用其情緒色階：healthy `#82FF9A`（綠）、degraded `#FFD561`（黃）、down `#FF7DB2`（粉紅）；severity badge：P0 `#FF7DB2`、P1 `#FFD561`、P2 `#E2C7FF`（badge 文字用深靛紫 `#312e81`）。
  - 字型：複製 trading-stream 的三款像素字型（`Aurora-BC.ttf`/`New-Gen.ttf`/`Pixel-12x10.ttf`，來源 `/Users/navibluer/Code/trading-stream/src/fonts/`，授權由使用者確認）→ `src/fonts/`，以 `next/font/local` 載入。**用途分工**：Aurora-BC＝大標題與 nav brand；New-Gen＝表頭/badge/按鈕/nav 連結；**內文（錯誤訊息、時間戳、表身）用系統 sans**（Arial/Helvetica）保可讀性。
  - 質感慣例：**無圓角、無陰影**（pixel 感）；表格無豎線、列間以細橫線分隔、寬鬆 padding；金黃 thead 不加粗（`font-weight: 400`）。
  - Discord embed 配色維持 Plan 6 定案值不變（那是 Discord 側慣例，非 dashboard 視覺）。

## 本計畫涵蓋 vs. 後續

**做（spec §4.7 全部 + §6 dashboard 部分）：** `changeIssueStatus` pipeline helper + Store `updateIssueStatus`、auth 基建（ssr clients/middleware/login/signout）、RLS+Realtime migration、查詢模組、四頁 UI、spec 定案更新。

**不做：** 發生趨勢圖表（spec §4.7 的「趨勢」以 events 列表呈現，圖表列未來）；規則編輯器；reopen 復發語意調整與恢復通知（Plan 6 交接，另案）；網域 allowlist。

---

### Task 1: Store `updateIssueStatus` + `changeIssueStatus` pipeline helper

**Files:**
- Modify: `src/store/contracts.ts`、`src/store/memory.ts`、`src/store/supabase.ts`
- Create: `src/pipeline/change-issue-status.ts`
- Test: Modify `tests/store/memory.test.ts`、`tests/integration/supabase-store.test.ts`；Create `tests/pipeline/change-issue-status.test.ts`

**Interfaces:**
- `Store` 加：`updateIssueStatus(issueId: string, status: IssueStatus): Promise<StoredIssue>`（回更新後 issue；unknown id throw——0-rows 慣例）。
- `changeIssueStatus(store: Store, issueId: string, status: IssueStatus, now: Date): Promise<{ issue: StoredIssue; health: HealthStatus }>`——更新後呼叫 `refreshServiceHealth`。
- InMemoryStore：既有 test-seam `setIssueStatus` 保留；新 port 方法回防禦性拷貝。

- [ ] **Step 1: contracts 加方法；寫失敗測試**

`tests/pipeline/change-issue-status.test.ts`：

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { changeIssueStatus } from '@/pipeline/change-issue-status'
import { processEvent } from '@/pipeline/process-event'
import { InMemoryStore } from '@/store/memory'
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
  discordWebhookUrl: null,
}

const event: CanonicalEvent = {
  serviceId: 's-1',
  source: 'push',
  level: 'error',
  errorType: 'X',
  message: 'x',
  fingerprint: 'fp',
  occurredAt: '2026-07-28T10:09:00.000Z',
  metadata: {},
}

describe('changeIssueStatus', () => {
  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc)
  })

  it('resolving the only P0 issue recovers service health', async () => {
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P0', match: {} })
    const processed = await processEvent(store, event, now)
    expect((await store.getService('s-1'))?.healthStatus).toBe('down')

    const result = await changeIssueStatus(store, processed.issue.id, 'resolved', now)
    expect(result.issue.status).toBe('resolved')
    expect(result.health).toBe('healthy')
    expect((await store.getService('s-1'))?.healthStatus).toBe('healthy')
  })

  it('acknowledged keeps counting toward health; ignored does not', async () => {
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P1', match: {} })
    const processed = await processEvent(store, event, now)
    const acked = await changeIssueStatus(store, processed.issue.id, 'acknowledged', now)
    expect(acked.health).toBe('degraded')
    const ignored = await changeIssueStatus(store, processed.issue.id, 'ignored', now)
    expect(ignored.health).toBe('healthy')
  })

  it('throws on unknown issue', async () => {
    await expect(changeIssueStatus(store, 'nope', 'resolved', now)).rejects.toThrow(/unknown issue/)
  })
})
```

`tests/store/memory.test.ts` 加：

```typescript
  it('updateIssueStatus returns updated copy and rejects unknown id', async () => {
    const { issue } = await store.upsertIssueWithEvent(event())
    const updated = await store.updateIssueStatus(issue.id, 'acknowledged')
    expect(updated.status).toBe('acknowledged')
    updated.tags.push('mutate') // 呼叫端改動不得污染 store
    expect((await store.listOpenIssues('s-1'))[0].status).toBe('acknowledged')
    await expect(store.updateIssueStatus('nope', 'resolved')).rejects.toThrow(/unknown issue/)
  })
```

`tests/integration/supabase-store.test.ts` 加：

```typescript
describe('SupabaseStore.updateIssueStatus', () => {
  it('updates status, returns mapped issue, rejects unknown id', async () => {
    const { issue } = await store.upsertIssueWithEvent(event())
    const updated = await store.updateIssueStatus(issue.id, 'resolved')
    expect(updated.status).toBe('resolved')
    expect(updated.id).toBe(issue.id)
    const { data } = await client.from('issues').select('status').eq('id', issue.id).single()
    expect(data?.status).toBe('resolved')
    await expect(
      store.updateIssueStatus('00000000-0000-0000-0000-000000000001', 'resolved'),
    ).rejects.toThrow(/unknown issue/)
  })
})
```

Run: `pnpm typecheck`
Expected: FAIL（兩 store 未實作）——RED。

- [ ] **Step 2: 實作**

`src/store/contracts.ts` 的 `Store` 加：

```typescript
  updateIssueStatus(issueId: string, status: IssueStatus): Promise<StoredIssue>
```

（import `IssueStatus`。）

`src/store/memory.ts`：

```typescript
  async updateIssueStatus(issueId: string, status: IssueStatus): Promise<StoredIssue> {
    for (const [key, issue] of this.issues) {
      if (issue.id === issueId) {
        const updated = { ...issue, status }
        this.issues.set(key, updated)
        return { ...updated, tags: [...updated.tags] }
      }
    }
    throw new Error(`unknown issue: ${issueId}`)
  }
```

`src/store/supabase.ts`：

```typescript
  async updateIssueStatus(issueId: string, status: IssueStatus): Promise<StoredIssue> {
    const { data, error } = await this.client
      .from('issues')
      .update({ status })
      .eq('id', issueId)
      .select('*')
    if (error) throw new Error(`updateIssueStatus failed: ${error.message}`)
    if (data.length === 0) throw new Error(`unknown issue: ${issueId}`)
    return rowToIssue(data[0])
  }
```

`src/pipeline/change-issue-status.ts`：

```typescript
import { refreshServiceHealth } from '@/pipeline/refresh-health'
import type { HealthStatus, IssueStatus } from '@/core/types'
import type { Store, StoredIssue } from '@/store/contracts'

export async function changeIssueStatus(
  store: Store,
  issueId: string,
  status: IssueStatus,
  now: Date,
): Promise<{ issue: StoredIssue; health: HealthStatus }> {
  const issue = await store.updateIssueStatus(issueId, status)
  // 狀態變更直接影響健康度推導（resolve P0 → 燈號恢復），必須立即重算
  const health = await refreshServiceHealth(store, issue.serviceId, now)
  return { issue, health }
}
```

- [ ] **Step 3: GREEN + 回歸**

Run: `pnpm test && pnpm typecheck && pnpm test:integration`
Expected: 全綠。

- [ ] **Step 4: Commit**

```bash
git add src/store/contracts.ts src/store/memory.ts src/store/supabase.ts src/pipeline/change-issue-status.ts tests/pipeline/change-issue-status.test.ts tests/store/memory.test.ts tests/integration/supabase-store.test.ts
git commit -m "feat(store): manual issue status changes with health recompute"
```

---

### Task 2: Auth 基建（@supabase/ssr、middleware、login/signout）

**Files:**
- Modify: `package.json`（`pnpm add @supabase/ssr`）、`supabase/config.toml`（signup 關閉）、`.env.example`
- Create: `src/web/paths.ts`、`src/web/supabase-browser.ts`、`src/web/supabase-server.ts`
- Create: `middleware.ts`（repo 根）
- Create: `app/login/page.tsx`、`app/auth/signout/route.ts`
- Test: `tests/web/paths.test.ts`

**Interfaces:**
- `isPublicPath(pathname: string): boolean`——`/login`、`/api/ingest`、`/api/poll` 前綴為 public（自帶驗證），其餘受保護。
- `createBrowserSupabase()`（anon key browser client）；`createSessionClient()`（ssr cookie client）；`requireUser()`（無 session 則 `redirect('/login')`，回傳 user）。

- [ ] **Step 1: 安裝與設定**

Run: `pnpm add @supabase/ssr`

`supabase/config.toml`：`[auth]` 區塊將 `enable_signup` 改為 `false`（鍵名以檔內為準；改完 `supabase db reset` 使設定生效——本地 stack 需重啟 auth 服務時依 CLI 提示操作，或 `supabase stop && supabase start`）。

`.env.example` 追加：

```bash
# 瀏覽器端 Supabase（publishable；本地值見 supabase status）
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<supabase status 取得>
```

- [ ] **Step 2: TDD `src/web/paths.ts`**

`tests/web/paths.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { isPublicPath } from '@/web/paths'

describe('isPublicPath', () => {
  it('login and self-authenticating APIs are public', () => {
    for (const p of ['/login', '/api/ingest', '/api/poll/services']) {
      expect(isPublicPath(p)).toBe(true)
    }
  })
  it('dashboard pages are protected', () => {
    for (const p of ['/', '/issues', '/issues/abc', '/auth/signout']) {
      expect(isPublicPath(p)).toBe(false)
    }
  })
})
```

`src/web/paths.ts`：

```typescript
const PUBLIC_PREFIXES = ['/login', '/api/ingest', '/api/poll']

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}
```

Run: `pnpm vitest run tests/web/paths.test.ts`（先 RED 後 GREEN）。

- [ ] **Step 3: Supabase clients 與 middleware**

`src/web/supabase-browser.ts`：

```typescript
'use client' 之外的普通模組（client component 匯入用）：

import { createBrowserClient } from '@supabase/ssr'

export function createBrowserSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}
```

（註：檔案不需 'use client' 指令，由匯入它的 client component 決定邊界；上行敘述性文字勿抄進檔案。）

`src/web/supabase-server.ts`：

```typescript
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { createServerClient } from '@supabase/ssr'
import type { User } from '@supabase/supabase-js'

export async function createSessionClient() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            )
          } catch {
            // Server Component 內無法寫 cookie——由 middleware 負責刷新，安全忽略
          }
        },
      },
    },
  )
}

export async function requireUser(): Promise<User> {
  const supabase = await createSessionClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (user === null) redirect('/login')
  return user
}
```

`middleware.ts`（repo 根）：

```typescript
import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { isPublicPath } from '@/web/paths'

export async function middleware(request: NextRequest) {
  if (isPublicPath(request.nextUrl.pathname)) return NextResponse.next()

  let response = NextResponse.next({ request })
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          )
        },
      },
    },
  )
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (user === null) {
    return NextResponse.redirect(new URL('/login', request.url))
  }
  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
```

（@supabase/ssr 的 cookie 介面以安裝版本的型別為準；若簽章不同，依套件型別調整並在報告註明。）

- [ ] **Step 4: login 頁與 signout**

`app/login/page.tsx`：

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserSupabase } from '@/web/supabase-browser'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const supabase = createBrowserSupabase()
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
    if (signInError) {
      setError('登入失敗，請確認帳號密碼')
      setBusy(false)
      return
    }
    router.push('/')
    router.refresh()
  }

  return (
    <main className="login">
      <form onSubmit={onSubmit} className="card login-card">
        <h1>th-beacon</h1>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          密碼
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error !== null && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? '登入中…' : '登入'}
        </button>
      </form>
    </main>
  )
}
```

`app/auth/signout/route.ts`：

```typescript
import { NextResponse } from 'next/server'
import { createSessionClient } from '@/web/supabase-server'

export async function POST(request: Request): Promise<Response> {
  const supabase = await createSessionClient()
  await supabase.auth.signOut()
  return NextResponse.redirect(new URL('/login', request.url))
}
```

- [ ] **Step 5: build + 回歸**

Run: `pnpm build && pnpm test && pnpm typecheck`
Expected: build 成功（middleware/login/signout 編譯過）、單元全綠。

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml supabase/config.toml .env.example src/web/paths.ts src/web/supabase-browser.ts src/web/supabase-server.ts middleware.ts app/login/page.tsx app/auth/signout/route.ts tests/web/paths.test.ts
git commit -m "feat(web): Supabase Auth infrastructure — middleware, login, signout"
```

---

### Task 3: RLS/Realtime migration + auth 整合測試

**Files:**
- Create: `supabase/migrations/<timestamp>_dashboard_read_policy.sql`（`supabase migration new dashboard_read_policy`）
- Test: `tests/integration/auth-rls.test.ts`

**Interfaces:**
- migration：`issues` SELECT policy（TO authenticated USING true）；`issues` 加入 `supabase_realtime` publication。
- 整合測試證明的安全邊界：authenticated 可讀 issues；authenticated **不可**讀 services/events（無 policy → 空結果）；anon 什麼都讀不到。

- [ ] **Step 1: migration**

Run: `supabase migration new dashboard_read_policy`

寫入：

```sql
-- Dashboard 讀取邊界：
-- issues 開放 authenticated SELECT（Realtime postgres_changes 需要）；
-- services / events / triage_rules / notifications 維持無 policy（deny）——
-- 頁面資料由 server-side service_role 讀取，webhook_secret / discord_webhook_url 不出伺服器（Plan 2 交接）。
create policy "authenticated can read issues"
  on public.issues
  for select
  to authenticated
  using (true);

-- Realtime：把 issues 加進 supabase_realtime publication（若已存在會報錯——以 reset 結果為準）
alter publication supabase_realtime add table public.issues;
```

Run: `supabase db reset && supabase db advisors --local --type security`
Expected: reset 乾淨；advisors 無 ERROR。若 `alter publication` 因已存在而失敗，改用條件式寫法（查 `pg_publication_tables` 判斷）並在報告註明。

- [ ] **Step 2: 整合測試 `tests/integration/auth-rls.test.ts`**

```typescript
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createServiceRoleClient, cleanDatabase, getLocalSupabaseEnv } from './helpers'
import type { Database } from '@/db/database.types'

let admin: SupabaseClient<Database>
let userClient: SupabaseClient<Database>
let anonClient: SupabaseClient<Database>
let serviceId: string

const email = 'dash-test@example.com'
const password = 'test-password-123'

beforeAll(async () => {
  const { url, serviceRoleKey } = getLocalSupabaseEnv()
  admin = createServiceRoleClient()
  const env = getLocalSupabaseEnv()
  void env

  // 讀 anon key（supabase status -o env 的 ANON_KEY；鍵名以實跑為準）
  const { execSync } = await import('node:child_process')
  const statusEnv = execSync('supabase status -o env', { encoding: 'utf8' })
  const anonKey = statusEnv.match(/^ANON_KEY="?([^"\n]+)"?$/m)?.[1]
  if (anonKey === undefined) throw new Error('ANON_KEY not found in supabase status')

  anonClient = createClient<Database>(url, anonKey, { auth: { persistSession: false } })

  // 建測試使用者（冪等：先刪同 email）
  const { data: list } = await admin.auth.admin.listUsers()
  for (const u of list.users.filter((u) => u.email === email)) {
    await admin.auth.admin.deleteUser(u.id)
  }
  const { error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (createError) throw createError

  userClient = createClient<Database>(url, anonKey, { auth: { persistSession: false } })
  const { error: signInError } = await userClient.auth.signInWithPassword({ email, password })
  if (signInError) throw signInError
})

beforeEach(async () => {
  await cleanDatabase(admin)
  const { data, error } = await admin
    .from('services')
    .insert({ name: 'svc-rls', webhook_secret: 'super-secret' })
    .select('id')
    .single()
  if (error) throw error
  serviceId = data.id
  const { error: issueError } = await admin.from('issues').insert({
    service_id: serviceId,
    fingerprint: 'fp-rls',
    first_seen: '2026-07-28T10:00:00.000Z',
    last_seen: '2026-07-28T10:00:00.000Z',
    level: 'error',
    error_type: 'X',
    message: 'visible to authenticated',
  })
  if (issueError) throw issueError
})

describe('dashboard RLS boundary', () => {
  it('authenticated user can read issues', async () => {
    const { data, error } = await userClient.from('issues').select('message')
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0].message).toBe('visible to authenticated')
  })

  it('authenticated user cannot read services (secrets stay server-side)', async () => {
    const { data } = await userClient.from('services').select('webhook_secret')
    expect(data).toEqual([]) // 無 policy → deny → 空
  })

  it('authenticated user cannot read events or notifications', async () => {
    expect((await userClient.from('events').select('id')).data).toEqual([])
    expect((await userClient.from('notifications').select('id')).data).toEqual([])
  })

  it('anonymous can read nothing', async () => {
    expect((await anonClient.from('issues').select('id')).data).toEqual([])
    expect((await anonClient.from('services').select('id')).data).toEqual([])
  })
})
```

Run: `pnpm test:integration`
Expected: 全綠（新 4 條 + 既有）。

- [ ] **Step 3: 全量回歸**

Run: `pnpm test && pnpm typecheck`
Expected: 綠。

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations tests/integration/auth-rls.test.ts
git commit -m "feat(db): dashboard read policy for issues and realtime publication"
```

---

### Task 4: 查詢模組 `src/web/queries.ts`

**Files:**
- Create: `src/web/queries.ts`
- Test: `tests/integration/queries.test.ts`

**Interfaces:**
- 全部函式收 `SupabaseClient<Database>`（呼叫端傳 service_role client）：
  - `interface ServiceOverview { id: string; name: string; healthStatus: HealthStatus; openCounts: Record<Severity, number> }`
  - `getServicesOverview(client): Promise<ServiceOverview[]>`（依 name 排序；openCounts 只計 open/acknowledged）
  - `interface IssueListItem { id: string; serviceName: string; severity: Severity; status: IssueStatus; count: number; lastSeen: string; errorType: string; message: string }`
  - `interface IssueListFilters { serviceId?: string; severity?: Severity; status?: IssueStatus }`
  - `listIssues(client, filters): Promise<IssueListItem[]>`（last_seen desc，limit 100）
  - `interface IssueDetail { issue: StoredIssue; serviceName: string; events: Array<{ id: string; source: EventSource; level: string; message: string; occurredAt: string; metadata: unknown }> }`
  - `getIssueDetail(client, issueId): Promise<IssueDetail | null>`（events occurred_at desc limit 50）
- union 欄位一律走 `narrow*`（不裸 cast）。

- [ ] **Step 1: 寫整合測試 `tests/integration/queries.test.ts`**

```typescript
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createServiceRoleClient, cleanDatabase } from './helpers'
import { getServicesOverview, listIssues, getIssueDetail } from '@/web/queries'
import { SupabaseStore } from '@/store/supabase'
import { processEvent } from '@/pipeline/process-event'
import { normalizePushEvent } from '@/core/normalize'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/db/database.types'

let client: SupabaseClient<Database>
let store: SupabaseStore
let svcA: string
let svcB: string

const now = new Date('2026-07-28T10:10:00.000Z')
const receivedAt = new Date('2026-07-28T10:09:00.000Z')

beforeAll(() => {
  client = createServiceRoleClient()
  store = new SupabaseStore(client)
})

beforeEach(async () => {
  await cleanDatabase(client)
  const { data: a } = await client.from('services').insert({ name: 'svc-a' }).select('id').single()
  const { data: b } = await client.from('services').insert({ name: 'svc-b' }).select('id').single()
  svcA = a!.id
  svcB = b!.id
  await client.from('triage_rules').insert({
    service_id: null,
    priority: 10,
    severity: 'P1',
    match: { errorType: 'DBError' } as Json,
  })
  // svc-a：一筆 P1（DBError）＋一筆 P2；svc-b：無 issue
  await processEvent(store, normalizePushEvent(svcA, { message: 'db down', errorType: 'DBError' }, receivedAt), now)
  await processEvent(store, normalizePushEvent(svcA, { message: 'minor', errorType: 'Warn' }, receivedAt), now)
})

describe('getServicesOverview', () => {
  it('returns services ordered by name with per-severity open counts', async () => {
    const overview = await getServicesOverview(client)
    expect(overview.map((s) => s.name)).toEqual(['svc-a', 'svc-b'])
    expect(overview[0].openCounts).toEqual({ P0: 0, P1: 1, P2: 1 })
    expect(overview[0].healthStatus).toBe('degraded')
    expect(overview[1].openCounts).toEqual({ P0: 0, P1: 0, P2: 0 })
  })

  it('excludes resolved/ignored from counts', async () => {
    const issues = await listIssues(client, { serviceId: svcA, severity: 'P1' })
    await store.updateIssueStatus(issues[0].id, 'resolved')
    const overview = await getServicesOverview(client)
    expect(overview[0].openCounts).toEqual({ P0: 0, P1: 0, P2: 1 })
  })
})

describe('listIssues', () => {
  it('filters by service, severity and status', async () => {
    expect(await listIssues(client, {})).toHaveLength(2)
    expect(await listIssues(client, { severity: 'P1' })).toHaveLength(1)
    expect(await listIssues(client, { serviceId: svcB })).toHaveLength(0)
    const p1 = (await listIssues(client, { severity: 'P1' }))[0]
    expect(p1.serviceName).toBe('svc-a')
    await store.updateIssueStatus(p1.id, 'acknowledged')
    expect(await listIssues(client, { status: 'acknowledged' })).toHaveLength(1)
  })
})

describe('getIssueDetail', () => {
  it('returns issue with service name and events; null when missing', async () => {
    const [item] = await listIssues(client, { severity: 'P1' })
    const detail = await getIssueDetail(client, item.id)
    expect(detail?.serviceName).toBe('svc-a')
    expect(detail?.issue.severity).toBe('P1')
    expect(detail?.events).toHaveLength(1)
    expect(detail?.events[0].message).toBe('db down')
    expect(await getIssueDetail(client, '00000000-0000-0000-0000-000000000001')).toBeNull()
  })
})
```

- [ ] **Step 2: 確認 RED**

Run: `pnpm test:integration -- --reporter=basic 2>&1 | head -20`（或直接跑）
Expected: queries 測試 FAIL（module not found）。

- [ ] **Step 3: 實作 `src/web/queries.ts`**

```typescript
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/db/database.types'
import type { EventSource, HealthStatus, IssueStatus, Severity } from '@/core/types'
import type { StoredIssue } from '@/store/contracts'
import {
  narrowEventSource,
  narrowHealthStatus,
  narrowIssueStatus,
  narrowSeverity,
  rowToIssue,
} from '@/store/mapping'

type Client = SupabaseClient<Database>

export interface ServiceOverview {
  id: string
  name: string
  healthStatus: HealthStatus
  openCounts: Record<Severity, number>
}

export async function getServicesOverview(client: Client): Promise<ServiceOverview[]> {
  const { data: services, error } = await client
    .from('services')
    .select('id,name,health_status')
    .order('name')
  if (error) throw new Error(`getServicesOverview failed: ${error.message}`)

  const { data: openIssues, error: issueError } = await client
    .from('issues')
    .select('service_id,severity')
    .in('status', ['open', 'acknowledged'])
  if (issueError) throw new Error(`getServicesOverview issues failed: ${issueError.message}`)

  return services.map((service) => {
    const openCounts: Record<Severity, number> = { P0: 0, P1: 0, P2: 0 }
    for (const issue of openIssues.filter((i) => i.service_id === service.id)) {
      openCounts[narrowSeverity(issue.severity)] += 1
    }
    return {
      id: service.id,
      name: service.name,
      healthStatus: narrowHealthStatus(service.health_status),
      openCounts,
    }
  })
}

export interface IssueListItem {
  id: string
  serviceName: string
  severity: Severity
  status: IssueStatus
  count: number
  lastSeen: string
  errorType: string
  message: string
}

export interface IssueListFilters {
  serviceId?: string
  severity?: Severity
  status?: IssueStatus
}

export async function listIssues(client: Client, filters: IssueListFilters): Promise<IssueListItem[]> {
  let query = client
    .from('issues')
    .select('id,severity,status,count,last_seen,error_type,message,services(name)')
    .order('last_seen', { ascending: false })
    .limit(100)
  if (filters.serviceId !== undefined) query = query.eq('service_id', filters.serviceId)
  if (filters.severity !== undefined) query = query.eq('severity', filters.severity)
  if (filters.status !== undefined) query = query.eq('status', filters.status)

  const { data, error } = await query
  if (error) throw new Error(`listIssues failed: ${error.message}`)
  return data.map((row) => ({
    id: row.id,
    serviceName: row.services?.name ?? '(unknown)',
    severity: narrowSeverity(row.severity),
    status: narrowIssueStatus(row.status),
    count: row.count,
    lastSeen: row.last_seen,
    errorType: row.error_type,
    message: row.message,
  }))
}

export interface IssueDetail {
  issue: StoredIssue
  serviceName: string
  events: Array<{
    id: string
    source: EventSource
    level: string
    message: string
    occurredAt: string
    metadata: unknown
  }>
}

export async function getIssueDetail(client: Client, issueId: string): Promise<IssueDetail | null> {
  const { data: issueRow, error } = await client
    .from('issues')
    .select('*,services(name)')
    .eq('id', issueId)
    .maybeSingle()
  if (error) throw new Error(`getIssueDetail failed: ${error.message}`)
  if (issueRow === null) return null

  const { data: events, error: eventsError } = await client
    .from('events')
    .select('id,source,level,message,occurred_at,metadata')
    .eq('issue_id', issueId)
    .order('occurred_at', { ascending: false })
    .limit(50)
  if (eventsError) throw new Error(`getIssueDetail events failed: ${eventsError.message}`)

  const { services, ...bareIssue } = issueRow
  return {
    issue: rowToIssue(bareIssue),
    serviceName: services?.name ?? '(unknown)',
    events: events.map((event) => ({
      id: event.id,
      source: narrowEventSource(event.source),
      level: event.level,
      message: event.message,
      occurredAt: event.occurred_at,
      metadata: event.metadata,
    })),
  }
}
```

（`services(name)` 內嵌 join 的產生型別在不同版本 supabase-js 可能是物件或陣列——以 typecheck 為準調整（如 `row.services` 取 `?.name` 或 `[0]?.name`），報告註明實際形狀。）

- [ ] **Step 4: GREEN + 回歸**

Run: `pnpm test:integration && pnpm test && pnpm typecheck`
Expected: 全綠。

- [ ] **Step 5: Commit**

```bash
git add src/web/queries.ts tests/integration/queries.test.ts
git commit -m "feat(web): dashboard read-model queries"
```

---

### Task 5: UI 頁面（總覽/列表/詳情 + server actions + Realtime）

**Files:**
- Create: `src/fonts/Aurora-BC.ttf`、`src/fonts/New-Gen.ttf`、`src/fonts/Pixel-12x10.ttf`（自 trading-stream 複製）、`src/web/fonts.ts`
- Create: `app/globals.css`；Modify: `app/layout.tsx`
- Replace: `app/page.tsx`（服務總覽）
- Create: `app/issues/page.tsx`、`app/issues/[id]/page.tsx`、`app/issues/actions.ts`
- Create: `src/web/realtime-refresh.tsx`
- Test:（UI 為薄渲染層，不做元件測試；actions 的核心已由 Task 1 覆蓋。`pnpm build` 為驗證。）

**Interfaces:**
- server action：`changeIssueStatusAction(issueId: string, status: string): Promise<void>`——`requireUser()` → `narrowIssueStatus` → `changeIssueStatus(createServerStore(), ...)` → `revalidatePath`。
- `RealtimeRefresh`（client component）：訂閱 issues 變更 → `router.refresh()`；掛在 layout。

- [ ] **Step 1: 複製像素字型並建立字型模組**

Run: `mkdir -p src/fonts && cp /Users/navibluer/Code/trading-stream/src/fonts/Aurora-BC.ttf /Users/navibluer/Code/trading-stream/src/fonts/New-Gen.ttf /Users/navibluer/Code/trading-stream/src/fonts/Pixel-12x10.ttf src/fonts/`
Expected: 三個 ttf 就位（`ls src/fonts`）。

`src/web/fonts.ts`：

```typescript
import localFont from 'next/font/local'

export const auroraBC = localFont({
  variable: '--font-aurora-bc',
  src: '../fonts/Aurora-BC.ttf',
})

export const newGen = localFont({
  variable: '--font-new-gen',
  src: '../fonts/New-Gen.ttf',
})

export const pixel12x10 = localFont({
  variable: '--font-pixel-12x10',
  src: '../fonts/Pixel-12x10.ttf',
})
```

- [ ] **Step 2: `app/globals.css`（trading-stream 像素電子看板 tokens）**

```css
:root {
  --bg: #312e81;
  --fg: #ffffff;
  --gold: #f5dca6;
  --pink: #ff7db2;
  --yellow: #ffd561;
  --green: #82ff9a;
  --lilac: #e2c7ff;
  --line: rgba(226, 199, 255, 0.25);
  --panel: rgba(255, 255, 255, 0.05);
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: Arial, Helvetica, sans-serif;
}
a {
  color: inherit;
}
h1,
h2 {
  color: var(--gold);
  font-family: var(--font-aurora-bc), Arial, sans-serif;
  font-weight: 400;
  letter-spacing: 0.03em;
}
.nav {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  padding: 0.9rem 1.5rem;
  border-bottom: 1px solid var(--line);
  font-family: var(--font-new-gen), Arial, sans-serif;
}
.brand {
  color: var(--gold);
  font-family: var(--font-aurora-bc), Arial, sans-serif;
  font-size: 1.15rem;
}
.nav a {
  color: var(--lilac);
  text-decoration: none;
}
.nav a:hover {
  color: var(--gold);
}
.nav form {
  margin-left: auto;
}
.nav button {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--lilac);
  padding: 0.25rem 0.75rem;
  cursor: pointer;
  font-family: var(--font-new-gen), Arial, sans-serif;
}
.container {
  max-width: 1100px;
  margin: 0 auto;
  padding: 1.5rem;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 1rem;
}
.card {
  background: var(--panel);
  border: 1px solid var(--line);
  padding: 1rem 1.25rem;
}
.card h2 {
  margin-top: 0;
  font-size: 1.15rem;
}
.health {
  display: inline-block;
  width: 0.7rem;
  height: 0.7rem;
  margin-right: 0.5rem;
}
.health-healthy {
  background: var(--green);
}
.health-degraded {
  background: var(--yellow);
}
.health-down {
  background: var(--pink);
}
.badge {
  display: inline-block;
  padding: 0.1rem 0.5rem;
  color: var(--bg);
  font-family: var(--font-new-gen), Arial, sans-serif;
  font-size: 0.85rem;
}
.badge-P0 {
  background: var(--pink);
}
.badge-P1 {
  background: var(--yellow);
}
.badge-P2 {
  background: var(--lilac);
}
table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
}
thead th {
  color: var(--gold);
  font-family: var(--font-new-gen), Arial, sans-serif;
  font-weight: 400;
  font-size: 1.05rem;
}
th,
td {
  text-align: left;
  padding: 0.55rem 1rem;
}
tbody td {
  border-bottom: 1px solid var(--line);
}
.filters {
  display: flex;
  gap: 0.5rem;
  margin: 1rem 0;
}
.filters select,
.filters button {
  background: var(--panel);
  color: var(--fg);
  border: 1px solid var(--line);
  padding: 0.35rem 0.6rem;
  font-family: var(--font-new-gen), Arial, sans-serif;
}
.actions {
  display: flex;
  gap: 0.5rem;
  margin: 1rem 0;
}
.actions button {
  padding: 0.4rem 0.9rem;
  border: 1px solid var(--lilac);
  background: transparent;
  color: var(--lilac);
  cursor: pointer;
  font-family: var(--font-new-gen), Arial, sans-serif;
}
.actions button:hover {
  background: var(--lilac);
  color: var(--bg);
}
.error {
  color: var(--pink);
}
.login {
  display: grid;
  place-items: center;
  min-height: 100vh;
}
.login-card {
  width: 340px;
  display: grid;
  gap: 0.75rem;
}
.login-card h1 {
  text-align: center;
}
.login-card input {
  width: 100%;
  padding: 0.45rem;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid var(--line);
  color: var(--fg);
}
.login-card button {
  padding: 0.5rem;
  background: var(--gold);
  color: var(--bg);
  border: none;
  cursor: pointer;
  font-family: var(--font-new-gen), Arial, sans-serif;
}
pre {
  background: rgba(0, 0, 0, 0.25);
  padding: 0.5rem;
  overflow-x: auto;
  color: var(--lilac);
}
```

（設計原則：全站**無 border-radius、無 box-shadow**——pixel 電子看板質感；表格無豎線、僅細橫線。）

- [ ] **Step 3: `app/layout.tsx` 改為（字型變數 + brand）**

```tsx
import type { ReactNode } from 'react'
import Link from 'next/link'
import './globals.css'
import { auroraBC, newGen, pixel12x10 } from '@/web/fonts'
import { RealtimeRefresh } from '@/web/realtime-refresh'

export const metadata = { title: 'th-beacon' }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body className={`${auroraBC.variable} ${newGen.variable} ${pixel12x10.variable}`}>
        <nav className="nav">
          <span className="brand">th-beacon</span>
          <Link href="/">服務總覽</Link>
          <Link href="/issues">檢傷列表</Link>
          <form action="/auth/signout" method="post">
            <button type="submit">登出</button>
          </form>
        </nav>
        <div className="container">{children}</div>
        <RealtimeRefresh />
      </body>
    </html>
  )
}
```

- [ ] **Step 4: `src/web/realtime-refresh.tsx`**

```tsx
'use client'

import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { createBrowserSupabase } from '@/web/supabase-browser'

export function RealtimeRefresh() {
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    if (pathname.startsWith('/login')) return
    const supabase = createBrowserSupabase()
    const channel = supabase
      .channel('issues-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'issues' }, () => {
        router.refresh()
      })
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [router, pathname])

  return null
}
```

- [ ] **Step 5: `app/page.tsx`（服務總覽）**

```tsx
import Link from 'next/link'
import { requireUser } from '@/web/supabase-server'
import { createServerStore } from '@/store/server'
import { getServicesOverview } from '@/web/queries'

export const dynamic = 'force-dynamic'

export default async function OverviewPage() {
  await requireUser()
  const overview = await getServicesOverview(createServerStore().rawClient())

  return (
    <main>
      <h1>服務總覽</h1>
      <div className="cards">
        {overview.map((service) => (
          <div key={service.id} className="card">
            <h2>
              <span className={`health health-${service.healthStatus}`} />
              {service.name}
            </h2>
            <p>
              <span className="badge badge-P0">P0 {service.openCounts.P0}</span>{' '}
              <span className="badge badge-P1">P1 {service.openCounts.P1}</span>{' '}
              <span className="badge badge-P2">P2 {service.openCounts.P2}</span>
            </p>
            <Link href={`/issues?serviceId=${service.id}`}>看 issues →</Link>
          </div>
        ))}
        {overview.length === 0 && <p>尚未註冊任何服務。</p>}
      </div>
    </main>
  )
}
```

註：`queries` 需要原始 `SupabaseClient`——在 `SupabaseStore` 加一個唯讀存取器（`src/store/supabase.ts`）：

```typescript
  rawClient(): SupabaseClient<Database> {
    return this.client
  }
```

- [ ] **Step 6: `app/issues/page.tsx`（檢傷列表）**

```tsx
import Link from 'next/link'
import { requireUser } from '@/web/supabase-server'
import { createServerStore } from '@/store/server'
import { listIssues, type IssueListFilters } from '@/web/queries'
import { narrowSeverity, narrowIssueStatus } from '@/store/mapping'

export const dynamic = 'force-dynamic'

const SEVERITIES = ['P0', 'P1', 'P2'] as const
const STATUSES = ['open', 'acknowledged', 'resolved', 'ignored'] as const

export default async function IssuesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireUser()
  const params = await searchParams
  const filters: IssueListFilters = {}
  if (typeof params.serviceId === 'string' && params.serviceId !== '') {
    filters.serviceId = params.serviceId
  }
  if (typeof params.severity === 'string' && params.severity !== '') {
    filters.severity = narrowSeverity(params.severity)
  }
  if (typeof params.status === 'string' && params.status !== '') {
    filters.status = narrowIssueStatus(params.status)
  }

  const issues = await listIssues(createServerStore().rawClient(), filters)

  return (
    <main>
      <h1>檢傷列表</h1>
      <form className="filters" method="get">
        {typeof params.serviceId === 'string' && params.serviceId !== '' && (
          <input type="hidden" name="serviceId" value={params.serviceId} />
        )}
        <select name="severity" defaultValue={typeof params.severity === 'string' ? params.severity : ''}>
          <option value="">全部 severity</option>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select name="status" defaultValue={typeof params.status === 'string' ? params.status : ''}>
          <option value="">全部狀態</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button type="submit">篩選</button>
      </form>
      <table>
        <thead>
          <tr>
            <th>severity</th>
            <th>服務</th>
            <th>錯誤</th>
            <th>次數</th>
            <th>狀態</th>
            <th>最後發生</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue) => (
            <tr key={issue.id}>
              <td>
                <span className={`badge badge-${issue.severity}`}>{issue.severity}</span>
              </td>
              <td>{issue.serviceName}</td>
              <td>
                <Link href={`/issues/${issue.id}`}>
                  {issue.errorType}: {issue.message.slice(0, 80)}
                </Link>
              </td>
              <td>{issue.count}</td>
              <td>{issue.status}</td>
              <td>{new Date(issue.lastSeen).toLocaleString('zh-TW')}</td>
            </tr>
          ))}
          {issues.length === 0 && (
            <tr>
              <td colSpan={6}>沒有符合條件的 issue。</td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  )
}
```

- [ ] **Step 7: `app/issues/actions.ts` 與 `app/issues/[id]/page.tsx`**

`app/issues/actions.ts`：

```typescript
'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/web/supabase-server'
import { createServerStore } from '@/store/server'
import { changeIssueStatus } from '@/pipeline/change-issue-status'
import { narrowIssueStatus } from '@/store/mapping'

export async function changeIssueStatusAction(issueId: string, status: string): Promise<void> {
  await requireUser()
  await changeIssueStatus(createServerStore(), issueId, narrowIssueStatus(status), new Date())
  revalidatePath('/')
  revalidatePath('/issues')
  revalidatePath(`/issues/${issueId}`)
}
```

`app/issues/[id]/page.tsx`：

```tsx
import { notFound } from 'next/navigation'
import { requireUser } from '@/web/supabase-server'
import { createServerStore } from '@/store/server'
import { getIssueDetail } from '@/web/queries'
import { changeIssueStatusAction } from '@/issues-actions'

export const dynamic = 'force-dynamic'

const NEXT_STATUSES = ['acknowledged', 'resolved', 'ignored', 'open'] as const

export default async function IssueDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await requireUser()
  const { id } = await params
  const detail = await getIssueDetail(createServerStore().rawClient(), id)
  if (detail === null) notFound()
  const { issue, serviceName, events } = detail

  return (
    <main>
      <h1>
        <span className={`badge badge-${issue.severity}`}>{issue.severity}</span> {serviceName} —{' '}
        {issue.errorType}
      </h1>
      <p>{issue.message}</p>
      <p>
        狀態：<strong>{issue.status}</strong>｜次數：{issue.count}｜first seen:{' '}
        {new Date(issue.firstSeen).toLocaleString('zh-TW')}｜last seen:{' '}
        {new Date(issue.lastSeen).toLocaleString('zh-TW')}
        {issue.tags.length > 0 && <>｜tags: {issue.tags.join(', ')}</>}
      </p>
      <div className="actions">
        {NEXT_STATUSES.filter((s) => s !== issue.status).map((status) => (
          <form key={status} action={changeIssueStatusAction.bind(null, issue.id, status)}>
            <button type="submit">標記為 {status}</button>
          </form>
        ))}
      </div>
      <h2>事件（最近 {events.length} 筆）</h2>
      <table>
        <thead>
          <tr>
            <th>時間</th>
            <th>來源</th>
            <th>level</th>
            <th>訊息</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id}>
              <td>{new Date(event.occurredAt).toLocaleString('zh-TW')}</td>
              <td>{event.source}</td>
              <td>{event.level}</td>
              <td>
                {event.message}
                {event.metadata !== null && Object.keys(event.metadata as object).length > 0 && (
                  <pre>{JSON.stringify(event.metadata, null, 2)}</pre>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  )
}
```

（import 路徑 `@/issues-actions` 為示意——實際請用相對路徑 `../actions` 或 `@/../app/issues/actions`，以 typecheck 可過為準，報告註明。）

- [ ] **Step 8: build + 回歸**

Run: `pnpm build && pnpm test && pnpm typecheck && pnpm test:integration`
Expected: 全綠；build 列出 `/`、`/issues`、`/issues/[id]`、`/login` 等路由。

- [ ] **Step 9: Commit**

```bash
git add src/fonts src/web/fonts.ts app/globals.css app/layout.tsx app/page.tsx app/issues src/web/realtime-refresh.tsx src/store/supabase.ts
git commit -m "feat(web): dashboard pages in trading-stream pixel style"
```

---

### Task 6: spec 定案更新 + 收尾回歸

**Files:**
- Modify: `docs/superpowers/specs/2026-07-23-service-monitoring-dashboard-design.md`（§4.7、§6）

- [ ] **Step 1: spec 更新**

§4.7 Dashboard UI 末尾加：

```markdown
- **實作定案**：讀取走 server components + service_role（`services`/`events` 不開瀏覽器端 policy，敏感欄位不出伺服器）；RLS 僅 `issues` 開 authenticated SELECT 供 Realtime；即時更新=訂閱 issues 變更後 `router.refresh()`；狀態變更走 server action（驗 session → 更新 → 立即重算健康度）。趨勢圖表列未來擴充。
```

§6 存取控制的 Dashboard bullet 改為：

```markdown
- **Dashboard**：Supabase Auth 登入（invite-only email/password，signup 關閉，成員由管理者建立；網域 allowlist 列未來擴充）。middleware 保護除 `/login` 與自帶驗證 API 外的全部路徑。
```

- [ ] **Step 2: 全量回歸**

Run: `pnpm test && pnpm typecheck && pnpm test:integration && pnpm build`
Expected: 四綠。

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-23-service-monitoring-dashboard-design.md
git commit -m "docs: finalize dashboard access model in spec"
```

---

## 完成後

Plan 7 交付 MVP dashboard——至此 **spec 的 MVP 範圍全部完成**（兩條入口、判級、健康度、Discord 告警、dashboard）。使用者驗收：`pnpm dev`（自管）→ Supabase Studio 建使用者 → 登入操作三頁 → 以 `scripts/report-to-beacon.sh` 打事件驗證即時刷新與 Discord。

### 部署清單（go-live 前置，來自 Plan 7 最終 review；Vercel 行為項未實地驗證）

1. **Hosted Supabase**：關閉 signup（**本地 config.toml 不會生效於雲端**，需在專案設定操作）；套用全部 migrations 與 seed；建正式使用者。
2. **Vercel env**：`NEXT_PUBLIC_SUPABASE_URL`／`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`（sb_publishable_...）／`SUPABASE_URL`／`SUPABASE_SECRET_KEY`（sb_secret_...）／`CRON_SECRET`／`DISCORD_WEBHOOK_URL`（選）／`APP_URL`（選）。金鑰用 hosted 專案的新制 API keys（非 legacy anon/service_role JWT）。
3. **Vercel Cron**：實地驗證 `CRON_SECRET` 的 Bearer 注入行為；方案的 cron 頻率限制；評估 poll route `maxDuration` vs 服務數×timeout 上界。
4. **Next 16**：middleware→proxy 改名警告，升版前處理。

### Deferred（記錄於各 task review）

- reopen 復發語意與恢復通知（Plan 6 交接，另案裁量）。
- server action 錯誤走 Next 通用錯誤頁（可補 app/error.tsx）；`getServicesOverview` O(n×m)（量大再改）；memory store 線性找 id ×3；error 補漏硬化與 truncated 旗標消費（Plan 5 交接）。
- fix wave `9d26879` 已修：非 UUID 404 而非 500、realtime 1.5s debounce + 60s backstop（涵蓋燈號恢復缺口）、/login 不渲染 nav、Pixel-12x10 移除載入（ttf 保留）、signout 303、ratchet 說明句。
