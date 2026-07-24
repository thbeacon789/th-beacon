import type { HealthStatus, Issue, Severity } from '@/core/types'

export interface PollState {
  lastPollAt: string | null
  healthy: boolean | null
  consecutiveFailures: number
}

export type OpenIssue = Pick<Issue, 'severity' | 'status' | 'lastSeen'>

export interface DeriveHealthParams {
  poll: PollState | null
  openIssues: OpenIssue[]
  now: Date
  windowMinutes: number
  failureThreshold: number
}

const RANK: Record<HealthStatus, number> = { healthy: 0, degraded: 1, down: 2 }
const SEVERITY_TO_HEALTH: Record<Severity, HealthStatus> = {
  P0: 'down',
  P1: 'degraded',
  P2: 'healthy',
}

function worst(a: HealthStatus, b: HealthStatus): HealthStatus {
  return RANK[a] >= RANK[b] ? a : b
}

export function deriveHealth(params: DeriveHealthParams): HealthStatus {
  const { poll, openIssues, now, windowMinutes, failureThreshold } = params

  const pollHealth: HealthStatus =
    poll && poll.healthy === false && poll.consecutiveFailures >= failureThreshold
      ? 'down'
      : 'healthy'

  const windowMs = windowMinutes * 60_000
  let issueHealth: HealthStatus = 'healthy'
  for (const issue of openIssues) {
    if (issue.status !== 'open' && issue.status !== 'acknowledged') continue
    const age = now.getTime() - new Date(issue.lastSeen).getTime()
    if (age > windowMs) continue
    issueHealth = worst(issueHealth, SEVERITY_TO_HEALTH[issue.severity])
  }

  return worst(pollHealth, issueHealth)
}
