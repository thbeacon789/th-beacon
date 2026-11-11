-- AI 判定準確率與花費統計：判定紀錄、用量紀錄、合併相同判定的 rpc
create table public.ai_judgments (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.issues(id) on delete cascade,
  service_id uuid not null references public.services(id) on delete cascade,
  source text not null check (source in ('server', 'ci')),
  severity text not null check (severity in ('P0', 'P1', 'P2')),
  category text not null check (category in ('env', 'app')),
  model text,
  judged_at timestamptz not null,
  last_judged_at timestamptz not null,
  merge_count int not null default 1,
  severity_verdict text check (severity_verdict in ('correct', 'wrong')),
  severity_correct text check (severity_correct in ('P0', 'P1', 'P2')),
  category_verdict text check (category_verdict in ('correct', 'wrong')),
  category_correct text check (category_correct in ('env', 'app')),
  labeled_by text,
  labeled_at timestamptz,
  created_at timestamptz not null default now(),
  constraint ai_judgments_severity_label_chk check (
    (severity_verdict is null and severity_correct is null)
    or (severity_verdict = 'correct' and severity_correct is null)
    or (severity_verdict = 'wrong' and severity_correct is not null and severity_correct <> severity)
  ),
  constraint ai_judgments_category_label_chk check (
    (category_verdict is null and category_correct is null)
    or (category_verdict = 'correct' and category_correct is null)
    or (category_verdict = 'wrong' and category_correct is not null and category_correct <> category)
  )
);

create index ai_judgments_issue_judged_idx on public.ai_judgments (issue_id, judged_at desc);
create index ai_judgments_judged_at_idx on public.ai_judgments (judged_at);

create table public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references public.services(id) on delete cascade,
  source text not null check (source in ('server_triage', 'ci_diagnosis', 'ci_pr')),
  model text,
  input_tokens int check (input_tokens >= 0),
  output_tokens int check (output_tokens >= 0),
  cost_usd numeric(12, 6) check (cost_usd >= 0),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (cost_usd is not null or (input_tokens is not null and output_tokens is not null))
);

create index ai_usage_occurred_at_idx on public.ai_usage (occurred_at);

-- deny-by-default：不加 policy，伺服器端走 service_role
alter table public.ai_judgments enable row level security;
alter table public.ai_usage enable row level security;

-- 與該 issue 最新一筆判定（judged_at desc, created_at desc）相同 → 合併；否則新增
create function public.record_ai_judgment(
  p_issue_id uuid,
  p_service_id uuid,
  p_source text,
  p_severity text,
  p_category text,
  p_model text,
  p_judged_at timestamptz
) returns table (judgment_id uuid, merged boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_latest record;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('ai_judgment:' || p_issue_id::text, 0));

  select j.id, j.severity, j.category into v_latest
  from public.ai_judgments j
  where j.issue_id = p_issue_id
  order by j.judged_at desc, j.created_at desc
  limit 1;

  if found and v_latest.severity = p_severity and v_latest.category = p_category then
    update public.ai_judgments j
      set last_judged_at = greatest(j.last_judged_at, p_judged_at),
          merge_count = j.merge_count + 1
      where j.id = v_latest.id;
    return query select v_latest.id, true;
    return;
  end if;

  insert into public.ai_judgments
    (issue_id, service_id, source, severity, category, model, judged_at, last_judged_at)
  values
    (p_issue_id, p_service_id, p_source, p_severity, p_category, p_model, p_judged_at, p_judged_at)
  returning id into v_id;

  return query select v_id, false;
end;
$$;

revoke execute on function public.record_ai_judgment(uuid, uuid, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.record_ai_judgment(uuid, uuid, text, text, text, text, timestamptz) to service_role;
