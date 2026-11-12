import { describe, it, expect, beforeEach, vi } from 'vitest'
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { handleInteraction, type InteractionResponse } from '@/notify/handle-interaction'
import { processEvent } from '@/pipeline/process-event'
import { InMemoryStore } from '@/store/memory'
import type { ServiceRecord } from '@/store/contracts'
import type { CanonicalEvent } from '@/core/types'
import type { DiscordBot, InteractionResponder } from '@/notify/discord-bot'
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

type Edit = { token: string; data: any }
function fakeResponder() {
  const edits: Edit[] = []
  const followUps: Array<{ token: string; content: string }> = []
  const responder: InteractionResponder = {
    async editOriginal(token, data) {
      edits.push({ token, data })
      return { ok: true }
    },
    async followUp(token, content) {
      followUps.push({ token, content })
      return { ok: true }
    },
  }
  return { responder, edits, followUps }
}

const botPosts: any[] = []
function fakeBot(): DiscordBot {
  return {
    async post(m) {
      botPosts.push(m)
      return { ok: true, channelId: 'ch-1', messageId: 'reply-1' }
    },
    async postTo(_channelId, m) {
      botPosts.push(m)
      return { ok: true, channelId: 'thread-1', messageId: 'reply-1' }
    },
    async startThread() {
      return { ok: true }
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
    token: 'tok-1',
    data: { custom_id: customId },
    ...(shape === 'member' ? { member: { user: { id: userId } } } : { user: { id: userId } }),
  })
  let fr = fakeResponder()
  beforeEach(() => {
    fr = fakeResponder()
    botPosts.length = 0
  })
  const runOn = (st: InMemoryStore, body: unknown, bot: DiscordBot | null = fakeBot()) =>
    handleInteraction(st, bot, fr.responder, config, signed(body), now)
  const run = (body: unknown, bot: DiscordBot | null = fakeBot()) => runOn(store, body, bot)
  /** 回應必須立即是 type 6；執行 after 後 fake responder 才收到內容 */
  const settle = async (r: InteractionResponse) => {
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ type: 6 })
    await r.after?.()
  }
  const lastFollowUp = () => fr.followUps[fr.followUps.length - 1]?.content
  const alertMsg = (id: string, seq = 0) =>
    withAlertButtons(
      buildDiscordMessage({
        serviceName: 'svc-a', severity: 'P1', errorType: 'X', message: 'x', count: 1,
        firstSeen: event.occurredAt, lastSeen: event.occurredAt,
      }),
      id, seq, ['ack', 'resolve'],
    )

  it('缺簽章 header 回 401', async () => {
    const r = await handleInteraction(store, null, fr.responder, config, { rawBody: '{}', signature: null, timestamp: null }, now)
    expect(r.status).toBe(401)
  })

  it('簽章錯誤回 401', async () => {
    const other = generateKeyPairSync('ed25519').privateKey
    const r = await handleInteraction(store, null, fr.responder, config, signed({ type: 1 }, other), now)
    expect(r.status).toBe(401)
  })

  it('JSON 壞掉回 400', async () => {
    const rawBody = '{bad'
    const signature = sign(null, Buffer.from(TS + rawBody), privateKey).toString('hex')
    const r = await handleInteraction(store, null, fr.responder, config, { rawBody, timestamp: TS, signature }, now)
    expect(r.status).toBe(400)
  })

  it('PING 回 type 1', async () => {
    const r = await run({ type: 1 })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ type: 1 })
  })

  it('驗簽後回應產生前不得碰 store；DB 寫入只在 after 之後', async () => {
    const spy = vi.spyOn(store, 'getIssue')
    const r = await run(click(`ack:${issueId}:0`))
    expect(r.body).toEqual({ type: 6 })
    expect(spy).not.toHaveBeenCalled()
    expect((await store.getIssue(issueId))?.status).toBe('open')
    spy.mockClear()
    await r.after?.()
    expect(spy).toHaveBeenCalled()
    expect((await store.getIssue(issueId))?.status).toBe('acknowledged')
    spy.mockRestore()
  })

  it('ack 按鈕 -> 立即 type 6；after 後 editOriginal、DB acknowledged', async () => {
    const r = await run(click(`ack:${issueId}:0`))
    expect(r.after).toBeTypeOf('function')
    await settle(r)
    expect(fr.edits).toHaveLength(1)
    expect(fr.edits[0].token).toBe('tok-1')
    expect(fr.edits[0].data.allowed_mentions).toEqual({ parse: [] })
    expect(fr.edits[0].data).not.toHaveProperty('username')
    expect(fr.followUps).toHaveLength(0)
    // 確認回覆由 transitionIssue 發一次（指向根訊息、不 tag）
    expect(botPosts).toHaveLength(1)
    expect(botPosts[0].content).toBe('🟡 Acknowledged — <@111> · 18:10')
    expect(botPosts[0].allowed_mentions).toEqual({ parse: [] })
    expect(botPosts[0].message_reference).toBeUndefined()
    const issue = await store.getIssue(issueId)
    expect(issue?.status).toBe('acknowledged')
    expect(issue?.acknowledgedBy).toBe('discord:111')
  })

  it('第二次 ack（無 message）-> ephemeral follow-up 已由 <@111> 確認', async () => {
    await settle(await run(click(`ack:${issueId}:0`)))
    fr = fakeResponder()
    await settle(await run(click(`ack:${issueId}:0`, '222')))
    expect(lastFollowUp()).toBe('🟡 Acknowledged — <@111>')
    expect(fr.edits).toHaveLength(0)
  })

  it('ephemeral follow-up 內容為 flags 64（由 responder 負責）且不 throw', async () => {
    await settle(await run(click(`ack:${issueId}:5`)))
    expect(fr.followUps).toHaveLength(1)
  })

  it('第二次 ack 且帶 interaction.message -> editOriginal 收掉確認按鈕（內容不變）並 ephemeral 提示', async () => {
    await settle(await run(click(`ack:${issueId}:0`)))
    fr = fakeResponder()
    botPosts.length = 0
    const msg = alertMsg(issueId)
    const body = { ...click(`ack:${issueId}:0`, '222'), message: { embeds: msg.embeds, components: msg.components } }
    await settle(await run(body))
    expect(lastFollowUp()).toBe('🟡 Acknowledged — <@111>')
    expect(botPosts).toHaveLength(0)
    const data = fr.edits[0].data
    expect(data.flags).toBeUndefined()
    expect(data.embeds).toEqual(msg.embeds)
    expect(JSON.stringify(data.components)).not.toContain(`ack:${issueId}`)
    expect(JSON.stringify(data.components)).toContain(`resolve:${issueId}`)
    expect((await store.getIssue(issueId))?.acknowledgedBy).toBe('discord:111')
  })

  it('resolve 後再按 resolve -> follow-up 此問題已解決', async () => {
    await settle(await run(click(`resolve:${issueId}:0`)))
    expect(botPosts[0].content).toBe('🟢 Resolved — <@111> · 18:10')
    fr = fakeResponder()
    await settle(await run(click(`resolve:${issueId}:0`)))
    expect(lastFollowUp()).toBe('🟢 Resolved')
  })

  it('resolve 後再按帶 message 的 resolve -> 收掉按鈕且內容不變，並 ephemeral 提示', async () => {
    await settle(await run(click(`resolve:${issueId}:0`)))
    fr = fakeResponder()
    const msg = alertMsg(issueId)
    await settle(await run({ ...click(`resolve:${issueId}:0`, '222'), message: { embeds: msg.embeds, components: msg.components } }))
    expect(fr.edits[0].data.embeds).toEqual(msg.embeds)
    expect(fr.edits[0].data.components).toBeUndefined()
    expect(lastFollowUp()).toBe('🟢 Resolved')
  })

  it('incidentSeq 不符 -> 過期 follow-up 且 DB 不變', async () => {
    await settle(await run(click(`ack:${issueId}:5`)))
    expect(lastFollowUp()).toBe('此通知已過期，請看最新一則')
    expect((await store.getIssue(issueId))?.status).toBe('open')
  })

  it('找不到 issue -> 找不到此問題', async () => {
    await settle(await run(click('ack:00000000-0000-4000-8000-000000000000:0')))
    expect(lastFollowUp()).toBe('找不到此問題')
  })

  it('custom_id 亂碼 -> 同步 ephemeral（不碰 DB、不 defer）', async () => {
    const r = await run(click('garbage'))
    const body = r.body as { type: number; data: { content: string; flags: number } }
    expect(body.type).toBe(4)
    expect(body.data.content).toBe('無法辨識的按鈕')
    expect(body.data.flags).toBe(64)
    expect(r.after).toBeUndefined()
  })

  it('DM 形式（user.id）也能取到點擊者', async () => {
    await settle(await run(click(`ack:${issueId}:0`, '333', 'user')))
    expect((await store.getIssue(issueId))?.acknowledgedBy).toBe('discord:333')
  })

  it('沒有根訊息紀錄時以 interaction.message 為底 editOriginal', async () => {
    const bare = new InMemoryStore()
    bare.seedService(svc)
    bare.seedRule(null, { id: 'r', priority: 10, severity: 'P1', match: {} })
    const { issue } = await processEvent(bare, event, now)
    const msg = alertMsg(issue.id)
    const body = { ...click(`ack:${issue.id}:0`), message: { embeds: msg.embeds, components: msg.components } }
    await settle(await runOn(bare, body))
    expect(fr.edits[0].data.embeds).toEqual(msg.embeds)
    expect(JSON.stringify(fr.edits[0].data.components)).not.toContain(`ack:${issue.id}`)
  })

  it('沒有根訊息也沒有 interaction.message -> 不呼叫 Discord', async () => {
    const bare = new InMemoryStore()
    bare.seedService(svc)
    bare.seedRule(null, { id: 'r', priority: 10, severity: 'P1', match: {} })
    const { issue } = await processEvent(bare, event, now)
    await settle(await runOn(bare, click(`ack:${issue.id}:0`)))
    expect(fr.edits).toHaveLength(0)
    expect(fr.followUps).toHaveLength(0)
    expect((await bare.getIssue(issue.id))?.status).toBe('acknowledged')
  })

  it('預檢通過後事故被 reopen（TOCTOU）：不確認新事故，follow-up 已過期', async () => {
    await store.transitionIssueStatus(issueId, 'resolved', ['open'], null, now.toISOString())
    await processEvent(store, event, now) // reopen -> reopenCount 1
    const real = await store.getIssue(issueId)
    expect(real?.reopenCount).toBe(1)
    const spy = vi.spyOn(store, 'getIssue').mockResolvedValueOnce({ ...(real as NonNullable<typeof real>), reopenCount: 0 })
    await settle(await run(click(`ack:${issueId}:0`)))
    spy.mockRestore()
    expect(lastFollowUp()).toBe('此通知已過期，請看最新一則')
    expect((await store.getIssue(issueId))?.status).toBe('open')
    expect((await store.getIssue(issueId))?.acknowledgedBy).toBeNull()
  })

  it('ack 後再 resolve：editOriginal 含最新次數、無已確認欄位、無按鈕', async () => {
    await settle(await run(click(`ack:${issueId}:0`)))
    await processEvent(store, event, now)
    fr = fakeResponder()
    await settle(await run(click(`resolve:${issueId}:0`, '222')))
    const fields = fr.edits[0].data.embeds[0].fields as Array<{ name: string; value: string }>
    expect(fields.some((f) => f.name === '✋ 已確認')).toBe(false)
    expect(fr.edits[0].data.components).toBeUndefined()
    expect(fields.find((f) => f.name === '次數')?.value).toBe('2')
  })

  it('DB 拋錯 -> 不拋出，發「處理失敗」follow-up', async () => {
    const spy = vi.spyOn(store, 'getIssue').mockRejectedValueOnce(new Error('db down'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const r = await run(click(`ack:${issueId}:0`))
    await expect(r.after?.()).resolves.toBeUndefined()
    spy.mockRestore()
    err.mockRestore()
    expect(lastFollowUp()).toBe('處理失敗，請稍後再試')
    expect(fr.edits).toHaveLength(0)
  })
})
