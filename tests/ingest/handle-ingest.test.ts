import { describe, it, expect, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { handleIngest } from '@/ingest/handle-ingest'
import { InMemoryStore } from '@/store/memory'
import type { ServiceRecord } from '@/store/contracts'

const now = new Date('2026-07-28T10:00:00.000Z')
const nowSec = String(Math.floor(now.getTime() / 1000))
const secret = 'svc-secret'

const svc: ServiceRecord = {
  id: 's-1',
  name: 'svc-a',
  healthWindowMinutes: 15,
  healthFailureThreshold: 2,
  healthStatus: 'healthy',
  poll: null,
}

function sign(sec: string, ts: string, raw: string): string {
  return `sha256=${createHmac('sha256', sec).update(`${ts}.${raw}`).digest('hex')}`
}

function request(rawBody: string, over: Partial<{ serviceName: string | null; timestamp: string | null; signature: string | null }> = {}) {
  return {
    rawBody,
    serviceName: 'svc-a',
    timestamp: nowSec,
    signature: sign(secret, nowSec, rawBody),
    ...over,
  }
}

describe('handleIngest', () => {
  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc, secret)
  })

  it('401 when any auth header is missing', async () => {
    const body = '{"message":"x"}'
    for (const over of [{ serviceName: null }, { timestamp: null }, { signature: null }]) {
      const res = await handleIngest(store, request(body, over), now)
      expect(res.status).toBe(401)
    }
  })

  it('401 for unknown service and service without secret (indistinguishable)', async () => {
    const body = '{"message":"x"}'
    const unknown = await handleIngest(store, request(body, { serviceName: 'nope' }), now)
    store.seedService({ ...svc, id: 's-2', name: 'svc-nosecret' }, null)
    const nosecret = await handleIngest(
      store,
      request(body, { serviceName: 'svc-nosecret', signature: sign(secret, nowSec, body) }),
      now,
    )
    expect(unknown).toEqual(nosecret)
    expect(unknown.status).toBe(401)
    expect(unknown.body).toEqual({ error: 'unauthorized' })
  })

  it('401 for bad signature and stale timestamp', async () => {
    const body = '{"message":"x"}'
    const bad = await handleIngest(store, request(body, { signature: 'sha256=' + '0'.repeat(64) }), now)
    expect(bad.status).toBe(401)
    const staleTs = String(Math.floor(now.getTime() / 1000) - 301)
    const stale = await handleIngest(
      store,
      request(body, { timestamp: staleTs, signature: sign(secret, staleTs, body) }),
      now,
    )
    expect(stale.status).toBe(401)
  })

  it('400 for invalid JSON (signature valid over the raw bytes)', async () => {
    const body = 'not json'
    const res = await handleIngest(store, request(body), now)
    expect(res.status).toBe(400)
  })

  it('422 for schema violations with details', async () => {
    const body = '{"level":7}'
    const res = await handleIngest(store, request(body), now)
    expect(res.status).toBe(422)
    expect(res.body.details).toBeDefined()
  })

  it('201 on success: event flows through processEvent and persists', async () => {
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P1', tags: ['ci'], match: { errorType: 'test_failure' } })
    const body = JSON.stringify({ message: 'unit tests failed', errorType: 'test_failure' })
    const res = await handleIngest(store, request(body), now)
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ severity: 'P1', health: 'degraded', duplicate: false })
    const open = await store.listOpenIssues('s-1')
    expect(open).toHaveLength(1)
    expect((await store.getService('s-1'))?.healthStatus).toBe('degraded')
  })

  it('repeat events aggregate into the same issue', async () => {
    const body = JSON.stringify({ message: 'User 1 not found' })
    const body2 = JSON.stringify({ message: 'User 999 not found' })
    await handleIngest(store, request(body), now)
    const res = await handleIngest(store, request(body2), now)
    expect(res.status).toBe(201)
    expect(await store.listOpenIssues('s-1')).toHaveLength(1)
  })
})
