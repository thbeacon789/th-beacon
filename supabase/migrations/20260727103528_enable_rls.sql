-- 全表啟用 RLS。MVP 階段不新增 anon/authenticated policy：
-- 預設 deny-all，伺服器端以 service_role 存取（繞過 RLS）。
-- dashboard 的具名讀取 policy 留待 Plan 6 依實際存取模型加上。
alter table public.services enable row level security;
alter table public.issues enable row level security;
alter table public.events enable row level security;
alter table public.triage_rules enable row level security;
alter table public.notifications enable row level security;
