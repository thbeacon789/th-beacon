import { describe, it, expect } from 'vitest'
import { evaluateDeps } from '@/core/security/deps'
import { MAX_SUMMARY, MAX_TITLE } from '@/core/security/constants'
import type { ImageDeps, DepCounts } from '@/core/security/types'

const counts = (over: Partial<DepCounts> = {}): DepCounts => ({ critical: 0, high: 0, moderate: 0, low: 0, unscored: 0, ...over })
const img = (image: string, c: Partial<DepCounts> = {}): ImageDeps => ({ image, digest: 'sha256:a', containers: ['c'], counts: counts(c), packages: [] })
const failed = (image: string): ImageDeps => ({ image, digest: null, containers: ['c'], error: 'pull failed' })

describe('evaluateDeps', () => {
  it('任一映像檔有 critical → bad，即使另一個失敗', () => {
    const r = evaluateDeps({ images: [img('a/app', { critical: 2 }), failed('b/x')] })
    expect(r.check.status).toBe('bad')
  })
  it('無 critical、有 high → warn', () => {
    expect(evaluateDeps({ images: [img('a/app', { high: 1 }), img('b/x')] }).check.status).toBe('warn')
  })
  it('無 critical／high、有失敗 → unknown', () => {
    expect(evaluateDeps({ images: [img('a/app', { moderate: 3 }), failed('b/x')] }).check.status).toBe('unknown')
  })
  it('只有 moderate／low／unscored → ok；空清單 → na', () => {
    expect(evaluateDeps({ images: [img('a/app', { moderate: 1, low: 2, unscored: 3 })] }).check.status).toBe('ok')
    expect(evaluateDeps({ images: [] }).check.status).toBe('na')
  })
  it('none → na；failed → unknown 並說明', () => {
    expect(evaluateDeps({ none: true }).check.status).toBe('na')
    const r = evaluateDeps({ failed: true })
    expect(r.check).toEqual({ status: 'unknown', summary: '無法取得容器映像檔清單' })
    expect(r.findings).toEqual([])
  })
  it('summary 含數量、映像檔與未能掃描數，且不超長', () => {
    const r = evaluateDeps({ images: [img('altinvest/backend/app', { critical: 2, high: 5 }), img('b/x'), img('c/y'), failed('d/z')] })
    expect(r.check.summary).toContain('4 個映像檔')
    expect(r.check.summary).toContain('critical 2')
    expect(r.check.summary).toContain('high 5')
    expect(r.check.summary).toContain('altinvest/backend/app')
    expect(r.check.summary).toContain('1 個未能掃描')
    expect(r.check.summary.length).toBeLessThanOrEqual(MAX_SUMMARY)
  })
  it('括號最多列 3 個映像檔，超過以「等」結尾；長名稱仍不超長', () => {
    const imgs = ['a', 'b', 'c', 'd'].map((n) => img(`registry.example.com/team/${n.repeat(20)}`, { critical: 1 }))
    const r = evaluateDeps({ images: imgs })
    expect(r.check.summary).toContain('等')
    expect(r.check.summary.length).toBeLessThanOrEqual(MAX_SUMMARY)
    const r2 = evaluateDeps({ images: ['a', 'b', 'c', 'd'].map((n) => img(n, { high: 1 })) })
    expect(r2.check.summary).toContain('a、b、c等')
  })
  it('findings：critical → high、只有 high → medium，其餘不產生', () => {
    const r = evaluateDeps({ images: [img('a/app', { critical: 2, high: 1 }), img('b/x', { high: 4 }), img('c/y', { moderate: 9 }), failed('d/z')] })
    expect(r.findings).toHaveLength(2)
    expect(r.findings[0]).toMatchObject({ check: 'deps', key: 'image:a/app', severity: 'high', recommendation: '升級映像檔內受影響的套件或基礎映像檔後重建部署' })
    expect(r.findings[0].keyFallback).toBeUndefined()
    expect(r.findings[0].title).toContain('a/app')
    expect(r.findings[0].title).toContain('2')
    expect(r.findings[1]).toMatchObject({ check: 'deps', key: 'image:b/x', severity: 'medium' })
    for (const f of r.findings) expect(f.title.length).toBeLessThanOrEqual(MAX_TITLE)
  })
  it('title 過長會截斷', () => {
    const r = evaluateDeps({ images: [img('x'.repeat(300), { critical: 1 })] })
    expect(r.findings[0].title.length).toBeLessThanOrEqual(MAX_TITLE)
  })
})
