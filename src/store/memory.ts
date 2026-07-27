import type { CanonicalEvent, HealthStatus, IssueStatus, Severity } from '@/core/types'
import type { TriageRule } from '@/core/rules'
import type { OpenIssue } from '@/core/health'
import type { ServiceRecord, Store, StoredIssue, UpsertOutcome } from '@/store/contracts'

interface SeededRule {
  serviceId: string | null
  rule: TriageRule
}

export class InMemoryStore implements Store {
  private services = new Map<string, ServiceRecord>()
  private issues = new Map<string, StoredIssue>() // key: `${serviceId}:${fingerprint}`
  private dedup = new Map<string, string>() // key: `${serviceId}:${externalId}` → issueId
  private rules: SeededRule[] = []
  private nextId = 1

  seedService(service: ServiceRecord): void {
    this.services.set(service.id, service)
  }

  seedRule(serviceId: string | null, rule: TriageRule): void {
    this.rules.push({ serviceId, rule })
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

  async upsertIssueWithEvent(event: CanonicalEvent): Promise<UpsertOutcome> {
    const externalId =
      typeof event.metadata.externalId === 'string' ? event.metadata.externalId : null

    if (externalId !== null) {
      const issueId = this.dedup.get(`${event.serviceId}:${externalId}`)
      if (issueId !== undefined) {
        const issue = this.findIssueById(issueId)
        return { issue: this.defensiveCopy(issue), created: false, duplicate: true }
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
      }
      created = true
    } else {
      issue = {
        ...existing,
        count: existing.count + 1,
        lastSeen:
          new Date(existing.lastSeen) >= new Date(event.occurredAt)
            ? existing.lastSeen
            : event.occurredAt,
        // 取最後到達（與 SQL upsert 的 excluded.level 一致）
        level: event.level,
        status: existing.status === 'resolved' ? 'open' : existing.status,
      }
    }

    this.issues.set(key, issue)
    if (externalId !== null) this.dedup.set(`${event.serviceId}:${externalId}`, issue.id)
    return { issue: this.defensiveCopy(issue), created, duplicate: false }
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
      .map((i) => ({ severity: i.severity, status: i.status, lastSeen: i.lastSeen }))
  }

  async updateServiceHealth(serviceId: string, health: HealthStatus): Promise<void> {
    const service = this.services.get(serviceId)
    if (service === undefined) throw new Error(`unknown service: ${serviceId}`)
    this.services.set(serviceId, { ...service, healthStatus: health })
  }

  private defensiveCopy(issue: StoredIssue): StoredIssue {
    return { ...issue, tags: [...issue.tags] }
  }

  private findIssueById(issueId: string): StoredIssue {
    for (const issue of this.issues.values()) {
      if (issue.id === issueId) return issue
    }
    throw new Error(`inconsistent store: dedup entry without issue ${issueId}`)
  }
}
