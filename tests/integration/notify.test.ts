import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHmac } from 'node:crypto'
import { createServiceRoleClient, cleanDatabase, getLocalSupabaseEnv } from './helpers'
import { POST } from '@/../app/api/ingest/route'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/db/database.types'

let client: SupabaseClient<Database>
let serviceId: string
let discordStub: Server
let webhookUrl: string
const received: Array<Record<string, unknown>> = []
const secret = 'notify-secret'

function signedRequest(body: string): Request {
  const ts = String(Math.floor(Date.now() / 1000))
  const sig = `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`
  return new Request('http://localhost/api/ingest', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-beacon-service': 'svc-notify',
      'x-beacon-timestamp': ts,
      'x-beacon-signature': sig,
    },
    body,
  })
}

beforeAll(async () => {
  const { url, secretKey } = getLocalSupabaseEnv()
  process.env.NEXT_PUBLIC_SUPABASE_URL = url
  process.env.SUPABASE_SECRET_KEY = secretKey
  client = createServiceRoleClient()

  discordStub = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      received.push(JSON.parse(raw))
      res.writeHead(204).end()
    })
  })
  await new Promise<void>((resolve) => discordStub.listen(0, '127.0.0.1', resolve))
  const address = discordStub.address() as AddressInfo
  webhookUrl = `http://127.0.0.1:${address.port}/webhook`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => discordStub.close((e) => (e ? reject(e) : resolve())))
})

beforeEach(async () => {
  await cleanDatabase(client)
  received.length = 0
  const { data, error } = await client
    .from('services')
    .insert({ name: 'svc-notify', webhook_secret: secret, discord_webhook_url: webhookUrl })
    .select('id')
    .single()
  if (error) throw error
  serviceId = data.id
  await client
    .from('triage_rules')
    .insert({ service_id: null, priority: 10, severity: 'P1', tags: ['ci'], match: { errorType: 'test_failure' } as Json })
  await client.from('triage_rules').insert({
    service_id: null,
    priority: 20,
    severity: 'P0',
    match: { errorType: 'test_failure', minCountInWindow: 3, windowMinutes: 60 } as Json,
  })
})

describe('Discord notifications end-to-end (ingest route → stub webhook)', () => {
  const body = JSON.stringify({ message: 'nightly tests failed', errorType: 'test_failure' })

  it('first P1 sends embed and records notification; cooldown suppresses repeat', async () => {
    const first = await POST(signedRequest(body))
    expect(first.status).toBe(201)
    expect((await first.json()).notified).toBe(true)
    expect(received).toHaveLength(1)
    expect((received[0].embeds as Array<{ title: string }>)[0].title).toBe(
      '[P1] svc-notify — test_failure',
    )

    const second = await POST(signedRequest(body))
    expect((await second.json()).notified).toBe(false)
    expect(received).toHaveLength(1) // 冷卻期內不重發

    const { data: rows } = await client
      .from('notifications')
      .select('severity,status,count_at_send')
      .eq('service_id', serviceId)
    expect(rows).toHaveLength(1)
    expect(rows![0]).toMatchObject({ severity: 'P1', status: 'sent', count_at_send: 1 })
  })

  it('escalation to P0 bypasses cooldown and re-sends', async () => {
    await POST(signedRequest(body)) // count 1 → P1, sent
    await POST(signedRequest(body)) // count 2 → still P1, cooldown
    const third = await POST(signedRequest(body)) // count 3 → P0 escalation
    expect((await third.json())).toMatchObject({ severity: 'P0', notified: true })
    expect(received).toHaveLength(2)
    expect((received[1].embeds as Array<{ title: string }>)[0].title).toBe(
      '[P0] svc-notify — test_failure',
    )
    const { data: rows } = await client
      .from('notifications')
      .select('severity')
      .eq('service_id', serviceId)
      .order('sent_at')
    expect(rows!.map((r) => r.severity)).toEqual(['P1', 'P0'])
  })
})
