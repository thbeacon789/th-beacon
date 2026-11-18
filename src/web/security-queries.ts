import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/db/database.types'
import { buildSecurityView, type SecurityView } from '@/core/security/view'
import { rowToSecurityScan } from '@/store/mapping'

type Client = SupabaseClient<Database>

export async function getSecurityView(client: Client, now: Date): Promise<SecurityView> {
  const servicesRes = await client.from('services').select('id, name')
  if (servicesRes.error) throw new Error(`資安查詢失敗：${servicesRes.error.message}`)

  const perService = await Promise.all(
    (servicesRes.data ?? []).map(async (svc) => {
      const res = await client
        .from('security_scans')
        .select('*')
        .eq('service_id', svc.id)
        .order('scanned_at', { ascending: false })
        .limit(1)
      if (res.error) throw new Error(`資安查詢失敗：${res.error.message}`)
      const row = res.data?.[0]
      return row ? { serviceName: svc.name, scan: rowToSecurityScan(row) } : null
    }),
  )

  return buildSecurityView(
    perService.filter((x): x is NonNullable<typeof x> => x !== null),
    now,
  )
}
