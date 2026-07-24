import type { Issue, Severity } from '@/core/types'

export interface RuleMatch {
  serviceId?: string
  level?: string
  errorType?: string
  messageIncludes?: string
  minCountInWindow?: number
  windowMinutes?: number
}

export interface TriageRule {
  id: string
  priority: number
  severity: Severity
  tags?: string[]
  match: RuleMatch
}

export type IssueForEval = Pick<
  Issue,
  'serviceId' | 'level' | 'errorType' | 'message' | 'count' | 'firstSeen' | 'lastSeen'
>

function matches(rule: TriageRule, issue: IssueForEval): boolean {
  const m = rule.match
  if (m.serviceId !== undefined && m.serviceId !== issue.serviceId) return false
  if (m.level !== undefined && m.level !== issue.level) return false
  if (m.errorType !== undefined && m.errorType !== issue.errorType) return false
  if (
    m.messageIncludes !== undefined &&
    !issue.message.toLowerCase().includes(m.messageIncludes.toLowerCase())
  ) {
    return false
  }
  if (m.minCountInWindow !== undefined) {
    if (issue.count < m.minCountInWindow) return false
    const windowMs = (m.windowMinutes ?? 60) * 60_000
    const spanMs = new Date(issue.lastSeen).getTime() - new Date(issue.firstSeen).getTime()
    if (spanMs > windowMs) return false
  }
  return true
}

export function evaluateSeverity(
  issue: IssueForEval,
  rules: TriageRule[],
): { severity: Severity; tags: string[] } {
  const ordered = [...rules].sort((a, b) => b.priority - a.priority)
  for (const rule of ordered) {
    if (matches(rule, issue)) {
      return { severity: rule.severity, tags: rule.tags ?? [] }
    }
  }
  return { severity: 'P2', tags: [] }
}
