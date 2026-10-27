import { evaluateSeverity } from '@/core/rules'
import { deriveHealth } from '@/core/health'
import { resolveSeverity } from '@/core/ai-triage'
import type { CanonicalEvent, HealthStatus, Severity } from '@/core/types'
import type { ServiceRecord, Store, StoredIssue, UpsertOutcome } from '@/store/contracts'

const SEVERITY_RANK: Record<Severity, number> = { P2: 0, P1: 1, P0: 2 }

export interface ProcessResult {
  issue: StoredIssue
  created: boolean
  duplicate: boolean
  previousSeverity: Severity | null
  health: HealthStatus
}

export async function processEvent(
  store: Store,
  event: CanonicalEvent,
  now: Date,
): Promise<ProcessResult> {
  const service = await store.getService(event.serviceId)
  if (service === null) throw new Error(`unknown service: ${event.serviceId}`)
  const upsert = await store.upsertIssueWithEvent(event)
  return applyTriage(store, service, event, upsert, null, now)
}

/**
 * upsert 之後的判級＋健康度。`ai` 為本 event 採用的 AI 等級（null = 無 AI，純規則）。
 * - event 自帶 severity（CI 判讀）：取代規則表、套 ratchet（維持既有行為，不套 reset）。
 * - 其餘：resolveSeverity；新建／reopened 用 reset（允許降級），否則 ratchet。
 */
export async function applyTriage(
  store: Store,
  service: ServiceRecord,
  event: CanonicalEvent,
  upsert: UpsertOutcome,
  ai: Severity | null,
  now: Date,
): Promise<ProcessResult> {
  const { issue, created, duplicate, reopened } = upsert
  if (duplicate) {
    return {
      issue,
      created: false,
      duplicate: true,
      previousSeverity: issue.severity,
      health: service.healthStatus,
    }
  }

  const previousSeverity = created ? null : issue.severity
  let final: Severity
  let tags: string[]
  if (event.severity) {
    // Ratchet（已拍板）：severity 只升不降——避免 P0↔P2 震盪讓「升級才追發」的通知洗版。
    final = SEVERITY_RANK[event.severity] > SEVERITY_RANK[issue.severity] ? event.severity : issue.severity
    tags = issue.tags
  } else {
    const rule = evaluateSeverity(issue, await store.loadRules(event.serviceId))
    final = resolveSeverity({
      current: issue.severity,
      ai,
      rule: rule.severity,
      errorType: issue.errorType,
      mode: created || reopened ? 'reset' : 'ratchet',
    })
    tags = rule.tags
  }

  let triaged = issue
  if (final !== issue.severity) {
    await store.updateIssueTriage(issue.id, final, tags)
    triaged = { ...issue, severity: final, tags }
  } else if (created && !sameTags(tags, issue.tags)) {
    await store.updateIssueTriage(issue.id, issue.severity, tags)
    triaged = { ...issue, tags }
  }

  const openIssues = await store.listOpenIssues(event.serviceId)
  const health = deriveHealth({
    poll: service.poll,
    openIssues,
    now,
    windowMinutes: service.healthWindowMinutes,
    failureThreshold: service.healthFailureThreshold,
  })
  if (health !== service.healthStatus) {
    await store.updateServiceHealth(event.serviceId, health)
  }

  return { issue: triaged, created, duplicate: false, previousSeverity, health }
}

function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((tag, index) => tag === b[index])
}
