import { describe, it, expect, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { handleAiUsage } from '@/ai-usage/handle-ai-usage'
import { InMemoryStore } from '@/store/memory'
import type { ServiceRecord } from '@/store/contracts'

const now = new Date('2026-11-11T10:00:00.000Z')
const nowSec = String(Math.floor(now.getTime() / 1000))
const secret = 'svc-secret'

const svc: ServiceRecord = {
  id: 's-1',
  name: 'svc-a',
  healthWindowMinutes: 15,
  healthFailureThreshold: 2,
  healthStatus: 'healthy',
  poll: null,
  discordWebhookUrl: null,
  description: null,
  ownerDiscordId: null,
}

function sign(sec: string, ts: string, raw: string): string {
  return `sha256=${createHmac('sha256', sec).update(`${ts}.${raw}`).digest('hex')}`
}

function request(rawBody: string, over: Partial<{ serviceName: string | null; timestamp: string | null; signature: string | null }> = {}) {
  return { rawBody, serviceName: 'svc-a', timestamp: nowSec, signature: sign(secret, nowSec, rawBody), ...over }
}

describe('handleAiUsage', () => {
  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc, secret)
  })

  it('簽章正確 → 201，寫入 ci_diagnosis 用量，costUsd 依單價、priced=true', async () => {
    const body = JSON.stringify({ source: 'ci_diagnosis', model: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 500 })
    const res = await handleAiUsage(store, request(body), now)
    expect(res.status).toBe(201)
    expect(res.body.costUsd).toBeCloseTo(0.007, 9)
    expect(res.body.priced).toBe(true)
    expect(typeof res.body.id).toBe('string')
    const rows = store.listAiUsage()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      serviceId: 's-1',
      source: 'ci_diagnosis',
      model: 'claude-sonnet-5-5',
      inputTokens: 1000,
      outputTokens: 500,
      occurredAt: now.toISOString(),
    })
  })

  it('未定價 model → 201，costUsd null、priced=false，tokens 仍寫入', async () => {
    const body = JSON.stringify({ source: 'ci_pr', model: 'mystery-1', inputTokens: 10, outputTokens: 20 })
    const res = await handleAiUsage(store, request(body), now)
    expect(res.status).toBe(201)
    expect(res.body.costUsd).toBeNull()
    expect(res.body.priced).toBe(false)
    expect(store.listAiUsage()[0]).toMatchObject({ costUsd: null, inputTokens: 10, outputTokens: 20 })
  })

  it('有 costUsd → 以回報值寫入', async () => {
    const body = JSON.stringify({ source: 'ci_pr', model: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 500, costUsd: 0.5 })
    const res = await handleAiUsage(store, request(body), now)
    expect(res.status).toBe(201)
    expect(res.body.costUsd).toBe(0.5)
    expect(res.body.priced).toBe(true)
    expect(store.listAiUsage()[0].costUsd).toBe(0.5)
  })

  it('header 缺漏／服務不存在／簽章錯／timestamp 超過 ±300 秒 → 401 且不寫入', async () => {
    const body = JSON.stringify({ source: 'ci_pr', costUsd: 1 })
    const staleTs = String(Math.floor(now.getTime() / 1000) - 301)
    const cases = [
      request(body, { serviceName: null }),
      request(body, { timestamp: null }),
      request(body, { signature: null }),
      request(body, { serviceName: 'nope' }),
      request(body, { signature: 'sha256=' + '0'.repeat(64) }),
      request(body, { timestamp: staleTs, signature: sign(secret, staleTs, body) }),
    ]
    for (const c of cases) {
      const res = await handleAiUsage(store, c, now)
      expect(res).toEqual({ status: 401, body: { error: 'unauthorized' } })
    }
    expect(store.listAiUsage()).toHaveLength(0)
  })

  it('壞 JSON → 400；payload 不合法 → 422 帶 details', async () => {
    const bad = await handleAiUsage(store, request('{nope'), now)
    expect(bad.status).toBe(400)
    const invalid = await handleAiUsage(store, request(JSON.stringify({ source: 'server_triage', costUsd: 1 })), now)
    expect(invalid.status).toBe(422)
    expect(Array.isArray(invalid.body.details)).toBe(true)
    expect(store.listAiUsage()).toHaveLength(0)
  })
})
