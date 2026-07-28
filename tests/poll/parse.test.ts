import { describe, it, expect } from 'vitest'
import { parsePolledErrors } from '@/poll/parse'

describe('parsePolledErrors', () => {
  it('parses the errors envelope and maps id to externalId', () => {
    const result = parsePolledErrors({
      errors: [
        { id: 'e-1', message: 'db down', errorType: 'DBError', level: 'fatal' },
        { message: 'minor glitch' },
      ],
    })
    expect(result).toEqual({
      ok: true,
      truncated: false,
      value: [
        { message: 'db down', externalId: 'e-1', errorType: 'DBError', level: 'fatal' },
        { message: 'minor glitch' },
      ],
    })
  })

  it('rejects non-envelope shapes', () => {
    for (const bad of [null, 'x', [1], {}, { errors: 'nope' }]) {
      expect(parsePolledErrors(bad).ok).toBe(false)
    }
  })

  it('requires message per item', () => {
    const result = parsePolledErrors({ errors: [{ id: 'x' }] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join()).toMatch(/errors\[0\]\.message/)
  })

  it('silently drops wrongly-typed optional fields', () => {
    const result = parsePolledErrors({
      errors: [{ message: 'x', id: 7, level: true, occurredAt: 'not-a-date', metadata: [1] }],
    })
    expect(result).toEqual({ ok: true, truncated: false, value: [{ message: 'x' }] })
  })

  it('caps at maxItems and flags truncation', () => {
    const many = { errors: Array.from({ length: 5 }, (_, i) => ({ message: `m${i}` })) }
    const result = parsePolledErrors(many, 3)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toHaveLength(3)
      expect(result.truncated).toBe(true)
    }
  })
})
