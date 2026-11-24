import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { handleSecurityScan } from '@/security-scan/handle-security-scan'
import { InMemoryStore } from '@/store/memory'
import type { NewSecurityScan, ServiceRecord } from '@/store/contracts'

const now = new Date('2026-11-18T10:00:00.000Z')
const nowSec = String(Math.floor(now.getTime() / 1000))
const secret = 'svc-secret'

const svc: ServiceRecord = {
  id: 's-1',
  name: 'svc-a',
  healthWindowMinutes: 15,
  healthFailureThreshold: 2,
  healthStatus: 'healthy',
  poll: null,
  discordWebhookUrl: null,
  description: null,
  ownerDiscordIds: [],
}

function sign(sec: string, ts: string, raw: string): string {
  return `sha256=${createHmac('sha256', sec).update(`${ts}.${raw}`).digest('hex')}`
}

function request(
  rawBody: string,
  over: Partial<{ serviceName: string | null; timestamp: string | null; signature: string | null }> = {},
) {
  return { rawBody, serviceName: 'svc-a', timestamp: nowSec, signature: sign(secret, nowSec, rawBody), ...over }
}

const inventory = (extraKeys: Array<{ user: string; fingerprint: string }> = []) => ({
  users: ['alice'],
  admins: ['alice'],
  sshKeys: [{ user: 'alice', fingerprint: 'SHA256:aaa' }, ...extraKeys],
  scheduled: [],
  listeners: [{ proto: 'tcp', port: 22, process: 'sshd' }],
  services: ['nginx'],
})

const hours = (day: string, count: number) =>
  [0, 1, 2, 3].map((h) => ({ hour: `${day}T0${h}:00:00.000Z`, count }))

function payload(over: Record<string, unknown> = {}) {
  return {
    scannedAt: '2026-11-18T09:00:00.000Z',
    kind: 'vm',
    checks: {
      ports: { status: 'ok', summary: '無異常' },
      updates: { status: 'ok', summary: '無待更新' },
      logins: { status: 'ok', summary: '無異常' },
      deps: { status: 'na', summary: '' },
    },
    deps: [],
    findings: [],
    certs: [],
    exposure: [
      {
        domain: 'a.example.com',
        sensitivePaths: [{ path: '/.env', exposed: false }],
        headers: { hsts: true, contentTypeOptions: true, frameProtection: true, csp: true, referrerPolicy: true },
        legacyTls: false,
      },
    ],
    logVolume: [{ source: 'nginx', hourly: hours('2026-11-18', 10) }],
    inventory: inventory(),
    ...over,
  }
}

// 歷史快照直接植入 store：scannedAt 有 2 小時的下限，無法再經 handler 回填
const seed = (store: InMemoryStore, over: Partial<NewSecurityScan> = {}) =>
  store.insertSecurityScan({
    serviceId: 's-1',
    scannedAt: '2026-11-16T09:00:00.000Z',
    kind: 'vm',
    checks: {} as NewSecurityScan['checks'],
    findings: [],
    certs: [],
    logVolume: [],
    exposure: [],
    inventory: null,
    deps: null,
    ...over,
  })

const send = (store: InMemoryStore, body: unknown) => handleSecurityScan(store, request(JSON.stringify(body)), now)

describe('handleSecurityScan', () => {
  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc, secret)
  })

  it('缺 header／未知服務／簽章錯誤皆回 401', async () => {
    const body = JSON.stringify(payload())
    for (const over of [{ serviceName: null }, { timestamp: null }, { signature: null }, { serviceName: 'nope' }, { signature: 'sha256=bad' }]) {
      const res = await handleSecurityScan(store, request(body, over), now)
      expect(res).toEqual({ status: 401, body: { error: 'unauthorized' } })
    }
    expect(store.listSecurityScans()).toHaveLength(0)
  })

  it('非 JSON 回 400；欄位不合法回 422 並附 details', async () => {
    const bad = await handleSecurityScan(store, request('not json'), now)
    expect(bad).toEqual({ status: 400, body: { error: 'invalid JSON' } })
    const res = await send(store, { kind: 'vm' })
    expect(res.status).toBe(422)
    expect((res.body as { error: string; details: unknown[] }).error).toBe('invalid payload')
    expect((res.body as { details: unknown[] }).details.length).toBeGreaterThan(0)
  })

  it('body 超過 512 KB 回 413（驗簽之後）', async () => {
    const big = JSON.stringify({ pad: 'x'.repeat(524288) })
    const res = await handleSecurityScan(store, request(big), now)
    expect(res).toEqual({ status: 413, body: { error: 'payload too large' } })
    // 簽章錯誤仍先回 401
    const unsigned = await handleSecurityScan(store, request(big, { signature: 'sha256=bad' }), now)
    expect(unsigned.status).toBe(401)
  })

  it('首筆 vm 快照回 201：logVolume 與 changes 為 unknown「基準建立中」，exposure 依事實判定', async () => {
    const res = await send(store, payload())
    expect(res.status).toBe(201)
    const checks = (res.body as { checks: Record<string, { status: string; summary: string }> }).checks
    expect(checks.logVolume).toEqual({ status: 'unknown', summary: '基準建立中' })
    expect(checks.changes).toEqual({ status: 'unknown', summary: '基準建立中' })
    expect(checks.exposure.status).toBe('ok')
    expect(checks.ports.status).toBe('ok')
    expect(store.listSecurityScans()).toHaveLength(1)
  })

  it('exposure 有外露路徑時為 bad', async () => {
    const p = payload()
    p.exposure[0].sensitivePaths = [{ path: '/.env', exposed: true }]
    const res = await send(store, p)
    expect((res.body as { checks: Record<string, { status: string }> }).checks.exposure.status).toBe('bad')
  })

  it('三筆歷史後第四筆出現暴增，checks.logVolume 為 bad，findings 多一筆 logVolume 的 high', async () => {
    for (const d of ['2026-11-14', '2026-11-15', '2026-11-16']) {
      await seed(store, { scannedAt: `${d}T09:00:00.000Z`, logVolume: [{ source: 'nginx', hourly: hours(d, 10) }] })
    }
    const res = await send(store, payload({ logVolume: [{ source: 'nginx', hourly: hours('2026-11-18', 5000) }] }))
    expect(res.status).toBe(201)
    expect((res.body as { checks: Record<string, { status: string }> }).checks.logVolume.status).toBe('bad')
    const stored = store.listSecurityScans().find((s) => s.scannedAt === '2026-11-18T09:00:00.000Z')!
    expect(stored.findings.filter((f) => f.check === 'logVolume' && f.severity === 'high')).toHaveLength(1)
  })

  it('儲存的 logVolume 含 anomalousHours', async () => {
    await send(store, payload())
    const stored = store.listSecurityScans()[0]
    expect(stored.logVolume[0]).toHaveProperty('anomalousHours')
  })

  it('第二筆起與最早一筆比對 inventory，新增金鑰使 changes 為 bad', async () => {
    await seed(store, { inventory: inventory() as NewSecurityScan['inventory'] })
    const res = await send(store, payload({ inventory: inventory([{ user: 'alice', fingerprint: 'SHA256:evil' }]) }))
    expect((res.body as { checks: Record<string, { status: string }> }).checks.changes.status).toBe('bad')
    const stored = store.listSecurityScans().find((s) => s.scannedAt === '2026-11-18T09:00:00.000Z')!
    expect(stored.findings.some((f) => f.check === 'changes' && f.severity === 'high')).toBe(true)
  })

  it('同一 scannedAt 重送回 200 { duplicate: true }，store 仍只有一筆', async () => {
    await send(store, payload())
    const res = await send(store, payload())
    expect(res).toEqual({ status: 200, body: { duplicate: true } })
    expect(store.listSecurityScans()).toHaveLength(1)
  })

  it('亂序：先送 09:30、再送 09:00（皆在 2 小時窗內），09:00 那筆不以 09:30 為基準', async () => {
    await send(store, payload({ scannedAt: '2026-11-18T09:30:00.000Z', inventory: inventory([{ user: 'alice', fingerprint: 'SHA256:evil' }]) }))
    const res = await send(store, payload({ scannedAt: '2026-11-18T09:00:00.000Z' }))
    expect(res.status).toBe(201)
    expect((res.body as { checks: Record<string, unknown> }).checks.changes).toEqual({ status: 'unknown', summary: '基準建立中' })
  })

  it('scannedAt 早於現在超過 2 小時回 422，且不寫入', async () => {
    const res = await send(store, payload({ scannedAt: '2026-11-18T07:59:00.000Z' }))
    expect(res.status).toBe(422)
    expect(JSON.stringify((res.body as { details: string[] }).details)).toContain('2 小時')
    expect(store.listSecurityScans()).toHaveLength(0)
  })

  it('其他服務的歷史快照不成為本服務的基準（服務 A 的第一筆仍是「基準建立中」）', async () => {
    store.seedService({ ...svc, id: 's-2', name: 'svc-b' }, 'other-secret')
    await seed(store, {
      serviceId: 's-2',
      scannedAt: '2026-11-17T09:00:00.000Z',
      inventory: { ...inventory(), users: [], admins: [], sshKeys: [], services: [] } as NewSecurityScan['inventory'],
      logVolume: [{ source: 'nginx', hourly: hours('2026-11-17', 10) }],
    })
    const res = await send(store, payload())
    expect(res.status).toBe(201)
    const checks = (res.body as { checks: Record<string, unknown> }).checks
    expect(checks.changes).toEqual({ status: 'unknown', summary: '基準建立中' })
    expect(checks.logVolume).toEqual({ status: 'unknown', summary: '基準建立中' })
  })

  it('hosted 快照的 logVolume 與 changes 為 na，inventory 存 null', async () => {
    const res = await send(store, (() => {
      const p = payload({ kind: 'hosted', logVolume: undefined, inventory: undefined, deps: undefined })
      delete (p.checks as Record<string, unknown>).deps
      return p
    })())
    expect(res.status).toBe(201)
    const checks = (res.body as { checks: Record<string, { status: string }> }).checks
    expect(checks.logVolume.status).toBe('na')
    expect(checks.changes.status).toBe('na')
    expect(store.listSecurityScans()[0].inventory).toBeNull()
    expect(checks.deps).toEqual({ status: 'na', summary: '' })
    expect(store.listSecurityScans()[0].checks.deps).toEqual({ status: 'na', summary: '' })
    expect(store.listSecurityScans()[0].deps).toBeNull()
  })

  it('vm 快照的 deps 檢查與明細原樣存入，findings 含 deps 那筆', async () => {
    const depsFinding = { check: 'deps', key: 'img:app:GHSA-1', severity: 'high', title: 'app 有高風險套件', recommendation: '升級' }
    const deps = [{
      image: 'app', digest: 'sha256:' + 'a'.repeat(64), containers: ['web'],
      counts: { critical: 0, high: 1, moderate: 0, low: 0, unscored: 0 },
      packages: [{ name: 'lodash', version: '4.0.0', ecosystem: 'npm', severity: 'high', ids: ['GHSA-1'] }],
    }]
    const res = await send(store, payload({
      checks: {
        ports: { status: 'ok', summary: '無異常' },
        updates: { status: 'ok', summary: '無待更新' },
        logins: { status: 'ok', summary: '無異常' },
        deps: { status: 'bad', summary: '1 個高風險' },
      },
      deps,
      findings: [depsFinding],
    }))
    expect(res.status).toBe(201)
    const stored = store.listSecurityScans()[0]
    expect(stored.checks.deps).toEqual({ status: 'bad', summary: '1 個高風險' })
    expect(stored.deps).toEqual(deps)
    expect(stored.findings.some((f) => f.check === 'deps')).toBe(true)
  })

  it('vm 有大量 deps finding、judged finding 很少時，不視為 judged 截斷', async () => {
    await store.upsertSecurityFindings([{
      serviceId: 's-1', fingerprint: 'ports:tcp/22', check: 'ports', status: 'open', severity: 'medium',
      title: 't', recommendation: 'r', keyFallback: false, firstSeenAt: '2026-11-01T00:00:00.000Z',
      lastSeenAt: '2026-11-17T00:00:00.000Z', statusChangedAt: '2026-11-01T00:00:00.000Z', statusChangedBy: 'system',
      reopenCount: 0, missedCount: 1,
    }])
    const findings = Array.from({ length: 20 }, (_, i) => ({
      check: 'deps', key: `img:app:GHSA-${i}`, severity: 'high', title: `dep ${i}`, recommendation: 'r',
    }))
    const res = await send(store, payload({
      checks: {
        ports: { status: 'ok', summary: '無異常' },
        updates: { status: 'ok', summary: '無待更新' },
        logins: { status: 'ok', summary: '無異常' },
        deps: { status: 'bad', summary: '20 個' },
      },
      findings,
    }))
    expect(res.status).toBe(201)
    const port = store.listAllSecurityFindings().find((r) => r.fingerprint === 'ports:tcp/22')!
    // 有被檢查到且這次沒出現 → 缺席計數累加（若誤判截斷會維持 1）
    expect(port.missedCount).toBeGreaterThan(1)
  })
  describe('資安發現紀錄 reconcile', () => {
    const certPayload = (scannedAt = '2026-11-18T09:00:00.000Z', over: Record<string, unknown> = {}) =>
      payload({ scannedAt, certs: [{ domain: 'a.example.com', notAfter: '2026-11-23T09:00:00.000Z' }], ...over })

    it('first scan creates open findings', async () => {
      const res = await send(store, certPayload())
      expect(res.status).toBe(201)
      const rows = store.listAllSecurityFindings()
      const cert = rows.find((r) => r.check === 'cert')
      expect(cert).toBeDefined()
      expect(cert!.status).toBe('open')
      expect(cert!.serviceId).toBe('s-1')
    })

    it('second scan same findings creates no duplicates', async () => {
      await send(store, certPayload('2026-11-18T09:00:00.000Z'))
      const before = store.listAllSecurityFindings().length
      await send(store, certPayload('2026-11-18T09:30:00.000Z'))
      const rows = store.listAllSecurityFindings()
      expect(rows).toHaveLength(before)
      expect(rows.find((r) => r.check === 'cert')!.lastSeenAt).toBe('2026-11-18T09:30:00.000Z')
    })

    it('duplicate scannedAt does not reconcile', async () => {
      await send(store, certPayload())
      const spy = vi.spyOn(store, 'upsertSecurityFindings')
      const res = await send(store, certPayload())
      expect(res).toEqual({ status: 200, body: { duplicate: true } })
      expect(spy).not.toHaveBeenCalled()
    })

    it('older scannedAt than latest skips reconcile but stores snapshot', async () => {
      await send(store, certPayload('2026-11-18T09:30:00.000Z'))
      const spy = vi.spyOn(store, 'upsertSecurityFindings')
      const res = await send(store, certPayload('2026-11-18T09:00:00.000Z'))
      expect(res.status).toBe(201)
      expect(spy).not.toHaveBeenCalled()
      expect(store.listSecurityScans()).toHaveLength(2)
    })

    it('reconcile failure still returns 201', async () => {
      vi.spyOn(store, 'upsertSecurityFindings').mockRejectedValue(new Error('boom'))
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const res = await send(store, certPayload())
      expect(res.status).toBe(201)
      expect(store.listSecurityScans()).toHaveLength(1)
      expect(errSpy).toHaveBeenCalled()
      errSpy.mockRestore()
    })

    it('judged list at the cap makes ports/updates/logins uncovered', async () => {
      await store.upsertSecurityFindings([{
        serviceId: 's-1', fingerprint: 'ports:tcp/22', check: 'ports', status: 'open', severity: 'medium',
        title: 't', recommendation: 'r', keyFallback: false, firstSeenAt: '2026-11-01T00:00:00.000Z',
        lastSeenAt: '2026-11-17T00:00:00.000Z', statusChangedAt: '2026-11-01T00:00:00.000Z', statusChangedBy: 'system',
        reopenCount: 0, missedCount: 1,
      }])
      const findings = Array.from({ length: 15 }, (_, i) => ({
        check: 'logins', key: `unexpected-success:10.0.0.${i + 1}`, severity: 'high', title: `login ${i}`, recommendation: 'r',
      }))
      const res = await send(store, payload({ findings }))
      expect(res.status).toBe(201)
      const port = store.listAllSecurityFindings().find((r) => r.fingerprint === 'ports:tcp/22')!
      expect(port).toMatchObject({ status: 'open', missedCount: 1 })
    })

    it('cert findings not stored in snapshot', async () => {
      await send(store, certPayload())
      expect(store.listSecurityScans()[0].findings.some((f) => f.check === 'cert')).toBe(false)
    })
  })
})
