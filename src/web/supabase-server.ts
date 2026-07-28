import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { createServerClient } from '@supabase/ssr'
import type { User } from '@supabase/supabase-js'

export async function createSessionClient() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            )
          } catch {
            // Server Component 內無法寫 cookie——由 middleware 負責刷新，安全忽略
          }
        },
      },
    },
  )
}

export async function requireUser(): Promise<User> {
  const supabase = await createSessionClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (user === null) redirect('/login')
  // 白名單複查（RLS 只允許讀自己那列）：被移出 allowed_emails 的帳號即刻失去頁面存取。
  // 完整撤權（含 Realtime）仍需刪除 auth.users 帳號，見部署清單的撤權 runbook。
  const { data: allowed } = await supabase.from('allowed_emails').select('email').limit(1)
  if (allowed === null || allowed.length === 0) {
    redirect(`/login?error=${encodeURIComponent('此帳號已不在白名單，請聯絡管理員')}`)
  }
  return user
}
