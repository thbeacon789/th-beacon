import { describe, it, expect } from 'vitest'
import { fingerprintOf, normalizeJudgedKey } from '@/core/security/finding-key'

const FB = { key: '_fallback', keyFallback: true }
const ok = (key: string) => ({ key, keyFallback: false })

describe('normalizeJudgedKey', () => {
  it('ports', () => {
    expect(normalizeJudgedKey('ports', 'tcp/3306')).toEqual(ok('tcp/3306'))
    expect(normalizeJudgedKey('ports', 'udp/53')).toEqual(ok('udp/53'))
    for (const bad of ['tcp/0', 'tcp/65536', 'port:tcp/22', 'TCP/22']) expect(normalizeJudgedKey('ports', bad)).toEqual(FB)
  })
  it('updates', () => {
    for (const k of ['security', 'eol', 'reboot', 'auto-disabled']) expect(normalizeJudgedKey('updates', k)).toEqual(ok(k))
    expect(normalizeJudgedKey('updates', 'kernel')).toEqual(FB)
  })
  it('logins', () => {
    for (const k of ['password-auth', 'root-login', 'failed-spike', 'unexpected-success:203.0.113.5', 'unexpected-success:2001:db8::1']) {
      expect(normalizeJudgedKey('logins', k)).toEqual(ok(k))
    }
    for (const bad of ['unexpected-success:', 'unexpected-success:evil host']) expect(normalizeJudgedKey('logins', bad)).toEqual(FB)
  })
  it('非字串或空字串退回 fallback', () => {
    for (const bad of [undefined, 42, '']) expect(normalizeJudgedKey('ports', bad)).toEqual(FB)
  })
})

describe('fingerprintOf', () => {
  it('check:key', () => expect(fingerprintOf({ check: 'ports', key: 'tcp/22' })).toBe('ports:tcp/22'))
})
