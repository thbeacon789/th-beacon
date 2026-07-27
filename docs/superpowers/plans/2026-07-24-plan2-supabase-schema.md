# Supabase 本地環境 + Schema/RLS + 型別產生 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **REQUIRED SUB-SKILL for every DB task:** Use the `supabase:supabase` skill. Before writing/altering schema or RLS, follow its guidance: fetch `https://supabase.com/changelog.md` for breaking changes, discover CLI flags via `--help` (never guess), and run advisors after changes. The concrete SQL/commands below are the starting point, not a licence to skip that skill.

**Goal:** 建立本地 Supabase 開發環境，定義 th-beacon 的資料庫 schema（services / issues / events / triage_rules / notifications）與 RLS，並產生 TypeScript 型別，供後續持久層與管線使用。

**Architecture:** 本地優先——用 Supabase CLI 起本地 stack（OrbStack Docker），schema 以 imperative migration 檔管理於 `supabase/migrations/`。所有表啟用 RLS 且預設無 anon/authenticated policy（deny-by-default）；伺服器端以 service_role 存取（繞過 RLS），dashboard 的具名讀取 policy 留到 Plan 6 建 consumer 時再依實際存取模型加上。此計畫不含 app 程式碼、adapter 或 orchestrator（那是 Plan 3）。

**Tech Stack:** Supabase CLI 2.98.1、本地 Postgres（Docker/OrbStack）、SQL migrations、`supabase gen types typescript`。

## Global Constraints

- 套件管理一律用 **pnpm**。
- 本地 Docker 由 **OrbStack** 提供；Supabase 本地 stack 由執行者以 `supabase start` 管理（這不是 app dev server，可自行啟動）。
- Schema 走 **imperative migrations**（`supabase/migrations/*.sql`），不使用 declarative schemas。
- **每張 public 表都必須啟用 RLS**（`alter table ... enable row level security;`）。MVP 階段不新增 anon/authenticated policy（deny-by-default）；伺服器端存取一律走 service_role。
- severity 值域 `P0|P1|P2`；issue.status 值域 `open|acknowledged|resolved|ignored`；event.source 值域 `push|poll`；service.health_status 值域 `down|degraded|healthy`——一律以 `check` 約束落實。
- 時間欄位用 `timestamptz`；主鍵用 `uuid default gen_random_uuid()`。
- 產出的型別檔置於 `src/db/database.types.ts`（讓 Plan 3 的 adapter import）。
- 每個 DB 變更後跑 advisors，修掉 ERROR 級問題；RLS-enabled-no-policy 的 INFO 提示為本階段預期（伺服器端 service_role 存取），於報告中註明即可。

## 本計畫涵蓋 vs. 後續計畫

**本計畫做（對應 spec §5、§6 的資料層部分）：** 本地 Supabase 初始化、5 張表的 schema（欄位／約束／索引／外鍵）、全表啟用 RLS、advisors 清乾淨、產生 TS 型別。

**本計畫不做：** supabase-js client、Store port／InMemoryStore／SupabaseStore、管線 orchestrator（皆 Plan 3）；ingest／poller（Plan 4）；Discord（Plan 5）；dashboard 具名讀取 policy／Auth／Realtime（Plan 6）。

---

### Task 1: 初始化本地 Supabase 專案

**Files:**
- Create: `supabase/config.toml`（由 `supabase init` 產生）
- Modify: `.gitignore`（加入 Supabase 本地暫存目錄）

**Interfaces:**
- Consumes: 無。
- Produces: 可用的本地 Supabase 專案結構與 `supabase/config.toml`；`supabase start` 能起本地 stack。

- [ ] **Step 1: 確認工具鏈**

Run: `docker version --format '{{.Server.Version}}' && supabase --version`
Expected: 印出 Docker server 版本（OrbStack）與 supabase CLI 版本（≥ 2.98）。若任一缺失，STOP 回報。

- [ ] **Step 2: 初始化 Supabase 專案**

Run: `supabase init`
Expected: 產生 `supabase/config.toml`（以及 `supabase/` 下的預設結構）。若 CLI 詢問 VS Code / IntelliJ settings，一律選否（不需要）。

- [ ] **Step 3: 補強 `.gitignore`（Supabase 本地暫存與環境檔）**

在 `.gitignore` 末端追加（若尚未存在）：

```gitignore
# Supabase local
supabase/.branches
supabase/.temp
supabase/.env
```

- [ ] **Step 4: 啟動本地 stack 驗證可運作**

Run: `supabase start`
Expected: 拉起本地 Postgres/Studio 等容器並印出 API URL、`anon key`、`service_role key`、DB URL。若 Docker 未執行則 STOP 回報（請使用者確認 OrbStack 已啟動）。

- [ ] **Step 5: 確認狀態**

Run: `supabase status`
Expected: 顯示各服務為 running。

- [ ] **Step 6: Commit**

```bash
git add supabase/config.toml .gitignore
git commit -m "chore(db): initialize local Supabase project"
```

註：`supabase/config.toml` 應納入版控；本地暫存目錄（`.branches`/`.temp`/`.env`）已被忽略。若 `supabase init` 另外產生了 `supabase/.gitignore`，一併 `git add supabase/.gitignore`。

---

### Task 2: 建立核心 schema migration（5 張表）

**Files:**
- Create: `supabase/migrations/<timestamp>_init_schema.sql`（用 `supabase migration new init_schema` 產生檔名，勿手打時間戳）

**Interfaces:**
- Consumes: Task 1 的本地 stack。
- Produces: `services`、`issues`、`events`、`triage_rules`、`notifications` 五張表，含約束與索引。欄位是 Plan 3 adapter 與後續 dashboard 的資料契約。

- [ ] **Step 1: 建立空白 migration 檔**

Run: `supabase migration new init_schema`
Expected: 於 `supabase/migrations/` 產生一支空的 `<timestamp>_init_schema.sql`，印出路徑。

- [ ] **Step 2: 寫入 schema SQL**

把以下內容寫進該 migration 檔：

```sql
-- services: 被監控的服務清單與其設定
create table public.services (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  webhook_secret text,
  discord_webhook_url text,
  health_window_minutes integer not null default 15,
  health_failure_threshold integer not null default 2,
  poll_health_url text,
  poll_error_url text,
  poll_interval_seconds integer,
  poll_timeout_ms integer not null default 5000,
  poll_expected_status integer not null default 200,
  poll_cursor text,
  poll_consecutive_failures integer not null default 0,
  last_poll_at timestamptz,
  last_poll_healthy boolean,
  health_status text not null default 'healthy'
    check (health_status in ('down', 'degraded', 'healthy')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- issues: 依 fingerprint 聚合的問題
create table public.issues (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references public.services(id) on delete cascade,
  fingerprint text not null,
  severity text not null default 'P2' check (severity in ('P0', 'P1', 'P2')),
  status text not null default 'open'
    check (status in ('open', 'acknowledged', 'resolved', 'ignored')),
  count integer not null default 0,
  first_seen timestamptz not null,
  last_seen timestamptz not null,
  level text not null,
  error_type text not null,
  message text not null,
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (service_id, fingerprint)
);

create index issues_service_status_idx on public.issues (service_id, status);
create index issues_service_last_seen_idx on public.issues (service_id, last_seen desc);

-- events: 原始事件，歸屬於某 issue
create table public.events (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.issues(id) on delete cascade,
  service_id uuid not null references public.services(id) on delete cascade,
  source text not null check (source in ('push', 'poll')),
  level text not null,
  error_type text not null,
  message text not null,
  occurred_at timestamptz not null,
  metadata jsonb not null default '{}',
  external_id text,
  created_at timestamptz not null default now()
);

create index events_issue_idx on public.events (issue_id);
-- poll 來源去重：同服務同 external_id 只計一次（external_id 為 null 者不受限）
create unique index events_service_external_id_uidx
  on public.events (service_id, external_id)
  where external_id is not null;

-- triage_rules: 檢傷規則（service_id 為 null 表示套用到所有服務）
create table public.triage_rules (
  id uuid primary key default gen_random_uuid(),
  service_id uuid references public.services(id) on delete cascade,
  priority integer not null,
  severity text not null check (severity in ('P0', 'P1', 'P2')),
  tags text[] not null default '{}',
  match jsonb not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create index triage_rules_service_idx on public.triage_rules (service_id);

-- notifications: 已發送 Discord 紀錄（供冷卻/去重/稽核）
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid references public.issues(id) on delete set null,
  service_id uuid not null references public.services(id) on delete cascade,
  fingerprint text not null,
  severity text not null check (severity in ('P0', 'P1', 'P2')),
  channel text not null default 'discord',
  status text not null default 'sent' check (status in ('sent', 'failed')),
  count_at_send integer not null,
  sent_at timestamptz not null default now()
);

create index notifications_fingerprint_sent_idx
  on public.notifications (fingerprint, sent_at desc);
```

- [ ] **Step 3: 套用 migration（乾淨重建）**

Run: `supabase db reset`
Expected: 重建本地 DB 並套用全部 migration，無錯誤，結尾顯示 migration 套用成功。若任何 SQL 報錯，修正 migration 檔後重跑，直到乾淨。

- [ ] **Step 4: 驗證表已建立**

Run: `supabase migration list --local`
Expected: 列出 `init_schema` migration 為已套用（local 欄有值）。

再以一筆查詢確認表存在（透過 MCP `execute_sql` 或 `psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '\"')" -c '\dt public.*'`；若 CLI/MCP 版本不支援，改用 `supabase db diff --local` 應顯示無差異）：
Expected: 看到 services / issues / events / triage_rules / notifications 五張表。

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations
git commit -m "feat(db): core schema — services, issues, events, triage_rules, notifications"
```

---

### Task 3: 啟用 RLS（deny-by-default）並清 advisors

**Files:**
- Create: `supabase/migrations/<timestamp>_enable_rls.sql`（用 `supabase migration new enable_rls` 產生）

**Interfaces:**
- Consumes: Task 2 的五張表。
- Produces: 全表啟用 RLS，無 anon/authenticated policy（伺服器端 service_role 存取）。

- [ ] **Step 1: 建立 RLS migration 檔**

Run: `supabase migration new enable_rls`
Expected: 產生空的 `<timestamp>_enable_rls.sql`，印出路徑。

- [ ] **Step 2: 寫入 RLS SQL**

```sql
-- 全表啟用 RLS。MVP 階段不新增 anon/authenticated policy：
-- 預設 deny-all，伺服器端以 service_role 存取（繞過 RLS）。
-- dashboard 的具名讀取 policy 留待 Plan 6 依實際存取模型加上。
alter table public.services enable row level security;
alter table public.issues enable row level security;
alter table public.events enable row level security;
alter table public.triage_rules enable row level security;
alter table public.notifications enable row level security;
```

- [ ] **Step 3: 套用**

Run: `supabase db reset`
Expected: 全部 migration（含 RLS）乾淨套用，無錯誤。

- [ ] **Step 4: 跑 advisors（security）**

Run: `supabase db advisors --local --type security`（若此 CLI 版本不支援該旗標或子命令，改用 MCP `get_advisors` type=security；先以 `supabase db advisors --help` 確認用法）
Expected: 無 ERROR 級發現。允許出現 `rls_enabled_no_policy` 類 INFO/WARN（本階段預期，因伺服器端以 service_role 存取）；於報告中逐項列出並註明為預期。若出現任何非預期的 ERROR，修正後重跑。

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations
git commit -m "feat(db): enable RLS on all tables (deny-by-default)"
```

---

### Task 4: 產生 TypeScript 型別

**Files:**
- Create: `src/db/database.types.ts`（由 `supabase gen types` 產生）
- Modify: `package.json`（新增 `db:types` script）

**Interfaces:**
- Consumes: 已套用 schema 的本地 stack。
- Produces: `src/db/database.types.ts`（Plan 3 的 adapter 會 import 其中的 `Database` / 資料列型別）；`pnpm db:types` 可重新產生。

- [ ] **Step 1: 新增產生型別的 script 到 `package.json`**

在 `scripts` 區塊加入：

```json
    "db:types": "supabase gen types typescript --local > src/db/database.types.ts"
```

（先以 `supabase gen types --help` 確認 `typescript` 子命令與 `--local` 旗標在此 CLI 版本的正確寫法；若不同，調整 script 內容並在報告註明。）

- [ ] **Step 2: 產生型別檔**

Run: `mkdir -p src/db && pnpm db:types`
Expected: 產生 `src/db/database.types.ts`，內含 `Database` 型別與各表的 `Row`/`Insert`/`Update` 型別。

- [ ] **Step 3: 型別檔能被 TypeScript 正確解析**

Run: `pnpm typecheck`
Expected: 無錯誤（exit 0）。若產生的檔案觸發 lint/strict 問題，勿手改型別內容（那是自動產生物）；改為在報告中回報並停下。

- [ ] **Step 4: 快速健檢——確認關鍵表型別存在**

以 Read 檢視 `src/db/database.types.ts`，確認 `services`、`issues`、`events`、`triage_rules`、`notifications` 五張表都出現在 `Database['public']['Tables']` 下。

- [ ] **Step 5: Commit**

```bash
git add src/db/database.types.ts package.json
git commit -m "feat(db): generate TypeScript types from schema"
```

---

## 完成後

Plan 2 交付可運作的本地 Supabase 環境、含 RLS 的 schema（含 updated_at 自動 bump trigger）、與自動產生的 TS 型別。

### Plan 3 必要驗收條件（來自 Plan 2 最終 whole-branch review，勿遺漏）

1. **externalId lift 契約**：`normalizePolledError` 把 `externalId` 放在 `metadata.externalId`，但 poll 去重靠 `events.external_id` 欄位的 partial unique index。Plan 3 adapter **必須**把 `externalId` 提升到 `events.external_id` 欄位（否則去重靜默失效），並測試：重複 externalId 以 `on conflict do nothing` 落地時 issue.count 不重複累計。
2. **triage_rules 的 service_id 單一權威來源**：規則引擎只認 `match.serviceId`；DB 另有 `triage_rules.service_id` 欄位（null=全域）。Plan 3 載入規則時以查詢端過濾（`where service_id = $1 or service_id is null`）為權威，jsonb `match` 內不重複放 serviceId；加對應測試防「規則意外全域套用」。
3. 產生型別中 severity/status/source 為寬鬆 `string`：adapter 載回 domain 型別時必須 narrow/驗證，不可直接 cast。
4. Plan 1 的 `Issue` 介面無 `tags` 欄位而 DB 有：Plan 3 擴充 `Issue.tags` 或明確對映。

（其餘 deferred：poller 的 status-JSON 判準欄位與 events.service_id 一般索引留待 Plan 4 依查詢模式決定；Plan 6 對 services 開放讀取 policy 時須以 column grant/view 排除 webhook_secret 與 discord_webhook_url；通知冷卻只計 status='sent'。）下一份 **Plan 3｜持久層與管線接線** 會定義 `Store` port、`InMemoryStore`（純 TDD 測 orchestrator）、管線 orchestrator（`normalize → 依 fingerprint upsert → evaluateSeverity → 更新 severity → deriveHealth → 更新 health`），以及以本計畫 schema 為後盾的 `SupabaseStore` adapter（對本地 stack 做整合測試）。
