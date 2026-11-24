create table public.security_findings (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references public.services(id) on delete cascade,
  fingerprint text not null,
  "check" text not null,
  status text not null check (status in ('open','resolved','ignored')),
  severity text not null,
  title text not null,
  recommendation text not null,
  key_fallback boolean not null default false,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  status_changed_at timestamptz not null,
  status_changed_by text,
  reopen_count integer not null default 0,
  missed_count integer not null default 0,
  unique (service_id, fingerprint)
);
create index security_findings_status_service_idx on public.security_findings (status, service_id);
alter table public.security_findings enable row level security;
