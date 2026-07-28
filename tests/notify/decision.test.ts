import { describe, it, expect } from 'vitest'
import { shouldNotify } from '@/notify/decision'
import type { LatestNotification } from '@/store/contracts'

const now = new Date('2026-07-28T10:30:00.000Z')
const sentRecently: LatestNotification = { severity: 'P1', sentAt: '2026-07-28T10:15:00.000Z' } // 15 分鐘前
const sentLongAgo: LatestNotification = { severity: 'P1', sentAt: '2026-07-28T09:30:00.000Z' } // 60 分鐘前

describe('shouldNotify', () => {
  it('skips duplicates outright', () => {
    expect(shouldNotify({ severity: 'P0', duplicate: true, lastSent: null, now })).toEqual({
      notify: false,
      reason: 'duplicate',
    })
  })

  it('skips below threshold (P2)', () => {
    expect(shouldNotify({ severity: 'P2', duplicate: false, lastSent: null, now })).toEqual({
      notify: false,
      reason: 'below_threshold',
    })
  })

  it('notifies first time at/above threshold', () => {
    expect(shouldNotify({ severity: 'P1', duplicate: false, lastSent: null, now })).toEqual({
      notify: true,
      reason: 'first',
    })
  })

  it('suppresses within cooldown at same severity', () => {
    expect(shouldNotify({ severity: 'P1', duplicate: false, lastSent: sentRecently, now })).toEqual({
      notify: false,
      reason: 'cooldown',
    })
  })

  it('escalation bypasses cooldown', () => {
    expect(shouldNotify({ severity: 'P0', duplicate: false, lastSent: sentRecently, now })).toEqual({
      notify: true,
      reason: 'escalation',
    })
  })

  it('re-notifies after cooldown expires', () => {
    expect(shouldNotify({ severity: 'P1', duplicate: false, lastSent: sentLongAgo, now })).toEqual({
      notify: true,
      reason: 'cooldown_expired',
    })
  })

  it('cooldown boundary: exactly 30 minutes counts as expired', () => {
    const boundary: LatestNotification = { severity: 'P1', sentAt: '2026-07-28T10:00:00.000Z' }
    expect(shouldNotify({ severity: 'P1', duplicate: false, lastSent: boundary, now })).toEqual({
      notify: true,
      reason: 'cooldown_expired',
    })
  })
})
