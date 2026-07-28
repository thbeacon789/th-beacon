import type { CanonicalEvent, HealthStatus, Issue, Severity } from '@/core/types'
import type { TriageRule } from '@/core/rules'
import type { OpenIssue, PollState } from '@/core/health'

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

export interface Store {
  getService(serviceId: string): Promise<ServiceRecord | null>
  getServiceByName(name: string): Promise<ServiceAuth | null>
  upsertIssueWithEvent(event: CanonicalEvent): Promise<UpsertOutcome>
  loadRules(serviceId: string): Promise<TriageRule[]>
  updateIssueTriage(issueId: string, severity: Severity, tags: string[]): Promise<void>
  listOpenIssues(serviceId: string): Promise<OpenIssue[]>
  updateServiceHealth(serviceId: string, health: HealthStatus): Promise<void>
  listPollableServices(): Promise<PollableService[]>
  updatePollState(serviceId: string, state: PollStateUpdate): Promise<void>
  resolveHealthCheckIssue(serviceId: string): Promise<boolean>
}
