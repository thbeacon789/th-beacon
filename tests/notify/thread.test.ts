import { describe, it, expect, vi, afterEach } from 'vitest'
import { postInThread } from '@/notify/thread'
import type { DiscordBot } from '@/notify/discord-bot'
import type { DiscordMessage, DiscordReplyMessage } from '@/notify/message'
import { buildDiscordMessage } from '@/notify/message'

const payload: DiscordMessage = buildDiscordMessage({
  serviceName: 'svc',
  ownerDiscordId: null,
  severity: 'P1',
  errorType: 'X',
  message: 'x'.repeat(300),
  count: 1,
  firstSeen: 'f',
  lastSeen: 'l',
})
const root = { channelId: 'ch-1', messageId: 'm-1', payload }
const build = (replyTo?: string): DiscordReplyMessage => ({
  username: 'th-beacon',
  content: 'hi',
  allowed_mentions: { parse: [] },
  ...(replyTo !== undefined ? { message_reference: { message_id: replyTo, fail_if_not_exists: false as const } } : {}),
})

function fakeBot(postResults: boolean[]) {
  const postTos: Array<{ channelId: string; message: unknown }> = []
  const threads: Array<{ channelId: string; messageId: string; name: string }> = []
  let i = 0
  const bot: DiscordBot = {
    async post() {
      return { ok: false, reason: 'unused' }
    },
    async postTo(channelId, message) {
      postTos.push({ channelId, message })
      const ok = postResults[i++] ?? false
      return ok ? { ok: true, channelId, messageId: 'r-1' } : { ok: false, reason: 'http 500' }
    },
    async startThread(channelId, messageId, name) {
      threads.push({ channelId, messageId, name })
      return { ok: true }
    },
    async edit() {
      return { ok: true }
    },
  }
  return { bot, postTos, threads }
}

describe('postInThread', () => {
  afterEach(() => vi.restoreAllMocks())

  it('討論串直接發送成功 → 只呼叫一次 postTo(messageId)', async () => {
    const f = fakeBot([true])
    const r = await postInThread(f.bot, root, build)
    expect(r.ok).toBe(true)
    expect(f.postTos).toHaveLength(1)
    expect(f.postTos[0].channelId).toBe('m-1')
    expect(f.threads).toHaveLength(0)
  })

  it('第一次失敗 → startThread(channelId, messageId, title 前 100 字) 後重發', async () => {
    const f = fakeBot([false, true])
    const r = await postInThread(f.bot, root, build)
    expect(r.ok).toBe(true)
    expect(f.threads).toHaveLength(1)
    expect(f.threads[0]).toMatchObject({ channelId: 'ch-1', messageId: 'm-1' })
    expect(f.threads[0].name.length).toBeLessThanOrEqual(100)
    expect(f.threads[0].name).toBe((payload.embeds[0].title ?? '').slice(0, 100))
    expect(f.postTos.map((p) => p.channelId)).toEqual(['m-1', 'm-1'])
  })

  it('討論串仍失敗 → 退回 postTo(channelId) 且帶 message_reference', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const f = fakeBot([false, false, true])
    const r = await postInThread(f.bot, root, build)
    expect(r.ok).toBe(true)
    expect(f.postTos).toHaveLength(3)
    expect(f.postTos[2].channelId).toBe('ch-1')
    expect((f.postTos[2].message as DiscordReplyMessage).message_reference?.message_id).toBe('m-1')
  })

  it('全部失敗 → 回 {ok:false}，不 throw', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const f = fakeBot([false, false, false])
    const r = await postInThread(f.bot, root, build)
    expect(r.ok).toBe(false)
  })
})
