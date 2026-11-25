import { describe, expect, it, vi } from 'vitest'
import { sendDiscordWebhookFiles } from '@/notify/discord'
import { createDiscordBot } from '@/notify/discord-bot'
import { buildMultipartBody, type DiscordFile } from '@/notify/discord-files'
import type { DiscordMessage } from '@/notify/message'

const files: DiscordFile[] = [
  { filename: 'a.png', data: new Uint8Array([1, 2, 3]), contentType: 'image/png' },
  { filename: 'b.png', data: new Uint8Array([4, 5]), contentType: 'image/png' },
]
const message = { username: 'th-beacon', content: 'hi', allowed_mentions: { parse: [] } } as unknown as DiscordMessage
const config = { token: 'tok', channelId: 'c1' }

function fakeFetch(status = 200, body: unknown = { id: 'm1' }) {
  return vi.fn(async () => new Response(status === 204 ? null : JSON.stringify(body), { status }))
}

describe('buildMultipartBody', () => {
  it('payload_json 帶 attachments，files[n] 帶檔名與型別', () => {
    const form = buildMultipartBody({ content: 'hi' }, files)
    const payload = JSON.parse(form.get('payload_json') as string)
    expect(payload.content).toBe('hi')
    expect(payload.attachments).toEqual([
      { id: 0, filename: 'a.png' },
      { id: 1, filename: 'b.png' },
    ])
    for (const [i, name] of ['a.png', 'b.png'].entries()) {
      const part = form.get(`files[${i}]`) as File
      expect(part.name).toBe(name)
      expect(part.type).toBe('image/png')
    }
  })
})

describe('bot postFiles', () => {
  it('打對 URL、Authorization、無 content-type、payload 無 username', async () => {
    const f = fakeFetch()
    const result = await createDiscordBot(config, f as unknown as typeof fetch).postFiles(message, files)
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://discord.com/api/v10/channels/c1/messages')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bot tok')
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('content-type')
    const form = init.body as FormData
    expect(form).toBeInstanceOf(FormData)
    const payload = JSON.parse(form.get('payload_json') as string)
    expect(payload).not.toHaveProperty('username')
    expect(payload.content).toBe('hi')
    expect(result).toEqual({ ok: true, channelId: 'c1', messageId: 'm1' })
  })

  it('403 → ok:false', async () => {
    const f = fakeFetch(403, {})
    expect(await createDiscordBot(config, f as unknown as typeof fetch).postFiles(message, files)).toEqual({
      ok: false,
      reason: 'http 403',
    })
  })
})

describe('sendDiscordWebhookFiles', () => {
  it('POST FormData 到 webhookUrl；204 → ok', async () => {
    const f = fakeFetch(204)
    const result = await sendDiscordWebhookFiles('https://x/hook', message, files, f as unknown as typeof fetch)
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://x/hook')
    expect(init.method).toBe('POST')
    expect(init.body).toBeInstanceOf(FormData)
    expect(init.headers).toBeUndefined()
    const payload = JSON.parse((init.body as FormData).get('payload_json') as string)
    expect(payload.username).toBe('th-beacon')
    expect(result).toEqual({ ok: true })
  })

  it('fetch throw → ok:false', async () => {
    const f = vi.fn(async () => {
      throw new Error('boom')
    })
    const result = await sendDiscordWebhookFiles('https://x/hook', message, files, f as unknown as typeof fetch)
    expect(result.ok).toBe(false)
  })
})
