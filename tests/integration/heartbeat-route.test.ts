import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { createServiceRoleClient, cleanDatabase, getLocalSupabaseEnv } from './helpers'
import { POST } from '@/../app/api/heartbeat/route'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/db/database.types'

let client: SupabaseClient<Database>
let serviceId: string
const secret = 'hb-secret'

function signedRequest(body: string, over: Record<string, string> = {}): Request {
  const ts = String(Math.floor(Date.now() / 1000))
  const sig = `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`
  return new Request('http://localhost/api/heartbeat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-beacon-service': 'svc-hb',
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
    .insert({ name: 'svc-hb', webhook_secret: secret })
    .select('id')
    .single()
  if (error) throw error
  serviceId = data.id

  await client.from('triage_rules').insert({
    service_id: null,
    priority: 100,
    severity: 'P1',
    tags: ['ci'],
    match: { errorType: 'test_failure' } as Json,
  })
  const { error: hbError } = await client.from('heartbeats').insert({
    service_id: serviceId,
    name: 'daily-test',
    interval_seconds: 86_400,
    grace_seconds: 3_600,
    last_run_at: '2026-07-27T03:00:00.000Z',
    last_success_at: '2026-07-27T03:00:00.000Z',
    last_run_status: 'pass',
  })
  if (hbError) throw hbError
})

describe('POST /api/heartbeat (route-level, real DB)', () => {
  it('pass 同時推進 last_run_at 與 last_success_at，且不建立 issue', async () => {
    const body = JSON.stringify({
      name: 'daily-test',
      status: 'pass',
      runUrl: 'https://github.com/o/r/actions/runs/7',
    })
    const res = await POST(signedRequest(body))
    expect(res.status).toBe(200)

    const { data: hb } = await client
      .from('heartbeats')
      .select('last_run_at,last_success_at,last_run_status,last_run_url')
      .eq('service_id', serviceId)
      .single()
    expect(hb?.last_run_status).toBe('pass')
    expect(hb?.last_run_url).toBe('https://github.com/o/r/actions/runs/7')
    expect(hb?.last_run_at).not.toBe('2026-07-27T03:00:00+00:00')
    expect(new Date(hb!.last_success_at as string).getTime()).toBe(
      new Date(hb!.last_run_at as string).getTime(),
    )

    const { data: issues } = await client.from('issues').select('id').eq('service_id', serviceId)
    expect(issues).toHaveLength(0)
  })

  it('fail 只推進 last_run_at，並產生 P1 test_failure issue 與帶 metadata 的 event', async () => {
    const body = JSON.stringify({
      name: 'daily-test',
      status: 'fail',
      runUrl: 'https://github.com/o/r/actions/runs/8',
      summary: '3 of 210 tests failed',
    })
    const res = await POST(signedRequest(body))
    expect(res.status).toBe(200)

    const { data: hb } = await client
      .from('heartbeats')
      .select('last_run_status,last_success_at')
      .eq('service_id', serviceId)
      .single()
    expect(hb?.last_run_status).toBe('fail')
    // last_success_at 必須停在 seed 的時間，不被失敗回報推進
    expect(new Date(hb!.last_success_at as string).toISOString()).toBe('2026-07-27T03:00:00.000Z')

    const { data: issue } = await client
      .from('issues')
      .select('id,severity,error_type,message,status')
      .eq('service_id', serviceId)
      .single()
    expect(issue).toMatchObject({
      severity: 'P1',
      error_type: 'test_failure',
      message: 'Test failed: daily-test',
      status: 'open',
    })

    const { data: event } = await client
      .from('events')
      .select('metadata')
      .eq('issue_id', issue!.id)
      .single()
    expect(event?.metadata).toMatchObject({
      heartbeat: 'daily-test',
      runUrl: 'https://github.com/o/r/actions/runs/8',
      summary: '3 of 210 tests failed',
    })
  })

  it('先 fail 後 pass：test_failure issue 被自動 resolve', async () => {
    await POST(signedRequest(JSON.stringify({ name: 'daily-test', status: 'fail' })))
    const { data: before } = await client
      .from('issues')
      .select('status')
      .eq('service_id', serviceId)
      .single()
    expect(before?.status).toBe('open')

    await POST(signedRequest(JSON.stringify({ name: 'daily-test', status: 'pass' })))
    const { data: after } = await client
      .from('issues')
      .select('status')
      .eq('service_id', serviceId)
      .single()
    expect(after?.status).toBe('resolved')
  })

  it('未登記的心跳名稱回 404 且不產生任何 issue', async () => {
    const res = await POST(signedRequest(JSON.stringify({ name: 'nope', status: 'pass' })))
    expect(res.status).toBe(404)
    const { data: issues } = await client.from('issues').select('id').eq('service_id', serviceId)
    expect(issues).toHaveLength(0)
  })

  it('錯誤簽章回 401', async () => {
    const body = JSON.stringify({ name: 'daily-test', status: 'pass' })
    const res = await POST(signedRequest(body, { 'x-beacon-signature': `sha256=${'0'.repeat(64)}` }))
    expect(res.status).toBe(401)
  })

  it('非法 runUrl（非 http(s) scheme）回 200 並照常記錄 run，但 last_run_url 為 null 且回應帶 warning', async () => {
    const body = JSON.stringify({
      name: 'daily-test',
      status: 'pass',
      runUrl: 'javascript:alert(1)',
    })
    const res = await POST(signedRequest(body))
    expect(res.status).toBe(200)
    const payload = await res.json()
    expect(payload.warnings).toContain('runUrl was rejected: must be an http(s) URL')

    const { data: hb } = await client
      .from('heartbeats')
      .select('last_run_at,last_run_url')
      .eq('service_id', serviceId)
      .single()
    // 存活訊號本身要被記到——不能因為裝飾性欄位格式錯誤就整包被拒
    expect(new Date(hb!.last_run_at as string).toISOString()).not.toBe('2026-07-27T03:00:00.000Z')
    // 但非法 runUrl 絕不能被寫進 DB
    expect(hb?.last_run_url).toBeNull()
  })
})
