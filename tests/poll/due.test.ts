import { describe, it, expect } from 'vitest'
import { isPollDue } from '@/poll/due'

const now = new Date('2026-07-28T10:01:00.000Z')

describe('isPollDue', () => {
  it('is due when never polled', () => {
    expect(isPollDue(null, 60, now)).toBe(true)
  })

  it('is due at/after the interval, not before', () => {
    expect(isPollDue('2026-07-28T10:00:00.000Z', 60, now)).toBe(true) // 恰 60s
    expect(isPollDue('2026-07-28T10:00:30.000Z', 60, now)).toBe(false) // 30s
    expect(isPollDue('2026-07-28T09:59:00.000Z', 60, now)).toBe(true) // 120s
  })

  it('defaults interval to 60 when null', () => {
    expect(isPollDue('2026-07-28T10:00:00.000Z', null, now)).toBe(true)
    expect(isPollDue('2026-07-28T10:00:30.000Z', null, now)).toBe(false)
  })
})
