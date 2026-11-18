import { describe, it, expect } from 'vitest'
import { InMemoryStore } from '@/store/memory'
import type { NewSecurityScan } from '@/store/contracts'

const scan = (over: Partial<NewSecurityScan> = {}): NewSecurityScan => ({
  serviceId: 'svc-1',
  scannedAt: '2026-11-18T00:00:00.000Z',
  kind: 'vm',
  checks: {} as NewSecurityScan['checks'],
  findings: [],
  certs: [],
  logVolume: [],
  exposure: [],
  inventory: null,
  ...over,
})

describe('InMemoryStore security scans', () => {
  it('新增後可列出並回傳 id', async () => {
    const store = new InMemoryStore()
    const r = await store.insertSecurityScan(scan())
    expect(r).not.toBeNull()
    const all = store.listSecurityScans()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe(r!.id)
  })

  it('同 (serviceId, scannedAt) 第二次回 null 且不新增', async () => {
    const store = new InMemoryStore()
    await store.insertSecurityScan(scan())
    expect(await store.insertSecurityScan(scan({ kind: 'hosted' }))).toBeNull()
    expect(store.listSecurityScans()).toHaveLength(1)
  })

  it('listSecurityScansBetween：含 from、不含 before、升冪、只回該 service', async () => {
    const store = new InMemoryStore()
    await store.insertSecurityScan(scan({ scannedAt: '2026-11-03T00:00:00.000Z' }))
    await store.insertSecurityScan(scan({ scannedAt: '2026-11-01T00:00:00.000Z' }))
    await store.insertSecurityScan(scan({ scannedAt: '2026-11-02T00:00:00.000Z' }))
    await store.insertSecurityScan(scan({ scannedAt: '2026-11-04T00:00:00.000Z' }))
    await store.insertSecurityScan(scan({ serviceId: 'svc-2', scannedAt: '2026-11-02T00:00:00.000Z' }))
    const rows = await store.listSecurityScansBetween('svc-1', '2026-11-02T00:00:00.000Z', '2026-11-04T00:00:00.000Z')
    expect(rows.map((r) => r.scannedAt)).toEqual(['2026-11-02T00:00:00.000Z', '2026-11-03T00:00:00.000Z'])
  })

  it('purgeSecurityScansBefore：某服務所有快照都早於界線時仍保留其最新一筆', async () => {
    const store = new InMemoryStore()
    await store.insertSecurityScan(scan({ scannedAt: '2026-08-01T00:00:00.000Z' }))
    await store.insertSecurityScan(scan({ scannedAt: '2026-08-02T00:00:00.000Z' }))
    await store.insertSecurityScan(scan({ serviceId: 'svc-2', scannedAt: '2026-08-01T00:00:00.000Z' }))
    await store.insertSecurityScan(scan({ serviceId: 'svc-2', scannedAt: '2026-11-03T00:00:00.000Z' }))
    expect(await store.purgeSecurityScansBefore('2026-11-01T00:00:00.000Z')).toBe(2)
    expect(store.listSecurityScans().map((s) => `${s.serviceId}/${s.scannedAt}`).sort()).toEqual([
      'svc-1/2026-08-02T00:00:00.000Z',
      'svc-2/2026-11-03T00:00:00.000Z',
    ])
  })

  it('purgeSecurityScansBefore：沒有任何快照時正常執行', async () => {
    expect(await new InMemoryStore().purgeSecurityScansBefore('2026-11-01T00:00:00.000Z')).toBe(0)
  })

  it('purgeSecurityScansBefore 回刪除筆數且只刪更早的', async () => {
    const store = new InMemoryStore()
    await store.insertSecurityScan(scan({ scannedAt: '2026-11-01T00:00:00.000Z' }))
    await store.insertSecurityScan(scan({ scannedAt: '2026-11-02T00:00:00.000Z' }))
    await store.insertSecurityScan(scan({ scannedAt: '2026-11-03T00:00:00.000Z' }))
    expect(await store.purgeSecurityScansBefore('2026-11-03T00:00:00.000Z')).toBe(2)
    expect(store.listSecurityScans().map((s) => s.scannedAt)).toEqual(['2026-11-03T00:00:00.000Z'])
  })
})
