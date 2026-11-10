import type { CanonicalEvent, HealthStatus, IssueStatus, Severity } from '@/core/types'
import type { TriageRule } from '@/core/rules'
import type { OpenIssue } from '@/core/health'
import type { ServiceRecord, ServiceAuth, Store, StoredIssue, UpsertOutcome, PollConfig, PollableService, PollStateUpdate, LatestNotification, NotificationRecord, StoredHeartbeat, HeartbeatRun, RegisteredService, NewHeartbeat, IssueAiTriage, IncidentRoot } from '@/store/contracts'

interface SeededRule {
  serviceId: string | null
  rule: TriageRule
}

export class InMemoryStore implements Store {
  private services = new Map<string, ServiceRecord>()
  private issues = new Map<string, StoredIssue>() // key: `${serviceId}:${fingerprint}`
  private dedup = new Map<string, string>() // key: `${serviceId}:${externalId}` → issueId
  private rules: SeededRule[] = []
  private secrets = new Map<string, string | null>() // serviceId → webhookSecret
  private pollConfigs = new Map<string, PollConfig>()
  private lastPollAts = new Map<string, string>()
  private notifications: NotificationRecord[] = []
  private heartbeats: StoredHeartbeat[] = []
  private createdAts = new Map<string, string>() // serviceId → created_at（僅登記頁需要）
  private nextId = 1

  seedHeartbeat(serviceId: string, hb: Omit<StoredHeartbeat, 'serviceId'>): void {
    this.heartbeats.push({ ...hb, serviceId })
  }

  seedService(service: ServiceRecord, webhookSecret: string | null = null): void {
    this.services.set(service.id, service)
    this.secrets.set(service.id, webhookSecret)
  }

  seedRule(serviceId: string | null, rule: TriageRule): void {
    this.rules.push({ serviceId, rule })
  }

  seedPollConfig(serviceId: string, config: PollConfig): void {
    this.pollConfigs.set(serviceId, { ...config })
  }

  setIssueStatus(issueId: string, status: IssueStatus): void {
    for (const [key, issue] of this.issues) {
      if (issue.id === issueId) {
        this.issues.set(key, { ...issue, status })
        return
      }
    }
    throw new Error(`unknown issue: ${issueId}`)
  }

  async getService(serviceId: string): Promise<ServiceRecord | null> {
    const service = this.services.get(serviceId)
    if (service === undefined) return null
    return { ...service, poll: service.poll ? { ...service.poll } : null }
  }

  async getServiceByName(name: string): Promise<ServiceAuth | null> {
    for (const service of this.services.values()) {
      if (service.name === name) {
        return {
          service: { ...service, poll: service.poll ? { ...service.poll } : null },
          webhookSecret: this.secrets.get(service.id) ?? null,
        }
      }
    }
    return null
  }

  async upsertIssueWithEvent(event: CanonicalEvent): Promise<UpsertOutcome> {
    const externalId =
      typeof event.metadata.externalId === 'string' ? event.metadata.externalId : null

    if (externalId !== null) {
      const issueId = this.dedup.get(`${event.serviceId}:${externalId}`)
      if (issueId !== undefined) {
        const issue = this.findIssueById(issueId)
        return { issue: this.defensiveCopy(issue), created: false, duplicate: true, reopened: false }
      }
    }

    const key = `${event.serviceId}:${event.fingerprint}`
    const existing = this.issues.get(key)
    let issue: StoredIssue
    let created = false

    if (existing === undefined) {
      issue = {
        id: `issue-${this.nextId++}`,
        serviceId: event.serviceId,
        fingerprint: event.fingerprint,
        severity: 'P2',
        status: 'open',
        count: 1,
        firstSeen: event.occurredAt,
        lastSeen: event.occurredAt,
        level: event.level,
        errorType: event.errorType,
        message: event.message,
        tags: [],
        ai: null,
        acknowledgedAt: null,
        acknowledgedBy: null,
        resolvedAt: null,
        resolvedBy: null,
        reopenCount: 0,
        incidentFirstSeen: event.occurredAt,
        incidentCount: 1,
      }
      created = true
    } else {
      const reopening = existing.status === 'resolved'
      issue = {
        ...existing,
        count: existing.count + 1,
        lastSeen:
          new Date(existing.lastSeen) >= new Date(event.occurredAt)
            ? existing.lastSeen
            : event.occurredAt,
        // 取最後到達（與 SQL upsert 的 excluded.level 一致）
        level: event.level,
        status: reopening ? 'open' : existing.status,
        // 鏡像 rpc：resolved→open 開新事故並清空確認／解決紀錄
        ...(reopening
          ? {
              reopenCount: existing.reopenCount + 1,
              incidentFirstSeen: event.occurredAt,
              incidentCount: 1,
              acknowledgedAt: null,
              acknowledgedBy: null,
              resolvedAt: null,
              resolvedBy: null,
            }
          : { incidentCount: existing.incidentCount + 1 }),
      }
    }

    this.issues.set(key, issue)
    if (externalId !== null) this.dedup.set(`${event.serviceId}:${externalId}`, issue.id)
    return {
      issue: this.defensiveCopy(issue),
      created,
      duplicate: false,
      reopened: existing?.status === 'resolved',
    }
  }

  async loadRules(serviceId: string): Promise<TriageRule[]> {
    return this.rules
      .filter((r) => r.serviceId === null || r.serviceId === serviceId)
      .map((r) => r.rule)
  }

  async updateIssueTriage(issueId: string, severity: Severity, tags: string[]): Promise<void> {
    for (const [key, issue] of this.issues) {
      if (issue.id === issueId) {
        this.issues.set(key, { ...issue, severity, tags })
        return
      }
    }
    throw new Error(`unknown issue: ${issueId}`)
  }

  async listOpenIssues(serviceId: string): Promise<OpenIssue[]> {
    return [...this.issues.values()]
      .filter(
        (i) =>
          i.serviceId === serviceId && (i.status === 'open' || i.status === 'acknowledged'),
      )
      .map((i) => ({
        severity: i.severity,
        status: i.status,
        lastSeen: i.lastSeen,
        errorType: i.errorType,
      }))
  }

  async listRecentIssues(
    serviceId: string,
    sinceIso: string,
  ): Promise<Array<{ severity: Severity; status: IssueStatus; firstSeen: string; lastSeen: string }>> {
    const since = new Date(sinceIso).getTime()
    return [...this.issues.values()]
      .filter((i) => i.serviceId === serviceId && new Date(i.lastSeen).getTime() >= since)
      .map((i) => ({ severity: i.severity, status: i.status, firstSeen: i.firstSeen, lastSeen: i.lastSeen }))
  }

  async updateServiceHealth(serviceId: string, health: HealthStatus): Promise<void> {
    const service = this.services.get(serviceId)
    if (service === undefined) throw new Error(`unknown service: ${serviceId}`)
    this.services.set(serviceId, { ...service, healthStatus: health })
  }

  async listPollableServices(): Promise<PollableService[]> {
    const result: PollableService[] = []
    for (const [serviceId, config] of this.pollConfigs) {
      const service = this.services.get(serviceId)
      if (service === undefined) continue
      if (config.healthUrl === null && config.errorUrl === null) continue
      result.push({
        service: { ...service, poll: service.poll ? { ...service.poll } : null },
        config: { ...config },
        lastPollAt: this.lastPollAts.get(serviceId) ?? null,
      })
    }
    return result
  }

  async updatePollState(serviceId: string, state: PollStateUpdate): Promise<void> {
    const service = this.services.get(serviceId)
    if (service === undefined) throw new Error(`unknown service: ${serviceId}`)
    this.lastPollAts.set(serviceId, state.lastPollAt)
    const config = this.pollConfigs.get(serviceId)
    if (state.cursor !== undefined && config !== undefined) {
      this.pollConfigs.set(serviceId, { ...config, cursor: state.cursor })
    }
    if (config?.healthUrl != null) {
      this.services.set(serviceId, {
        ...service,
        poll: {
          lastPollAt: state.lastPollAt,
          healthy: state.healthy,
          consecutiveFailures: state.consecutiveFailures,
        },
      })
    }
  }

  async getLatestSentNotification(
    serviceId: string,
    fingerprint: string,
    incidentSeq: number,
  ): Promise<LatestNotification | null> {
    const sent = this.notifications
      .filter(
        (n) =>
          n.serviceId === serviceId &&
          n.fingerprint === fingerprint &&
          n.incidentSeq === incidentSeq &&
          (n.kind === 'alert' || n.kind === 'count_edit') &&
          n.status === 'sent',
      )
      .sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime())
    return sent.length === 0 ? null : { severity: sent[0].severity, sentAt: sent[0].sentAt }
  }

  async getIncidentRoot(issueId: string, incidentSeq: number): Promise<IncidentRoot | null> {
    const roots = this.notifications
      .filter(
        (n) =>
          n.issueId === issueId &&
          n.incidentSeq === incidentSeq &&
          n.kind === 'alert' &&
          n.status === 'sent' &&
          n.discordMessageId !== null,
      )
      .sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime())
    const root = roots[0]
    if (root === undefined || root.discordMessageId === null || root.payload === null) return null
    return {
      channelId: root.discordChannelId ?? '',
      messageId: root.discordMessageId,
      payload: root.payload,
    }
  }

  async transitionIssueStatus(
    issueId: string,
    to: IssueStatus,
    allowedFrom: readonly IssueStatus[],
    actor: string | null,
    nowIso: string,
  ): Promise<{ issue: StoredIssue; changed: boolean } | null> {
    for (const [key, issue] of this.issues) {
      if (issue.id !== issueId) continue
      if (!allowedFrom.includes(issue.status)) {
        return { issue: this.defensiveCopy(issue), changed: false }
      }
      const updated: StoredIssue = { ...issue, status: to }
      if (to === 'acknowledged') {
        updated.acknowledgedAt = nowIso
        updated.acknowledgedBy = actor
      } else if (to === 'resolved') {
        updated.resolvedAt = nowIso
        updated.resolvedBy = actor
      } else if (to === 'open') {
        updated.acknowledgedAt = null
        updated.acknowledgedBy = null
        updated.resolvedAt = null
        updated.resolvedBy = null
      }
      this.issues.set(key, updated)
      return { issue: this.defensiveCopy(updated), changed: true }
    }
    return null
  }

  async findActiveIssueIds(
    serviceId: string,
    match: { fingerprint: string } | { errorType: 'health_check_failed' },
  ): Promise<string[]> {
    return [...this.issues.values()]
      .filter(
        (i) =>
          i.serviceId === serviceId &&
          (i.status === 'open' || i.status === 'acknowledged') &&
          ('fingerprint' in match
            ? i.fingerprint === match.fingerprint
            : i.errorType === match.errorType),
      )
      .map((i) => i.id)
  }

  /** 測試用：目前記錄的全部通知 */
  listNotifications(): NotificationRecord[] {
    return this.notifications.map((n) => ({ ...n }))
  }

  async recordNotification(record: NotificationRecord): Promise<void> {
    this.notifications.push({ ...record })
  }

  async listEnabledHeartbeats(): Promise<StoredHeartbeat[]> {
    return this.heartbeats.filter((h) => h.enabled).map((h) => ({ ...h }))
  }

  async recordHeartbeatRun(
    serviceId: string,
    name: string,
    run: HeartbeatRun,
  ): Promise<StoredHeartbeat | null> {
    const index = this.heartbeats.findIndex((h) => h.serviceId === serviceId && h.name === name)
    if (index === -1) return null
    const current = this.heartbeats[index]
    const updated: StoredHeartbeat = {
      ...current,
      lastRunAt: run.at,
      lastRunStatus: run.status,
      lastRunUrl: run.runUrl,
      lastRunSummary: run.summary,
      // pass 才推進 last_success_at；fail 保留舊值
      lastSuccessAt: run.status === 'pass' ? run.at : current.lastSuccessAt,
    }
    this.heartbeats[index] = updated
    return { ...updated }
  }

  // ---- 後台登記 ----

  async createService(
    name: string,
    webhookSecret: string,
    description: string | null,
    ownerDiscordId: string | null = null,
  ): Promise<ServiceRecord | null> {
    for (const existing of this.services.values()) {
      if (existing.name === name) return null
    }
    const service: ServiceRecord = {
      id: `service-${this.nextId++}`,
      name,
      healthWindowMinutes: 15,
      healthFailureThreshold: 2,
      healthStatus: 'healthy',
      poll: null,
      discordWebhookUrl: null,
      description,
      ownerDiscordId,
    }
    this.services.set(service.id, service)
    this.secrets.set(service.id, webhookSecret)
    this.createdAts.set(service.id, new Date(0).toISOString())
    return { ...service }
  }

  async createHeartbeat(
    serviceId: string,
    heartbeat: NewHeartbeat,
  ): Promise<StoredHeartbeat | null> {
    if (this.heartbeats.some((h) => h.serviceId === serviceId && h.name === heartbeat.name)) {
      return null
    }
    const created: StoredHeartbeat = {
      id: `heartbeat-${this.nextId++}`,
      serviceId,
      name: heartbeat.name,
      intervalSeconds: heartbeat.intervalSeconds,
      graceSeconds: heartbeat.graceSeconds,
      enabled: true,
      lastRunAt: null,
      lastSuccessAt: null,
      lastRunStatus: null,
      lastRunUrl: null,
      lastRunSummary: null,
      createdAt: new Date(0).toISOString(),
    }
    this.heartbeats.push(created)
    return { ...created }
  }

  async updateServiceDescription(serviceId: string, description: string | null): Promise<boolean> {
    const service = this.services.get(serviceId)
    if (service === undefined) return false
    this.services.set(serviceId, { ...service, description })
    return true
  }

  async updateServiceOwner(serviceId: string, ownerDiscordId: string | null): Promise<boolean> {
    const service = this.services.get(serviceId)
    if (service === undefined) return false
    this.services.set(serviceId, { ...service, ownerDiscordId })
    return true
  }

  async recordIssueAiTriage(issueId: string, triage: IssueAiTriage): Promise<void> {
    for (const [key, issue] of this.issues) {
      if (issue.id === issueId) {
        this.issues.set(key, { ...issue, ai: { ...triage } })
        return
      }
    }
    throw new Error(`unknown issue: ${issueId}`)
  }

  async rotateWebhookSecret(serviceId: string, webhookSecret: string): Promise<boolean> {
    if (!this.services.has(serviceId)) return false
    this.secrets.set(serviceId, webhookSecret)
    return true
  }

  async listRegisteredServices(): Promise<RegisteredService[]> {
    return [...this.services.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((service) => ({
        id: service.id,
        name: service.name,
        hasWebhookSecret: (this.secrets.get(service.id) ?? null) !== null,
        description: service.description,
        ownerDiscordId: service.ownerDiscordId,
        createdAt: this.createdAts.get(service.id) ?? new Date(0).toISOString(),
        heartbeats: this.heartbeats
          .filter((h) => h.serviceId === service.id)
          .map((h) => ({ ...h }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      }))
  }

  private defensiveCopy(issue: StoredIssue): StoredIssue {
    return { ...issue, tags: [...issue.tags], ai: issue.ai === null ? null : { ...issue.ai } }
  }

  private findIssueById(issueId: string): StoredIssue {
    for (const issue of this.issues.values()) {
      if (issue.id === issueId) return issue
    }
    throw new Error(`inconsistent store: dedup entry without issue ${issueId}`)
  }
}
