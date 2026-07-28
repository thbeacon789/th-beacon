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
} from '@/store/mapping'

type Client = SupabaseClient<Database>

export interface ServiceOverview {
  id: string
  name: string
  healthStatus: HealthStatus
  openCounts: Record<Severity, number>
}

export async function getServicesOverview(client: Client): Promise<ServiceOverview[]> {
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

  return services.map((service) => {
    const openCounts: Record<Severity, number> = { P0: 0, P1: 0, P2: 0 }
    for (const issue of openIssues.filter((i) => i.service_id === service.id)) {
      openCounts[narrowSeverity(issue.severity)] += 1
    }
    return {
      id: service.id,
      name: service.name,
      healthStatus: narrowHealthStatus(service.health_status),
      openCounts,
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
