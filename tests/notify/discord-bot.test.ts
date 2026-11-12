import { describe, expect, it, vi } from 'vitest'
import { createDiscordBot, createInteractionResponder } from '@/notify/discord-bot'
import type { DiscordMessage } from '@/notify/message'

const message = {
  username: 'beacon',
  allowed_mentions: { parse: [] },
  embeds: [],
} as unknown as DiscordMessage

function fakeFetch(status = 200, body: unknown = { id: 'm1', channel_id: 'c1' }) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }))
}
const config = { token: 'tok', channelId: 'c1' }

describe('createDiscordBot', () => {
  it('post 打對 URL 與 Authorization', async () => {
    const f = fakeFetch()
    await createDiscordBot(config, f as unknown as typeof fetch).post(message)
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://discord.com/api/v10/channels/c1/messages')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bot tok')
    expect(headers['content-type']).toBe('application/json')
  })

  it('post 送出的 body 無 username', async () => {
    const f = fakeFetch()
    await createDiscordBot(config, f as unknown as typeof fetch).post(message)
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1]
    const body = JSON.parse(init.body as string)
    expect('username' in body).toBe(false)
    expect(body.embeds).toEqual([])
  })

  it('post 回傳 response JSON 的 id 作 messageId', async () => {
    const r = await createDiscordBot(config, fakeFetch() as unknown as typeof fetch).post(message)
    expect(r).toEqual({ ok: true, channelId: 'c1', messageId: 'm1' })
  })

  it('edit 用 PATCH 並打對 URL', async () => {
    const f = fakeFetch()
    const r = await createDiscordBot(config, f as unknown as typeof fetch).edit('c9', 'm9', message)
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://discord.com/api/v10/channels/c9/messages/m9')
    expect(init.method).toBe('PATCH')
    expect(r).toEqual({ ok: true })
  })

  it('postTo 打指定 channel（thread id）並回傳該 channelId', async () => {
    const f = fakeFetch()
    const r = await createDiscordBot(config, f as unknown as typeof fetch).postTo('t9', message)
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://discord.com/api/v10/channels/t9/messages')
    expect(init.method).toBe('POST')
    expect(r).toEqual({ ok: true, channelId: 't9', messageId: 'm1' })
  })

  it('startThread：POST /channels/{c}/messages/{m}/threads，body 僅 name＋auto_archive_duration，名稱截 100', async () => {
    const f = fakeFetch(201, { id: 'm9' })
    const r = await createDiscordBot(config, f as unknown as typeof fetch).startThread('c9', 'm9', 'x'.repeat(150))
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://discord.com/api/v10/channels/c9/messages/m9/threads')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bot tok')
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({ name: 'x'.repeat(100), auto_archive_duration: 10080 })
    expect(r).toEqual({ ok: true })
  })

  it('startThread 400（已有 thread）／throw 回 ok:false 不 throw', async () => {
    const bot400 = createDiscordBot(config, fakeFetch(400, {}) as unknown as typeof fetch)
    expect(await bot400.startThread('c', 'm', 'n')).toEqual({ ok: false, reason: 'http 400' })
    const boom = vi.fn(async () => {
      throw new TypeError('x')
    })
    expect(await createDiscordBot(config, boom as unknown as typeof fetch).startThread('c', 'm', 'n')).toEqual({
      ok: false,
      reason: 'TypeError',
    })
  })

  it('http 500 回 ok:false reason http 500', async () => {
    const bot = createDiscordBot(config, fakeFetch(500, {}) as unknown as typeof fetch)
    expect(await bot.post(message)).toEqual({ ok: false, reason: 'http 500' })
    expect(await bot.edit('c', 'm', message)).toEqual({ ok: false, reason: 'http 500' })
  })

  it('fetch throw 回 ok:false', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('boom')
    })
    const r = await createDiscordBot(config, f as unknown as typeof fetch).post(message)
    expect(r).toEqual({ ok: false, reason: 'TypeError' })
  })
})

describe('createInteractionResponder', () => {
  it('editOriginal PATCH @original、無 Authorization；followUp POST ephemeral', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const r = createInteractionResponder({ applicationId: 'app1' }, f)
    expect(await r.editOriginal('tk', { content: 'x' })).toEqual({ ok: true })
    expect(await r.followUp('tk', 'hi')).toEqual({ ok: true })
    expect(calls[0].url).toBe('https://discord.com/api/v10/webhooks/app1/tk/messages/@original')
    expect(calls[0].init.method).toBe('PATCH')
    expect(JSON.stringify(calls[0].init.headers)).not.toContain('Authorization')
    expect(calls[1].url).toBe('https://discord.com/api/v10/webhooks/app1/tk')
    expect(calls[1].init.method).toBe('POST')
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ content: 'hi', flags: 64, allowed_mentions: { parse: [] } })
  })

  it('失敗不 throw', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const f = (async () => {
      throw new Error('boom')
    }) as unknown as typeof fetch
    const r = createInteractionResponder({ applicationId: 'a' }, f)
    expect((await r.followUp('t', 'x')).ok).toBe(false)
    err.mockRestore()
  })
})
