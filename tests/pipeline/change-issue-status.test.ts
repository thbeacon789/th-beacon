import { describe, it, expect, beforeEach } from 'vitest'
import { changeIssueStatus } from '@/pipeline/change-issue-status'
import { processEvent } from '@/pipeline/process-event'
import { InMemoryStore } from '@/store/memory'
import type { ServiceRecord } from '@/store/contracts'
import type { CanonicalEvent } from '@/core/types'

const now = new Date('2026-07-28T10:10:00.000Z')

const svc: ServiceRecord = {
  id: 's-1',
  name: 'svc-a',
  healthWindowMinutes: 15,
  healthFailureThreshold: 2,
  healthStatus: 'healthy',
  poll: null,
  discordWebhookUrl: null,
}

const event: CanonicalEvent = {
  serviceId: 's-1',
  source: 'push',
  level: 'error',
  errorType: 'X',
  message: 'x',
  fingerprint: 'fp',
  occurredAt: '2026-07-28T10:09:00.000Z',
  metadata: {},
}

describe('changeIssueStatus', () => {
  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc)
  })

  it('resolving the only P0 issue recovers service health', async () => {
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P0', match: {} })
    const processed = await processEvent(store, event, now)
    expect((await store.getService('s-1'))?.healthStatus).toBe('down')

    const result = await changeIssueStatus(store, processed.issue.id, 'resolved', now)
    expect(result.issue.status).toBe('resolved')
    expect(result.health).toBe('healthy')
    expect((await store.getService('s-1'))?.healthStatus).toBe('healthy')
  })

  it('acknowledged keeps counting toward health; ignored does not', async () => {
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P1', match: {} })
    const processed = await processEvent(store, event, now)
    const acked = await changeIssueStatus(store, processed.issue.id, 'acknowledged', now)
    expect(acked.health).toBe('degraded')
    const ignored = await changeIssueStatus(store, processed.issue.id, 'ignored', now)
    expect(ignored.health).toBe('healthy')
  })

  it('throws on unknown issue', async () => {
    await expect(changeIssueStatus(store, 'nope', 'resolved', now)).rejects.toThrow(/unknown issue/)
  })
})
