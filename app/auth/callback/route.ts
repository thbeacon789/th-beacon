import { NextResponse } from 'next/server'
import { createSessionClient } from '@/web/supabase-server'

// Google OAuth PKCE callback：以 code 換 session（cookie 由 route handler 寫入）。
// 白名單被拒或其他失敗時，GoTrue 會帶 error_description 導回來，轉交 /login 顯示。
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')

  if (code !== null) {
    const supabase = await createSessionClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (error === null) return NextResponse.redirect(`${origin}/`, 303)
  }

  const description = searchParams.get('error_description') ?? '登入失敗，請重試'
  return NextResponse.redirect(
    `${origin}/login?error=${encodeURIComponent(description)}`,
    303,
  )
}
