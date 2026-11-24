import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createServiceRoleClient, cleanDatabase } from './helpers'
import { SupabaseStore } from '@/store/supabase'
import type { NewSecurityScan } from '@/store/contracts'
import type { SecurityFindingWrite } from '@/core/security/findings'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/db/database.types'

let client: SupabaseClient<Database>
let store: SupabaseStore
let serviceId: string

const finding = (over: Partial<SecurityFindingWrite> = {}): SecurityFindingWrite => ({
  serviceId,
  fingerprint: 'ports:22',
  check: 'ports',
  status: 'open',
  severity: 'high',
  title: 'SSH 對外開放',
  recommendation: '限制來源',
  keyFallback: false,
  firstSeenAt: '2026-11-20T00:00:00.000Z',
  lastSeenAt: '2026-11-20T00:00:00.000Z',
  statusChangedAt: '2026-11-20T00:00:00.000Z',
  statusChangedBy: 'system',
  reopenCount: 0,
  missedCount: 0,
  ...over,
})

const scan = (scannedAt: string): NewSecurityScan => ({
  serviceId,
  scannedAt,
  kind: 'vm',
  checks: {} as unknown as NewSecurityScan['checks'],
  findings: [],
  certs: [],
  logVolume: [],
  exposure: [],
  inventory: null,
})

beforeAll(() => {
  client = createServiceRoleClient()
  store = new SupabaseStore(client)
})

beforeEach(async () => {
  await cleanDatabase(client)
  const a = await client.from('services').insert({ name: 'svc-find' }).select('id').single()
  if (a.error) throw a.error
  serviceId = a.data.id
})

describe('SupabaseStore 資安發現', () => {
  it('upsert inserts then updates same fingerprint', async () => {
    await store.upsertSecurityFindings([finding()])
    const [existing] = await store.listSecurityFindings(serviceId)
    await store.upsertSecurityFindings([finding({ title: '新標題', lastSeenAt: '2026-11-21T00:00:00.000Z', reopenCount: 1, id: existing.id, expectedStatus: 'open' })])
    const rows = await store.listSecurityFindings(serviceId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ title: '新標題', reopenCount: 1, check: 'ports', statusChangedBy: 'system' })
    expect(Date.parse(rows[0].lastSeenAt)).toBe(Date.parse('2026-11-21T00:00:00.000Z'))
  })

  it('upsert keeps manual status change made after the list', async () => {
    await store.upsertSecurityFindings([finding()])
    const [stale] = await store.listSecurityFindings(serviceId)
    expect(await store.setSecurityFindingStatus(stale.id, 'ignored', 'open', 'a@x.com', '2026-11-22T00:00:00.000Z')).toBe(true)
    await store.upsertSecurityFindings([finding({ title: '掃描覆寫', id: stale.id, expectedStatus: 'open' })])
    const [after] = await store.listSecurityFindings(serviceId)
    expect(after).toMatchObject({ status: 'ignored', title: stale.title, statusChangedBy: 'a@x.com' })
  })

  it('insert of an already existing fingerprint without id is ignored', async () => {
    await store.upsertSecurityFindings([finding()])
    await store.upsertSecurityFindings([finding({ title: '競態新增' })])
    const rows = await store.listSecurityFindings(serviceId)
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('SSH 對外開放')
  })

  it('conditional status update fails on mismatch', async () => {
    await store.upsertSecurityFindings([finding({ missedCount: 1 })])
    const [row] = await store.listSecurityFindings(serviceId)
    expect(await store.setSecurityFindingStatus(row.id, 'ignored', 'resolved', 'a@x.com', '2026-11-22T00:00:00.000Z')).toBe(false)
    const [after] = await store.listSecurityFindings(serviceId)
    expect(after).toEqual(row)
  })

  it('conditional status update succeeds and resets missedCount', async () => {
    await store.upsertSecurityFindings([finding({ missedCount: 1 })])
    const [row] = await store.listSecurityFindings(serviceId)
    expect(await store.setSecurityFindingStatus(row.id, 'resolved', 'open', 'a@x.com', '2026-11-22T00:00:00.000Z')).toBe(true)
    const [after] = await store.listSecurityFindings(serviceId)
    expect(after).toMatchObject({ status: 'resolved', statusChangedBy: 'a@x.com', missedCount: 0 })
    expect(Date.parse(after.statusChangedAt)).toBe(Date.parse('2026-11-22T00:00:00.000Z'))
  })

  it('getLatestSecurityScanAt returns max scanned_at or null', async () => {
    expect(await store.getLatestSecurityScanAt(serviceId)).toBeNull()
    await store.insertSecurityScan(scan('2026-11-18T00:00:00.000Z'))
    await store.insertSecurityScan(scan('2026-11-20T00:00:00.000Z'))
    const latest = await store.getLatestSecurityScanAt(serviceId)
    expect(Date.parse(latest!)).toBe(Date.parse('2026-11-20T00:00:00.000Z'))
  })

  it('deleting service cascades findings', async () => {
    await store.upsertSecurityFindings([finding()])
    const del = await client.from('services').delete().eq('id', serviceId)
    expect(del.error).toBeNull()
    const left = await client.from('security_findings').select('id')
    expect(left.data).toHaveLength(0)
  })
})
