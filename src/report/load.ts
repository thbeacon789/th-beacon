import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/db/database.types'
import { reportWindow, type WeeklyReportInput } from '@/core/weekly-report'
import { getServicesOverview } from '@/web/queries'
import { getSecurityView } from '@/web/security-queries'
import { rowToSecurityFinding, narrowSeverity, narrowIssueStatus } from '@/store/mapping'

/** 讀取週報所需的全部資料（唯讀）；任一查詢失敗即 throw */
export async function loadWeeklyReportInput(
  client: SupabaseClient<Database>,
  now: Date,
): Promise<WeeklyReportInput> {
  const { start, end } = reportWindow(now)
  const startIso = start.toISOString()
  const endIso = end.toISOString()

  const [overview, securityView, issuesRes, eventsRes, notifRes, findingsRes] = await Promise.all([
    getServicesOverview(client, now),
    getSecurityView(client, now),
    client
      .from('issues')
      .select(
        'id,service_id,severity,status,message,count,first_seen,last_seen,resolved_at,acknowledged_by,reopen_count,incident_first_seen',
      )
      .or(
        `status.in.(open,acknowledged),first_seen.gte.${startIso},last_seen.gte.${startIso},resolved_at.gte.${startIso}`,
      ),
    client
      .from('events')
      .select('service_id,occurred_at')
      .eq('error_type', 'health_check_failed')
      .gte('occurred_at', startIso)
      .lt('occurred_at', endIso),
    client
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'sent')
      .gte('sent_at', startIso)
      .lt('sent_at', endIso),
    client
      .from('security_findings')
      .select('*')
      .neq('status', 'ignored')
      .or(`status.eq.open,last_seen_at.gte.${startIso}`),
  ])
  if (issuesRes.error) throw new Error(`週報 issues 查詢失敗：${issuesRes.error.message}`)
  if (eventsRes.error) throw new Error(`週報 events 查詢失敗：${eventsRes.error.message}`)
  if (notifRes.error) throw new Error(`週報 notifications 查詢失敗：${notifRes.error.message}`)
  if (findingsRes.error) throw new Error(`週報 security_findings 查詢失敗：${findingsRes.error.message}`)

  return {
    now,
    services: overview.map((s) => ({
      id: s.id,
      name: s.name,
      healthStatus: s.healthStatus,
      openCounts: s.openCounts,
    })),
    issues: (issuesRes.data ?? []).map((r) => ({
      id: r.id,
      serviceId: r.service_id,
      severity: narrowSeverity(r.severity),
      status: narrowIssueStatus(r.status),
      message: r.message,
      count: r.count,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      resolvedAt: r.resolved_at,
      acknowledgedBy: r.acknowledged_by,
      reopenCount: r.reopen_count,
      incidentFirstSeen: r.incident_first_seen,
    })),
    healthFailEvents: (eventsRes.data ?? []).map((r) => ({ serviceId: r.service_id, occurredAt: r.occurred_at })),
    alertsSent: notifRes.count ?? 0,
    securityRows: securityView.rows.map((r) => ({ serviceId: r.serviceId, overall: r.overall, stale: r.stale })),
    securityFindings: (findingsRes.data ?? []).map((row) => {
      const f = rowToSecurityFinding(row)
      return {
        serviceId: f.serviceId,
        severity: f.severity,
        status: f.status,
        firstSeenAt: f.firstSeenAt,
        lastSeenAt: f.lastSeenAt,
        reopenCount: f.reopenCount,
        statusChangedAt: f.statusChangedAt ?? null,
        statusChangedBy: f.statusChangedBy ?? null,
      }
    }),
  }
}
