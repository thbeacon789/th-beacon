import type { CanonicalEvent, HealthStatus, Issue, IssueAiTriage, IssueStatus, Severity } from '@/core/types'
import type { TriageRule } from '@/core/rules'
import type { OpenIssue, PollState } from '@/core/health'
import type { DiscordMessage } from '@/notify/message'
import type { HeartbeatDefinition, HeartbeatRunStatus } from '@/core/heartbeat'

export type { IssueAiTriage }

export interface StoredIssue extends Issue {
  id: string
  ai: IssueAiTriage | null
  acknowledgedAt: string | null
  acknowledgedBy: string | null
  resolvedAt: string | null
  resolvedBy: string | null
  reopenCount: number
  incidentFirstSeen: string
  incidentCount: number
}

export interface ServiceRecord {
  id: string
  name: string
  healthWindowMinutes: number
  healthFailureThreshold: number
  healthStatus: HealthStatus
  poll: PollState | null
  discordWebhookUrl: string | null
  description: string | null
  ownerDiscordId: string | null
}

export interface ServiceAuth {
  service: ServiceRecord
  webhookSecret: string | null
}

export interface UpsertOutcome {
  issue: StoredIssue
  created: boolean
  duplicate: boolean
  reopened: boolean
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

export type NotificationKind = 'alert' | 'count_edit' | 'resolve_reply'

export interface NotificationRecord {
  issueId: string
  serviceId: string
  fingerprint: string
  severity: Severity
  status: 'sent' | 'failed'
  countAtSend: number
  sentAt: string
  kind: NotificationKind
  incidentSeq: number
  discordChannelId: string | null
  discordMessageId: string | null
  payload: DiscordMessage | null
}

export interface IncidentRoot {
  channelId: string
  messageId: string
  payload: DiscordMessage
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

/** 後台登記頁的服務檢視。不含 webhook_secret 明文——金鑰只在產生的當下回傳一次。 */
export interface RegisteredService {
  id: string
  name: string
  hasWebhookSecret: boolean
  description: string | null
  ownerDiscordId: string | null
  createdAt: string
  heartbeats: StoredHeartbeat[]
}

export interface NewHeartbeat {
  name: string
  intervalSeconds: number
  graceSeconds: number
}

export interface Store {
  getService(serviceId: string): Promise<ServiceRecord | null>
  getServiceByName(name: string): Promise<ServiceAuth | null>
  upsertIssueWithEvent(event: CanonicalEvent): Promise<UpsertOutcome>
  loadRules(serviceId: string): Promise<TriageRule[]>
  updateIssueTriage(issueId: string, severity: Severity, tags: string[]): Promise<void>
  updateIssueStatus(issueId: string, status: IssueStatus): Promise<StoredIssue>
  listOpenIssues(serviceId: string): Promise<OpenIssue[]>
  // 該服務 lastSeen >= sinceIso 的所有 issue（任何狀態），供 AI 判級的統計用。
  listRecentIssues(
    serviceId: string,
    sinceIso: string,
  ): Promise<Array<{ severity: Severity; status: IssueStatus; firstSeen: string; lastSeen: string }>>
  updateServiceHealth(serviceId: string, health: HealthStatus): Promise<void>
  listPollableServices(): Promise<PollableService[]>
  updatePollState(serviceId: string, state: PollStateUpdate): Promise<void>
  resolveHealthCheckIssue(serviceId: string): Promise<boolean>
  getLatestSentNotification(
    serviceId: string,
    fingerprint: string,
    incidentSeq: number,
  ): Promise<LatestNotification | null>
  /** 該 issue、該事故序號中 sent_at 最早、kind='alert'、status='sent' 且有 messageId 的通知 */
  getIncidentRoot(issueId: string, incidentSeq: number): Promise<IncidentRoot | null>
  /**
   * 單一條件式轉換（where status in allowedFrom）。issue 不存在回 null；
   * 存在但現況不在 allowedFrom 回 { issue: 現況, changed: false }。
   */
  transitionIssueStatus(
    issueId: string,
    to: IssueStatus,
    allowedFrom: readonly IssueStatus[],
    actor: string | null,
    nowIso: string,
  ): Promise<{ issue: StoredIssue; changed: boolean } | null>
  findActiveIssueIds(
    serviceId: string,
    match: { fingerprint: string } | { errorType: 'health_check_failed' },
  ): Promise<string[]>
  recordNotification(record: NotificationRecord): Promise<void>
  listEnabledHeartbeats(): Promise<StoredHeartbeat[]>
  recordHeartbeatRun(serviceId: string, name: string, run: HeartbeatRun): Promise<StoredHeartbeat | null>
  resolveIssueByFingerprint(serviceId: string, fingerprint: string): Promise<boolean>
  recordIssueAiTriage(issueId: string, triage: IssueAiTriage): Promise<void>

  // ---- 後台登記（Plan 9）：唯一寫入路徑是登入後的 server action ----
  /** 名稱已存在時回 null（unique 違反由 DB 判定，不做 check-then-insert 競態） */
  createService(
    name: string,
    webhookSecret: string,
    description: string | null,
    ownerDiscordId?: string | null,
  ): Promise<ServiceRecord | null>
  /** 服務不存在時回 false */
  updateServiceDescription(serviceId: string, description: string | null): Promise<boolean>
  /** 設定／清除（null）負責人。服務不存在時回 false */
  updateServiceOwner(serviceId: string, ownerDiscordId: string | null): Promise<boolean>
  /** 同服務下名稱已存在時回 null */
  createHeartbeat(serviceId: string, heartbeat: NewHeartbeat): Promise<StoredHeartbeat | null>
  /** 服務不存在時回 false */
  rotateWebhookSecret(serviceId: string, webhookSecret: string): Promise<boolean>
  listRegisteredServices(): Promise<RegisteredService[]>
}
