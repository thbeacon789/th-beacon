import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryStore } from '@/store/memory'
import type { ServiceRecord } from '@/store/contracts'
import type { CanonicalEvent } from '@/core/types'

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
  occurredAt: '2026-07-27T10:00:00.000Z',
  metadata: {},
  ...over,
})

describe('InMemoryStore', () => {
  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc)
  })

  it('creates a new issue with defaults on first event', async () => {
    const { issue, created, duplicate } = await store.upsertIssueWithEvent(event())
    expect(created).toBe(true)
    expect(duplicate).toBe(false)
    expect(issue).toMatchObject({
      serviceId: 's-1',
      fingerprint: 'fp-1',
      severity: 'P2',
      status: 'open',
      count: 1,
      firstSeen: '2026-07-27T10:00:00.000Z',
      lastSeen: '2026-07-27T10:00:00.000Z',
      tags: [],
    })
  })

  it('increments count and advances lastSeen on same fingerprint', async () => {
    await store.upsertIssueWithEvent(event())
    const { issue, created } = await store.upsertIssueWithEvent(
      event({ occurredAt: '2026-07-27T10:05:00.000Z' }),
    )
    expect(created).toBe(false)
    expect(issue.count).toBe(2)
    expect(issue.lastSeen).toBe('2026-07-27T10:05:00.000Z')
    expect(issue.firstSeen).toBe('2026-07-27T10:00:00.000Z')
  })

  it('does not move lastSeen backwards for late-arriving events', async () => {
    await store.upsertIssueWithEvent(event({ occurredAt: '2026-07-27T10:05:00.000Z' }))
    const { issue } = await store.upsertIssueWithEvent(event({ occurredAt: '2026-07-27T10:01:00.000Z' }))
    expect(issue.count).toBe(2)
    expect(issue.lastSeen).toBe('2026-07-27T10:05:00.000Z')
  })

  it('dedupes by (serviceId, externalId): no count increment', async () => {
    const first = await store.upsertIssueWithEvent(event({ metadata: { externalId: 'x-1' } }))
    const second = await store.upsertIssueWithEvent(event({ metadata: { externalId: 'x-1' } }))
    expect(second.duplicate).toBe(true)
    expect(second.issue.id).toBe(first.issue.id)
    expect(second.issue.count).toBe(1)
  })

  it('never dedupes events without externalId', async () => {
    await store.upsertIssueWithEvent(event())
    const { issue, duplicate } = await store.upsertIssueWithEvent(event())
    expect(duplicate).toBe(false)
    expect(issue.count).toBe(2)
  })

  it('reopens a resolved issue on new event; ignored stays ignored', async () => {
    const { issue } = await store.upsertIssueWithEvent(event())
    store.setIssueStatus(issue.id, 'resolved')
    const reopened = await store.upsertIssueWithEvent(event())
    expect(reopened.issue.status).toBe('open')

    store.setIssueStatus(issue.id, 'ignored')
    const still = await store.upsertIssueWithEvent(event())
    expect(still.issue.status).toBe('ignored')
  })

  it('loadRules returns global + matching service rules only', async () => {
    const rule = (id: string) => ({ id, priority: 1, severity: 'P1' as const, match: {} })
    store.seedRule('s-1', rule('mine'))
    store.seedRule('s-2', rule('other'))
    store.seedRule(null, rule('global'))
    const rules = await store.loadRules('s-1')
    expect(rules.map((r) => r.id).sort()).toEqual(['global', 'mine'])
  })

  it('updateIssueTriage persists severity and tags', async () => {
    const { issue } = await store.upsertIssueWithEvent(event())
    await store.updateIssueTriage(issue.id, 'P0', ['db'])
    const open = await store.listOpenIssues('s-1')
    expect(open).toEqual([
      { severity: 'P0', status: 'open', lastSeen: '2026-07-27T10:00:00.000Z' },
    ])
  })

  it('listOpenIssues excludes resolved/ignored', async () => {
    const { issue } = await store.upsertIssueWithEvent(event())
    store.setIssueStatus(issue.id, 'resolved')
    expect(await store.listOpenIssues('s-1')).toEqual([])
  })

  it('updateServiceHealth + getService roundtrip', async () => {
    await store.updateServiceHealth('s-1', 'down')
    expect((await store.getService('s-1'))?.healthStatus).toBe('down')
    expect(await store.getService('nope')).toBeNull()
  })
})
