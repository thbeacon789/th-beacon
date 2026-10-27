import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { handleIngest } from '@/ingest/handle-ingest'
import { InMemoryStore } from '@/store/memory'
import type { ServiceRecord } from '@/store/contracts'
import type { NotifyDeps } from '@/pipeline/process-and-notify'
import type { DiscordMessage } from '@/notify/message'
import type { Triager } from '@/triage/claude'

const now = new Date('2026-10-27T10:00:00.000Z')
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

const sign = (raw: string) =>
  `sha256=${createHmac('sha256', secret).update(`${nowSec}.${raw}`).digest('hex')}`
const request = (rawBody: string) => ({ rawBody, serviceName: 'svc-a', timestamp: nowSec, signature: sign(rawBody) })

describe('handleIngest 延後 AI 判級', () => {
  let store: InMemoryStore
  let sent: DiscordMessage[]
  let deps: NotifyDeps
  const triager: Triager = async () => ({
    ok: true,
    diagnosis: { category: 'app', severity: 'P0', reason: '使用者受影響', suggestion: '重啟' },
    usage: { inputTokens: 1, outputTokens: 1 },
  })
  const body = JSON.stringify({ message: 'boom', errorType: 'TypeError' })

  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc, secret)
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

  it('有 defer 且需呼叫 AI：回 triage deferred、不含 severity，task 執行後才判級與通知', async () => {
    const tasks: Array<() => Promise<void>> = []
    const res = await handleIngest(store, deps, request(body), now, (t) => tasks.push(t))
    expect(res.status).toBe(201)
    expect(res.body.triage).toBe('deferred')
    expect(res.body).not.toHaveProperty('severity')
    expect(res.body).not.toHaveProperty('notified')
    expect(await store.listOpenIssues('s-1')).toHaveLength(1)
    expect(sent).toHaveLength(0)
    expect(tasks).toHaveLength(1)

    await tasks[0]()
    const open = await store.listOpenIssues('s-1')
    expect(open[0].severity).toBe('P0')
    expect(sent).toHaveLength(1)
  })

  it('延後 task 內 finishEvent 拋錯：task 不 reject，console.error 被呼叫', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const tasks: Array<() => Promise<void>> = []
    await handleIngest(store, deps, request(body), now, (t) => tasks.push(t))
    store.recordIssueAiTriage = async () => {
      throw new Error('x')
    }
    store.listOpenIssues = async () => {
      throw new Error('db down')
    }
    store.getLatestSentNotification = async () => {
      throw new Error('db down')
    }
    store.getService = async () => {
      throw new Error('db down')
    }
    await expect(tasks[0]()).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('不帶 defer：triage sync，欄位與現行相同', async () => {
    const res = await handleIngest(store, deps, request(body), now)
    expect(res.body.triage).toBe('sync')
    expect(res.body).toMatchObject({ severity: 'P0', duplicate: false, notified: true })
    expect(res.body).toHaveProperty('health')
  })

  it('不需呼叫 AI（triager null）：即使有 defer 也同步', async () => {
    const tasks: Array<() => Promise<void>> = []
    const res = await handleIngest(
      store,
      { ...deps, triage: { triager: null, budget: null } },
      request(body),
      now,
      (t) => tasks.push(t),
    )
    expect(res.body.triage).toBe('sync')
    expect(res.body).toHaveProperty('severity')
    expect(tasks).toHaveLength(0)
  })
})
