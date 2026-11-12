import { describe, it, expect, beforeEach, vi } from 'vitest'
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { handleInteraction } from '@/notify/handle-interaction'
import { processEvent } from '@/pipeline/process-event'
import { InMemoryStore } from '@/store/memory'
import type { ServiceRecord } from '@/store/contracts'
import type { CanonicalEvent } from '@/core/types'
import type { DiscordBot } from '@/notify/discord-bot'
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

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publicKeyHex = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('hex')
const config = { publicKey: publicKeyHex }
const TS = '1700000000'

function signed(body: unknown, key: KeyObject = privateKey) {
  const rawBody = JSON.stringify(body)
  return { rawBody, timestamp: TS, signature: sign(null, Buffer.from(TS + rawBody), key).toString('hex') }
}

function fakeBot(): DiscordBot {
  return {
    async post() {
      return { ok: true, channelId: 'ch-1', messageId: 'reply-1' }
    },
    async edit() {
      return { ok: true }
    },
  }
}

describe('handleInteraction', () => {
  let store: InMemoryStore
  let issueId: string
  beforeEach(async () => {
    store = new InMemoryStore()
    store.seedService(svc)
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P1', match: {} })
    const { issue } = await processEvent(store, event, now)
    issueId = issue.id
    const base = buildDiscordMessage({
      serviceName: 'svc-a',
      severity: issue.severity,
      errorType: 'X',
      message: 'x',
      count: 1,
      firstSeen: event.occurredAt,
      lastSeen: event.occurredAt,
    })
    await store.recordNotification({
      issueId,
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
  })

  const click = (customId: string, userId = '111', shape: 'member' | 'user' = 'member') => ({
    type: 3,
    data: { custom_id: customId },
    ...(shape === 'member' ? { member: { user: { id: userId } } } : { user: { id: userId } }),
  })
  const run = (body: unknown, bot: DiscordBot | null = fakeBot()) =>
    handleInteraction(store, bot, config, signed(body), now)

  it('缺簽章 header 回 401', async () => {
    const r = await handleInteraction(store, null, config, { rawBody: '{}', signature: null, timestamp: null }, now)
    expect(r.status).toBe(401)
  })

  it('簽章錯誤回 401', async () => {
    const other = generateKeyPairSync('ed25519').privateKey
    const r = await handleInteraction(store, null, config, signed({ type: 1 }, other), now)
    expect(r.status).toBe(401)
  })

  it('PING 回 type 1', async () => {
    const r = await run({ type: 1 })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ type: 1 })
  })

  it('ack 按鈕 -> type 7、DB acknowledged、有 after', async () => {
    const r = await run(click(`ack:${issueId}:0`))
    expect(r.status).toBe(200)
    expect((r.body as { type: number }).type).toBe(7)
    expect((r.body as { data: { allowed_mentions: unknown } }).data.allowed_mentions).toEqual({ parse: [] })
    expect((r.body as { data: object }).data).not.toHaveProperty('username')
    expect(r.after).toBeTypeOf('function')
    const issue = await store.getIssue(issueId)
    expect(issue?.status).toBe('acknowledged')
    expect(issue?.acknowledgedBy).toBe('discord:111')
  })

  it('第二次 ack -> ephemeral 已由 <@111> 確認', async () => {
    await run(click(`ack:${issueId}:0`))
    const r = await run(click(`ack:${issueId}:0`, '222'))
    const body = r.body as { type: number; data: { content: string; flags: number } }
    expect(body.type).toBe(4)
    expect(body.data.flags).toBe(64)
    expect(body.data.content).toBe('已由 <@111> 確認')
  })

  it('第二次 ack 且帶 interaction.message -> type 7 重繪成已確認、收掉確認按鈕（所有人可見）', async () => {
    await run(click(`ack:${issueId}:0`))
    const msg = withAlertButtons(
      buildDiscordMessage({
        serviceName: 'svc-a', severity: 'P1', errorType: 'X', message: 'x', count: 1,
        firstSeen: event.occurredAt, lastSeen: event.occurredAt,
      }),
      issueId, 0, ['ack', 'resolve'],
    )
    const body = { ...click(`ack:${issueId}:0`, '222'), message: { embeds: msg.embeds, components: msg.components } }
    const r = await handleInteraction(store, fakeBot(), config, signed(body), now)
    const out = r.body as { type: number; data: { embeds: unknown[]; components: unknown[]; flags?: number } }
    expect(out.type).toBe(7)
    expect(out.data.flags).toBeUndefined()
    expect(JSON.stringify(out.data.embeds)).toContain('<@111>')
    expect(JSON.stringify(out.data.components)).not.toContain(`ack:${issueId}`)
    expect(JSON.stringify(out.data.components)).toContain(`resolve:${issueId}`)
    expect((await store.getIssue(issueId))?.acknowledgedBy).toBe('discord:111')
  })

  it('resolve 後再按 resolve -> 此問題已解決', async () => {
    await run(click(`resolve:${issueId}:0`))
    const r = await run(click(`resolve:${issueId}:0`))
    expect((r.body as { data: { content: string } }).data.content).toBe('此問題已解決')
  })

  it('incidentSeq 不符 -> 過期 ephemeral 且 DB 不變', async () => {
    const r = await run(click(`ack:${issueId}:5`))
    expect((r.body as { data: { content: string } }).data.content).toBe('此告警已過期，請看最新一則')
    expect((await store.getIssue(issueId))?.status).toBe('open')
  })

  it('找不到 issue -> 找不到此問題', async () => {
    const r = await run(click('ack:00000000-0000-4000-8000-000000000000:0'))
    expect((r.body as { data: { content: string } }).data.content).toBe('找不到此問題')
  })

  it('custom_id 亂碼 -> 無法辨識的按鈕', async () => {
    const r = await run(click('garbage'))
    const body = r.body as { type: number; data: { content: string; flags: number } }
    expect(body.type).toBe(4)
    expect(body.data.content).toBe('無法辨識的按鈕')
    expect(body.data.flags).toBe(64)
  })

  it('DM 形式（user.id）也能取到點擊者', async () => {
    await run(click(`ack:${issueId}:0`, '333', 'user'))
    expect((await store.getIssue(issueId))?.acknowledgedBy).toBe('discord:333')
  })

  it('沒有根訊息紀錄時以 interaction.message 為底回 type 7', async () => {
    const bare = new InMemoryStore()
    bare.seedService(svc)
    bare.seedRule(null, { id: 'r', priority: 10, severity: 'P1', match: {} })
    const { issue } = await processEvent(bare, event, now)
    const msg = withAlertButtons(
      buildDiscordMessage({
        serviceName: 'svc-a', severity: issue.severity, errorType: 'X', message: 'x', count: 1,
        firstSeen: event.occurredAt, lastSeen: event.occurredAt,
      }),
      issue.id, 0, ['ack', 'resolve'],
    )
    const body = { ...click(`ack:${issue.id}:0`), message: { embeds: msg.embeds, components: msg.components } }
    const r = await handleInteraction(bare, fakeBot(), config, signed(body), now)
    const out = r.body as { type: number; data: { embeds: unknown[] } }
    expect(out.type).toBe(7)
    expect(JSON.stringify(out.data.embeds)).toContain('已確認')
  })

  it('沒有根訊息也沒有 interaction.message -> type 6', async () => {
    const bare = new InMemoryStore()
    bare.seedService(svc)
    bare.seedRule(null, { id: 'r', priority: 10, severity: 'P1', match: {} })
    const { issue } = await processEvent(bare, event, now)
    const r = await handleInteraction(bare, fakeBot(), config, signed(click(`ack:${issue.id}:0`)), now)
    expect((r.body as { type: number }).type).toBe(6)
  })

  it('預檢通過後事故被 reopen（TOCTOU）：不確認新事故，回已過期', async () => {
    await store.transitionIssueStatus(issueId, 'resolved', ['open'], null, now.toISOString())
    await processEvent(store, event, now) // reopen -> reopenCount 1
    const real = await store.getIssue(issueId)
    expect(real?.reopenCount).toBe(1)
    const spy = vi.spyOn(store, 'getIssue').mockResolvedValueOnce({ ...(real as NonNullable<typeof real>), reopenCount: 0 })
    const r = await run(click(`ack:${issueId}:0`))
    spy.mockRestore()
    expect((r.body as { data: { content: string } }).data.content).toBe('此告警已過期，請看最新一則')
    expect((await store.getIssue(issueId))?.status).toBe('open')
    expect((await store.getIssue(issueId))?.acknowledgedBy).toBeNull()
  })

  it('ack 後再 resolve：type 7 同時含已確認欄位與最新次數', async () => {
    await run(click(`ack:${issueId}:0`))
    await processEvent(store, event, now)
    const r = await run(click(`resolve:${issueId}:0`, '222'))
    const out = r.body as { type: number; data: { embeds: Array<{ fields: Array<{ name: string; value: string }> }> } }
    expect(out.type).toBe(7)
    const fields = out.data.embeds[0].fields
    expect(fields.some((f) => f.name === '✋ 已確認')).toBe(true)
    expect(fields.find((f) => f.name === '次數')?.value).toBe('2')
  })
})
