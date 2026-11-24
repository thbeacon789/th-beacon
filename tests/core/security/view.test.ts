import { describe, it, expect } from 'vitest'
import { evaluateCert, isScanStale, overallStatus, buildSecurityView } from '@/core/security/view'
import type { StoredSecurityScan } from '@/core/security/view'
import type { CheckResult, Finding } from '@/core/security/types'

const now = new Date('2026-11-19T00:00:00.000Z')
const DAY = 86400000
const inDays = (d: number) => new Date(now.getTime() + d * DAY).toISOString()
const ok: CheckResult = { status: 'ok', summary: '正常' }

function scan(over: Partial<StoredSecurityScan> = {}): StoredSecurityScan {
  return {
    id: 's1',
    serviceId: 'svc1',
    scannedAt: '2026-11-18T23:00:00.000Z',
    kind: 'vm',
    checks: { ports: ok, updates: ok, logins: ok, logVolume: ok, exposure: ok, changes: ok, deps: ok },
    findings: [],
    certs: [],
    logVolume: [],
    exposure: [],
    inventory: null,
    deps: null,
    ...over,
  }
}

function f(check: Finding['check'], severity: Finding['severity'], title = 't'): Finding {
  return { check, key: '_fallback', severity, title, recommendation: 'r' }
}

describe('evaluateCert', () => {
  it('空陣列回 unknown', () => {
    expect(evaluateCert([], now)).toEqual({ check: { status: 'unknown', summary: '未檢查' }, findings: [] })
  })
  it('憑證剩 13 天為 bad、14 天為 warn、29 天為 warn、30 天為 ok', () => {
    const at = (d: number) => evaluateCert([{ domain: 'a.com', notAfter: inDays(d) }], now)
    expect(at(13).check.status).toBe('bad')
    expect(at(13).findings[0].severity).toBe('high')
    expect(at(14).check.status).toBe('warn')
    expect(at(14).findings[0].severity).toBe('medium')
    expect(at(29).check.status).toBe('warn')
    expect(at(30).check).toEqual({ status: 'ok', summary: '剩 30 天' })
    expect(at(30).findings).toEqual([])
    expect(at(13).check.summary).toBe('剩 13 天')
    expect(at(13).findings[0].title).toBe('a.com 的 SSL 憑證剩 13 天到期')
    expect(at(13).findings[0].recommendation).toBe('更新憑證，並確認自動續期是否正常')
  })
  it('已過期為 bad 且 summary 為「已過期」', () => {
    const r = evaluateCert([{ domain: 'a.com', notAfter: now.toISOString() }], now)
    expect(r.check).toEqual({ status: 'bad', summary: '已過期' })
    expect(r.findings[0]).toMatchObject({ check: 'cert', severity: 'high', title: 'a.com 的 SSL 憑證已過期' })
  })
  it('不受信任但還有 90 天：bad，summary 為「憑證不受信任」，並有 high 發現', () => {
    const r = evaluateCert([{ domain: 'a.com', notAfter: inDays(90), trusted: false, error: 'SELF_SIGNED' }], now)
    expect(r.check).toEqual({ status: 'bad', summary: '憑證不受信任' })
    expect(r.findings).toEqual([{
      check: 'cert', key: '_fallback', severity: 'high',
      title: 'a.com 的 SSL 憑證不受信任（SELF_SIGNED）',
      recommendation: '檢查憑證鏈與網域名稱是否相符，重新簽發憑證',
    }])
  })
  it('不受信任且未帶 error：原因顯示「未知原因」；已過期時兩筆發現都列出', () => {
    const r = evaluateCert([{ domain: 'a.com', notAfter: now.toISOString(), trusted: false }], now)
    expect(r.check.status).toBe('bad')
    expect(r.findings.map((f) => f.title)).toEqual(['a.com 的 SSL 憑證不受信任（未知原因）', 'a.com 的 SSL 憑證已過期'])
  })
  it('trusted 為 true 或未帶：行為與到期判定相同', () => {
    expect(evaluateCert([{ domain: 'a.com', notAfter: inDays(90), trusted: true }], now).check.status).toBe('ok')
    expect(evaluateCert([{ domain: 'a.com', notAfter: inDays(90) }], now)).toEqual(
      evaluateCert([{ domain: 'a.com', notAfter: inDays(90), trusted: true }], now),
    )
  })
  it('多張憑證取最早到期者', () => {
    const r = evaluateCert(
      [{ domain: 'late.com', notAfter: inDays(100) }, { domain: 'early.com', notAfter: inDays(5) }],
      now,
    )
    expect(r.check.summary).toBe('剩 5 天')
    expect(r.findings[0].title).toContain('early.com')
  })
})

describe('isScanStale', () => {
  it('30 小時整不算過期，30 小時又 1 分鐘算過期', () => {
    expect(isScanStale(new Date(now.getTime() - 30 * 3600000).toISOString(), now)).toBe(false)
    expect(isScanStale(new Date(now.getTime() - (30 * 60 + 1) * 60000).toISOString(), now)).toBe(true)
  })
})

describe('overallStatus', () => {
  it('na 不計；bad > warn > unknown > ok；全 na 回 unknown', () => {
    expect(overallStatus(['ok', 'na'])).toBe('ok')
    expect(overallStatus(['ok', 'unknown'])).toBe('unknown')
    expect(overallStatus(['unknown', 'warn', 'ok'])).toBe('warn')
    expect(overallStatus(['warn', 'bad', 'unknown'])).toBe('bad')
    expect(overallStatus(['na', 'na'])).toBe('unknown')
    expect(overallStatus([])).toBe('unknown')
  })
})

describe('buildSecurityView', () => {
  it('過期列的 overall 為 unknown，且服務名列入 staleServices', () => {
    const stale = scan({ scannedAt: new Date(now.getTime() - 50.5 * 3600000).toISOString(), findings: [f('ports', 'high')] })
    const v = buildSecurityView([{ serviceName: 'A', scan: stale }, { serviceName: 'B', scan: scan() }], now)
    expect(v.rows[0].stale).toBe(true)
    expect(v.rows[0].overall).toBe('unknown')
    expect(v.staleServices).toEqual([{ serviceName: 'A', hours: 50 }])
  })
  it('非過期列的 bad 憑證使該列 overall 為 bad，staleServices 為空', () => {
    const v = buildSecurityView([{ serviceName: 'A', scan: scan({ certs: [{ domain: 'a.com', notAfter: inDays(5) }] }) }], now)
    expect(v.rows[0].stale).toBe(false)
    expect(v.rows[0].checks.cert.status).toBe('bad')
    expect(v.rows[0].overall).toBe('bad')
    expect(v.staleServices).toEqual([])
  })
  it('rows 依 serviceName 排序，且保留 logVolume', () => {
    const v = buildSecurityView(
      [{ serviceName: 'B', scan: scan() }, { serviceName: 'A', scan: scan({ logVolume: [{ source: 's', error: true }] }) }],
      now,
    )
    expect(v.rows.map((r) => r.serviceName)).toEqual(['A', 'B'])
    expect(v.rows[0].logVolume).toEqual([{ source: 's', error: true }])
  })
  it('舊快照沒有 checks.deps 時不 throw，deps 格為 na', () => {
    const legacy = scan()
    delete (legacy.checks as Partial<typeof legacy.checks>).deps
    const v = buildSecurityView([{ serviceName: 'A', scan: legacy }], now)
    expect(v.rows[0].checks.deps).toEqual({ status: 'na', summary: '' })
  })
  it('deps 為 bad 的快照讓 overall 為 bad，並帶出 deps 明細', () => {
    const deps = [{ image: 'app', digest: null, containers: ['web'], error: 'x' }]
    const v = buildSecurityView([{ serviceName: 'A', scan: scan({ checks: { ...scan().checks, deps: { status: 'bad', summary: '2 高' } }, deps }) }], now)
    expect(v.rows[0].overall).toBe('bad')
    expect(v.rows[0].deps).toEqual(deps)
  })
})
