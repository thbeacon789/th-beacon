'use client'

import { useEffect, useState } from 'react'
import { createBrowserSupabase } from '@/web/supabase-browser'

export function GoogleLoginButton() {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 從 Google 按返回鍵回來時，bfcache 會還原 busy=true 的畫面，按鈕卡死——pageshow 時重置
  useEffect(() => {
    const onPageShow = () => setBusy(false)
    window.addEventListener('pageshow', onPageShow)
    return () => window.removeEventListener('pageshow', onPageShow)
  }, [])

  async function onClick() {
    setBusy(true)
    setError(null)
    try {
      const supabase = createBrowserSupabase()
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: `${window.location.origin}/auth/callback` },
      })
      // 成功時瀏覽器會被導向 Google，不會走到這裡
      if (oauthError !== null) throw oauthError
    } catch {
      setError('無法啟動 Google 登入，請重試')
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn-cta google-login"
        onClick={onClick}
        disabled={busy}
        aria-busy={busy}
      >
        {busy ? 'Loading…' : 'Google Login'}
      </button>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  )
}
