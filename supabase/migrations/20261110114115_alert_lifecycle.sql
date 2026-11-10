-- 告警生命週期：issues 確認／解決／事故序號欄位、notifications 的 Discord 訊息紀錄
alter table public.issues
  add column acknowledged_at timestamptz,
  add column acknowledged_by text,
  add column resolved_at timestamptz,
  add column resolved_by text,
  add column reopen_count int not null default 0,
  add column incident_first_seen timestamptz,
  add column incident_count int not null default 1;

update public.issues set incident_first_seen = first_seen, incident_count = count;

alter table public.issues alter column incident_first_seen set not null;

alter table public.notifications
  add column kind text not null default 'alert' check (kind in ('alert', 'count_edit', 'resolve_reply')),
  add column incident_seq int not null default 0,
  add column discord_channel_id text,
  add column discord_message_id text,
  add column payload jsonb;

create index notifications_issue_incident_sent_idx
  on public.notifications (issue_id, incident_seq, sent_at);

-- 簽名與回傳不變，可直接 create or replace。
-- 復發（舊 status = resolved）開新一輪事故：reopen_count+1、事故起點與計數重置、清空確認／解決紀錄。
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
    (service_id, fingerprint, count, first_seen, last_seen, level, error_type, message,
     incident_first_seen, incident_count)
  values
    (p_service_id, p_fingerprint, 1, p_occurred_at, p_occurred_at, p_level, p_error_type, p_message,
     p_occurred_at, 1)
  on conflict (service_id, fingerprint) do update
    set count = i.count + 1,
        last_seen = greatest(i.last_seen, excluded.last_seen),
        level = excluded.level,
        status = case when i.status = 'resolved' then 'open' else i.status end,
        reopen_count = case when i.status = 'resolved' then i.reopen_count + 1 else i.reopen_count end,
        incident_first_seen = case when i.status = 'resolved' then p_occurred_at else i.incident_first_seen end,
        incident_count = case when i.status = 'resolved' then 1 else i.incident_count + 1 end,
        acknowledged_at = case when i.status = 'resolved' then null else i.acknowledged_at end,
        acknowledged_by = case when i.status = 'resolved' then null else i.acknowledged_by end,
        resolved_at = case when i.status = 'resolved' then null else i.resolved_at end,
        resolved_by = case when i.status = 'resolved' then null else i.resolved_by end
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
