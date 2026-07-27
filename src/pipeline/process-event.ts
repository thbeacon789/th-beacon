import { evaluateSeverity } from '@/core/rules'
import { deriveHealth } from '@/core/health'
import type { CanonicalEvent, HealthStatus, Severity } from '@/core/types'
import type { Store, StoredIssue } from '@/store/contracts'

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
  const { severity, tags } = evaluateSeverity(issue, rules)

  let triaged = issue
  if (severity !== issue.severity || !sameTags(tags, issue.tags)) {
    await store.updateIssueTriage(issue.id, severity, tags)
    triaged = { ...issue, severity, tags }
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
