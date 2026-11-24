import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MAX_DEP_IDS, MAX_DEP_PACKAGES, parseOsvImageScan } from '../../../../src/core/security/collect/osv.ts'

const fixture = (n: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'))

/** 合成輸入：每個 package 一個 group，severity 由 max_severity 或 GHSA 標籤決定 */
function synth(
  pkgs: Array<{ name: string; groups: Array<{ ids: string[]; max?: string; ghsa?: string }> }>,
): unknown {
  return {
    results: [
      {
        packages: pkgs.map((p) => ({
          package: { name: p.name, version: '1.0.0', ecosystem: 'npm' },
          vulnerabilities: p.groups.flatMap((g) =>
            g.ids.map((id) => ({ id, database_specific: g.ghsa ? { severity: g.ghsa } : {} })),
          ),
          groups: p.groups.map((g) => ({ ids: g.ids, max_severity: g.max ?? '' })),
        })),
      },
    ],
  }
}

describe('parseOsvImageScan', () => {
  it('caddy', () => {
    const r = parseOsvImageScan(fixture('osv-caddy.json'))
    expect(r.counts).toEqual({ critical: 1, high: 5, moderate: 5, low: 0, unscored: 3 })
    expect(r.packages).toHaveLength(8)
    expect(r.packages[0]).toMatchObject({ name: 'zlib', ecosystem: 'Alpine:v3.24', severity: 'critical' })
    expect(r.packages.find((p) => p.name === 'github.com/klauspost/compress')?.severity).toBe('unscored')
  })

  it('python（pip 多路徑只算一筆）', () => {
    const r = parseOsvImageScan(fixture('osv-python.json'))
    expect(r.counts).toEqual({ critical: 0, high: 5, moderate: 12, low: 2, unscored: 0 })
    expect(r.packages).toHaveLength(5)
    expect(r.packages.filter((p) => p.name === 'pip')).toHaveLength(1)
    expect(r.packages.find((p) => p.name === 'pip' && p.version === '24.0')?.severity).toBe('moderate')
    expect(r.packages.find((p) => p.name === 'wheel' && p.version === '0.45.1')?.severity).toBe('high')
    expect(r.packages.find((p) => p.name === 'util-linux')?.severity).toBe('high')
  })

  it('empty', () => {
    expect(parseOsvImageScan(fixture('osv-empty.json'))).toEqual({
      counts: { critical: 0, high: 0, moderate: 0, low: 0, unscored: 0 },
      packages: [],
    })
  })

  it('排序：嚴重度再 name 升冪', () => {
    const r = parseOsvImageScan(
      synth([
        { name: 'b', groups: [{ ids: ['x1'], max: '5.0' }] },
        { name: 'z', groups: [{ ids: ['x2'], max: '9.8' }] },
        { name: 'a', groups: [{ ids: ['x3'], max: '5.0' }] },
        { name: 'c', groups: [{ ids: ['x4'] }] },
        { name: 'm', groups: [{ ids: ['x5'], max: '9.1' }] },
      ]),
    )
    expect(r.packages.map((p) => p.name)).toEqual(['m', 'z', 'a', 'b', 'c'])
  })

  it('截斷：packages 20 筆，counts 照實', () => {
    const r = parseOsvImageScan(
      synth(Array.from({ length: 25 }, (_, i) => ({ name: `p${i}`, groups: [{ ids: [`g${i}`], ghsa: 'HIGH' }] }))),
    )
    expect(MAX_DEP_PACKAGES).toBe(20)
    expect(r.packages).toHaveLength(20)
    expect(r.counts.high).toBe(25)
  })

  it('ids：取各 group 第一個、去重、最多 5', () => {
    const r = parseOsvImageScan(
      synth([
        {
          name: 'p',
          groups: [
            { ids: ['A', 'A2'], max: '5' },
            { ids: ['A', 'A3'], max: '5.1' },
            ...['B', 'C', 'D', 'E', 'F', 'G'].map((id) => ({ ids: [id], max: '5' })),
          ],
        },
      ]),
    )
    expect(MAX_DEP_IDS).toBe(5)
    expect(r.packages[0].ids).toEqual(['A', 'B', 'C', 'D', 'E'])
  })

  it('GHSA 標籤優先於 CVSS，取組內最高', () => {
    const r = parseOsvImageScan(
      synth([{ name: 'p', groups: [{ ids: ['g'], max: '9.9', ghsa: 'LOW' }] }]),
    )
    expect(r.packages[0].severity).toBe('low')
    const j = synth([{ name: 'p', groups: [{ ids: ['g1', 'g2'], max: '1.0' }] }]) as any
    j.results[0].packages[0].vulnerabilities[0].database_specific = { severity: 'MODERATE' }
    j.results[0].packages[0].vulnerabilities[1].database_specific = { severity: 'CRITICAL' }
    expect(parseOsvImageScan(j).packages[0].severity).toBe('critical')
  })

  it.each([null, {}, { results: {} }, { results: [{ packages: [{ package: {} }] }] }])('結構不符 throw %#', (bad) => {
    expect(() => parseOsvImageScan(bad)).toThrow()
  })

  it.each([
    ['9.0', 'critical'],
    ['7.0', 'high'],
    ['4.0', 'moderate'],
    ['0.1', 'low'],
    ['', 'unscored'],
    ['0', 'unscored'],
    ['abc', 'unscored'],
  ])('CVSS %s → %s', (max, sev) => {
    const r = parseOsvImageScan(synth([{ name: 'p', groups: [{ ids: ['g'], max }] }]))
    expect(r.packages[0].severity).toBe(sev)
  })
})
