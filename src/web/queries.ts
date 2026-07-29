import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/db/database.types'
import type { EventSource, HealthStatus, IssueStatus, Severity } from '@/core/types'
import type { StoredIssue } from '@/store/contracts'
import {
  narrowEventSource,
  narrowHealthStatus,
  narrowIssueStatus,
  narrowSeverity,
  rowToIssue,
  rowToHeartbeat,
} from '@/store/mapping'
import { isHeartbeatOverdue, isSafeRunUrl, type HeartbeatRunStatus } from '@/core/heartbeat'
import { worst } from '@/core/health'

type Client = SupabaseClient<Database>

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

export interface HeartbeatSummary {
  name: string
  overdue: boolean
  lastRunAt: string | null
  lastSuccessAt: string | null
  lastRunStatus: HeartbeatRunStatus | null
  lastRunUrl: string | null
}

export interface ServiceOverview {
  id: string
  name: string
  healthStatus: HealthStatus
  openCounts: Record<Severity, number>
  heartbeats: HeartbeatSummary[]
}

// 純函式：15 分鐘健康度視窗一過，services.health_status 會轉回 healthy，
// 但心跳逾期本身就是「服務可能出事」的訊號（spec §7）。有逾期時燈號不能低於 degraded。
export function applyHeartbeatOverdue(
  healthStatus: HealthStatus,
  heartbeats: Array<Pick<HeartbeatSummary, 'overdue'>>,
): HealthStatus {
  const hasOverdue = heartbeats.some((hb) => hb.overdue)
  return hasOverdue ? worst(healthStatus, 'degraded') : healthStatus
}

export interface HealthSummary {
  /** 0–100，healthy=100 / degraded=50 / down=0 的平均；無服務時視為 100 */
  score: number
  /** 燈號沿用「取最差」語意：一個 down 就是 down，不因其他服務正常而被平均掉 */
  worst: HealthStatus
  counts: Record<HealthStatus, number>
  total: number
}

const HEALTH_POINTS: Record<HealthStatus, number> = { healthy: 100, degraded: 50, down: 0 }

// 純函式：總體健康度。score 供指針位置用（看得出「多少比例出事」），
// worst 供文字與顏色用（監控情境不能讓一台掛掉被平均成綠燈）。
export function summarizeHealth(
  services: Array<Pick<ServiceOverview, 'healthStatus'>>,
): HealthSummary {
  const counts: Record<HealthStatus, number> = { healthy: 0, degraded: 0, down: 0 }
  for (const service of services) counts[service.healthStatus] += 1

  const total = services.length
  const score =
    total === 0
      ? 100
      : Math.round(
          services.reduce((sum, s) => sum + HEALTH_POINTS[s.healthStatus], 0) / total,
        )
  const worst: HealthStatus =
    counts.down > 0 ? 'down' : counts.degraded > 0 ? 'degraded' : 'healthy'

  return { score, worst, counts, total }
}

export async function getServicesOverview(client: Client, now: Date): Promise<ServiceOverview[]> {
  const { data: services, error } = await client
    .from('services')
    .select('id,name,health_status')
    .order('name')
  if (error) throw new Error(`getServicesOverview failed: ${error.message}`)

  const { data: openIssues, error: issueError } = await client
    .from('issues')
    .select('service_id,severity')
    .in('status', ['open', 'acknowledged'])
  if (issueError) throw new Error(`getServicesOverview issues failed: ${issueError.message}`)

  const { data: heartbeatRows, error: hbError } = await client
    .from('heartbeats')
    .select('*')
    .eq('enabled', true)
    .order('name')
  if (hbError) throw new Error(`getServicesOverview heartbeats failed: ${hbError.message}`)

  return services.map((service) => {
    const openCounts: Record<Severity, number> = { P0: 0, P1: 0, P2: 0 }
    for (const issue of openIssues.filter((i) => i.service_id === service.id)) {
      openCounts[narrowSeverity(issue.severity)] += 1
    }
    // 逾期狀態即時推導：Hobby cron 一天一次，health_status 欄位不足以反映心跳狀態
    const heartbeats = heartbeatRows
      .filter((row) => row.service_id === service.id)
      .map((row) => {
        const hb = rowToHeartbeat(row)
        return {
          name: hb.name,
          overdue: isHeartbeatOverdue(hb, now),
          lastRunAt: hb.lastRunAt,
          lastSuccessAt: hb.lastSuccessAt,
          lastRunStatus: hb.lastRunStatus,
          // 讀取端也要擋：DB 可能存有修正前寫入、或繞過 API 直接改 DB 的髒資料
          lastRunUrl: isSafeRunUrl(hb.lastRunUrl) ? hb.lastRunUrl : null,
        }
      })
    return {
      id: service.id,
      name: service.name,
      // 有逾期心跳就把顯示燈號取最差（spec §7），別讓過期 health_status 蓋掉真相
      healthStatus: applyHeartbeatOverdue(narrowHealthStatus(service.health_status), heartbeats),
      openCounts,
      heartbeats,
    }
  })
}

export interface IssueListItem {
  id: string
  serviceName: string
  severity: Severity
  status: IssueStatus
  count: number
  lastSeen: string
  errorType: string
  message: string
}

export interface IssueListFilters {
  serviceId?: string
  severity?: Severity
  status?: IssueStatus
}

// searchParams 是不受信輸入：非法值視為未篩選（而非 throw 讓整頁 500）
export function parseIssueFilters(
  params: Record<string, string | string[] | undefined>,
): IssueListFilters {
  const filters: IssueListFilters = {}
  if (typeof params.serviceId === 'string' && params.serviceId !== '') {
    filters.serviceId = params.serviceId
  }
  if (typeof params.severity === 'string' && params.severity !== '') {
    try {
      filters.severity = narrowSeverity(params.severity)
    } catch {
      // ignore invalid
    }
  }
  if (typeof params.status === 'string' && params.status !== '') {
    try {
      filters.status = narrowIssueStatus(params.status)
    } catch {
      // ignore invalid
    }
  }
  return filters
}

export async function listIssues(client: Client, filters: IssueListFilters): Promise<IssueListItem[]> {
  let query = client
    .from('issues')
    .select('id,severity,status,count,last_seen,error_type,message,services(name)')
    .order('last_seen', { ascending: false })
    .limit(100)
  if (filters.serviceId !== undefined) query = query.eq('service_id', filters.serviceId)
  if (filters.severity !== undefined) query = query.eq('severity', filters.severity)
  if (filters.status !== undefined) query = query.eq('status', filters.status)

  const { data, error } = await query
  if (error) throw new Error(`listIssues failed: ${error.message}`)
  return data.map((row) => ({
    id: row.id,
    serviceName: row.services?.name ?? '(unknown)',
    severity: narrowSeverity(row.severity),
    status: narrowIssueStatus(row.status),
    count: row.count,
    lastSeen: row.last_seen,
    errorType: row.error_type,
    message: row.message,
  }))
}

export interface IssueDetail {
  issue: StoredIssue
  serviceName: string
  events: Array<{
    id: string
    source: EventSource
    level: string
    message: string
    occurredAt: string
    metadata: unknown
  }>
}

export async function getIssueDetail(client: Client, issueId: string): Promise<IssueDetail | null> {
  if (!isUuid(issueId)) return null
  const { data: issueRow, error } = await client
    .from('issues')
    .select('*,services(name)')
    .eq('id', issueId)
    .maybeSingle()
  if (error) throw new Error(`getIssueDetail failed: ${error.message}`)
  if (issueRow === null) return null

  const { data: events, error: eventsError } = await client
    .from('events')
    .select('id,source,level,message,occurred_at,metadata')
    .eq('issue_id', issueId)
    .order('occurred_at', { ascending: false })
    .limit(50)
  if (eventsError) throw new Error(`getIssueDetail events failed: ${eventsError.message}`)

  const { services, ...bareIssue } = issueRow
  return {
    issue: rowToIssue(bareIssue),
    serviceName: services?.name ?? '(unknown)',
    events: events.map((event) => ({
      id: event.id,
      source: narrowEventSource(event.source),
      level: event.level,
      message: event.message,
      occurredAt: event.occurred_at,
      metadata: event.metadata,
    })),
  }
}

// event metadata 是外部輸入：只接受 http(s) 連結，避免渲染任意 scheme
// 驗證規則與 isSafeRunUrl（@/core/heartbeat）共用，勿另開一套較寬鬆的檢查。
export function extractRunUrl(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null
  const value = (metadata as Record<string, unknown>).runUrl
  return isSafeRunUrl(value) ? value : null
}
