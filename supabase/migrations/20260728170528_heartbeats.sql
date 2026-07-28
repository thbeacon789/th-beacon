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
