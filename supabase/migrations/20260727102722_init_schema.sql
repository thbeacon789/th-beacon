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
