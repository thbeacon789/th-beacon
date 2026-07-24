import { describe, it, expect } from 'vitest'
import { normalizeMessage, computeFingerprint } from '@/core/fingerprint'

describe('normalizeMessage', () => {
  it('replaces digits, uuids and hex with placeholders', () => {
    expect(normalizeMessage('User 12345 not found')).toBe('User <n> not found')
    expect(normalizeMessage('id 550e8400-e29b-41d4-a716-446655440000 bad')).toBe('id <uuid> bad')
    expect(normalizeMessage('ptr 0xDEADBEEF freed')).toBe('ptr <hex> freed')
  })

  it('collapses whitespace and trims', () => {
    expect(normalizeMessage('  too   many\tspaces ')).toBe('too many spaces')
  })
})

describe('computeFingerprint', () => {
  const base = { serviceId: 'svc-a', errorType: 'TypeError', message: 'User 1 not found' }

  it('is stable across variable parts of the message', () => {
    const a = computeFingerprint(base)
    const b = computeFingerprint({ ...base, message: 'User 999 not found' })
    expect(a).toBe(b)
  })

  it('differs by service', () => {
    expect(computeFingerprint(base)).not.toBe(computeFingerprint({ ...base, serviceId: 'svc-b' }))
  })

  it('differs by errorType', () => {
    expect(computeFingerprint(base)).not.toBe(computeFingerprint({ ...base, errorType: 'RangeError' }))
  })

  it('returns a 64-char hex string', () => {
    expect(computeFingerprint(base)).toMatch(/^[0-9a-f]{64}$/)
  })
})
