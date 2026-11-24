import { describe, it, expect } from 'vitest'
import { evaluateExposure } from '@/core/security/exposure'
import type { ExposureFact } from '@/core/security/types'

function fact(over: Partial<ExposureFact> = {}): ExposureFact {
  return {
    domain: 'a.com',
    sensitivePaths: [{ path: '/.env', exposed: false }],
    headers: { hsts: true, contentTypeOptions: true, frameProtection: true, csp: true, referrerPolicy: true },
    legacyTls: false,
    ...over,
  }
}

describe('evaluateExposure', () => {
  it('空陣列回 unknown', () => {
    const r = evaluateExposure([])
    expect(r.check).toEqual({ status: 'unknown', summary: '未檢查' })
    expect(r.findings).toEqual([])
  })
  it('全部良好為 ok', () => {
    expect(evaluateExposure([fact()])).toEqual({ check: { status: 'ok', summary: '正常' }, findings: [] })
  })
  it('敏感路徑暴露為 bad 並產生 high 發現', () => {
    const r = evaluateExposure([fact({ sensitivePaths: [{ path: '/.env', exposed: true }, { path: '/.git/config', exposed: false }] })])
    expect(r.check).toEqual({ status: 'bad', summary: '1 個敏感路徑暴露' })
    expect(r.findings).toEqual([{
      check: 'exposure', key: 'path:a.com|/.env', severity: 'high', title: 'a.com/.env 可被公開存取',
      recommendation: '立即封鎖該路徑，並輪替其中可能外洩的金鑰',
    }])
  })
  it('缺必要標頭為 warn，各一筆 medium', () => {
    const r = evaluateExposure([fact({ headers: { hsts: false, contentTypeOptions: false, frameProtection: false, csp: true, referrerPolicy: true } })])
    expect(r.check).toEqual({ status: 'warn', summary: '缺 3 項防護' })
    expect(r.findings.map((f) => f.title)).toEqual([
      'a.com 缺少 Strict-Transport-Security 標頭',
      'a.com 缺少 X-Content-Type-Options 標頭',
      'a.com 缺少 X-Frame-Options 或 CSP frame-ancestors 標頭',
    ])
    expect(r.findings.every((f) => f.severity === 'medium')).toBe(true)
  })
  it('只缺 csp 與 referrerPolicy 時狀態為 ok，但有 2 筆 low 發現', () => {
    const r = evaluateExposure([fact({ headers: { hsts: true, contentTypeOptions: true, frameProtection: true, csp: false, referrerPolicy: false } })])
    expect(r.check.status).toBe('ok')
    expect(r.findings.map((f) => [f.severity, f.title])).toEqual([
      ['low', 'a.com 缺少 Content-Security-Policy 標頭'],
      ['low', 'a.com 缺少 Referrer-Policy 標頭'],
    ])
  })
  it('key：header 用 headerKey、legacy-tls 用 domain', () => {
    const r = evaluateExposure([fact({ legacyTls: true, headers: { hsts: false, contentTypeOptions: true, frameProtection: true, csp: false, referrerPolicy: true } })])
    expect(r.findings.map((f) => f.key)).toEqual(['header:a.com|hsts', 'legacy-tls:a.com', 'header:a.com|csp'])
  })
  it('legacyTls 為 true 產生 medium', () => {
    const r = evaluateExposure([fact({ legacyTls: true })])
    expect(r.check.status).toBe('warn')
    expect(r.findings[0].title).toBe('a.com 仍接受 TLS 1.0／1.1')
  })
  it('legacyTls 為 null 不產生發現', () => {
    expect(evaluateExposure([fact({ legacyTls: null })]).findings).toEqual([])
  })
  it('多網域取最差', () => {
    const r = evaluateExposure([
      fact({ domain: 'a.com', legacyTls: true }),
      fact({ domain: 'b.com', sensitivePaths: [{ path: '/.env', exposed: true }] }),
    ])
    expect(r.check).toEqual({ status: 'bad', summary: '1 個敏感路徑暴露' })
    expect(r.findings).toHaveLength(2)
  })
})
