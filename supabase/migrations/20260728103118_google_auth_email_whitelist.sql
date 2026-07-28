-- 登入白名單：只有名單內的 email 能建立帳號（Google OAuth 首次登入即 signup）。
-- 名單由管理員在 Studio / SQL 直接維護；RLS deny-by-default，僅 service_role 與
-- security definer hook 能讀。

create table public.allowed_emails (
  email text primary key check (email = lower(email)),
  note text,
  created_at timestamptz not null default now()
);

alter table public.allowed_emails enable row level security;

-- Before User Created hook：GoTrue 建立使用者前呼叫；回傳 {} 放行、{"error": ...} 拒絕。
-- security definer（owner postgres, bypassrls）才能在 deny-by-default RLS 下讀白名單表。
create or replace function public.before_user_created_hook(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(event -> 'user' ->> 'email');
begin
  if v_email is not null
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

-- 僅 GoTrue（supabase_auth_admin）可執行；避免 public 下的 security definer 函式被任意角色呼叫
grant execute on function public.before_user_created_hook to supabase_auth_admin;
revoke execute on function public.before_user_created_hook from authenticated, anon, public;
