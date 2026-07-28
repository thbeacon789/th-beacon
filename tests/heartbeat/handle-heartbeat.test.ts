import { describe, it, expect, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { handleHeartbeat } from '@/heartbeat/handle-heartbeat'
import { InMemoryStore } from '@/store/memory'
import { heartbeatFingerprint, synthesizeHeartbeatMissedEvent } from '@/core/heartbeat'
import type { ServiceRecord, StoredHeartbeat } from '@/store/contracts'
import type { NotifyDeps } from '@/pipeline/process-and-notify'

const now = new Date('2026-07-29T03:00:00.000Z')
const nowSec = String(Math.floor(now.getTime() / 1000))
const secret = 'svc-secret'

const noopDeps: NotifyDeps = {
  sender: async () => ({ ok: true }) as const,
  fallbackWebhookUrl: null,
}

const svc: ServiceRecord = {
  id: 's-1',
  name: 'svc-a',
  healthWindowMinutes: 15,
  healthFailureThreshold: 2,
  healthStatus: 'healthy',
  poll: null,
  discordWebhookUrl: null,
}

const hb: Omit<StoredHeartbeat, 'serviceId'> = {
  id: 'hb-1',
  name: 'daily-test',
  intervalSeconds: 86_400,
  graceSeconds: 3_600,
  enabled: true,
  lastRunAt: '2026-07-27T03:00:00.000Z',
  lastSuccessAt: '2026-07-27T03:00:00.000Z',
  lastRunStatus: 'pass',
  lastRunUrl: null,
  createdAt: '2026-07-01T00:00:00.000Z',
}

function sign(ts: string, raw: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}`
}

function request(rawBody: string, over: Record<string, unknown> = {}) {
  return {
    rawBody,
    serviceName: 'svc-a',
    timestamp: nowSec,
    signature: sign(nowSec, rawBody),
    ...over,
  } as Parameters<typeof handleHeartbeat>[2]
}

describe('handleHeartbeat', () => {
  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc, secret)
    store.seedHeartbeat('s-1', hb)
    store.seedRule(null, {
      id: 'r-1',
      priority: 100,
      severity: 'P1',
      tags: ['ci'],
      match: { errorType: 'test_failure' },
    })
  })

  it('缺少任一驗證標頭回 401', async () => {
    const body = '{"name":"daily-test","status":"pass"}'
    for (const over of [{ serviceName: null }, { timestamp: null }, { signature: null }]) {
      const res = await handleHeartbeat(store, noopDeps, request(body, over), now)
      expect(res.status).toBe(401)
    }
  })

  it('簽章錯誤回 401', async () => {
    const body = '{"name":"daily-test","status":"pass"}'
    const res = await handleHeartbeat(store, noopDeps, request(body, { signature: 'sha256=' + '0'.repeat(64) }), now)
    expect(res.status).toBe(401)
  })

  it('非法 JSON 回 400、payload 不合格回 422', async () => {
    const bad = await handleHeartbeat(store, noopDeps, request('not json'), now)
    expect(bad.status).toBe(400)
    const invalid = await handleHeartbeat(store, noopDeps, request('{"name":"x"}'), now)
    expect(invalid.status).toBe(422)
  })

  it('未登記的心跳名稱回 404', async () => {
    const body = '{"name":"nope","status":"pass"}'
    const res = await handleHeartbeat(store, noopDeps, request(body), now)
    expect(res.status).toBe(404)
  })

  it('pass 更新兩個時間戳且不建立 issue', async () => {
    const body = '{"name":"daily-test","status":"pass","runUrl":"https://ci/run/9"}'
    const res = await handleHeartbeat(store, noopDeps, request(body), now)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      name: 'daily-test',
      status: 'pass',
      lastRunAt: now.toISOString(),
      lastSuccessAt: now.toISOString(),
    })
    expect(await store.listOpenIssues('s-1')).toHaveLength(0)
  })

  it('fail 只推進 lastRunAt 並建立 test_failure issue', async () => {
    const body = '{"name":"daily-test","status":"fail","summary":"3 of 210 failed"}'
    const res = await handleHeartbeat(store, noopDeps, request(body), now)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'fail', lastSuccessAt: '2026-07-27T03:00:00.000Z' })
    const open = await store.listOpenIssues('s-1')
    expect(open).toHaveLength(1)
    expect(open[0].severity).toBe('P1')
  })

  it('任何回報都 resolve heartbeat_missed issue（有回報即證明還活著）', async () => {
    await store.upsertIssueWithEvent(
      synthesizeHeartbeatMissedEvent('s-1', { ...hb }, new Date('2026-07-29T01:00:00.000Z')),
    )
    expect(await store.listOpenIssues('s-1')).toHaveLength(1)

    const body = '{"name":"daily-test","status":"fail"}'
    await handleHeartbeat(store, noopDeps, request(body), now)

    const missedFp = heartbeatFingerprint('s-1', 'heartbeat_missed', 'daily-test')
    const stillOpen = await store.listOpenIssues('s-1')
    // heartbeat_missed 已被 resolve，只剩 fail 產生的 test_failure
    expect(stillOpen).toHaveLength(1)
    expect(await store.resolveIssueByFingerprint('s-1', missedFp)).toBe(false)
  })

  it('pass 額外 resolve 先前的 test_failure issue', async () => {
    await handleHeartbeat(store, noopDeps, request('{"name":"daily-test","status":"fail"}'), now)
    expect(await store.listOpenIssues('s-1')).toHaveLength(1)

    const later = new Date('2026-07-30T03:00:00.000Z')
    const laterSec = String(Math.floor(later.getTime() / 1000))
    const body = '{"name":"daily-test","status":"pass"}'
    await handleHeartbeat(
      store,
      noopDeps,
      { rawBody: body, serviceName: 'svc-a', timestamp: laterSec, signature: sign(laterSec, body) },
      later,
    )
    expect(await store.listOpenIssues('s-1')).toHaveLength(0)
  })
})
