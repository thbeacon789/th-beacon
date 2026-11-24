import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/db/database.types'
import { buildSecurityView, type SecurityView } from '@/core/security/view'
import { rowToSecurityScan, rowToSecurityFinding } from '@/store/mapping'
import type { SecurityFindingRecord, SecurityFindingStatus } from '@/core/security/findings'
import { RESOLVED_LIST_LIMIT } from '@/core/security/constants'

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

export interface FindingListItem extends SecurityFindingRecord {
  serviceName: string
}

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const
const STATUSES: readonly SecurityFindingStatus[] = ['open', 'resolved', 'ignored']

/** 三個 head count ＋ 一次列表（含服務名 join），共四個查詢 */
export async function getSecurityFindings(
  client: Client,
  tab: SecurityFindingStatus,
): Promise<{ items: FindingListItem[]; counts: Record<SecurityFindingStatus, number> }> {
  let listQuery = client.from('security_findings').select('*, services(name)').eq('status', tab)
  if (tab === 'open') listQuery = listQuery.order('last_seen_at', { ascending: false })
  else listQuery = listQuery.order('status_changed_at', { ascending: false })
  if (tab === 'resolved') listQuery = listQuery.limit(RESOLVED_LIST_LIMIT)

  const [listRes, ...countRes] = await Promise.all([
    listQuery,
    ...STATUSES.map((st) => client.from('security_findings').select('id', { count: 'exact', head: true }).eq('status', st)),
  ])
  if (listRes.error) throw new Error(`資安發現查詢失敗：${listRes.error.message}`)
  const counts = { open: 0, resolved: 0, ignored: 0 }
  STATUSES.forEach((st, i) => {
    const r = countRes[i]
    if (r.error) throw new Error(`資安發現計數失敗：${r.error.message}`)
    counts[st] = r.count ?? 0
  })

  const items: FindingListItem[] = (listRes.data ?? []).map(({ services, ...row }) => ({
    ...rowToSecurityFinding(row),
    serviceName: services?.name ?? '（未知服務）',
  }))
  // open：severity 優先，同級維持 lastSeenAt desc（Array.sort 為穩定排序）
  if (tab === 'open') items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
  return { items, counts }
}
