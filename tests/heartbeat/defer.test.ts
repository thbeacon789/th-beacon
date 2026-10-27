import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { handleHeartbeat } from '@/heartbeat/handle-heartbeat'
import { InMemoryStore } from '@/store/memory'
import type { ServiceRecord, StoredHeartbeat } from '@/store/contracts'
import type { NotifyDeps } from '@/pipeline/process-and-notify'
import type { DiscordMessage } from '@/notify/message'
import type { Triager } from '@/triage/claude'

const now = new Date('2026-10-27T03:00:00.000Z')
const nowSec = String(Math.floor(now.getTime() / 1000))
const secret = 'svc-secret'

const svc: ServiceRecord = {
  id: 's-1',
  name: 'svc-a',
  healthWindowMinutes: 15,
  healthFailureThreshold: 2,
  healthStatus: 'healthy',
  poll: null,
  discordWebhookUrl: 'https://discord/webhook',
  description: null,
}
const hb: Omit<StoredHeartbeat, 'serviceId'> = {
  id: 'hb-1',
  name: 'daily-test',
  intervalSeconds: 86_400,
  graceSeconds: 3_600,
  enabled: true,
  lastRunAt: '2026-10-26T03:00:00.000Z',
  lastSuccessAt: '2026-10-26T03:00:00.000Z',
  lastRunStatus: 'pass',
  lastRunUrl: null,
  lastRunSummary: null,
  createdAt: '2026-10-01T00:00:00.000Z',
}
const sign = (raw: string) =>
  `sha256=${createHmac('sha256', secret).update(`${nowSec}.${raw}`).digest('hex')}`
const request = (rawBody: string) => ({ rawBody, serviceName: 'svc-a', timestamp: nowSec, signature: sign(rawBody) })

describe('handleHeartbeat 延後 AI 判級', () => {
  let store: InMemoryStore
  let sent: DiscordMessage[]
  let deps: NotifyDeps
  let calls: number
  const triager: Triager = async () => {
    calls++
    return {
      ok: true,
      diagnosis: { category: 'app', severity: 'P0', reason: '使用者受影響', suggestion: '重啟' },
      usage: { inputTokens: 1, outputTokens: 1 },
    }
  }
  const failBody = JSON.stringify({ name: 'daily-test', status: 'fail' })

  beforeEach(() => {
    calls = 0
    store = new InMemoryStore()
    store.seedService(svc, secret)
    store.seedHeartbeat('s-1', hb)
    sent = []
    deps = {
      sender: async (_u, m) => {
        sent.push(m)
        return { ok: true }
      },
      fallbackWebhookUrl: null,
      triage: { triager, budget: null },
    }
  })

  it('fail 且需呼叫 AI＋有 defer：triage deferred、不含 severity／notified，task 執行後等級更新並通知', async () => {
    const tasks: Array<() => Promise<void>> = []
    const res = await handleHeartbeat(store, deps, request(failBody), now, (t) => tasks.push(t))
    expect(res.status).toBe(200)
    expect(res.body.triage).toBe('deferred')
    expect(res.body).not.toHaveProperty('severity')
    expect(res.body).not.toHaveProperty('eventSeverity')
    expect(res.body).not.toHaveProperty('notified')
    expect(res.body).toHaveProperty('issueId')
    expect(await store.listOpenIssues('s-1')).toHaveLength(1)
    expect(sent).toHaveLength(0)

    await tasks[0]()
    expect((await store.listOpenIssues('s-1'))[0].severity).toBe('P0')
    expect(sent).toHaveLength(1)
  })

  it('延後 task 內 finishEvent 拋錯：task 不 reject', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const tasks: Array<() => Promise<void>> = []
    await handleHeartbeat(store, deps, request(failBody), now, (t) => tasks.push(t))
    store.getService = async () => {
      throw new Error('db down')
    }
    store.getLatestSentNotification = async () => {
      throw new Error('db down')
    }
    store.listOpenIssues = async () => {
      throw new Error('db down')
    }
    await expect(tasks[0]()).resolves.toBeUndefined()
    spy.mockRestore()
  })

  it('不帶 defer：triage sync，帶 severity／notified', async () => {
    const res = await handleHeartbeat(store, deps, request(failBody), now)
    expect(res.body.triage).toBe('sync')
    expect(res.body).toMatchObject({ severity: 'P0', notified: true })
  })

  it('CI 已判（帶 diagnosis）：即使有 defer 也同步，不呼叫 triager', async () => {
    const tasks: Array<() => Promise<void>> = []
    const body = JSON.stringify({
      name: 'daily-test',
      status: 'fail',
      diagnosis: { category: 'app', severity: 'P1', reason: 'r', suggestion: 's' },
    })
    const res = await handleHeartbeat(store, deps, request(body), now, (t) => tasks.push(t))
    expect(res.body.triage).toBe('sync')
    expect(res.body).toMatchObject({ eventSeverity: 'P1' })
    expect(tasks).toHaveLength(0)
    expect(calls).toBe(0)
  })
})
