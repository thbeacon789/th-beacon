-- AI 嚴重度判定：服務說明 + issue 的 AI 判定欄位 + upsert 回傳 reopened
alter table public.services add column description text;

alter table public.issues
  add column ai_severity text check (ai_severity in ('P0', 'P1', 'P2')),
  add column ai_category text check (ai_category in ('env', 'app')),
  add column ai_reason text,
  add column ai_suggestion text,
  add column ai_model text,
  add column ai_judged_at timestamptz,
  add column ai_error text;

-- 回傳型別改變不能 create or replace，需 drop 後重建（參數與原回傳欄位不變，僅多 reopened）。
-- 舊程式以欄位名稱讀取結果，多一欄不影響。
drop function public.upsert_issue_with_event(uuid, text, text, text, text, text, timestamptz, jsonb, text);

create function public.upsert_issue_with_event(
  p_service_id uuid,
  p_fingerprint text,
  p_source text,
  p_level text,
  p_error_type text,
  p_message text,
  p_occurred_at timestamptz,
  p_metadata jsonb,
  p_external_id text
) returns table (issue_id uuid, created boolean, duplicate boolean, reopened boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_issue_id uuid;
  v_created boolean := false;
  v_prev_status text;
  v_reopened boolean := false;
begin
  if p_external_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_service_id::text || ':' || p_external_id, 0));

    select e.issue_id into v_issue_id
    from public.events e
    where e.service_id = p_service_id and e.external_id = p_external_id;
    if found then
      return query select v_issue_id, false, true, false;
      return;
    end if;
  end if;

  -- 更新前讀出既有狀態以判斷是否 reopen（鎖列避免併發下判斷過期）
  select i.status into v_prev_status
  from public.issues i
  where i.service_id = p_service_id and i.fingerprint = p_fingerprint
  for update;
  v_reopened := coalesce(v_prev_status = 'resolved', false);

  insert into public.issues as i
    (service_id, fingerprint, count, first_seen, last_seen, level, error_type, message)
  values
    (p_service_id, p_fingerprint, 1, p_occurred_at, p_occurred_at, p_level, p_error_type, p_message)
  on conflict (service_id, fingerprint) do update
    set count = i.count + 1,
        last_seen = greatest(i.last_seen, excluded.last_seen),
        level = excluded.level,
        status = case when i.status = 'resolved' then 'open' else i.status end
  returning id, (count = 1) into v_issue_id, v_created;

  insert into public.events
    (issue_id, service_id, source, level, error_type, message, occurred_at, metadata, external_id)
  values
    (v_issue_id, p_service_id, p_source, p_level, p_error_type, p_message, p_occurred_at, p_metadata, p_external_id)
  on conflict (service_id, external_id) where external_id is not null do nothing;

  return query select v_issue_id, v_created, false, v_reopened;
end;
$$;

revoke execute on function public.upsert_issue_with_event(uuid, text, text, text, text, text, timestamptz, jsonb, text) from public, anon, authenticated;
grant execute on function public.upsert_issue_with_event(uuid, text, text, text, text, text, timestamptz, jsonb, text) to service_role;
