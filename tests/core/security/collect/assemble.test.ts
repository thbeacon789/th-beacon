import { describe, it, expect } from 'vitest'
import { applyChangesIgnore, assemblePayload, unknownJudgment, type Judgment, type TargetConfig } from '@/core/security/collect/assemble'
import { parseVmDump } from '@/core/security/collect/vm-dump'
import { parseSecurityScanPayload } from '@/core/security/payload'
import type { Inventory } from '@/core/security/types'
import { readFileSync } from 'node:fs'

const NONCE = '0123456789abcdef0123456789abcdef'
const vm = parseVmDump(readFileSync(new URL('./fixtures/vm-dump.txt', import.meta.url), 'utf8'), NONCE)
const now = new Date('2026-11-18T22:10:00.000Z')

const judgment: Judgment = {
  checks: {
    ports: { status: 'ok', summary: '僅開放 80、443' },
    updates: { status: 'warn', summary: '5 個待更新' },
    logins: { status: 'ok', summary: '無異常' },
  },
  findings: [{ check: 'updates', severity: 'medium', title: 'openssl 待更新', recommendation: 'apt upgrade' }],
}
const base = { service: 's', secretEnv: 'X', domains: ['example.com'] }
const certs = [{ domain: 'example.com', notAfter: '2027-01-01T00:00:00.000Z' }]
const exposure = [{
  domain: 'example.com',
  sensitivePaths: [{ path: '/.env', exposed: false }],
  headers: { hsts: true, contentTypeOptions: true, frameProtection: true, csp: true, referrerPolicy: true },
  legacyTls: false,
}]

describe('applyChangesIgnore', () => {
  const inv: Inventory = {
    users: ['alice', 'bot'], admins: ['alice', 'bot'],
    sshKeys: [{ user: 'bot', fingerprint: 'a' }, { user: 'alice', fingerprint: 'b' }],
    scheduled: [], listeners: [], services: [],
  }
  it('剔除忽略帳號及其金鑰', () => {
    const r = applyChangesIgnore(inv, { users: ['bot'] })
    expect(r.users).toEqual(['alice'])
    expect(r.admins).toEqual(['alice'])
    expect(r.sshKeys).toEqual([{ user: 'alice', fingerprint: 'b' }])
  })
  it('未設定時原樣回傳內容', () => {
    expect(applyChangesIgnore(inv, undefined)).toEqual(inv)
    expect(applyChangesIgnore(inv, {})).toEqual(inv)
  })
})

describe('assemblePayload logSources', () => {
  it('設定的 log 來源在 vm.logVolume 缺席時補成 error', () => {
    const target: TargetConfig = {
      ...base, kind: 'vm',
      logSources: [{ name: 'ghost', type: 'journal', unit: 'ghost.service' }, ...vm.logVolume.map((v) => ({ name: v.source, type: 'journal' as const, unit: 'x' }))],
    }
    const p = assemblePayload({ scannedAt: now.toISOString(), target, judgment, certs, exposure, vm })
    expect(p.logVolume).toContainEqual({ source: 'ghost', error: true })
    expect(p.logVolume!.filter((v) => v.source === 'ghost')).toHaveLength(1)
    for (const v of vm.logVolume) expect(p.logVolume!.filter((x) => x.source === v.source)).toHaveLength(1)
  })
})

describe('unknownJudgment', () => {
  it('vm 三項皆 unknown', () => {
    const j = unknownJudgment('vm')
    expect(Object.values(j.checks).map((c) => c.status)).toEqual(['unknown', 'unknown', 'unknown'])
    expect(j.findings).toEqual([])
  })
  it('hosted 的 ports 與 logins 為 na、updates 為 unknown', () => {
    const j = unknownJudgment('hosted')
    expect(j.checks.ports.status).toBe('na')
    expect(j.checks.logins.status).toBe('na')
    expect(j.checks.updates.status).toBe('unknown')
  })
})

describe('assemblePayload', () => {
  it('vm 的輸出能通過 parseSecurityScanPayload，且套用 changesIgnore、不帶 anomalousHours', () => {
    const target: TargetConfig = { ...base, kind: 'vm', changesIgnore: { users: ['alice'] } }
    const withAnomaly = { ...vm, logVolume: vm.logVolume.map((l) => ({ ...l, anomalousHours: ['2026-11-18T20:00:00Z'] })) }
    const p = assemblePayload({ scannedAt: '2026-11-18T22:00:00.000Z', target, judgment, certs, exposure, vm: withAnomaly })
    const r = parseSecurityScanPayload(JSON.parse(JSON.stringify(p)), now)
    expect(r.ok).toBe(true)
    expect(p.kind).toBe('vm')
    expect(p.inventory?.users).toEqual(['deploy'])
    expect(p.inventory?.sshKeys).toEqual([{ user: 'deploy', fingerprint: 'SHA256:aaa' }])
    expect(p.logVolume).toHaveLength(2)
    expect(JSON.stringify(p.logVolume)).not.toContain('anomalousHours')
  })

  it('hosted 的輸出能通過 parseSecurityScanPayload，且省略 logVolume 與 inventory', () => {
    const target: TargetConfig = { ...base, kind: 'hosted' }
    const j = unknownJudgment('hosted')
    const p = assemblePayload({ scannedAt: '2026-11-18T22:00:00.000Z', target, judgment: j, certs, exposure, vm })
    expect('logVolume' in p).toBe(false)
    expect('inventory' in p).toBe(false)
    expect(parseSecurityScanPayload(JSON.parse(JSON.stringify(p)), now).ok).toBe(true)
  })
})
