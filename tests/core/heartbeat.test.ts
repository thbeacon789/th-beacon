import { describe, it, expect } from 'vitest'
import {
  heartbeatFingerprint,
  heartbeatDueAt,
  isHeartbeatOverdue,
  synthesizeHeartbeatMissedEvent,
  normalizeHeartbeatFailure,
  type HeartbeatDefinition,
} from '@/core/heartbeat'

const base: HeartbeatDefinition = {
  name: 'daily-test',
  intervalSeconds: 86_400,
  graceSeconds: 3_600,
  lastRunAt: '2026-07-28T03:00:00.000Z',
  createdAt: '2026-07-01T00:00:00.000Z',
}

describe('heartbeatDueAt', () => {
  it('以 lastRunAt 加上 interval 為到期時刻', () => {
    expect(heartbeatDueAt(base).toISOString()).toBe('2026-07-29T03:00:00.000Z')
  })

  it('從未回報時以 createdAt 為基準', () => {
    const fresh = { ...base, lastRunAt: null }
    expect(heartbeatDueAt(fresh).toISOString()).toBe('2026-07-02T00:00:00.000Z')
  })
})

describe('isHeartbeatOverdue', () => {
  it('到期時刻加寬限期之前不算逾期', () => {
    // 到期 07-29T03:00 + grace 1h = 04:00，邊界值本身不算逾期
    expect(isHeartbeatOverdue(base, new Date('2026-07-29T04:00:00.000Z'))).toBe(false)
  })

  it('超過寬限期算逾期', () => {
    expect(isHeartbeatOverdue(base, new Date('2026-07-29T04:00:00.001Z'))).toBe(true)
  })

  it('grace 為 0 時到期即逾期', () => {
    const nograce = { ...base, graceSeconds: 0 }
    expect(isHeartbeatOverdue(nograce, new Date('2026-07-29T03:00:00.000Z'))).toBe(false)
    expect(isHeartbeatOverdue(nograce, new Date('2026-07-29T03:00:00.001Z'))).toBe(true)
  })
})

describe('heartbeatFingerprint', () => {
  it('名稱中的數字不被正規化吃掉——不同名稱必須產生不同指紋', () => {
    const a = heartbeatFingerprint('s-1', 'heartbeat_missed', 'daily-2')
    const b = heartbeatFingerprint('s-1', 'heartbeat_missed', 'daily-3')
    expect(a).not.toBe(b)
  })

  it('同名同 errorType 穩定，跨 errorType 不同', () => {
    const a = heartbeatFingerprint('s-1', 'heartbeat_missed', 'daily-test')
    const b = heartbeatFingerprint('s-1', 'heartbeat_missed', 'daily-test')
    const c = heartbeatFingerprint('s-1', 'test_failure', 'daily-test')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

describe('synthesizeHeartbeatMissedEvent', () => {
  const now = new Date('2026-07-29T09:00:00.000Z')

  it('message 固定含名稱，變動細節進 metadata', () => {
    const event = synthesizeHeartbeatMissedEvent('s-1', base, now)
    expect(event.message).toBe('Heartbeat missed: daily-test')
    expect(event.errorType).toBe('heartbeat_missed')
    expect(event.source).toBe('poll')
    expect(event.level).toBe('error')
    expect(event.occurredAt).toBe('2026-07-29T09:00:00.000Z')
    expect(event.metadata).toMatchObject({
      heartbeat: 'daily-test',
      intervalSeconds: 86_400,
      graceSeconds: 3_600,
      lastRunAt: '2026-07-28T03:00:00.000Z',
      overdueSeconds: 21_600, // 09:00 - 03:00 = 6h
    })
  })

  it('指紋與 normalizeHeartbeatFailure 不同（兩類 issue 必須分開）', () => {
    const missed = synthesizeHeartbeatMissedEvent('s-1', base, now)
    const failed = normalizeHeartbeatFailure('s-1', base, {}, now)
    expect(missed.fingerprint).not.toBe(failed.fingerprint)
  })
})

describe('normalizeHeartbeatFailure', () => {
  const now = new Date('2026-07-29T03:05:00.000Z')

  it('message 固定，runUrl 與 summary 進 metadata', () => {
    const event = normalizeHeartbeatFailure(
      's-1',
      base,
      { runUrl: 'https://github.com/o/r/actions/runs/1', summary: '3 of 210 failed' },
      now,
    )
    expect(event.message).toBe('Test failed: daily-test')
    expect(event.errorType).toBe('test_failure')
    expect(event.source).toBe('push')
    expect(event.metadata).toEqual({
      heartbeat: 'daily-test',
      runUrl: 'https://github.com/o/r/actions/runs/1',
      summary: '3 of 210 failed',
    })
  })

  it('未提供選填欄位時 metadata 不含該鍵', () => {
    const event = normalizeHeartbeatFailure('s-1', base, {}, now)
    expect(event.metadata).toEqual({ heartbeat: 'daily-test' })
  })

  it('同一心跳連續失敗聚合成同一指紋', () => {
    const a = normalizeHeartbeatFailure('s-1', base, { summary: 'x' }, now)
    const b = normalizeHeartbeatFailure('s-1', base, { summary: 'y' }, now)
    expect(a.fingerprint).toBe(b.fingerprint)
  })
})
