'use client'

import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { createBrowserSupabase } from '@/web/supabase-browser'

export function RealtimeRefresh() {
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    if (pathname.startsWith('/login')) return
    const supabase = createBrowserSupabase()
    const channel = supabase
      .channel('issues-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'issues' }, () => {
        router.refresh()
      })
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [router, pathname])

  return null
}
