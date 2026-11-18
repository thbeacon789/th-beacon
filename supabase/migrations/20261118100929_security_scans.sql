create table public.security_scans (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references public.services(id) on delete cascade,
  scanned_at timestamptz not null,
  received_at timestamptz not null default now(),
  kind text not null check (kind in ('vm','hosted')),
  checks jsonb not null,
  findings jsonb not null default '[]'::jsonb,
  certs jsonb not null default '[]'::jsonb,
  log_volume jsonb not null default '[]'::jsonb,
  exposure jsonb not null default '[]'::jsonb,
  inventory jsonb,
  unique (service_id, scanned_at)
);
create index security_scans_service_scanned_idx on public.security_scans (service_id, scanned_at desc);
alter table public.security_scans enable row level security;

-- ai_usage.source 的現有約束是未命名的行內約束：動態找出（限定含 server_triage 者，避免誤刪 cost_usd／input_tokens 的 check）並 drop
do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.ai_usage'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%source%'
      and pg_get_constraintdef(oid) like '%server_triage%'
  loop
    execute format('alter table public.ai_usage drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.ai_usage add constraint ai_usage_source_check
  check (source in ('server_triage','ci_diagnosis','ci_pr','ci_security'));
