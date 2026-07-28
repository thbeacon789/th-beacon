-- 登入白名單：只有名單內的 email 能建立帳號，且僅限 Google OAuth。
-- 名單由管理員在 Studio / SQL 直接維護；RLS deny-by-default，
-- 僅開一條「authenticated 讀自己那列」的 policy 供登入後複查。

create table public.allowed_emails (
  email text primary key check (email = lower(email)),
  note text,
  created_at timestamptz not null default now()
);

alter table public.allowed_emails enable row level security;

-- 登入後複查用（requireUser）：只能看見自己 email 對應的那一列
create policy allowed_emails_select_own on public.allowed_emails
  for select to authenticated
  using (email = lower(auth.jwt() ->> 'email'));

-- Before User Created hook：GoTrue 建立使用者前呼叫；回傳 {} 放行、{"error": ...} 拒絕。
-- 兩道閘門：
--   1. provider 必須是 google——封死 email/password signup 被拿來免信箱驗證
--      冒名搶佔白名單 email 的攻擊面（admin API 不經 hook，屬受信任後台）。
--   2. email 必須在白名單。
-- security definer（owner postgres, bypassrls）才能在 deny-by-default RLS 下讀白名單表。
create or replace function public.before_user_created_hook(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider text := event -> 'user' -> 'app_metadata' ->> 'provider';
  v_email text := lower(trim(event -> 'user' ->> 'email'));
begin
  if v_provider is distinct from 'google' then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', '僅支援 Google 登入'
      )
    );
  end if;
  if v_email is not null and v_email <> ''
     and exists (select 1 from public.allowed_emails where email = v_email) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'Email not allowed: 請聯絡管理員將你的 email 加入白名單'
    )
  );
end;
$$;

-- GoTrue（supabase_auth_admin）執行 hook；service_role 保留執行權供整合測試直接驗證邏輯。
-- 避免 public 下的 security definer 函式被任意角色呼叫：revoke 掉預設 PUBLIC 授權。
grant execute on function public.before_user_created_hook to supabase_auth_admin, service_role;
revoke execute on function public.before_user_created_hook from authenticated, anon, public;
