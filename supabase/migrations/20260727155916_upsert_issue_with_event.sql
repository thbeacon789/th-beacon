-- 原子 upsert：dedup(externalId) → issue upsert(count/last_seen/reopen) → event insert。
-- 集中成單一 function 以避免 TS 端 read-modify-write 的競態；
-- PostgREST 的 upsert 無法對 partial unique index 指定 on_conflict，故 event 去重也在此處理。
create or replace function public.upsert_issue_with_event(
  p_service_id uuid,
  p_fingerprint text,
  p_source text,
  p_level text,
  p_error_type text,
  p_message text,
  p_occurred_at timestamptz,
  p_metadata jsonb,
  p_external_id text
) returns table (issue_id uuid, created boolean, duplicate boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_issue_id uuid;
  v_created boolean := false;
begin
  -- poll 來源去重：同服務同 external_id 只計一次（Plan 2 review 驗收條件 #1）
  if p_external_id is not null then
    select e.issue_id into v_issue_id
    from public.events e
    where e.service_id = p_service_id and e.external_id = p_external_id;
    if found then
      return query select v_issue_id, false, true;
      return;
    end if;
  end if;

  insert into public.issues as i
    (service_id, fingerprint, count, first_seen, last_seen, level, error_type, message)
  values
    (p_service_id, p_fingerprint, 1, p_occurred_at, p_occurred_at, p_level, p_error_type, p_message)
  on conflict (service_id, fingerprint) do update
    set count = i.count + 1,
        last_seen = greatest(i.last_seen, excluded.last_seen),
        level = excluded.level,
        -- resolved 遇新事件視為 regression 重開；ignored 維持人工決定
        status = case when i.status = 'resolved' then 'open' else i.status end
  returning id, (count = 1) into v_issue_id, v_created;

  insert into public.events
    (issue_id, service_id, source, level, error_type, message, occurred_at, metadata, external_id)
  values
    (v_issue_id, p_service_id, p_source, p_level, p_error_type, p_message, p_occurred_at, p_metadata, p_external_id)
  on conflict (service_id, external_id) where external_id is not null do nothing;

  return query select v_issue_id, v_created, false;
end;
$$;

-- deny-by-default：僅伺服器端（service_role）可呼叫
revoke execute on function public.upsert_issue_with_event(uuid, text, text, text, text, text, timestamptz, jsonb, text) from public, anon, authenticated;
grant execute on function public.upsert_issue_with_event(uuid, text, text, text, text, text, timestamptz, jsonb, text) to service_role;
