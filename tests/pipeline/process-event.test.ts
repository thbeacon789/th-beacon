import { describe, it, expect, beforeEach } from 'vitest'
import { processEvent } from '@/pipeline/process-event'
import { InMemoryStore } from '@/store/memory'
import type { ServiceRecord } from '@/store/contracts'
import type { CanonicalEvent } from '@/core/types'

const now = new Date('2026-07-27T10:10:00.000Z')

const svc: ServiceRecord = {
  id: 's-1',
  name: 'svc-a',
  healthWindowMinutes: 15,
  healthFailureThreshold: 2,
  healthStatus: 'healthy',
  poll: null,
}

const event = (over: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  serviceId: 's-1',
  source: 'push',
  level: 'error',
  errorType: 'TypeError',
  message: 'boom',
  fingerprint: 'fp-1',
  occurredAt: '2026-07-27T10:09:00.000Z',
  metadata: {},
  ...over,
})

describe('processEvent', () => {
  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc)
  })

  it('throws on unknown service', async () => {
    await expect(processEvent(store, event({ serviceId: 'nope' }), now)).rejects.toThrow(
      /unknown service/,
    )
  })

  it('new event with no rules: P2 issue, service stays healthy', async () => {
    const result = await processEvent(store, event(), now)
    expect(result.created).toBe(true)
    expect(result.previousSeverity).toBeNull()
    expect(result.issue.severity).toBe('P2')
    expect(result.health).toBe('healthy')
    expect((await store.getService('s-1'))?.healthStatus).toBe('healthy')
  })

  it('P0 rule drives severity, tags and service health to down (persisted)', async () => {
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P0', tags: ['crit'], match: {} })
    const result = await processEvent(store, event(), now)
    expect(result.issue.severity).toBe('P0')
    expect(result.issue.tags).toEqual(['crit'])
    expect(result.health).toBe('down')
    expect((await store.getService('s-1'))?.healthStatus).toBe('down')
  })

  it('escalation is visible via previousSeverity', async () => {
    await processEvent(store, event(), now) // P2
    store.seedRule(null, {
      id: 'freq',
      priority: 10,
      severity: 'P0',
      match: { minCountInWindow: 2, windowMinutes: 60 },
    })
    const result = await processEvent(store, event({ occurredAt: '2026-07-27T10:09:30.000Z' }), now)
    expect(result.previousSeverity).toBe('P2')
    expect(result.issue.severity).toBe('P0')
    expect(result.issue.count).toBe(2)
  })

  it('duplicate externalId short-circuits: no triage, no health recompute', async () => {
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P0', match: {} })
    await processEvent(store, event({ source: 'poll', metadata: { externalId: 'x' } }), now)
    // 讓 service 健康度回到 healthy，若 duplicate 有重算就會再變 down
    await store.updateServiceHealth('s-1', 'healthy')
    const result = await processEvent(
      store,
      event({ source: 'poll', metadata: { externalId: 'x' } }),
      now,
    )
    expect(result.duplicate).toBe(true)
    expect(result.issue.count).toBe(1)
    expect(result.health).toBe('healthy')
    expect((await store.getService('s-1'))?.healthStatus).toBe('healthy')
  })

  it('poll-failing service is down regardless of issue severity (take worst)', async () => {
    store.seedService({
      ...svc,
      id: 's-2',
      poll: { lastPollAt: '2026-07-27T10:09:00.000Z', healthy: false, consecutiveFailures: 2 },
    })
    const result = await processEvent(store, event({ serviceId: 's-2' }), now)
    expect(result.health).toBe('down')
  })

  it('ratchet: severity never demotes when rules stop matching', async () => {
    // 頻率規則：1 分鐘窗內 >=2 次 → P0
    store.seedRule(null, {
      id: 'freq',
      priority: 10,
      severity: 'P0',
      tags: ['burst'],
      match: { minCountInWindow: 2, windowMinutes: 1 },
    })
    await processEvent(store, event({ occurredAt: '2026-07-28T10:00:00.000Z' }), now)
    const second = await processEvent(store, event({ occurredAt: '2026-07-28T10:00:30.000Z' }), now)
    expect(second.issue.severity).toBe('P0')

    // 第三次事件把 lastSeen-firstSeen 撐超過 1 分鐘窗 → 規則不再命中（evaluated P2）
    const third = await processEvent(store, event({ occurredAt: '2026-07-28T10:05:00.000Z' }), now)
    expect(third.issue.severity).toBe('P0') // 不降級
    expect(third.issue.tags).toEqual(['burst']) // tags 凍結
    expect(third.previousSeverity).toBe('P0')
    const open = await store.listOpenIssues('s-1')
    expect(open[0].severity).toBe('P0') // 持久化也未降
  })

  it('ratchet: created issue still gets initial tags for a P2 rule', async () => {
    store.seedRule(null, { id: 'tagger', priority: 1, severity: 'P2', tags: ['noise'], match: {} })
    const result = await processEvent(store, event(), now)
    expect(result.issue.severity).toBe('P2')
    expect(result.issue.tags).toEqual(['noise'])
  })
})
