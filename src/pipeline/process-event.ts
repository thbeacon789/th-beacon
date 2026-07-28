import { evaluateSeverity } from '@/core/rules'
import { deriveHealth } from '@/core/health'
import type { CanonicalEvent, HealthStatus, Severity } from '@/core/types'
import type { Store, StoredIssue } from '@/store/contracts'

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

  const { issue, created, duplicate } = await store.upsertIssueWithEvent(event)
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
  const rules = await store.loadRules(event.serviceId)
  const { severity: evaluated, tags } = evaluateSeverity(issue, rules)

  // Ratchet（已拍板）：severity 只升不降——頻率規則超窗回落時維持歷史最嚴重值，
  // 避免 P0↔P2 震盪讓「升級才追發」的通知洗版。未升級時 tags 一併凍結。
  const escalated = SEVERITY_RANK[evaluated] > SEVERITY_RANK[issue.severity]
  let triaged = issue
  if (escalated) {
    await store.updateIssueTriage(issue.id, evaluated, tags)
    triaged = { ...issue, severity: evaluated, tags }
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
