'use client'

import { useState } from 'react'
import { createBrowserSupabase } from '@/web/supabase-browser'

export function GoogleLoginButton() {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onClick() {
    setBusy(true)
    setError(null)
    const supabase = createBrowserSupabase()
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    })
    // 成功時瀏覽器會被導向 Google，不會走到這裡
    if (oauthError !== null) {
      setError('無法啟動 Google 登入，請重試')
      setBusy(false)
    }
  }

  return (
    <>
      <button type="button" onClick={onClick} disabled={busy}>
        {busy ? '前往 Google…' : '使用 Google 登入'}
      </button>
      {error !== null && <p className="error">{error}</p>}
    </>
  )
}
