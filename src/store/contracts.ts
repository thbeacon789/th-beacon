import type { CanonicalEvent, HealthStatus, Issue, IssueStatus, Severity } from '@/core/types'
import type { TriageRule } from '@/core/rules'
import type { OpenIssue, PollState } from '@/core/health'
import type { HeartbeatDefinition, HeartbeatRunStatus } from '@/core/heartbeat'

export interface StoredIssue extends Issue {
  id: string
}

export interface ServiceRecord {
  id: string
  name: string
  healthWindowMinutes: number
  healthFailureThreshold: number
  healthStatus: HealthStatus
  poll: PollState | null
  discordWebhookUrl: string | null
}

export interface ServiceAuth {
  service: ServiceRecord
  webhookSecret: string | null
}

export interface UpsertOutcome {
  issue: StoredIssue
  created: boolean
  duplicate: boolean
}

export interface PollConfig {
  healthUrl: string | null
  errorUrl: string | null
  intervalSeconds: number | null
  timeoutMs: number
  expectedStatus: number
  cursor: string | null
}

export interface PollableService {
  service: ServiceRecord
  config: PollConfig
  lastPollAt: string | null
}

export interface PollStateUpdate {
  lastPollAt: string
  healthy: boolean | null
  consecutiveFailures: number
  cursor?: string
}

export interface LatestNotification {
  severity: Severity
  sentAt: string
}

export interface NotificationRecord {
  issueId: string
  serviceId: string
  fingerprint: string
  severity: Severity
  status: 'sent' | 'failed'
  countAtSend: number
  sentAt: string
}

export interface StoredHeartbeat extends HeartbeatDefinition {
  id: string
  serviceId: string
  enabled: boolean
  lastSuccessAt: string | null
  lastRunStatus: HeartbeatRunStatus | null
  lastRunUrl: string | null
  lastRunSummary: string | null
}

export interface HeartbeatRun {
  status: HeartbeatRunStatus
  runUrl: string | null
  // pass 與 fail 都存——成功摘要（含耗時）是效能退化的早期信號
  summary: string | null
  at: string // ISO 8601
}

export interface Store {
  getService(serviceId: string): Promise<ServiceRecord | null>
  getServiceByName(name: string): Promise<ServiceAuth | null>
  upsertIssueWithEvent(event: CanonicalEvent): Promise<UpsertOutcome>
  loadRules(serviceId: string): Promise<TriageRule[]>
  updateIssueTriage(issueId: string, severity: Severity, tags: string[]): Promise<void>
  updateIssueStatus(issueId: string, status: IssueStatus): Promise<StoredIssue>
  listOpenIssues(serviceId: string): Promise<OpenIssue[]>
  updateServiceHealth(serviceId: string, health: HealthStatus): Promise<void>
  listPollableServices(): Promise<PollableService[]>
  updatePollState(serviceId: string, state: PollStateUpdate): Promise<void>
  resolveHealthCheckIssue(serviceId: string): Promise<boolean>
  getLatestSentNotification(serviceId: string, fingerprint: string): Promise<LatestNotification | null>
  recordNotification(record: NotificationRecord): Promise<void>
  listEnabledHeartbeats(): Promise<StoredHeartbeat[]>
  recordHeartbeatRun(serviceId: string, name: string, run: HeartbeatRun): Promise<StoredHeartbeat | null>
  resolveIssueByFingerprint(serviceId: string, fingerprint: string): Promise<boolean>
}
