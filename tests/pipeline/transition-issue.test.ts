import { describe, it, expect, beforeEach } from 'vitest'
import { transitionIssue } from '@/pipeline/transition-issue'
import { processEvent } from '@/pipeline/process-event'
import { InMemoryStore } from '@/store/memory'
import type { ServiceRecord } from '@/store/contracts'
import type { CanonicalEvent } from '@/core/types'
import type { DiscordBot } from '@/notify/discord-bot'
import type { DiscordOutgoing } from '@/notify/message'
import { buildDiscordMessage } from '@/notify/message'
import { withAlertButtons } from '@/notify/lifecycle-message'

const now = new Date('2026-07-28T10:10:00.000Z')

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

function fakeBot(opts: { editRejects?: boolean } = {}) {
  const posts: DiscordOutgoing[] = []
  const edits: Array<{ channelId: string; messageId: string; message: DiscordOutgoing }> = []
  const bot: DiscordBot = {
    async post(message) {
      posts.push(message)
      return { ok: true, channelId: 'ch-1', messageId: 'reply-1' }
    },
    async edit(channelId, messageId, message) {
      edits.push({ channelId, messageId, message })
      if (opts.editRejects) throw new Error('boom')
      return { ok: true }
    },
  }
  return { bot, posts, edits }
}

const text = (m: unknown): string => JSON.stringify(m)

describe('transitionIssue', () => {
  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc)
  })

  async function setupIssue(severity: 'P0' | 'P1' = 'P1', withRoot = true) {
    store.seedRule(null, { id: 'r', priority: 10, severity, match: {} })
    const processed = await processEvent(store, event, now)
    const issue = processed.issue
    if (withRoot) {
      const base = buildDiscordMessage({
        serviceName: 'svc-a',
        ownerDiscordId: '123456789012345678',
        severity: issue.severity,
        errorType: 'X',
        message: 'x',
        count: 1,
        firstSeen: '2026-07-28T10:09:00.000Z',
        lastSeen: '2026-07-28T10:09:00.000Z',
      })
      await store.recordNotification({
        issueId: issue.id,
        serviceId: 's-1',
        fingerprint: issue.fingerprint,
        severity: issue.severity,
        status: 'sent',
        countAtSend: 1,
        sentAt: '2026-07-28T10:09:30.000Z',
        kind: 'alert',
        incidentSeq: issue.reopenCount,
        discordChannelId: 'ch-1',
        discordMessageId: 'm-1',
        payload: withAlertButtons(base, issue.id, issue.reopenCount, ['ack', 'resolve']),
      })
    }
    return issue
  }

  it('resolving the only P0 issue recovers service health', async () => {
    const issue = await setupIssue('P0', false)
    expect((await store.getService('s-1'))?.healthStatus).toBe('down')
    const r = await transitionIssue(store, null, issue.id, 'resolved', { kind: 'dashboard', email: 'a@b.c' }, now)
    expect(r.outcome).toBe('changed')
    expect(r.issue?.status).toBe('resolved')
    expect(r.issue?.resolvedBy).toBe('a@b.c')
    expect((await store.getService('s-1'))?.healthStatus).toBe('healthy')
  })

  it('acknowledged keeps counting toward health; ignored does not', async () => {
    const issue = await setupIssue('P1', false)
    const actor = { kind: 'dashboard', email: 'a@b.c' } as const
    await transitionIssue(store, null, issue.id, 'acknowledged', actor, now)
    expect((await store.getService('s-1'))?.healthStatus).toBe('degraded')
    await transitionIssue(store, null, issue.id, 'ignored', actor, now)
    expect((await store.getService('s-1'))?.healthStatus).toBe('healthy')
  })

  it('unknown issue returns not_found', async () => {
    const r = await transitionIssue(store, null, 'nope', 'resolved', { kind: 'dashboard', email: 'a@b.c' }, now)
    expect(r.outcome).toBe('not_found')
    expect(r.issue).toBeNull()
  })

  it('ack 從 open：changed、DB 記 actor、bot.edit 收到含「已確認」的 payload', async () => {
    const issue = await setupIssue()
    const f = fakeBot()
    const r = await transitionIssue(store, f.bot, issue.id, 'acknowledged', { kind: 'discord', userId: '111' }, now)
    expect(r.outcome).toBe('changed')
    expect(r.issue?.acknowledgedBy).toBe('discord:111')
    expect(f.edits).toHaveLength(1)
    expect(f.edits[0]).toMatchObject({ channelId: 'ch-1', messageId: 'm-1' })
    expect(text(f.edits[0].message)).toContain('✋ 已確認')
  })

  it('第二次 ack：unchanged、bot 不被呼叫', async () => {
    const issue = await setupIssue()
    const f = fakeBot()
    const actor = { kind: 'discord', userId: '111' } as const
    await transitionIssue(store, f.bot, issue.id, 'acknowledged', actor, now)
    f.edits.length = 0
    const r = await transitionIssue(store, f.bot, issue.id, 'acknowledged', actor, now)
    expect(r.outcome).toBe('unchanged')
    expect(r.rootEdit).toBeNull()
    expect(f.edits).toHaveLength(0)
    expect(f.posts).toHaveLength(0)
  })

  it('resolved（system/poll）：edit 綠色 payload、post 自動恢復回覆、寫 resolve_reply 通知', async () => {
    const issue = await setupIssue()
    const f = fakeBot()
    const r = await transitionIssue(store, f.bot, issue.id, 'resolved', { kind: 'system', source: 'poll' }, now)
    expect(r.issue?.resolvedBy).toBeNull()
    expect(f.edits).toHaveLength(1)
    expect((f.edits[0].message as { embeds: Array<{ color: number }> }).embeds[0].color).toBe(0x2ecc71)
    expect(text(f.edits[0].message)).toContain('自動恢復（輪詢）')
    expect(f.posts).toHaveLength(1)
    expect(text(f.posts[0])).toContain('✅ 已自動恢復')
    expect(text(f.posts[0])).toContain('m-1')
    const replies = store.listNotifications().filter((n) => n.kind === 'resolve_reply')
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({
      status: 'sent',
      discordChannelId: 'ch-1',
      discordMessageId: 'reply-1',
      payload: null,
      incidentSeq: 0,
      issueId: issue.id,
    })
  })

  it('手動 resolved：回覆為「✅ 已解決」', async () => {
    const issue = await setupIssue()
    const f = fakeBot()
    await transitionIssue(store, f.bot, issue.id, 'resolved', { kind: 'dashboard', email: 'a@b.c' }, now)
    expect(text(f.posts[0])).toContain('✅ 已解決')
    expect(text(f.edits[0].message)).toContain('手動：a@b.c')
  })

  it('沒有根訊息：只改 DB，bot 完全不被呼叫', async () => {
    const issue = await setupIssue('P1', false)
    const f = fakeBot()
    const r = await transitionIssue(store, f.bot, issue.id, 'resolved', { kind: 'system', source: 'poll' }, now)
    expect(r.outcome).toBe('changed')
    expect(r.rootEdit).toBeNull()
    expect(f.edits).toHaveLength(0)
    expect(f.posts).toHaveLength(0)
  })

  it('bot.edit reject：outcome 仍 changed、健康度已重算', async () => {
    const issue = await setupIssue('P0')
    const f = fakeBot({ editRejects: true })
    const r = await transitionIssue(store, f.bot, issue.id, 'resolved', { kind: 'system', source: 'poll' }, now)
    expect(r.outcome).toBe('changed')
    expect((await store.getService('s-1'))?.healthStatus).toBe('healthy')
  })

  it('editRoot=false：rootEdit 有值但 bot.edit 未被呼叫', async () => {
    const issue = await setupIssue()
    const f = fakeBot()
    const r = await transitionIssue(store, f.bot, issue.id, 'acknowledged', { kind: 'discord', userId: '1' }, now, {
      editRoot: false,
    })
    expect(r.rootEdit).toMatchObject({ channelId: 'ch-1', messageId: 'm-1' })
    expect(f.edits).toHaveLength(0)
  })

  it('deferFollowUp=true：回傳後健康度尚未重算，呼叫 followUp() 後才有', async () => {
    const issue = await setupIssue('P0', false)
    const r = await transitionIssue(store, null, issue.id, 'resolved', { kind: 'dashboard', email: 'a@b.c' }, now, {
      deferFollowUp: true,
    })
    expect((await store.getService('s-1'))?.healthStatus).toBe('down')
    await r.followUp()
    expect((await store.getService('s-1'))?.healthStatus).toBe('healthy')
  })

  it('refreshHealth=false：不重算健康度', async () => {
    const issue = await setupIssue('P0', false)
    await transitionIssue(store, null, issue.id, 'resolved', { kind: 'system', source: 'poll' }, now, {
      refreshHealth: false,
    })
    expect((await store.getService('s-1'))?.healthStatus).toBe('down')
  })

  it('getIncidentRoot reject：outcome 仍 changed、健康度重算、bot 未被呼叫', async () => {
    const issue = await setupIssue('P0')
    store.getIncidentRoot = async () => {
      throw new Error('db down')
    }
    const f = fakeBot()
    const r = await transitionIssue(store, f.bot, issue.id, 'resolved', { kind: 'system', source: 'poll' }, now)
    expect(r.outcome).toBe('changed')
    expect(r.rootEdit).toBeNull()
    expect((await store.getService('s-1'))?.healthStatus).toBe('healthy')
    expect(f.edits).toHaveLength(0)
    expect(f.posts).toHaveLength(0)
  })

  it('ack -> 靜默計數 -> resolve：最終根訊息同時含已確認與最新次數', async () => {
    const issue = await setupIssue()
    const f = fakeBot()
    await transitionIssue(store, f.bot, issue.id, 'acknowledged', { kind: 'discord', userId: '111' }, now)
    await processEvent(store, event, now)
    await processEvent(store, event, now)
    f.edits.length = 0
    await transitionIssue(store, f.bot, issue.id, 'resolved', { kind: 'dashboard', email: 'a@b.c' }, now)
    const msg = f.edits[0].message as { embeds: Array<{ fields: Array<{ name: string; value: string }> }> }
    const fields = msg.embeds[0].fields
    expect(fields.some((x) => x.name === '✋ 已確認')).toBe(true)
    expect(fields.find((x) => x.name === '次數')?.value).toBe('3')
  })

  it('dashboard 改回 open：編輯無 content、allowed_mentions 為 {parse: []}', async () => {
    const issue = await setupIssue()
    const f = fakeBot()
    const stored = await store.getIncidentRoot(issue.id, 0)
    expect(stored?.payload.content).toContain('<@123456789012345678>')
    await store.transitionIssueStatus(issue.id, 'resolved', ['open'], null, now.toISOString())
    await transitionIssue(store, f.bot, issue.id, 'open', { kind: 'dashboard', email: 'a@b.c' }, now)
    const sent = f.edits[0].message as { content?: string; allowed_mentions: unknown }
    expect(sent.content).toBeUndefined()
    expect(sent.allowed_mentions).toEqual({ parse: [] })
  })

  it('expectedReopenCount 不符：changed=false 且 DB 不變', async () => {
    const issue = await setupIssue('P1', false)
    const r = await store.transitionIssueStatus(issue.id, 'acknowledged', ['open'], 'x', now.toISOString(), 7)
    expect(r?.changed).toBe(false)
    expect((await store.getIssue(issue.id))?.status).toBe('open')
    const ok = await store.transitionIssueStatus(issue.id, 'acknowledged', ['open'], 'x', now.toISOString(), 0)
    expect(ok?.changed).toBe(true)
  })
})
