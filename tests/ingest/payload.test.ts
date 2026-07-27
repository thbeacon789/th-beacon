import { describe, it, expect } from 'vitest'
import { parsePushPayload } from '@/ingest/payload'

describe('parsePushPayload', () => {
  it('accepts a minimal valid payload', () => {
    expect(parsePushPayload({ message: 'boom' })).toEqual({ ok: true, value: { message: 'boom' } })
  })

  it('accepts a full payload and passes fields through', () => {
    const full = {
      message: 'db down',
      errorType: 'test_failure',
      level: 'fatal',
      occurredAt: '2026-07-28T09:00:00.000Z',
      metadata: { runUrl: 'https://ci/run/1' },
    }
    const result = parsePushPayload(full)
    expect(result).toEqual({ ok: true, value: full })
  })

  it('rejects non-object payloads', () => {
    for (const bad of [null, 'x', 7, [1]]) {
      const result = parsePushPayload(bad)
      expect(result.ok).toBe(false)
    }
  })

  it('requires non-empty message', () => {
    for (const bad of [{}, { message: '' }, { message: '   ' }, { message: 7 }]) {
      const result = parsePushPayload(bad)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors.join()).toMatch(/message/)
    }
  })

  it('accumulates multiple errors', () => {
    const result = parsePushPayload({ errorType: 7, level: true, occurredAt: 'not-a-date', metadata: [1] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.length).toBeGreaterThanOrEqual(4)
  })

  it('rejects invalid occurredAt', () => {
    const result = parsePushPayload({ message: 'x', occurredAt: 'yesterday' })
    expect(result.ok).toBe(false)
  })
})
