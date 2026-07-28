import { refreshServiceHealth } from '@/pipeline/refresh-health'
import type { HealthStatus, IssueStatus } from '@/core/types'
import type { Store, StoredIssue } from '@/store/contracts'

export async function changeIssueStatus(
  store: Store,
  issueId: string,
  status: IssueStatus,
  now: Date,
): Promise<{ issue: StoredIssue; health: HealthStatus }> {
  const issue = await store.updateIssueStatus(issueId, status)
  // 狀態變更直接影響健康度推導（resolve P0 → 燈號恢復），必須立即重算
  const health = await refreshServiceHealth(store, issue.serviceId, now)
  return { issue, health }
}
