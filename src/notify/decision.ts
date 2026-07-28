import type { Severity } from '@/core/types'
import type { LatestNotification } from '@/store/contracts'

export const NOTIFY_MIN_SEVERITY: Severity = 'P1'
export const COOLDOWN_MINUTES = 30

const RANK: Record<Severity, number> = { P2: 0, P1: 1, P0: 2 }

export interface ShouldNotifyParams {
  severity: Severity
  duplicate: boolean
  lastSent: LatestNotification | null
  now: Date
  cooldownMinutes?: number
  minSeverity?: Severity
}

export type NotifyDecision =
  | { notify: false; reason: 'duplicate' | 'below_threshold' | 'cooldown' }
  | { notify: true; reason: 'first' | 'escalation' | 'cooldown_expired' }

export function shouldNotify(params: ShouldNotifyParams): NotifyDecision {
  const cooldownMs = (params.cooldownMinutes ?? COOLDOWN_MINUTES) * 60_000
  const minSeverity = params.minSeverity ?? NOTIFY_MIN_SEVERITY

  if (params.duplicate) return { notify: false, reason: 'duplicate' }
  if (RANK[params.severity] < RANK[minSeverity]) return { notify: false, reason: 'below_threshold' }
  if (params.lastSent === null) return { notify: true, reason: 'first' }
  if (RANK[params.severity] > RANK[params.lastSent.severity]) {
    return { notify: true, reason: 'escalation' }
  }
  const elapsed = params.now.getTime() - new Date(params.lastSent.sentAt).getTime()
  if (elapsed >= cooldownMs) return { notify: true, reason: 'cooldown_expired' }
  return { notify: false, reason: 'cooldown' }
}
