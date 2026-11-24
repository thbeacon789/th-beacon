import { describe, expect, it } from 'vitest'
import {
  isCovered,
  MANUAL_TRANSITIONS,
  reconcileFindings,
  type CoverageInput,
  type SecurityFindingRecord,
} from '../../../src/core/security/findings.ts'
import type { CheckResult, ExposureFact, Finding } from '../../../src/core/security/types.ts'
import type { StoredCheckKey } from '../../../src/core/security/view.ts'

const NOW = '2026-11-24T22:07:00Z'
const ok: CheckResult = { status: 'ok', summary: '' }

function cov(over: Omit<Partial<CoverageInput>, 'checks'> & { checks?: Partial<Record<StoredCheckKey | 'deps', CheckResult>> } = {}): CoverageInput {
  return {
    exposure: [], logVolume: [], evaluatedLogSources: [], judgedTruncated: false, certs: [],
    ...over,
    checks: { ports: ok, updates: ok, logins: ok, logVolume: ok, exposure: ok, changes: ok, ...over.checks },
  }
}
function rec(over: Partial<SecurityFindingRecord> = {}): SecurityFindingRecord {
  return {
    id: 'r1', serviceId: 's1', fingerprint: 'ports:tcp/22', check: 'ports', status: 'open', severity: 'medium',
    title: 'old', recommendation: 'oldrec', keyFallback: false, firstSeenAt: '2026-11-01T00:00:00Z',
    lastSeenAt: '2026-11-23T00:00:00Z', statusChangedAt: '2026-11-01T00:00:00Z', statusChangedBy: 'system',
    reopenCount: 0, missedCount: 0, ...over,
  }
}
function fnd(over: Partial<Finding> = {}): Finding {
  return { check: 'ports', key: 'tcp/22', severity: 'medium', title: 'new', recommendation: 'newrec', ...over }
}
const run = (existing: SecurityFindingRecord[], observed: Finding[], coverage = cov()) =>
  reconcileFindings({ serviceId: 's1', existing, observed, coverage, scannedAt: NOW })
const expo = (over: Partial<ExposureFact> = {}): ExposureFact => ({
  domain: 'a.com', sensitivePaths: [], headers: { hsts: true, contentTypeOptions: true, frameProtection: true, csp: true, referrerPolicy: true },
  legacyTls: false, probeErrors: 0, ...over,
})
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86400000).toISOString()

describe('reconcileFindings', () => {
  it('inserts new observed as open', () => {
    const [w] = run([], [fnd()])
    expect(w).toMatchObject({
      serviceId: 's1', fingerprint: 'ports:tcp/22', check: 'ports', status: 'open', firstSeenAt: NOW, lastSeenAt: NOW,
      reopenCount: 0, missedCount: 0, statusChangedAt: NOW, statusChangedBy: 'system', title: 'new',
    })
  })
  it('open observed updates content and resets missedCount', () => {
    const [w] = run([rec({ missedCount: 1 })], [fnd({ severity: 'high', title: 'fresh' })])
    expect(w).toMatchObject({ status: 'open', missedCount: 0, title: 'fresh', severity: 'high', lastSeenAt: NOW })
    expect(w).toMatchObject({ id: 'r1', expectedStatus: 'open' })
  })
  it('judged open needs 2 covered misses', () => {
    const [a] = run([rec()], [])
    expect(a).toMatchObject({ status: 'open', missedCount: 1 })
    const [b] = run([rec({ missedCount: 1 })], [])
    expect(b).toMatchObject({ status: 'resolved', statusChangedAt: NOW, statusChangedBy: 'system' })
  })
  it('computed open resolves after 1 covered miss', () => {
    const r = rec({ fingerprint: 'exposure:header:a.com|hsts', check: 'exposure' })
    const [w] = run([r], [], cov({ exposure: [expo()] }))
    expect(w).toMatchObject({ status: 'resolved', statusChangedBy: 'system' })
  })
  it('resolved observed reopens', () => {
    const [w] = run([rec({ status: 'resolved', reopenCount: 1, missedCount: 2 })], [fnd()])
    expect(w).toMatchObject({ status: 'open', reopenCount: 2, missedCount: 0, statusChangedAt: NOW, statusChangedBy: 'system' })
  })
  it('ignored observed stays ignored', () => {
    const [w] = run([rec({ status: 'ignored', statusChangedBy: 'a@b.c' })], [fnd({ title: 'fresh' })])
    expect(w).toMatchObject({ status: 'ignored', lastSeenAt: NOW, title: 'fresh', statusChangedBy: 'a@b.c', statusChangedAt: '2026-11-01T00:00:00Z' })
  })
  it('ignored/resolved not observed unchanged', () => {
    expect(run([rec({ status: 'ignored' }), rec({ id: 'r2', fingerprint: 'ports:tcp/80', status: 'resolved' })], [])).toEqual([])
  })
  it('changes never auto-resolves', () => {
    const r = rec({ fingerprint: 'changes:users-added:bob', check: 'changes', missedCount: 5 })
    expect(run([r], [])).toEqual([])
  })
  it('changes resolved re-reported within gap does not reopen', () => {
    const r = rec({ fingerprint: 'changes:x', check: 'changes', status: 'resolved', lastSeenAt: daysAgo(3) })
    const [w] = run([r], [fnd({ check: 'changes', key: 'x' })])
    expect(w).toMatchObject({ status: 'resolved', lastSeenAt: NOW, reopenCount: 0 })
  })
  it('changes resolved re-reported after gap reopens', () => {
    const r = rec({ fingerprint: 'changes:x', check: 'changes', status: 'resolved', lastSeenAt: daysAgo(9) })
    const [w] = run([r], [fnd({ check: 'changes', key: 'x' })])
    expect(w).toMatchObject({ status: 'open', reopenCount: 1 })
  })
  it('na check is not covered', () => {
    expect(run([rec({ missedCount: 1 })], [], cov({ checks: { ports: { status: 'na', summary: '' } } }))).toEqual([])
  })
  it('unknown check is not covered', () => {
    expect(run([rec({ missedCount: 1 })], [], cov({ checks: { ports: { status: 'unknown', summary: '' } } }))).toEqual([])
  })
  it('keyFallback propagates', () => {
    const [w] = run([], [fnd({ key: '_fallback', keyFallback: true })])
    expect(w.keyFallback).toBe(true)
    expect(w.fingerprint).toBe('ports:_fallback')
  })
  it('merges duplicate fingerprints', () => {
    const out = run([], [fnd({ severity: 'medium', title: 'm' }), fnd({ severity: 'high', title: 'h' })])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ severity: 'high', title: 'h' })
  })
  it('merge tie keeps the first', () => {
    const out = run([], [fnd({ title: 'first' }), fnd({ title: 'second' })])
    expect(out[0].title).toBe('first')
  })
  it('clips title to MAX_TITLE', () => {
    const [w] = run([], [fnd({ title: 'x'.repeat(500) })])
    expect(w.title.length).toBe(120)
  })
})

describe('isCovered', () => {
  const c = (fingerprint: string, check: SecurityFindingRecord['check'], coverage: CoverageInput) =>
    isCovered({ check, fingerprint }, coverage)
  it('absent domain is not covered', () => {
    expect(c('exposure:header:a.com|hsts', 'exposure', cov({ exposure: [expo({ domain: 'b.com' })] }))).toBe(false)
    expect(c('exposure:header:a.com|hsts', 'exposure', cov({ exposure: [expo()] }))).toBe(true)
  })
  it('exposure unknown is not covered', () => {
    expect(c('exposure:header:a.com|hsts', 'exposure', cov({ exposure: [expo()], checks: { exposure: { status: 'unknown', summary: '' } } }))).toBe(false)
  })
  it('path needs probeErrors === 0', () => {
    const fp = 'exposure:path:a.com|/.env'
    expect(c(fp, 'exposure', cov({ exposure: [expo({ probeErrors: 1 })] }))).toBe(false)
    expect(c(fp, 'exposure', cov({ exposure: [expo({ probeErrors: undefined })] }))).toBe(false)
    expect(c(fp, 'exposure', cov({ exposure: [expo({ probeErrors: 0 })] }))).toBe(true)
  })
  it('legacy-tls needs non-null', () => {
    const fp = 'exposure:legacy-tls:a.com'
    expect(c(fp, 'exposure', cov({ exposure: [expo({ legacyTls: null })] }))).toBe(false)
    expect(c(fp, 'exposure', cov({ exposure: [expo({ legacyTls: true })] }))).toBe(true)
  })
  it('logVolume source with error is not covered', () => {
    expect(c('logVolume:nginx', 'logVolume', cov({ logVolume: [{ source: 'nginx', error: true }], evaluatedLogSources: ['nginx'] }))).toBe(false)
    expect(c('logVolume:nginx', 'logVolume', cov({ logVolume: [{ source: 'nginx' }], evaluatedLogSources: ['nginx'] }))).toBe(true)
    expect(c('logVolume:nginx', 'logVolume', cov())).toBe(false)
  })
  it('insufficient baseline is not covered', () => {
    expect(c('logVolume:nginx', 'logVolume', cov({ logVolume: [{ source: 'nginx', hourly: [], anomalousHours: [] }], evaluatedLogSources: [] }))).toBe(false)
  })
  it('truncated judged list is not covered', () => {
    expect(c('ports:tcp/22', 'ports', cov({ judgedTruncated: true }))).toBe(false)
    expect(c('updates:security', 'updates', cov({ judgedTruncated: true }))).toBe(false)
    expect(c('ports:tcp/22', 'ports', cov())).toBe(true)
  })
  it('cert domain present is covered', () => {
    const certs = [{ domain: 'a.com', notAfter: NOW }]
    expect(c('cert:expiry:a.com', 'cert', cov({ certs }))).toBe(true)
    expect(c('cert:untrusted:b.com', 'cert', cov({ certs }))).toBe(false)
  })
  it('deps covered only when the deps check ran, regardless of judged truncation', () => {
    const fp = 'deps:image:ghcr.io/a/b'
    expect(c(fp, 'deps', cov())).toBe(false) // hosted／舊快照無 deps
    expect(c(fp, 'deps', cov({ checks: { deps: { status: 'na', summary: '' } } }))).toBe(false)
    expect(c(fp, 'deps', cov({ checks: { deps: ok }, judgedTruncated: true }))).toBe(true)
  })
  it('fallback record uses check-level coverage', () => {
    expect(c('ports:_fallback', 'ports', cov())).toBe(true)
    expect(c('ports:_fallback', 'ports', cov({ checks: { ports: { status: 'unknown', summary: '' } } }))).toBe(false)
  })
})

describe('MANUAL_TRANSITIONS', () => {
  it('matches spec', () => {
    expect(MANUAL_TRANSITIONS).toEqual({ open: ['resolved', 'ignored'], resolved: ['ignored'], ignored: ['open'] })
  })
})
