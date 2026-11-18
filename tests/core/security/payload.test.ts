import { describe, it, expect } from 'vitest'
import { parseSecurityScanPayload } from '@/core/security/payload'

const now = new Date('2026-11-18T22:10:00.000Z')

function validVm(): Record<string, unknown> {
  return {
    scannedAt: '2026-11-18T22:00:00.000Z',
    kind: 'vm',
    checks: {
      ports: { status: 'ok', summary: '僅開放 22、443' },
      updates: { status: 'warn', summary: '3 個待更新套件' },
      logins: { status: 'na', summary: '' },
    },
    findings: [
      { check: 'updates', severity: 'medium', title: 'openssl 待更新', recommendation: '執行 apt upgrade' },
    ],
    certs: [{ domain: 'example.com', notAfter: '2027-01-01T00:00:00.000Z' }],
    exposure: [
      {
        domain: 'example.com',
        sensitivePaths: [{ path: '/.env', exposed: false }],
        headers: { hsts: true, contentTypeOptions: true, frameProtection: true, csp: false, referrerPolicy: true },
        legacyTls: false,
      },
    ],
    logVolume: [
      { source: 'nginx', hourly: [{ hour: '2026-11-18T21:00:00.000Z', count: 120 }] },
      { source: 'auth', error: true },
    ],
    inventory: {
      users: ['alice'],
      admins: ['alice'],
      sshKeys: [{ user: 'alice', fingerprint: 'SHA256:abc' }],
      scheduled: [{ location: '/etc/crontab', schedule: '0 * * * *', executable: '/usr/bin/backup', hash: 'deadbeef' }],
      listeners: [{ proto: 'tcp', port: 22, process: 'sshd' }],
      services: ['nginx'],
    },
  }
}

function bad(mutate: (p: Record<string, any>) => void) {
  const p = validVm()
  mutate(p)
  return parseSecurityScanPayload(p, now)
}

describe('parseSecurityScanPayload', () => {
  it('接受完整的 vm payload', () => {
    expect(parseSecurityScanPayload(validVm(), now)).toEqual({ ok: true, value: validVm() })
  })

  it('接受省略 logVolume 與 inventory 的 hosted payload', () => {
    const p = validVm()
    p.kind = 'hosted'
    p.checks = {
      ports: { status: 'na', summary: '' },
      updates: { status: 'ok', summary: '無待更新' },
      logins: { status: 'na', summary: '' },
    }
    delete p.logVolume
    delete p.inventory
    expect(parseSecurityScanPayload(p, now).ok).toBe(true)
  })

  it('拒絕非物件', () => {
    expect(parseSecurityScanPayload([], now)).toEqual({ ok: false, errors: ['payload 必須是 JSON 物件'] })
    expect(parseSecurityScanPayload(null, now)).toEqual({ ok: false, errors: ['payload 必須是 JSON 物件'] })
  })

  it('拒絕未來時間的 scannedAt', () => {
    expect(bad((p) => { p.scannedAt = '2026-11-18T22:30:00.000Z' }).ok).toBe(false)
  })

  it('接受 10 分鐘內的時鐘偏差', () => {
    expect(bad((p) => { p.scannedAt = '2026-11-18T22:15:00.000Z' }).ok).toBe(true)
  })

  it('拒絕無法解析的 scannedAt', () => {
    expect(bad((p) => { p.scannedAt = 'nope' }).ok).toBe(false)
  })

  it('憑證的 trusted／error 選填欄位：接受合法值，拒絕型別錯誤', () => {
    const r = bad((p) => { p.certs = [{ domain: 'a.com', notAfter: '2027-01-01T00:00:00.000Z', trusted: false, error: ' DEPTH_ZERO_SELF_SIGNED_CERT ' }] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.certs[0]).toEqual({ domain: 'a.com', notAfter: '2027-01-01T00:00:00.000Z', trusted: false, error: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
    expect(bad((p) => { p.certs[0].trusted = 'yes' }).ok).toBe(false)
    expect(bad((p) => { p.certs[0].error = 5 }).ok).toBe(false)
    expect(bad((p) => { p.certs[0].error = 'x'.repeat(121) }).ok).toBe(false)
    expect(bad((p) => { p.certs[0].trusted = true }).ok).toBe(true)
  })

  it('拒絕超過 30 筆 findings', () => {
    const f = { check: 'ports', severity: 'low', title: 't', recommendation: '' }
    expect(bad((p) => { p.findings = Array.from({ length: 31 }, () => f) }).ok).toBe(false)
    expect(bad((p) => { p.findings = Array.from({ length: 30 }, () => f) }).ok).toBe(true)
  })

  it('拒絕超長 title', () => {
    expect(bad((p) => { p.findings[0].title = 'x'.repeat(121) }).ok).toBe(false)
  })

  it('拒絕 title 不是字串', () => {
    expect(bad((p) => { p.findings[0].title = { toString: () => 'x' } }).ok).toBe(false)
  })

  it('拒絕空 title', () => {
    expect(bad((p) => { p.findings[0].title = '  ' }).ok).toBe(false)
  })

  it('拒絕 findings.check 為 beacon 自算的項目', () => {
    expect(bad((p) => { p.findings[0].check = 'exposure' }).ok).toBe(false)
  })

  it('拒絕缺少任一 checks 鍵', () => {
    expect(bad((p) => { delete p.checks.logins }).ok).toBe(false)
  })

  it('拒絕非法 check status 與過長 summary', () => {
    expect(bad((p) => { p.checks.ports.status = 'great' }).ok).toBe(false)
    expect(bad((p) => { p.checks.ports.summary = 'x'.repeat(81) }).ok).toBe(false)
  })

  it('非 na／unknown 的 check 須有非空 summary', () => {
    expect(bad((p) => { p.checks.ports.summary = '' }).ok).toBe(false)
    expect(bad((p) => { p.checks.ports = { status: 'unknown', summary: '' } }).ok).toBe(true)
  })

  it('拒絕錯誤的 kind', () => {
    expect(bad((p) => { p.kind = 'cloud' }).ok).toBe(false)
  })

  it('拒絕壞的 certs', () => {
    expect(bad((p) => { p.certs = [{ domain: '', notAfter: '2027-01-01T00:00:00Z' }] }).ok).toBe(false)
    expect(bad((p) => { p.certs = [{ domain: 'a.com', notAfter: 'x' }] }).ok).toBe(false)
  })

  it('拒絕壞的 exposure', () => {
    expect(bad((p) => { delete p.exposure[0].headers.csp }).ok).toBe(false)
    expect(bad((p) => { p.exposure[0].sensitivePaths[0].path = 'env' }).ok).toBe(false)
  })

  it('接受 legacyTls 為 null', () => {
    expect(bad((p) => { p.exposure[0].legacyTls = null }).ok).toBe(true)
  })

  it('拒絕 legacyTls 為字串', () => {
    expect(bad((p) => { p.exposure[0].legacyTls = 'yes' }).ok).toBe(false)
  })

  it('拒絕同時有 error 與 hourly 的 log 來源', () => {
    expect(bad((p) => { p.logVolume[0].error = true }).ok).toBe(false)
  })

  it('拒絕 log 來源 error 與 hourly 皆無', () => {
    expect(bad((p) => { p.logVolume = [{ source: 'x' }] }).ok).toBe(false)
  })

  it('拒絕負數或非整數的 count', () => {
    expect(bad((p) => { p.logVolume[0].hourly[0].count = -1 }).ok).toBe(false)
    expect(bad((p) => { p.logVolume[0].hourly[0].count = 1.5 }).ok).toBe(false)
  })

  it('拒絕壞的 inventory', () => {
    expect(bad((p) => { p.inventory.users = 'alice' }).ok).toBe(false)
    expect(bad((p) => { delete p.inventory.services }).ok).toBe(false)
    expect(bad((p) => { p.inventory.listeners[0].port = 0 }).ok).toBe(false)
    expect(bad((p) => { p.inventory.listeners[0].port = 70000 }).ok).toBe(false)
    expect(bad((p) => { p.inventory.listeners[0].proto = 'icmp' }).ok).toBe(false)
  })

  it('忽略未知的頂層鍵', () => {
    const p = { ...validVm(), evil: 1 }
    const r = parseSecurityScanPayload(p, now)
    expect(r.ok).toBe(true)
    if (r.ok) expect('evil' in r.value).toBe(false)
  })

  it('字串欄位 trim 後存入', () => {
    const r = bad((p) => { p.findings[0].title = '  hi  ' })
    expect(r.ok && r.value.findings[0].title).toBe('hi')
  })

  it('一次回報多個錯誤', () => {
    const r = bad((p) => { p.kind = 'x'; p.scannedAt = 'bad' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(2)
  })
})
