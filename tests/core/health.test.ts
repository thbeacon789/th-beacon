import { describe, it, expect } from 'vitest'
import { deriveHealth, type PollState, type OpenIssue } from '@/core/health'

const now = new Date('2026-07-23T10:10:00.000Z')
const recent = '2026-07-23T10:09:00.000Z' // 1 分鐘前
const old = '2026-07-23T09:00:00.000Z' // 70 分鐘前

const healthyPoll: PollState = { lastPollAt: recent, healthy: true, consecutiveFailures: 0 }
const failingPoll: PollState = { lastPollAt: recent, healthy: false, consecutiveFailures: 2 }

const base = { now, windowMinutes: 15, failureThreshold: 2 }

describe('deriveHealth', () => {
  it('is healthy with no issues and healthy poll', () => {
    expect(deriveHealth({ ...base, poll: healthyPoll, openIssues: [] })).toBe('healthy')
  })

  it('is down when poll fails past the threshold, regardless of issues', () => {
    expect(deriveHealth({ ...base, poll: failingPoll, openIssues: [] })).toBe('down')
  })

  it('does not go down when failures are below threshold', () => {
    const poll: PollState = { lastPollAt: recent, healthy: false, consecutiveFailures: 1 }
    expect(deriveHealth({ ...base, poll, openIssues: [] })).toBe('healthy')
  })

  it('is degraded on an open P1 within the window', () => {
    const issues: OpenIssue[] = [{ severity: 'P1', status: 'open', lastSeen: recent }]
    expect(deriveHealth({ ...base, poll: healthyPoll, openIssues: issues })).toBe('degraded')
  })

  it('is down on an open P0 even when poll is healthy (take worst)', () => {
    const issues: OpenIssue[] = [{ severity: 'P0', status: 'open', lastSeen: recent }]
    expect(deriveHealth({ ...base, poll: healthyPoll, openIssues: issues })).toBe('down')
  })

  it('ignores resolved/ignored issues and issues outside the window', () => {
    const issues: OpenIssue[] = [
      { severity: 'P0', status: 'resolved', lastSeen: recent },
      { severity: 'P0', status: 'open', lastSeen: old },
    ]
    expect(deriveHealth({ ...base, poll: healthyPoll, openIssues: issues })).toBe('healthy')
  })

  it('falls back to issue-only derivation when poll is null', () => {
    const issues: OpenIssue[] = [{ severity: 'P1', status: 'acknowledged', lastSeen: recent }]
    expect(deriveHealth({ ...base, poll: null, openIssues: issues })).toBe('degraded')
  })
})
