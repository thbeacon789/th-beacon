import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { createServiceRoleClient, cleanDatabase, getLocalSupabaseEnv } from './helpers'
import { POST } from '@/../app/api/security-scan/route'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/db/database.types'

let client: SupabaseClient<Database>
let serviceId: string
const secret = 'scan-route-secret'

const body = JSON.stringify({
  scannedAt: new Date(Date.now() - 60_000).toISOString(),
  kind: 'hosted',
  checks: {
    ports: { status: 'na', summary: '' },
    updates: { status: 'na', summary: '' },
    logins: { status: 'na', summary: '' },
  },
  findings: [],
  certs: [],
  exposure: [],
})

function signedRequest(raw: string, over: Record<string, string> = {}): Request {
  const ts = String(Math.floor(Date.now() / 1000))
  const sig = `sha256=${createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}`
  return new Request('http://localhost/api/security-scan', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-beacon-service': 'svc-scan',
      'x-beacon-timestamp': ts,
      'x-beacon-signature': sig,
      ...over,
    },
    body: raw,
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
    .insert({ name: 'svc-scan', webhook_secret: secret })
    .select('id')
    .single()
  if (error) throw error
  serviceId = data.id
})

describe('POST /api/security-scan (route-level, real DB)', () => {
  it('201：簽章正確，資料列存在', async () => {
    const res = await POST(signedRequest(body))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.id).toBeTruthy()
    const { data } = await client.from('security_scans').select('id,kind').eq('service_id', serviceId)
    expect(data).toHaveLength(1)
    expect(data![0]).toMatchObject({ id: json.id, kind: 'hosted' })
  })

  it('重送同一 scannedAt 回 200 duplicate，仍只有一筆', async () => {
    expect((await POST(signedRequest(body))).status).toBe(201)
    const again = await POST(signedRequest(body))
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ duplicate: true })
    const { data } = await client.from('security_scans').select('id').eq('service_id', serviceId)
    expect(data).toHaveLength(1)
  })

  it('簽章錯誤回 401 且不寫入', async () => {
    const res = await POST(signedRequest(body, { 'x-beacon-signature': 'sha256=deadbeef' }))
    expect(res.status).toBe(401)
    const { data } = await client.from('security_scans').select('id').eq('service_id', serviceId)
    expect(data).toHaveLength(0)
  })
})
