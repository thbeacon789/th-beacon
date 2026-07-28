import { describe, it, expect, beforeEach } from 'vitest'
import { pollService, runPoll, type HttpGet, type HttpResult } from '@/poll/poll-service'
import { InMemoryStore } from '@/store/memory'
import type { PollableService, ServiceRecord, PollConfig } from '@/store/contracts'

const now = new Date('2026-07-28T10:10:00.000Z')

const svc: ServiceRecord = {
  id: 's-1',
  name: 'svc-a',
  healthWindowMinutes: 15,
  healthFailureThreshold: 2,
  healthStatus: 'healthy',
  poll: { lastPollAt: null, healthy: null, consecutiveFailures: 0 },
}

const config = (over: Partial<PollConfig> = {}): PollConfig => ({
  healthUrl: 'https://a/health',
  errorUrl: null,
  intervalSeconds: 60,
  timeoutMs: 5000,
  expectedStatus: 200,
  cursor: null,
  ...over,
})

function fakeHttp(routes: Record<string, HttpResult>): { http: HttpGet; calls: string[] } {
  const calls: string[] = []
  const http: HttpGet = async (url) => {
    calls.push(url)
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))
    if (hit === undefined) return { ok: false, reason: 'unrouted' }
    return hit[1]
  }
  return { http, calls }
}

const pollable = (c: PollConfig, lastPollAt: string | null = null): PollableService => ({
  service: svc,
  config: c,
  lastPollAt,
})

describe('pollService — health', () => {
  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc)
    store.seedPollConfig('s-1', config())
  })

  // 每次呼叫都從 store 取最新 pollable（runPoll 的實際行為）；
  // 傳過期快照會讓 consecutiveFailures 讀到舊值。
  const currentPollable = async () => (await store.listPollableServices())[0]

  it('unhealthy poll synthesizes event and reaches Down at threshold', async () => {
    const { http } = fakeHttp({ 'https://a/health': { ok: true, status: 500, bodyText: '' } })
    const first = await pollService(store, http, await currentPollable(), now)
    expect(first.healthy).toBe(false)
    // 第一次未達 threshold(2)：健康度由 issue 推導（health_check_failed 預設 P2 → healthy）
    expect((await store.getService('s-1'))?.healthStatus).toBe('healthy')
    const second = await pollService(store, http, await currentPollable(), now)
    expect(second.healthy).toBe(false)
    expect((await store.getService('s-1'))?.healthStatus).toBe('down') // 達 threshold
    const open = await store.listOpenIssues('s-1')
    expect(open).toHaveLength(1) // 同 fingerprint 聚合一筆
  })

  it('timeout/connection failure counts as unhealthy', async () => {
    const { http } = fakeHttp({ 'https://a/health': { ok: false, reason: 'AbortError' } })
    const outcome = await pollService(store, http, await currentPollable(), now)
    expect(outcome.healthy).toBe(false)
  })

  it('healthy poll resets failures, resolves health issue, refreshes health', async () => {
    const bad = fakeHttp({ 'https://a/health': { ok: true, status: 500, bodyText: '' } })
    await pollService(store, bad.http, await currentPollable(), now)
    await pollService(store, bad.http, await currentPollable(), now)
    expect((await store.getService('s-1'))?.healthStatus).toBe('down')

    const good = fakeHttp({ 'https://a/health': { ok: true, status: 200, bodyText: 'ok' } })
    const outcome = await pollService(store, good.http, await currentPollable(), now)
    expect(outcome.healthy).toBe(true)
    expect(outcome.healthIssueResolved).toBe(true)
    expect((await store.getService('s-1'))?.poll?.consecutiveFailures).toBe(0)
    expect((await store.getService('s-1'))?.healthStatus).toBe('healthy')
    expect(await store.listOpenIssues('s-1')).toHaveLength(0)
  })
})

describe('pollService — errors endpoint', () => {
  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc)
    store.seedPollConfig('s-1', config({ healthUrl: null, errorUrl: 'https://a/errors' }))
  })

  it('processes errors with externalId dedup and advances cursor', async () => {
    const body = JSON.stringify({ errors: [{ id: 'e-1', message: 'db down' }, { id: 'e-2', message: 'io slow' }] })
    const { http } = fakeHttp({ 'https://a/errors': { ok: true, status: 200, bodyText: body } })
    const c = config({ healthUrl: null, errorUrl: 'https://a/errors' })
    const outcome = await pollService(store, http, pollable(c), now)
    expect(outcome.errorsProcessed).toBe(2)
    expect(await store.listOpenIssues('s-1')).toHaveLength(2)

    // 重跑：同 externalId 全部 dedup，issue 數不變
    const again = await pollService(store, http, pollable(c), now)
    expect(again.errorsProcessed).toBe(2)
    expect(await store.listOpenIssues('s-1')).toHaveLength(2)

    const pollables = await store.listPollableServices()
    expect(pollables[0].config.cursor).toBe(now.toISOString())
  })

  it('appends since=cursor to the request when cursor exists', async () => {
    const body = JSON.stringify({ errors: [] })
    const { http, calls } = fakeHttp({ 'https://a/errors': { ok: true, status: 200, bodyText: body } })
    await pollService(store, http, pollable(config({ healthUrl: null, errorUrl: 'https://a/errors', cursor: '2026-07-28T10:00:00.000Z' })), now)
    expect(calls[0]).toBe('https://a/errors?since=2026-07-28T10%3A00%3A00.000Z')
  })

  it('fetch failure flags errorFetchFailed and keeps cursor', async () => {
    const { http } = fakeHttp({ 'https://a/errors': { ok: false, reason: 'ECONNREFUSED' } })
    const outcome = await pollService(store, http, pollable(config({ healthUrl: null, errorUrl: 'https://a/errors' })), now)
    expect(outcome.errorFetchFailed).toBe(true)
    const pollables = await store.listPollableServices()
    expect(pollables[0].config.cursor).toBeNull()
  })
})

describe('pollService — health + errors combined', () => {
  it('error-branch cursor write preserves health-branch poll state', async () => {
    const store = new InMemoryStore()
    store.seedService(svc)
    const c = config({ errorUrl: 'https://a/errors' }) // healthUrl 沿用預設 https://a/health
    store.seedPollConfig('s-1', c)
    const body = JSON.stringify({ errors: [{ id: 'e-1', message: 'db down' }] })
    const { http } = fakeHttp({
      'https://a/health': { ok: true, status: 500, bodyText: '' },
      'https://a/errors': { ok: true, status: 200, bodyText: body },
    })
    const pollableNow = (await store.listPollableServices())[0]
    const outcome = await pollService(store, http, pollableNow, now)

    expect(outcome.healthChecked).toBe(true)
    expect(outcome.healthy).toBe(false)
    expect(outcome.errorsProcessed).toBe(1)
    // health 分支寫入的 poll state 不被 error 分支的 cursor 寫入蓋壞
    expect((await store.getService('s-1'))?.poll).toEqual({
      lastPollAt: now.toISOString(),
      healthy: false,
      consecutiveFailures: 1,
    })
    const after = (await store.listPollableServices())[0]
    expect(after.config.cursor).toBe(now.toISOString())
    // 兩類 issue 都建立：health_check_failed + polled error
    expect(await store.listOpenIssues('s-1')).toHaveLength(2)
  })
})

describe('runPoll', () => {
  it('polls only due services', async () => {
    const store = new InMemoryStore()
    store.seedService(svc)
    store.seedPollConfig('s-1', config())
    store.seedService({ ...svc, id: 's-2', name: 'svc-b' })
    store.seedPollConfig('s-2', config())
    // s-2 剛輪詢過（30 秒前，interval 60）
    await store.updatePollState('s-2', { lastPollAt: '2026-07-28T10:09:30.000Z', healthy: true, consecutiveFailures: 0 })
    const { http } = fakeHttp({ 'https://a/health': { ok: true, status: 200, bodyText: 'ok' } })
    const outcomes = await runPoll(store, http, now)
    expect(outcomes.map((o) => o.serviceId)).toEqual(['s-1'])
  })

  it('continues polling remaining services when one throws', async () => {
    class ThrowingStore extends InMemoryStore {
      async updatePollState(serviceId: string, state: import('@/store/contracts').PollStateUpdate): Promise<void> {
        if (serviceId === 's-1') throw new Error('boom')
        return super.updatePollState(serviceId, state)
      }
    }
    const store = new ThrowingStore()
    store.seedService(svc)
    store.seedPollConfig('s-1', config())
    store.seedService({ ...svc, id: 's-2', name: 'svc-b' })
    store.seedPollConfig('s-2', config())
    const { http } = fakeHttp({ 'https://a/health': { ok: true, status: 200, bodyText: 'ok' } })
    const outcomes = await runPoll(store, http, now)
    expect(outcomes).toHaveLength(2)
    expect(outcomes[0]).toMatchObject({ serviceId: 's-1', error: 'boom' })
    expect(outcomes[1]).toMatchObject({ serviceId: 's-2', healthy: true })
  })
})
