import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServiceRoleClient, cleanDatabase, getLocalSupabaseEnv } from './helpers'
import { GET } from '@/../app/api/poll/services/route'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/db/database.types'

let client: SupabaseClient<Database>
let serviceId: string
let stub: Server
let stubOrigin: string

// stub 行為由測試逐案設定
const stubState = {
  healthStatus: 200,
  errors: [] as Array<Record<string, unknown>>,
  lastErrorsUrl: null as string | null,
}

function cronRequest(token = 'test-cron-secret'): Request {
  return new Request('http://localhost/api/poll/services', {
    headers: { authorization: `Bearer ${token}` },
  })
}

beforeAll(async () => {
  const { url, secretKey } = getLocalSupabaseEnv()
  process.env.NEXT_PUBLIC_SUPABASE_URL = url
  process.env.SUPABASE_SECRET_KEY = secretKey
  process.env.CRON_SECRET = 'test-cron-secret'
  client = createServiceRoleClient()

  stub = createServer((req, res) => {
    if (req.url?.startsWith('/health')) {
      res.writeHead(stubState.healthStatus).end('ok')
      return
    }
    if (req.url?.startsWith('/errors')) {
      stubState.lastErrorsUrl = req.url
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ errors: stubState.errors }))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  const address = stub.address() as AddressInfo
  stubOrigin = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => stub.close((e) => (e ? reject(e) : resolve())))
})

beforeEach(async () => {
  await cleanDatabase(client)
  stubState.healthStatus = 200
  stubState.errors = []
  stubState.lastErrorsUrl = null
  const { data, error } = await client
    .from('services')
    .insert({
      name: 'svc-poll',
      health_failure_threshold: 2,
      poll_health_url: `${stubOrigin}/health`,
      poll_error_url: `${stubOrigin}/errors`,
      poll_interval_seconds: 60,
    })
    .select('id')
    .single()
  if (error) throw error
  serviceId = data.id
  // 判級規則（cleanDatabase 會清 seed，這裡測試自備）
  await client.from('triage_rules').insert({
    service_id: null,
    priority: 100,
    severity: 'P0',
    tags: ['availability'],
    match: { errorType: 'health_check_failed', minCountInWindow: 2, windowMinutes: 15 } as Json,
  })
})

describe('GET /api/poll/services', () => {
  it('401 without or with wrong bearer token', async () => {
    expect((await GET(new Request('http://localhost/api/poll/services'))).status).toBe(401)
    expect((await GET(cronRequest('wrong'))).status).toBe(401)
  })

  it('health failures reach Down at threshold and aggregate one P0 issue', async () => {
    stubState.healthStatus = 500

    const first = await GET(cronRequest())
    expect(first.status).toBe(200)
    expect((await first.json()).polled).toBe(1)

    // 第一輪失敗未達 threshold：不得 Down（threshold gate 真正生效）
    const { data: mid } = await client
      .from('services')
      .select('health_status')
      .eq('id', serviceId)
      .single()
    expect(mid?.health_status).toBe('healthy')

    // 第二次到期：把 last_poll_at 撥回過去
    await client
      .from('services')
      .update({ last_poll_at: new Date(Date.now() - 120_000).toISOString() })
      .eq('id', serviceId)
    await GET(cronRequest())

    const { data: svc } = await client
      .from('services')
      .select('health_status,poll_consecutive_failures,last_poll_healthy')
      .eq('id', serviceId)
      .single()
    expect(svc).toMatchObject({
      health_status: 'down',
      poll_consecutive_failures: 2,
      last_poll_healthy: false,
    })
    const { data: issues } = await client
      .from('issues')
      .select('error_type,severity,status,count')
      .eq('service_id', serviceId)
    expect(issues).toHaveLength(1)
    expect(issues![0]).toMatchObject({
      error_type: 'health_check_failed',
      severity: 'P0',
      status: 'open',
      count: 2,
    })
  })

  it('recovery resolves the health issue and returns to healthy', async () => {
    stubState.healthStatus = 500
    await GET(cronRequest())
    await client
      .from('services')
      .update({ last_poll_at: new Date(Date.now() - 120_000).toISOString() })
      .eq('id', serviceId)
    await GET(cronRequest())

    stubState.healthStatus = 200
    await client
      .from('services')
      .update({ last_poll_at: new Date(Date.now() - 120_000).toISOString() })
      .eq('id', serviceId)
    const res = await GET(cronRequest())
    const body = await res.json()
    expect(body.outcomes[0]).toMatchObject({ healthy: true, healthIssueResolved: true })

    const { data: svc } = await client
      .from('services')
      .select('health_status,poll_consecutive_failures')
      .eq('id', serviceId)
      .single()
    expect(svc).toMatchObject({ health_status: 'healthy', poll_consecutive_failures: 0 })
    const { data: issues } = await client
      .from('issues')
      .select('status')
      .eq('service_id', serviceId)
    expect(issues![0].status).toBe('resolved')
  })

  it('error endpoint backfill dedupes by externalId and advances cursor with since param', async () => {
    stubState.errors = [
      { id: 'e-1', message: 'db down' },
      { id: 'e-2', message: 'io slow' },
    ]
    await GET(cronRequest())

    const { data: afterFirst } = await client
      .from('issues')
      .select('id')
      .eq('service_id', serviceId)
      .neq('error_type', 'health_check_failed')
    expect(afterFirst).toHaveLength(2)

    // 第二輪：同 externalId 應 dedup；cursor 應以 since 參數帶出
    await client
      .from('services')
      .update({ last_poll_at: new Date(Date.now() - 120_000).toISOString() })
      .eq('id', serviceId)
    await GET(cronRequest())
    expect(stubState.lastErrorsUrl).toMatch(/\/errors\?since=/)

    const { data: afterSecond } = await client
      .from('issues')
      .select('count')
      .eq('service_id', serviceId)
      .neq('error_type', 'health_check_failed')
    expect(afterSecond!.every((r) => r.count === 1)).toBe(true)

    const { data: svc } = await client
      .from('services')
      .select('poll_cursor')
      .eq('id', serviceId)
      .single()
    expect(svc?.poll_cursor).not.toBeNull()
  })

  it('skips services polled within their interval', async () => {
    await GET(cronRequest()) // 第一次會輪詢並寫 last_poll_at
    const res = await GET(cronRequest()) // interval 60s 內
    expect((await res.json()).polled).toBe(0)
  })
})
