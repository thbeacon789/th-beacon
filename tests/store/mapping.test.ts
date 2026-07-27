import { describe, it, expect } from 'vitest'
import {
  narrowSeverity,
  narrowIssueStatus,
  narrowHealthStatus,
  narrowEventSource,
  rowToIssue,
  rowToService,
  ruleRowToTriageRule,
} from '@/store/mapping'
import type { Database } from '@/db/database.types'

type IssueRow = Database['public']['Tables']['issues']['Row']
type ServiceRow = Database['public']['Tables']['services']['Row']
type RuleRow = Database['public']['Tables']['triage_rules']['Row']

const issueRow: IssueRow = {
  id: 'i-1',
  service_id: 's-1',
  fingerprint: 'fp',
  severity: 'P1',
  status: 'acknowledged',
  count: 3,
  first_seen: '2026-07-27T10:00:00+00:00',
  last_seen: '2026-07-27T10:05:00+00:00',
  level: 'error',
  error_type: 'TypeError',
  message: 'boom',
  tags: ['db'],
  created_at: '2026-07-27T10:00:00+00:00',
  updated_at: '2026-07-27T10:05:00+00:00',
}

const serviceRow: ServiceRow = {
  id: 's-1',
  name: 'svc-a',
  webhook_secret: null,
  discord_webhook_url: null,
  health_window_minutes: 15,
  health_failure_threshold: 2,
  poll_health_url: 'https://a/health',
  poll_error_url: null,
  poll_interval_seconds: 60,
  poll_timeout_ms: 5000,
  poll_expected_status: 200,
  poll_cursor: null,
  poll_consecutive_failures: 1,
  last_poll_at: '2026-07-27T10:04:00+00:00',
  last_poll_healthy: false,
  health_status: 'degraded',
  created_at: '2026-07-27T09:00:00+00:00',
  updated_at: '2026-07-27T10:04:00+00:00',
}

const ruleRow: RuleRow = {
  id: 'r-1',
  service_id: 's-1',
  priority: 10,
  severity: 'P0',
  tags: ['db'],
  match: { errorType: 'TypeError', minCountInWindow: 5, serviceId: 'SHOULD-BE-IGNORED' },
  enabled: true,
  created_at: '2026-07-27T09:00:00+00:00',
}

describe('narrow validators', () => {
  it('pass through valid values and throw on invalid', () => {
    expect(narrowSeverity('P0')).toBe('P0')
    expect(narrowIssueStatus('resolved')).toBe('resolved')
    expect(narrowHealthStatus('down')).toBe('down')
    expect(narrowEventSource('poll')).toBe('poll')
    expect(() => narrowSeverity('P9')).toThrow(/invalid severity/)
    expect(() => narrowIssueStatus('closed')).toThrow(/invalid issue status/)
    expect(() => narrowHealthStatus('ok')).toThrow(/invalid health status/)
    expect(() => narrowEventSource('sentry')).toThrow(/invalid event source/)
  })
})

describe('rowToIssue', () => {
  it('maps snake_case row to StoredIssue with narrowed unions', () => {
    expect(rowToIssue(issueRow)).toEqual({
      id: 'i-1',
      serviceId: 's-1',
      fingerprint: 'fp',
      severity: 'P1',
      status: 'acknowledged',
      count: 3,
      firstSeen: '2026-07-27T10:00:00+00:00',
      lastSeen: '2026-07-27T10:05:00+00:00',
      level: 'error',
      errorType: 'TypeError',
      message: 'boom',
      tags: ['db'],
    })
  })

  it('throws on invalid severity in row', () => {
    expect(() => rowToIssue({ ...issueRow, severity: 'P9' })).toThrow(/invalid severity/)
  })
})

describe('rowToService', () => {
  it('maps poll state when poll_health_url is configured', () => {
    expect(rowToService(serviceRow)).toEqual({
      id: 's-1',
      name: 'svc-a',
      healthWindowMinutes: 15,
      healthFailureThreshold: 2,
      healthStatus: 'degraded',
      poll: { lastPollAt: '2026-07-27T10:04:00+00:00', healthy: false, consecutiveFailures: 1 },
    })
  })

  it('maps poll to null when health polling is not configured', () => {
    expect(rowToService({ ...serviceRow, poll_health_url: null }).poll).toBeNull()
  })
})

describe('ruleRowToTriageRule', () => {
  it('maps columns and validated match, ignoring any serviceId inside jsonb', () => {
    const rule = ruleRowToTriageRule(ruleRow)
    expect(rule).toEqual({
      id: 'r-1',
      priority: 10,
      severity: 'P0',
      tags: ['db'],
      match: { errorType: 'TypeError', minCountInWindow: 5 },
    })
    expect('serviceId' in rule.match).toBe(false)
  })

  it('rejects non-object match', () => {
    expect(() => ruleRowToTriageRule({ ...ruleRow, match: 'nope' })).toThrow(/must be a JSON object/)
    expect(() => ruleRowToTriageRule({ ...ruleRow, match: [1] })).toThrow(/must be a JSON object/)
  })

  it('rejects wrongly-typed match fields', () => {
    expect(() => ruleRowToTriageRule({ ...ruleRow, match: { errorType: 7 } })).toThrow(/match\.errorType/)
    expect(() => ruleRowToTriageRule({ ...ruleRow, match: { windowMinutes: 'x' } })).toThrow(/match\.windowMinutes/)
  })
})
