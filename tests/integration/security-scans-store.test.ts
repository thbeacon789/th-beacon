import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createServiceRoleClient, cleanDatabase } from './helpers'
import { SupabaseStore } from '@/store/supabase'
import type { NewSecurityScan } from '@/store/contracts'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/db/database.types'

let client: SupabaseClient<Database>
let store: SupabaseStore
let serviceId: string
let otherServiceId: string

const scan = (over: Partial<NewSecurityScan> = {}): NewSecurityScan => ({
  serviceId,
  scannedAt: '2026-11-18T00:00:00.000Z',
  kind: 'vm',
  checks: { ports: { status: 'ok', summary: '無異常' } } as unknown as NewSecurityScan['checks'],
  findings: [],
  certs: [],
  logVolume: [],
  exposure: [],
  inventory: null,
  ...over,
})

beforeAll(() => {
  client = createServiceRoleClient()
  store = new SupabaseStore(client)
})

beforeEach(async () => {
  await cleanDatabase(client)
  const a = await client.from('services').insert({ name: 'svc-sec' }).select('id').single()
  if (a.error) throw a.error
  serviceId = a.data.id
  const b = await client.from('services').insert({ name: 'svc-sec-2' }).select('id').single()
  if (b.error) throw b.error
  otherServiceId = b.data.id
})

describe('SupabaseStore 資安掃描', () => {
  it('新增後可讀出；同 (serviceId, scannedAt) 第二次回 null 且不新增', async () => {
    const r = await store.insertSecurityScan(scan())
    expect(r?.id).toBeTruthy()
    expect(await store.insertSecurityScan(scan({ kind: 'hosted' }))).toBeNull()
    const rows = await store.listSecurityScansBetween(serviceId, '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z')
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(r!.id)
  })

  it('listSecurityScansBetween：含 from、不含 before、升冪、只回該 service', async () => {
    for (const d of ['03', '01', '02', '04']) await store.insertSecurityScan(scan({ scannedAt: `2026-11-${d}T00:00:00.000Z` }))
    await store.insertSecurityScan(scan({ serviceId: otherServiceId, scannedAt: '2026-11-02T00:00:00.000Z' }))
    const rows = await store.listSecurityScansBetween(serviceId, '2026-11-02T00:00:00.000Z', '2026-11-04T00:00:00.000Z')
    expect(rows.map((r) => new Date(r.scannedAt).toISOString())).toEqual(['2026-11-02T00:00:00.000Z', '2026-11-03T00:00:00.000Z'])
  })

  it('jsonb 欄位往返深度相等；inventory null 可往返', async () => {
    const full = scan({
      findings: [{ id: 'f1', severity: 'high', title: 't', recommendation: 'r' }] as unknown as NewSecurityScan['findings'],
      certs: [{ host: 'a.example', notAfter: '2027-01-01T00:00:00.000Z' }] as unknown as NewSecurityScan['certs'],
      logVolume: [{ source: 'nginx', count: 10 }] as unknown as NewSecurityScan['logVolume'],
      exposure: [{ port: 22 }] as unknown as NewSecurityScan['exposure'],
      inventory: { packages: ['a'] } as unknown as NewSecurityScan['inventory'],
    })
    await store.insertSecurityScan(full)
    await store.insertSecurityScan(scan({ scannedAt: '2026-11-19T00:00:00.000Z' }))
    const rows = await store.listSecurityScansBetween(serviceId, '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z')
    expect(rows[0].checks).toEqual(full.checks)
    expect(rows[0].findings).toEqual(full.findings)
    expect(rows[0].certs).toEqual(full.certs)
    expect(rows[0].logVolume).toEqual(full.logVolume)
    expect(rows[0].exposure).toEqual(full.exposure)
    expect(rows[0].inventory).toEqual(full.inventory)
    expect(rows[1].inventory).toBeNull()
  })

  it('purgeSecurityScansBefore 回刪除筆數且只刪更早的', async () => {
    for (const d of ['01', '02', '03']) await store.insertSecurityScan(scan({ scannedAt: `2026-11-${d}T00:00:00.000Z` }))
    expect(await store.purgeSecurityScansBefore('2026-11-03T00:00:00.000Z')).toBe(2)
    const rows = await store.listSecurityScansBetween(serviceId, '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z')
    expect(rows).toHaveLength(1)
  })

  it("recordAiUsage 以 source: 'ci_security' 寫入成功", async () => {
    const r = await store.recordAiUsage({ serviceId, source: 'ci_security', model: 'm', inputTokens: 1, outputTokens: 1, costUsd: null, occurredAt: '2026-11-18T00:00:00.000Z' })
    expect(r.id).toBeTruthy()
  })
})
