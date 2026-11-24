import { describe, expect, it } from 'vitest'
import { evaluateCertFindings } from '../../../src/core/security/cert-findings.ts'

const now = new Date('2026-11-24T00:00:00Z')
const inDays = (d: number) => new Date(now.getTime() + d * 86400000).toISOString()

describe('evaluateCertFindings', () => {
  it('逐網域各自出發現', () => {
    const f = evaluateCertFindings([{ domain: 'a.com', notAfter: inDays(20) }, { domain: 'b.com', notAfter: inDays(10) }], now)
    expect(f.map((x) => [x.key, x.severity])).toEqual([['expiry:a.com', 'medium'], ['expiry:b.com', 'high']])
  })
  it('剩 40 天無發現；已過期 high', () => {
    expect(evaluateCertFindings([{ domain: 'a.com', notAfter: inDays(40) }], now)).toEqual([])
    const f = evaluateCertFindings([{ domain: 'a.com', notAfter: inDays(-1) }], now)
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ key: 'expiry:a.com', severity: 'high' })
  })
  it('不受信任與到期並存', () => {
    const f = evaluateCertFindings([{ domain: 'a.com', notAfter: inDays(5), trusted: false, error: 'self signed' }], now)
    expect(f.map((x) => x.key)).toEqual(['untrusted:a.com', 'expiry:a.com'])
    expect(f[0]).toMatchObject({ severity: 'high', check: 'cert' })
  })
  it('天數以 scannedAt 計', () => {
    const c = [{ domain: 'a.com', notAfter: inDays(20) }]
    expect(evaluateCertFindings(c, now)).toHaveLength(1)
    expect(evaluateCertFindings(c, new Date(now.getTime() - 30 * 86400000))).toEqual([])
  })
  it('空陣列', () => expect(evaluateCertFindings([], now)).toEqual([]))
})
