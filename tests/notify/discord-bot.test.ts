import { describe, expect, it, vi } from 'vitest'
import { createDiscordBot } from '@/notify/discord-bot'
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
