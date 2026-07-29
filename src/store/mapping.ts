import type { Database } from '@/db/database.types'
import type { EventSource, HealthStatus, IssueStatus, Severity } from '@/core/types'
import type { RuleMatch, TriageRule } from '@/core/rules'
import type { HeartbeatRunStatus } from '@/core/heartbeat'
import type { ServiceRecord, StoredIssue, PollConfig, StoredHeartbeat } from '@/store/contracts'

type IssueRow = Database['public']['Tables']['issues']['Row']
type ServiceRow = Database['public']['Tables']['services']['Row']
type RuleRow = Database['public']['Tables']['triage_rules']['Row']
type HeartbeatRow = Database['public']['Tables']['heartbeats']['Row']

const SEVERITIES: readonly Severity[] = ['P0', 'P1', 'P2']
const ISSUE_STATUSES: readonly IssueStatus[] = ['open', 'acknowledged', 'resolved', 'ignored']
const HEALTH_STATUSES: readonly HealthStatus[] = ['down', 'degraded', 'healthy']
const EVENT_SOURCES: readonly EventSource[] = ['push', 'poll']

function narrow<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T
  throw new Error(`invalid ${label}: ${value}`)
}

export const narrowSeverity = (v: string): Severity => narrow(v, SEVERITIES, 'severity')
export const narrowIssueStatus = (v: string): IssueStatus => narrow(v, ISSUE_STATUSES, 'issue status')
export const narrowHealthStatus = (v: string): HealthStatus => narrow(v, HEALTH_STATUSES, 'health status')
export const narrowEventSource = (v: string): EventSource => narrow(v, EVENT_SOURCES, 'event source')

export function rowToIssue(row: IssueRow): StoredIssue {
  return {
    id: row.id,
    serviceId: row.service_id,
    fingerprint: row.fingerprint,
    severity: narrowSeverity(row.severity),
    status: narrowIssueStatus(row.status),
    count: row.count,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    level: row.level,
    errorType: row.error_type,
    message: row.message,
    tags: row.tags,
  }
}

export function rowToService(row: ServiceRow): ServiceRecord {
  return {
    id: row.id,
    name: row.name,
    healthWindowMinutes: row.health_window_minutes,
    healthFailureThreshold: row.health_failure_threshold,
    healthStatus: narrowHealthStatus(row.health_status),
    discordWebhookUrl: row.discord_webhook_url,
    poll:
      row.poll_health_url === null
        ? null
        : {
            lastPollAt: row.last_poll_at,
            healthy: row.last_poll_healthy,
            consecutiveFailures: row.poll_consecutive_failures,
          },
  }
}

const MATCH_STRING_KEYS = ['level', 'errorType', 'messageIncludes'] as const
const MATCH_NUMBER_KEYS = ['minCountInWindow', 'windowMinutes'] as const

export function ruleRowToTriageRule(row: RuleRow): TriageRule {
  const raw = row.match
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`triage_rules.match must be a JSON object (rule ${row.id})`)
  }
  const source = raw as Record<string, unknown>
  const match: RuleMatch = {}
  for (const key of MATCH_STRING_KEYS) {
    const value = source[key]
    if (value !== undefined) {
      if (typeof value !== 'string') throw new Error(`match.${key} must be a string (rule ${row.id})`)
      match[key] = value
    }
  }
  for (const key of MATCH_NUMBER_KEYS) {
    const value = source[key]
    if (value !== undefined) {
      if (typeof value !== 'number') throw new Error(`match.${key} must be a number (rule ${row.id})`)
      match[key] = value
    }
  }
  // serviceId 的權威是 triage_rules.service_id 欄位（載入時查詢端過濾）；
  // jsonb 內出現 serviceId 一律忽略，避免雙重來源（Plan 2 review 驗收條件 #2）。
  return {
    id: row.id,
    priority: row.priority,
    severity: narrowSeverity(row.severity),
    tags: row.tags,
    match,
  }
}

export function rowToPollConfig(row: ServiceRow): PollConfig {
  return {
    healthUrl: row.poll_health_url,
    errorUrl: row.poll_error_url,
    intervalSeconds: row.poll_interval_seconds,
    timeoutMs: row.poll_timeout_ms,
    expectedStatus: row.poll_expected_status,
    cursor: row.poll_cursor,
  }
}

const RUN_STATUSES: readonly HeartbeatRunStatus[] = ['pass', 'fail']

export function rowToHeartbeat(row: HeartbeatRow): StoredHeartbeat {
  return {
    id: row.id,
    serviceId: row.service_id,
    name: row.name,
    intervalSeconds: row.interval_seconds,
    graceSeconds: row.grace_seconds,
    enabled: row.enabled,
    lastRunAt: row.last_run_at,
    lastSuccessAt: row.last_success_at,
    lastRunStatus:
      row.last_run_status === null
        ? null
        : narrow(row.last_run_status, RUN_STATUSES, 'heartbeat run status'),
    lastRunUrl: row.last_run_url,
    lastRunSummary: row.last_run_summary,
    createdAt: row.created_at,
  }
}
