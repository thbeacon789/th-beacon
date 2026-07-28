import { isHeartbeatOverdue, synthesizeHeartbeatMissedEvent } from '@/core/heartbeat'
import { processAndNotify } from '@/pipeline/process-and-notify'
import type { NotifyDeps } from '@/pipeline/process-and-notify'
import type { Severity } from '@/core/types'
import type { Store } from '@/store/contracts'

export interface HeartbeatScanOutcome {
  heartbeatId: string
  serviceId: string
  name: string
  issueId?: string
  severity?: Severity
  notified?: boolean
  error?: string
}

export async function runHeartbeatScan(
  store: Store,
  deps: NotifyDeps,
  now: Date,
): Promise<HeartbeatScanOutcome[]> {
  const heartbeats = await store.listEnabledHeartbeats()
  const overdue = heartbeats.filter((hb) => isHeartbeatOverdue(hb, now))
  const outcomes: HeartbeatScanOutcome[] = []

  for (const hb of overdue) {
    const base = { heartbeatId: hb.id, serviceId: hb.serviceId, name: hb.name }
    try {
      const event = synthesizeHeartbeatMissedEvent(hb.serviceId, hb, now)
      const result = await processAndNotify(store, deps, event, now)
      outcomes.push({
        ...base,
        issueId: result.issue.id,
        severity: result.issue.severity,
        notified: result.notified,
      })
    } catch (error) {
      // 單一心跳失敗不得中斷整輪：記為 outcome，繼續下一個（照 runPoll 做法）
      outcomes.push({
        ...base,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return outcomes
}
