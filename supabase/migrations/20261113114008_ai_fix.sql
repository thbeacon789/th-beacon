-- AI 修復 PR 回報：issues 新增 ai_fix 四欄（皆可為 null；ai_fix_reported_at 是「有回報過」的唯一標記）
alter table public.issues
  add column ai_fix_status text check (ai_fix_status in ('pr_opened', 'no_fix', 'failed')),
  add column ai_fix_pr_url text,
  add column ai_fix_summary text,
  add column ai_fix_reported_at timestamptz,
  add constraint issues_ai_fix_pr_url_required
    check (ai_fix_status is distinct from 'pr_opened' or ai_fix_pr_url is not null);
