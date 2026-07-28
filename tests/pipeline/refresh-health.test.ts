import { describe, it, expect, beforeEach } from 'vitest'
import { refreshServiceHealth } from '@/pipeline/refresh-health'
import { InMemoryStore } from '@/store/memory'
import type { ServiceRecord } from '@/store/contracts'

const now = new Date('2026-07-28T10:10:00.000Z')

const svc: ServiceRecord = {
  id: 's-1',
  name: 'svc-a',
  healthWindowMinutes: 15,
  healthFailureThreshold: 2,
  healthStatus: 'down', // 故意設一個過期狀態
  poll: null,
  discordWebhookUrl: null,
}

describe('refreshServiceHealth', () => {
  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc)
  })

  it('recomputes stale health back to healthy when no open issues', async () => {
    expect(await refreshServiceHealth(store, 's-1', now)).toBe('healthy')
    expect((await store.getService('s-1'))?.healthStatus).toBe('healthy')
  })

  it('keeps derived health when open issues exist', async () => {
    const { issue } = await store.upsertIssueWithEvent({
      serviceId: 's-1',
      source: 'push',
      level: 'error',
      errorType: 'X',
      message: 'x',
      fingerprint: 'fp',
      occurredAt: '2026-07-28T10:09:00.000Z',
      metadata: {},
    })
    await store.updateIssueTriage(issue.id, 'P1', [])
    expect(await refreshServiceHealth(store, 's-1', now)).toBe('degraded')
    expect((await store.getService('s-1'))?.healthStatus).toBe('degraded')
  })

  it('throws on unknown service', async () => {
    await expect(refreshServiceHealth(store, 'nope', now)).rejects.toThrow(/unknown service/)
  })
})
