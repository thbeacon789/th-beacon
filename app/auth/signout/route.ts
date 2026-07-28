import { NextResponse } from 'next/server'
import { createSessionClient } from '@/web/supabase-server'

export async function POST(request: Request): Promise<Response> {
  const supabase = await createSessionClient()
  await supabase.auth.signOut()
  return NextResponse.redirect(new URL('/login', request.url), { status: 303 })
}
