import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { handleAiFix } from '@/ai-fix/handle-ai-fix'
import { InMemoryStore } from '@/store/memory'
import type { ServiceRecord } from '@/store/contracts'
import type { CanonicalEvent } from '@/core/types'
import { heartbeatFingerprint } from '@/core/heartbeat'
import type { DiscordBot } from '@/notify/discord-bot'
import type { DiscordOutgoing } from '@/notify/message'
import { buildDiscordMessage } from '@/notify/message'
import { processEvent } from '@/pipeline/process-event'
import { transitionIssue } from '@/pipeline/transition-issue'

const now = new Date('2026-11-13T10:00:00.000Z')
const nowSec = String(Math.floor(now.getTime() / 1000))
const secret = 'svc-secret'
const HB = 'android-e2e-prod'
const PR = 'https://github.com/o/r/pull/1'

const svc: ServiceRecord = {
  id: 's-1',
  name: 'svc-a',
  healthWindowMinutes: 15,
  healthFailureThreshold: 2,
  healthStatus: 'healthy',
  poll: null,
  discordWebhookUrl: null,
  description: null,
  ownerDiscordIds: ['555'],
}

function sign(sec: string, ts: string, raw: string): string {
  return `sha256=${createHmac('sha256', sec).update(`${ts}.${raw}`).digest('hex')}`
}
function request(rawBody: string, over: Partial<{ serviceName: string | null; timestamp: string | null; signature: string | null }> = {}) {
  return { rawBody, serviceName: 'svc-a', timestamp: nowSec, signature: sign(secret, nowSec, rawBody), ...over }
}
const body = (o: Record<string, unknown>) => JSON.stringify({ heartbeat: HB, status: 'pr_opened', prUrl: PR, summary: '修好了', ...o })

function fakeBot(opts: { fail?: boolean } = {}) {
  const postTos: Array<{ channelId: string; message: DiscordOutgoing }> = []
  const bot: DiscordBot = {
    async post() {
      return { ok: false, reason: 'unused' }
    },
    async postTo(channelId, message) {
      postTos.push({ channelId, message })
      return opts.fail ? { ok: false, reason: 'http 500' } : { ok: true, channelId, messageId: 'r-1' }
    },
    async postFiles() {
      return { ok: false as const, reason: "unused" }
    },
    async startThread() {
      return { ok: true }
    },
    async edit() {
      return { ok: true }
    },
  }
  return { bot, postTos }
}

function eventFor(hb: string): CanonicalEvent {
  return {
    serviceId: 's-1',
    source: 'push',
    level: 'error',
    errorType: 'test_failure',
    message: 'e2e failed',
    fingerprint: heartbeatFingerprint('s-1', 'test_failure', hb),
    occurredAt: '2026-11-13T09:00:00.000Z',
    metadata: {},
  }
}

describe('handleAiFix', () => {
  let store: InMemoryStore
  let issueId: string
  const hbRow = (name: string) => ({
    id: `hb-${name}`, name, intervalSeconds: 86400, graceSeconds: 3600, lastRunAt: null,
    createdAt: '2026-11-01T00:00:00.000Z', enabled: true, lastSuccessAt: null,
    lastRunStatus: null, lastRunUrl: null, lastRunSummary: null,
  })

  async function seedIssue(hb: string, withRoot = true): Promise<string> {
    const { issue } = await processEvent(store, eventFor(hb), now)
    if (withRoot) {
      await store.recordNotification({
        issueId: issue.id, serviceId: 's-1', fingerprint: issue.fingerprint, severity: issue.severity,
        status: 'sent', countAtSend: 1, sentAt: '2026-11-13T09:00:30.000Z', kind: 'alert',
        incidentSeq: issue.reopenCount, discordChannelId: 'ch-1', discordMessageId: 'm-1',
        payload: buildDiscordMessage({
          serviceName: 'svc-a', ownerDiscordIds: ['555'], severity: issue.severity, errorType: 'test_failure',
          message: 'e2e failed', count: 1, firstSeen: 'f', lastSeen: 'l',
        }),
      })
    }
    return issue.id
  }

  beforeEach(async () => {
    store = new InMemoryStore()
    store.seedService(svc, secret)
    store.seedHeartbeat('s-1', hbRow(HB))
    store.seedHeartbeat('s-1', hbRow('other-hb'))
    issueId = await seedIssue(HB)
  })
  afterEach(() => vi.restoreAllMocks())

  it('未帶 headers／簽章錯誤 → 401', async () => {
    const b = body({})
    const { bot } = fakeBot()
    for (const c of [
      request(b, { serviceName: null }),
      request(b, { timestamp: null }),
      request(b, { signature: null }),
      request(b, { signature: 'sha256=' + '0'.repeat(64) }),
    ]) {
      expect(await handleAiFix(store, bot, c, now)).toEqual({ status: 401, body: { error: 'unauthorized' } })
    }
  })

  it('JSON 壞 → 400', async () => {
    const res = await handleAiFix(store, null, request('{nope'), now)
    expect(res.status).toBe(400)
  })

  it('payload 不合法 → 422 且不寫入', async () => {
    const res = await handleAiFix(store, null, request(body({ status: 'weird' })), now)
    expect(res.status).toBe(422)
    expect((await store.getIssue(issueId))?.aiFix).toBeNull()
  })

  it('prUrl 為偽造網域 → 422，aiFix 仍為 null', async () => {
    const res = await handleAiFix(store, null, request(body({ prUrl: 'https://github.com.evil.com/o/r/pull/1' })), now)
    expect(res.status).toBe(422)
    expect((await store.getIssue(issueId))?.aiFix).toBeNull()
  })

  it('心跳未登記 → 404 unknown heartbeat', async () => {
    const res = await handleAiFix(store, null, request(body({ heartbeat: 'ghost' })), now)
    expect(res).toEqual({ status: 404, body: { error: 'unknown heartbeat' } })
  })

  it('issue 已 resolved → 404 no_active_issue，aiFix 不變', async () => {
    await transitionIssue(store, null, issueId, 'resolved', { kind: 'system', source: 'heartbeat' }, now)
    const res = await handleAiFix(store, null, request(body({})), now)
    expect(res).toEqual({ status: 404, body: { error: 'no_active_issue' } })
    expect((await store.getIssue(issueId))?.aiFix).toBeNull()
  })

  it('另一個心跳的 issue 不會被寫到', async () => {
    const other = await seedIssue('other-hb', false)
    const res = await handleAiFix(store, null, request(body({})), now)
    expect(res.status).toBe(201)
    expect(res.body.issueId).toBe(issueId)
    expect((await store.getIssue(other))?.aiFix).toBeNull()
  })

  it('pr_opened → 201 notified:true，aiFix 已存，討論串收到含 prUrl 與 <@owner> 的訊息', async () => {
    const f = fakeBot()
    const res = await handleAiFix(store, f.bot, request(body({})), now)
    expect(res).toEqual({ status: 201, body: { issueId, notified: true } })
    expect((await store.getIssue(issueId))?.aiFix).toEqual({
      status: 'pr_opened', prUrl: PR, summary: '修好了', reportedAt: now.toISOString(),
    })
    expect(f.postTos).toHaveLength(1)
    expect(f.postTos[0].channelId).toBe('m-1')
    const content = (f.postTos[0].message as { content: string }).content
    expect(content).toContain(PR)
    expect(content).toContain('<@555>')
  })

  it('no_fix、failed → 201 notified:false，欄位已存，bot.postTo 零次呼叫', async () => {
    for (const status of ['no_fix', 'failed']) {
      const f = fakeBot()
      const res = await handleAiFix(store, f.bot, request(body({ status, prUrl: null })), now)
      expect(res).toEqual({ status: 201, body: { issueId, notified: false } })
      expect((await store.getIssue(issueId))?.aiFix).toMatchObject({ status, prUrl: null })
      expect(f.postTos).toHaveLength(0)
    }
  })

  it('同一 prUrl 再回報 → 不重發，reportedAt 更新；不同 prUrl → 再發一則', async () => {
    const f = fakeBot()
    await handleAiFix(store, f.bot, request(body({})), now)
    const later = new Date('2026-11-13T11:00:00.000Z')
    const laterSec = String(Math.floor(later.getTime() / 1000))
    const b2 = body({})
    const res = await handleAiFix(store, f.bot, { rawBody: b2, serviceName: 'svc-a', timestamp: laterSec, signature: sign(secret, laterSec, b2) }, later)
    expect(res.body.notified).toBe(false)
    expect(f.postTos).toHaveLength(1)
    expect((await store.getIssue(issueId))?.aiFix?.reportedAt).toBe(later.toISOString())
    const b3 = body({ prUrl: 'https://github.com/o/r/pull/2' })
    const res3 = await handleAiFix(store, f.bot, request(b3), now)
    expect(res3.body.notified).toBe(true)
    expect(f.postTos).toHaveLength(2)
  })

  it('bot=null（webhook 模式）→ 201 notified:false，資料已存', async () => {
    const res = await handleAiFix(store, null, request(body({})), now)
    expect(res).toEqual({ status: 201, body: { issueId, notified: false } })
    expect((await store.getIssue(issueId))?.aiFix?.prUrl).toBe(PR)
  })

  it('找不到根訊息 → notified:false，資料已存', async () => {
    const s2 = new InMemoryStore()
    s2.seedService(svc, secret)
    s2.seedHeartbeat('s-1', hbRow(HB))
    const { issue } = await processEvent(s2, eventFor(HB), now)
    const f = fakeBot()
    const res = await handleAiFix(s2, f.bot, request(body({})), now)
    expect(res).toEqual({ status: 201, body: { issueId: issue.id, notified: false } })
    expect((await s2.getIssue(issue.id))?.aiFix?.prUrl).toBe(PR)
    expect(f.postTos).toHaveLength(0)
  })

  it('postTo 全部失敗 → 仍 201，notified:false', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const f = fakeBot({ fail: true })
    const res = await handleAiFix(store, f.bot, request(body({})), now)
    expect(res).toEqual({ status: 201, body: { issueId, notified: false } })
    expect((await store.getIssue(issueId))?.aiFix?.prUrl).toBe(PR)
  })

  it('pr_opened 後 listNotifications() 數量不變', async () => {
    const before = store.listNotifications().length
    await handleAiFix(store, fakeBot().bot, request(body({})), now)
    expect(store.listNotifications()).toHaveLength(before)
  })
})
