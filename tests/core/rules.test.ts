import { describe, it, expect } from 'vitest'
import { evaluateSeverity, type TriageRule, type IssueForEval } from '@/core/rules'

const issue = (over: Partial<IssueForEval> = {}): IssueForEval => ({
  serviceId: 'svc-a',
  level: 'error',
  errorType: 'TypeError',
  message: 'db connection lost',
  count: 1,
  firstSeen: '2026-07-23T10:00:00.000Z',
  lastSeen: '2026-07-23T10:00:30.000Z',
  ...over,
})

describe('evaluateSeverity', () => {
  it('defaults to P2 when no rule matches', () => {
    expect(evaluateSeverity(issue(), [])).toEqual({ severity: 'P2', tags: [] })
  })

  it('matches by errorType and returns severity + tags', () => {
    const rules: TriageRule[] = [
      { id: 'r1', priority: 10, severity: 'P0', tags: ['db'], match: { errorType: 'TypeError' } },
    ]
    expect(evaluateSeverity(issue(), rules)).toEqual({ severity: 'P0', tags: ['db'] })
  })

  it('honors priority: highest matching rule wins', () => {
    const rules: TriageRule[] = [
      { id: 'low', priority: 1, severity: 'P2', match: { serviceId: 'svc-a' } },
      { id: 'high', priority: 100, severity: 'P0', match: { serviceId: 'svc-a' } },
    ]
    expect(evaluateSeverity(issue(), rules).severity).toBe('P0')
  })

  it('matches messageIncludes case-insensitively', () => {
    const rules: TriageRule[] = [
      { id: 'r', priority: 5, severity: 'P1', match: { messageIncludes: 'CONNECTION LOST' } },
    ]
    expect(evaluateSeverity(issue(), rules).severity).toBe('P1')
  })

  it('frequency: matches when count >= minCountInWindow within windowMinutes', () => {
    const rules: TriageRule[] = [
      { id: 'freq', priority: 5, severity: 'P0', match: { minCountInWindow: 10, windowMinutes: 5 } },
    ]
    // 12 次、跨度 30 秒 → 命中
    expect(evaluateSeverity(issue({ count: 12 }), rules).severity).toBe('P0')
    // 12 次但跨度超過 5 分鐘 → 不命中 → 預設 P2
    const spread = issue({ count: 12, firstSeen: '2026-07-23T10:00:00.000Z', lastSeen: '2026-07-23T10:10:00.000Z' })
    expect(evaluateSeverity(spread, rules).severity).toBe('P2')
    // 次數不足 → 不命中
    expect(evaluateSeverity(issue({ count: 3 }), rules).severity).toBe('P2')
  })

  it('treats an empty match as a catch-all', () => {
    const rules: TriageRule[] = [
      { id: 'catch-all', priority: 1, severity: 'P1', match: {} },
    ]
    expect(evaluateSeverity(issue(), rules)).toEqual({ severity: 'P1', tags: [] })
  })
})
