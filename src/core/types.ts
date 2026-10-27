import type { DiagnosisCategory } from '@/core/heartbeat'
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
  severity?: Severity // 來源已判定的嚴重度（如 AI 診斷），有值時優先於規則引擎
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

/** Claude 對 issue 的判定紀錄。成功或失敗都寫，judgedAt 即「上次嘗試」時間。 */
export interface IssueAiTriage {
  severity: Severity | null // 失敗時 null
  category: DiagnosisCategory | null
  reason: string | null
  suggestion: string | null
  model: string | null
  judgedAt: string // ISO 8601
  error: string | null
}
