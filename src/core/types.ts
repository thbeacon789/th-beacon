export type Severity = 'P0' | 'P1' | 'P2'
export type HealthStatus = 'down' | 'degraded' | 'healthy'
export type IssueStatus = 'open' | 'acknowledged' | 'resolved' | 'ignored'
export type EventSource = 'push' | 'poll'

export interface CanonicalEvent {
  serviceId: string
  source: EventSource
  level: string
  errorType: string
  message: string
  fingerprint: string
  occurredAt: string // ISO 8601
  metadata: Record<string, unknown>
}

export interface Issue {
  fingerprint: string
  serviceId: string
  severity: Severity
  status: IssueStatus
  count: number
  firstSeen: string // ISO 8601
  lastSeen: string // ISO 8601
  level: string
  errorType: string
  message: string
  tags: string[]
}
