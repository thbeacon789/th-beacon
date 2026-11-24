import { describe, it, expect } from 'vitest'
import { InMemoryStore } from '@/store/memory'
import type { SecurityFindingWrite } from '@/core/security/findings'
import type { NewSecurityScan } from '@/store/contracts'

const finding = (over: Partial<SecurityFindingWrite> = {}): SecurityFindingWrite => ({
  serviceId: 'svc-1',
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

const scan = (serviceId: string, scannedAt: string): NewSecurityScan => ({
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

describe('InMemoryStore security findings', () => {
  it('upsert inserts then updates same fingerprint', async () => {
    const s = new InMemoryStore()
    await s.upsertSecurityFindings([finding()])
    const [existing] = await s.listSecurityFindings('svc-1')
    await s.upsertSecurityFindings([finding({ title: '新標題', lastSeenAt: '2026-11-21T00:00:00.000Z', id: existing.id, expectedStatus: 'open' })])
    const rows = await s.listSecurityFindings('svc-1')
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('新標題')
    expect(s.listAllSecurityFindings()).toHaveLength(1)
    await s.upsertSecurityFindings([finding({ serviceId: 'svc-2' })])
    expect(await s.listSecurityFindings('svc-1')).toHaveLength(1)
    expect(s.listAllSecurityFindings()).toHaveLength(2)
  })

  it('upsert keeps manual status change made after the list', async () => {
    const s = new InMemoryStore()
    await s.upsertSecurityFindings([finding()])
    const [stale] = await s.listSecurityFindings('svc-1')
    expect(await s.setSecurityFindingStatus(stale.id, 'ignored', 'open', 'a@x.com', '2026-11-22T00:00:00.000Z')).toBe(true)
    await s.upsertSecurityFindings([finding({ title: '掃描覆寫', id: stale.id, expectedStatus: 'open' })])
    const [after] = await s.listSecurityFindings('svc-1')
    expect(after).toMatchObject({ status: 'ignored', title: stale.title, statusChangedBy: 'a@x.com' })
  })

  it('insert of an already existing fingerprint without id is ignored', async () => {
    const s = new InMemoryStore()
    await s.upsertSecurityFindings([finding()])
    await s.upsertSecurityFindings([finding({ title: '競態新增' })])
    const rows = await s.listSecurityFindings('svc-1')
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('SSH 對外開放')
  })

  it('conditional status update fails on mismatch', async () => {
    const s = new InMemoryStore()
    await s.upsertSecurityFindings([finding({ missedCount: 1 })])
    const [row] = await s.listSecurityFindings('svc-1')
    expect(await s.setSecurityFindingStatus(row.id, 'ignored', 'resolved', 'a@x.com', '2026-11-22T00:00:00.000Z')).toBe(false)
    const [after] = await s.listSecurityFindings('svc-1')
    expect(after).toEqual(row)
    expect(await s.setSecurityFindingStatus('nope', 'ignored', 'open', 'a@x.com', '2026-11-22T00:00:00.000Z')).toBe(false)
  })

  it('conditional status update succeeds and resets missedCount', async () => {
    const s = new InMemoryStore()
    await s.upsertSecurityFindings([finding({ missedCount: 1 })])
    const [row] = await s.listSecurityFindings('svc-1')
    expect(await s.setSecurityFindingStatus(row.id, 'resolved', 'open', 'a@x.com', '2026-11-22T00:00:00.000Z')).toBe(true)
    const [after] = await s.listSecurityFindings('svc-1')
    expect(after).toMatchObject({ status: 'resolved', statusChangedAt: '2026-11-22T00:00:00.000Z', statusChangedBy: 'a@x.com', missedCount: 0 })
  })

  it('getLatestSecurityScanAt returns max scanned_at or null', async () => {
    const s = new InMemoryStore()
    expect(await s.getLatestSecurityScanAt('svc-1')).toBeNull()
    await s.insertSecurityScan(scan('svc-1', '2026-11-18T00:00:00.000Z'))
    await s.insertSecurityScan(scan('svc-1', '2026-11-20T00:00:00.000Z'))
    await s.insertSecurityScan(scan('svc-2', '2026-11-22T00:00:00.000Z'))
    expect(await s.getLatestSecurityScanAt('svc-1')).toBe('2026-11-20T00:00:00.000Z')
  })
})
