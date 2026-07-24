import { describe, it, expect } from 'vitest'
import {
  normalizePushEvent,
  synthesizeHealthCheckFailedEvent,
  normalizePolledError,
} from '@/core/normalize'
import { computeFingerprint } from '@/core/fingerprint'

const at = new Date('2026-07-23T10:00:00.000Z')

describe('normalizePushEvent', () => {
  it('fills defaults and computes fingerprint', () => {
    const e = normalizePushEvent('svc-a', { message: 'boom' }, at)
    expect(e.source).toBe('push')
    expect(e.level).toBe('error')
    expect(e.errorType).toBe('unknown')
    expect(e.occurredAt).toBe('2026-07-23T10:00:00.000Z')
    expect(e.metadata).toEqual({})
    expect(e.fingerprint).toBe(
      computeFingerprint({ serviceId: 'svc-a', errorType: 'unknown', message: 'boom' }),
    )
  })

  it('honors provided fields', () => {
    const e = normalizePushEvent(
      'svc-a',
      { message: 'x', errorType: 'TypeError', level: 'fatal', occurredAt: '2026-07-01T00:00:00.000Z', metadata: { a: 1 } },
      at,
    )
    expect(e.errorType).toBe('TypeError')
    expect(e.level).toBe('fatal')
    expect(e.occurredAt).toBe('2026-07-01T00:00:00.000Z')
    expect(e.metadata).toEqual({ a: 1 })
  })
})

describe('synthesizeHealthCheckFailedEvent', () => {
  it('produces a poll-sourced health_check_failed event stable per service', () => {
    const a = synthesizeHealthCheckFailedEvent('svc-a', { reason: 'timeout', statusCode: 504, url: 'https://a/health' }, at)
    const b = synthesizeHealthCheckFailedEvent('svc-a', { reason: 'connection refused' }, new Date('2026-07-23T11:00:00.000Z'))
    expect(a.source).toBe('poll')
    expect(a.errorType).toBe('health_check_failed')
    expect(a.metadata).toMatchObject({ statusCode: 504, url: 'https://a/health' })
    // 同服務的 health 失敗要能聚合成同一 issue（fingerprint 相同）
    expect(a.fingerprint).toBe(b.fingerprint)
  })
})

describe('normalizePolledError', () => {
  it('is poll-sourced and preserves externalId in metadata', () => {
    const e = normalizePolledError('svc-a', { message: 'db down', errorType: 'DBError', externalId: 'ext-42' }, at)
    expect(e.source).toBe('poll')
    expect(e.errorType).toBe('DBError')
    expect(e.metadata).toMatchObject({ externalId: 'ext-42' })
  })
})
