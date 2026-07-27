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

export interface Store {
  getService(serviceId: string): Promise<ServiceRecord | null>
  getServiceByName(name: string): Promise<ServiceAuth | null>
  upsertIssueWithEvent(event: CanonicalEvent): Promise<UpsertOutcome>
  loadRules(serviceId: string): Promise<TriageRule[]>
  updateIssueTriage(issueId: string, severity: Severity, tags: string[]): Promise<void>
  listOpenIssues(serviceId: string): Promise<OpenIssue[]>
  updateServiceHealth(serviceId: string, health: HealthStatus): Promise<void>
}
