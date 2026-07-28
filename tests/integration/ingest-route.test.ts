import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { createServiceRoleClient, cleanDatabase, getLocalSupabaseEnv } from './helpers'
import { POST } from '@/../app/api/ingest/route'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/db/database.types'

let client: SupabaseClient<Database>
let serviceId: string
const secret = 'route-secret'

function signedRequest(body: string, over: Record<string, string> = {}): Request {
  const ts = String(Math.floor(Date.now() / 1000))
  const sig = `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`
  return new Request('http://localhost/api/ingest', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-beacon-service': 'svc-route',
      'x-beacon-timestamp': ts,
      'x-beacon-signature': sig,
      ...over,
    },
    body,
  })
}

beforeAll(() => {
  const { url, secretKey } = getLocalSupabaseEnv()
  process.env.NEXT_PUBLIC_SUPABASE_URL = url
  process.env.SUPABASE_SECRET_KEY = secretKey
  client = createServiceRoleClient()
})

beforeEach(async () => {
  await cleanDatabase(client)
  const { data, error } = await client
    .from('services')
    .insert({ name: 'svc-route', webhook_secret: secret })
    .select('id')
    .single()
  if (error) throw error
  serviceId = data.id
})

describe('POST /api/ingest (route-level, real DB)', () => {
  it('201: signed CI test_failure lands as P1 issue and degrades health', async () => {
    await client.from('triage_rules').insert({
      service_id: null,
      priority: 100,
      severity: 'P1',
      tags: ['ci'],
      match: { errorType: 'test_failure' } as Json,
    })
    const body = JSON.stringify({
      message: 'nightly tests failed: 3 of 120',
      errorType: 'test_failure',
      metadata: { runUrl: 'https://ci.example/run/42' },
    })
    const res = await POST(signedRequest(body))
    expect(res.status).toBe(201)
    const payload = await res.json()
    expect(payload).toMatchObject({ severity: 'P1', health: 'degraded', duplicate: false })

    const { data: issue } = await client
      .from('issues')
      .select('severity,tags,count,error_type')
      .eq('service_id', serviceId)
      .single()
    expect(issue).toMatchObject({ severity: 'P1', tags: ['ci'], count: 1, error_type: 'test_failure' })
    const { data: svc } = await client
      .from('services')
      .select('health_status')
      .eq('id', serviceId)
      .single()
    expect(svc?.health_status).toBe('degraded')
  })

  it('401: tampered signature writes nothing', async () => {
    const body = JSON.stringify({ message: 'x' })
    const res = await POST(signedRequest(body, { 'x-beacon-signature': 'sha256=' + '0'.repeat(64) }))
    expect(res.status).toBe(401)
    const { count } = await client
      .from('issues')
      .select('*', { count: 'exact', head: true })
    expect(count).toBe(0)
  })

  it('422: schema violation reports details', async () => {
    const res = await POST(signedRequest('{"level":7}'))
    expect(res.status).toBe(422)
    const payload = await res.json()
    expect(payload.details).toBeDefined()
  })
})
