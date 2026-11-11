'use client'

import { useEffect } from 'react'

const RETRY_INTERVAL_MS = 15_000

// 背景 router.refresh 偶發失敗（網路抖動、上游逾時）時，錯誤會停在這裡而不是炸掉 root layout，
// RealtimeRefresh 因此保持掛載。unstable_retry 會重新抓 RSC，成功就換回正常內容。
export default function ErrorBoundary({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string }
  unstable_retry: () => void
}) {
  useEffect(() => {
    const retryIfVisible = () => {
      if (document.visibilityState === 'visible') unstable_retry()
    }
    const timer = setInterval(retryIfVisible, RETRY_INTERVAL_MS)
    document.addEventListener('visibilitychange', retryIfVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', retryIfVisible)
    }
  }, [unstable_retry])

  return (
    <main>
      <div className="page-head">
        <h1>暫時無法載入</h1>
        <p className="hint" role="status">
          伺服器回應失敗，每 {RETRY_INTERVAL_MS / 1000} 秒自動重試。
        </p>
      </div>
      <button type="button" className="btn" onClick={() => unstable_retry()}>
        立即重試
      </button>
      {error.digest !== undefined && <p className="hint mono">ERROR {error.digest}</p>}
    </main>
  )
}
