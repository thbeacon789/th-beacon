import { describe, it, expect, beforeEach, vi } from 'vitest'
import { processAndNotify } from '@/pipeline/process-and-notify'
import { InMemoryStore } from '@/store/memory'
import type { NotifyDeps } from '@/pipeline/process-and-notify'
import type { DiscordMessage, DiscordOutgoing } from '@/notify/message'
import type { DiscordBot, BotPostResult } from '@/notify/discord-bot'
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
  discordWebhookUrl: 'https://discord/webhook',
  description: null,
  ownerDiscordId: null,
}

const event = (over: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  serviceId: 's-1',
  source: 'push',
  level: 'error',
  errorType: 'TypeError',
  message: 'boom',
  fingerprint: 'fp-1',
  occurredAt: '2026-07-28T10:09:00.000Z',
  metadata: {},
  ...over,
})

function fakeSender(result: { ok: true } | { ok: false; reason: string } = { ok: true }) {
  const sent: Array<{ url: string; message: DiscordMessage }> = []
  const deps: NotifyDeps = {
    sender: async (url, message) => {
      sent.push({ url, message })
      return result
    },
    fallbackWebhookUrl: null,
  }
  return { deps, sent }
}

describe('processAndNotify', () => {
  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc)
  })

  it('P2 issue: 達門檻，發送', async () => {
    const { deps, sent } = fakeSender()
    const result = await processAndNotify(store, deps, event(), now)
    expect(result.notified).toBe(true)
    expect(result.notifyReason).toBe('first')
    expect(sent).toHaveLength(1)
    expect(sent[0].message.embeds[0].color).toBe(0x95a5a6)
  })

  it('服務有負責人：送出的 message tag 該負責人；無則不 tag', async () => {
    store.seedService({ ...svc, id: 's-9', name: 'svc-owner', ownerDiscordId: '123456789012345678' })
    const { deps, sent } = fakeSender()
    await processAndNotify(store, deps, event({ serviceId: 's-9', fingerprint: 'fp-9' }), now)
    expect(sent[0].message.content).toBe('<@123456789012345678>')
    expect(sent[0].message.allowed_mentions).toEqual({ parse: [], users: ['123456789012345678'] })

    await processAndNotify(store, deps, event(), now)
    expect(sent[1].message.content).toBeUndefined()
    expect(sent[1].message.allowed_mentions).toEqual({ parse: [] })
  })

  it('顏色與紀錄取 event severity', async () => {
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P1', match: {} })
    const { deps, sent } = fakeSender()
    await processAndNotify(store, deps, event(), now) // issue 先被規則判為 P1
    const later = new Date(now.getTime() + 31 * 60_000) // 過冷卻
    const result = await processAndNotify(store, deps, event({ severity: 'P2' }), later)
    expect(result.issue.severity).toBe('P1') // ratchet 不降
    expect(sent).toHaveLength(2)
    expect(sent[1].message.embeds[0].color).toBe(0x95a5a6)
    expect(await store.getLatestSentNotification('s-1', result.issue.fingerprint, 0)).toEqual({
      severity: 'P2',
      sentAt: later.toISOString(),
    })
  })

  it('無 event severity 時取 issue severity', async () => {
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P1', match: {} })
    const { deps, sent } = fakeSender()
    await processAndNotify(store, deps, event(), now)
    expect(sent[0].message.embeds[0].color).toBe(0xe67e22)
  })

  it('first P1: sends embed to per-service webhook and records sent', async () => {
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P1', match: {} })
    const { deps, sent } = fakeSender()
    const result = await processAndNotify(store, deps, event(), now)
    expect(result.notified).toBe(true)
    expect(result.notifyReason).toBe('first')
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe('https://discord/webhook')
    expect(sent[0].message.embeds[0].title).toBe('[P1] svc-a — TypeError')
    expect(await store.getLatestSentNotification('s-1', result.issue.fingerprint, 0)).toEqual({
      severity: 'P1',
      sentAt: now.toISOString(),
    })
  })

  it('cooldown suppresses repeat; escalation resends', async () => {
    store.seedRule(null, { id: 'p1', priority: 10, severity: 'P1', match: {} })
    const { deps, sent } = fakeSender()
    await processAndNotify(store, deps, event(), now)
    const repeat = await processAndNotify(store, deps, event(), now)
    expect(repeat.notified).toBe(false)
    expect(repeat.notifyReason).toBe('cooldown')
    expect(sent).toHaveLength(1)

    store.seedRule(null, {
      id: 'p0',
      priority: 20,
      severity: 'P0',
      match: { minCountInWindow: 3, windowMinutes: 60 },
    })
    const escalated = await processAndNotify(store, deps, event(), now)
    expect(escalated.notified).toBe(true)
    expect(escalated.notifyReason).toBe('escalation')
    expect(sent).toHaveLength(2)
    expect(sent[1].message.embeds[0].title).toBe('[P0] svc-a — TypeError')
  })

  it('sender failure records failed, pipeline result intact, next event retries', async () => {
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P1', match: {} })
    const failing = fakeSender({ ok: false, reason: 'http 500' })
    const result = await processAndNotify(store, failing.deps, event(), now)
    expect(result.notified).toBe(false)
    expect(result.notifyReason).toBe('first')
    expect(result.issue.severity).toBe('P1') // 管線不受影響
    expect(await store.getLatestSentNotification('s-1', result.issue.fingerprint, 0)).toBeNull() // failed 不計

    const ok = fakeSender()
    const retry = await processAndNotify(store, ok.deps, event(), now)
    expect(retry.notified).toBe(true)
    expect(retry.notifyReason).toBe('first') // 仍無 sent 紀錄 → first
  })

  it('falls back to global webhook; skips with no_webhook when neither set', async () => {
    store.seedService({ ...svc, id: 's-2', name: 'svc-b', discordWebhookUrl: null })
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P1', match: {} })
    const { deps, sent } = fakeSender()
    deps.fallbackWebhookUrl = 'https://discord/global'
    const viaFallback = await processAndNotify(store, deps, event({ serviceId: 's-2' }), now)
    expect(viaFallback.notified).toBe(true)
    expect(sent[0].url).toBe('https://discord/global')

    const none = fakeSender()
    store.seedService({ ...svc, id: 's-3', name: 'svc-c', discordWebhookUrl: null })
    const skipped = await processAndNotify(store, none.deps, event({ serviceId: 's-3', fingerprint: 'fp-3' }), now)
    expect(skipped.notified).toBe(false)
    expect(skipped.notifyReason).toBe('no_webhook')
    expect(none.sent).toHaveLength(0)
  })

  it('duplicate events skip notification evaluation', async () => {
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P1', match: {} })
    const { deps, sent } = fakeSender()
    await processAndNotify(store, deps, event({ source: 'poll', metadata: { externalId: 'x' } }), now)
    const dup = await processAndNotify(store, deps, event({ source: 'poll', metadata: { externalId: 'x' } }), now)
    expect(dup.notifyReason).toBe('duplicate')
    expect(sent).toHaveLength(1)
  })

  it('notify-stage store failure never breaks the pipeline result', async () => {
    class ThrowingNotifyStore extends InMemoryStore {
      async getLatestSentNotification(): Promise<never> {
        throw new Error('db blip')
      }
    }
    const store2 = new ThrowingNotifyStore()
    store2.seedService(svc)
    store2.seedRule(null, { id: 'r', priority: 10, severity: 'P1', match: {} })
    const { deps, sent } = fakeSender()
    const result = await processAndNotify(store2, deps, event(), now)
    expect(result.issue.severity).toBe('P1') // 管線結果完整
    expect(result.notified).toBe(false)
    expect(result.notifyReason).toBe('notify_error')
    expect(sent).toHaveLength(0)
  })
})

function fakeBot(opts: { postFail?: boolean; editFail?: boolean } = {}) {
  const posts: DiscordOutgoing[] = []
  const edits: Array<{ channelId: string; messageId: string; message: DiscordOutgoing }> = []
  const bot: DiscordBot = {
    post: async (message): Promise<BotPostResult> => {
      if (opts.postFail) return { ok: false, reason: 'http 500' }
      posts.push(message)
      return { ok: true, channelId: 'c1', messageId: `m${posts.length}` }
    },
    edit: async (channelId, messageId, message) => {
      edits.push({ channelId, messageId, message })
      return opts.editFail ? { ok: false, reason: 'http 500' } : { ok: true }
    },
  }
  const { deps, sent } = fakeSender()
  return { deps: { ...deps, bot } as NotifyDeps, bot, posts, edits, sent }
}

describe('processAndNotify（bot 模式）', () => {
  let store: InMemoryStore
  const min = (n: number) => new Date(now.getTime() + n * 60_000)
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService({ ...svc, ownerDiscordId: '123456789012345678' })
  })

  it('首次告警帶按鈕並記 message id 與 payload', async () => {
    const { deps, posts, sent } = fakeBot()
    const r = await processAndNotify(store, deps, event(), now)
    expect(r.notified).toBe(true)
    expect(sent).toHaveLength(0)
    expect((posts[0] as DiscordMessage).components).toBeDefined()
    const n = store.listNotifications()[0]
    expect(n.discordMessageId).toBe('m1')
    expect(n.discordChannelId).toBe('c1')
    expect(n.payload?.components).toBeDefined()
    expect(n.payload).not.toHaveProperty('message_reference')
  })

  it('bot 不需要 webhook url', async () => {
    store.seedService({ ...svc, id: 's-2', discordWebhookUrl: null })
    const { deps, posts } = fakeBot()
    const r = await processAndNotify(store, deps, event({ serviceId: 's-2', fingerprint: 'x' }), now)
    expect(r.notified).toBe(true)
    expect(posts).toHaveLength(1)
  })

  it('同事故升級發 reply、有 tag、無按鈕', async () => {
    const { deps, posts } = fakeBot()
    await processAndNotify(store, deps, event(), now)
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P0', match: {} })
    await processAndNotify(store, deps, event({ severity: 'P0' }), min(1))
    const m = posts[1] as DiscordMessage
    expect(m.message_reference?.message_id).toBe('m1')
    expect(m.content).toContain('<@123456789012345678>')
    expect(m.components).toBeUndefined()
    const n = store.listNotifications()[1]
    expect(n.payload).not.toHaveProperty('message_reference')
  })

  it('確認後冷卻到期只編輯計數、不 post；30 分鐘內不再 edit', async () => {
    const { deps, posts, edits } = fakeBot()
    const first = await processAndNotify(store, deps, event(), now)
    await store.transitionIssueStatus(first.issue.id, 'acknowledged', ['open'], 'alice', now.toISOString())
    const r = await processAndNotify(store, deps, event(), min(31))
    expect(r.notified).toBe(false)
    expect(r.notifyReason).toBe('acknowledged_silent')
    expect(posts).toHaveLength(1)
    expect(edits).toHaveLength(1)
    expect(edits[0].messageId).toBe('m1')
    const edited = edits[0].message as DiscordMessage
    const fields = edited.embeds[0].fields
    expect(fields.find((f) => f.name === '次數')?.value).toBe('2')
    expect(fields.some((f) => f.name === '✋ 已確認')).toBe(true)
    expect(JSON.stringify(edited.components)).not.toContain('ack')
    const rec = store.listNotifications().find((n) => n.kind === 'count_edit')
    expect(rec?.status).toBe('sent')
    expect(rec?.payload).toBeNull()
    expect(rec?.discordMessageId).toBe('m1')

    await processAndNotify(store, deps, event(), min(40))
    expect(edits).toHaveLength(1)
  })

  it('確認後升級仍 post 並 tag', async () => {
    const { deps, posts } = fakeBot()
    const first = await processAndNotify(store, deps, event(), now)
    await store.transitionIssueStatus(first.issue.id, 'acknowledged', ['open'], 'alice', now.toISOString())
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P0', match: {} })
    const r = await processAndNotify(store, deps, event(), min(1))
    expect(r.notifyReason).toBe('escalation')
    expect(posts).toHaveLength(2)
    expect((posts[1] as DiscordMessage).content).toContain('<@123456789012345678>')
  })

  it('復發：新告警 reply 到上一事故根訊息、上一則被編輯為已復發、冷卻從零', async () => {
    const { deps, posts, edits } = fakeBot()
    const first = await processAndNotify(store, deps, event(), now)
    store.setIssueStatus(first.issue.id, 'resolved')
    const r = await processAndNotify(store, deps, event(), min(1))
    expect(r.reopened).toBe(true)
    expect(r.notifyReason).toBe('first')
    const m = posts[1] as DiscordMessage
    expect(m.message_reference?.message_id).toBe('m1')
    expect(m.components).toBeDefined()
    expect(edits).toHaveLength(1)
    expect(edits[0].messageId).toBe('m1')
    const prev = edits[0].message as DiscordMessage
    expect(prev.embeds[0].fields.some((f) => f.name === '🔁 已復發')).toBe(true)
    expect(prev.components).toBeUndefined()
    const n = store.listNotifications()[1]
    expect(n.incidentSeq).toBe(1)
    expect(n.payload).not.toHaveProperty('message_reference')
  })

  it('編輯上一則失敗不阻止新告警寫入紀錄', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { deps } = fakeBot({ editFail: true })
    const first = await processAndNotify(store, deps, event(), now)
    store.setIssueStatus(first.issue.id, 'resolved')
    const r = await processAndNotify(store, deps, event(), min(1))
    expect(r.notified).toBe(true)
    expect(store.listNotifications()).toHaveLength(2)
    err.mockRestore()
  })

  it('post 失敗：記 failed、message id 為 null', async () => {
    const { deps } = fakeBot({ postFail: true })
    const r = await processAndNotify(store, deps, event(), now)
    expect(r.notified).toBe(false)
    const n = store.listNotifications()[0]
    expect(n.status).toBe('failed')
    expect(n.discordMessageId).toBeNull()
  })

  it('bot 為 null：送出的 message 無 components、走 sender(webhookUrl)', async () => {
    store.seedService(svc)
    const { deps, sent } = fakeSender()
    await processAndNotify(store, { ...deps, bot: null }, event(), now)
    expect(sent[0].url).toBe('https://discord/webhook')
    expect(sent[0].message.components).toBeUndefined()
  })
})
