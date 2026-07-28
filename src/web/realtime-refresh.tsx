'use client'

import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { createBrowserSupabase } from '@/web/supabase-browser'

const DEBOUNCE_MS = 1500
const BACKSTOP_INTERVAL_MS = 60_000

export function RealtimeRefresh() {
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    if (pathname.startsWith('/login')) return

    // 事件風暴時 trailing debounce，避免每筆 issues 變更都整頁 refresh
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleRefresh = () => {
      if (debounceTimer !== null) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => router.refresh(), DEBOUNCE_MS)
    }

    const supabase = createBrowserSupabase()
    const channel = supabase
      .channel('issues-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'issues' }, scheduleRefresh)
      .subscribe()

    // services.health_status 不在 realtime publication（secrets 不出伺服器的取捨）；
    // 低頻 interval 當 backstop，涵蓋「燈號恢復但無 issues 變更」的路徑
    const backstop = setInterval(() => router.refresh(), BACKSTOP_INTERVAL_MS)

    return () => {
      if (debounceTimer !== null) clearTimeout(debounceTimer)
      clearInterval(backstop)
      void supabase.removeChannel(channel)
    }
  }, [router, pathname])

  return null
}
