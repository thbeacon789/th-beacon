import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { detectPackageManager, parseNpmAudit, parsePnpmAudit } from '@/core/security/collect/audit'

const load = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8')) as unknown

describe('parsePnpmAudit', () => {
  it('取四個計數與套件清單', () => {
    const r = parsePnpmAudit(load('pnpm-audit.json'))
    expect(r.supported).toBe(true)
    expect(r.counts).toEqual({ low: 2, moderate: 13, high: 12, critical: 5 })
    expect(r.packages).toHaveLength(3)
    expect(r.packages[0].severity).toBe('high')
    expect(r.packages.map((p) => p.name).sort()).toEqual(['postcss', 'postcss', 'sharp'])
    expect(r.packages.at(-1)?.severity).toBe('moderate')
    expect(r.packages[0].title.length).toBeGreaterThan(0)
  })

  it('遇到結構不符會 throw', () => {
    expect(() => parsePnpmAudit(null)).toThrow()
    expect(() => parsePnpmAudit({})).toThrow()
    expect(() => parsePnpmAudit({ metadata: {} })).toThrow()
    expect(() => parsePnpmAudit({ metadata: { vulnerabilities: { low: '1', moderate: 0, high: 0, critical: 0 } } })).toThrow()
    expect(() => parsePnpmAudit({ error: { code: 'ERR_PNPM_AUDIT_BAD_RESPONSE' } })).toThrow()
  })

  it('沒有 advisories 時套件清單為空；清單最多 20 筆', () => {
    const meta = { vulnerabilities: { low: 0, moderate: 0, high: 0, critical: 0 } }
    expect(parsePnpmAudit({ metadata: meta }).packages).toEqual([])
    const advisories = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [String(i), { module_name: `m${i}`, severity: 'low', title: 't' }]))
    expect(parsePnpmAudit({ metadata: meta, advisories }).packages).toHaveLength(20)
  })
})

describe('parseNpmAudit', () => {
  it('取計數與套件，title 取 via 中第一個物件', () => {
    const r = parseNpmAudit(load('npm-audit.json'))
    expect(r.counts).toEqual({ low: 1, moderate: 0, high: 1, critical: 1 })
    expect(r.packages).toEqual([
      { name: 'minimist', severity: 'critical', title: 'Prototype Pollution in minimist' },
      { name: 'lodash', severity: 'high', title: 'Prototype Pollution in lodash' },
      { name: 'left-pad', severity: 'low', title: '' },
    ])
  })

  it('結構不符會 throw', () => {
    expect(() => parseNpmAudit({})).toThrow()
    expect(() => parseNpmAudit('x')).toThrow()
  })
})

describe('detectPackageManager', () => {
  it('依 lockfile 判斷，都沒有回 null', () => {
    expect(detectPackageManager(['package.json', 'pnpm-lock.yaml'])).toBe('pnpm')
    expect(detectPackageManager(['package-lock.json'])).toBe('npm')
    expect(detectPackageManager(['yarn.lock'])).toBe('yarn')
    expect(detectPackageManager(['package.json', 'README.md'])).toBeNull()
    expect(detectPackageManager([])).toBeNull()
  })
})
