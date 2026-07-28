import { describe, it, expect } from 'vitest'
import { extractRunUrl, applyHeartbeatOverdue } from '@/web/queries'

describe('extractRunUrl', () => {
  it('取出 metadata 中的 http(s) runUrl', () => {
    expect(extractRunUrl({ runUrl: 'https://ci/run/1' })).toBe('https://ci/run/1')
    expect(extractRunUrl({ runUrl: 'http://ci/run/1' })).toBe('http://ci/run/1')
  })

  it('非 http(s)、非字串、缺鍵時回 null', () => {
    expect(extractRunUrl({ runUrl: 'javascript:alert(1)' })).toBeNull()
    expect(extractRunUrl({ runUrl: 42 })).toBeNull()
    expect(extractRunUrl({})).toBeNull()
    expect(extractRunUrl(null)).toBeNull()
    expect(extractRunUrl('nope')).toBeNull()
  })
})

describe('applyHeartbeatOverdue', () => {
  it('有逾期心跳時，healthy 被降級為 degraded', () => {
    expect(applyHeartbeatOverdue('healthy', [{ overdue: true }])).toBe('degraded')
  })

  it('有逾期心跳時，degraded 維持 degraded（取最差不會降回去）', () => {
    expect(applyHeartbeatOverdue('degraded', [{ overdue: true }])).toBe('degraded')
  })

  it('有逾期心跳時，down 維持 down（degraded 比 down 輕，不會蓋掉）', () => {
    expect(applyHeartbeatOverdue('down', [{ overdue: true }])).toBe('down')
  })

  it('無逾期心跳（含空陣列）時維持原值', () => {
    expect(applyHeartbeatOverdue('healthy', [])).toBe('healthy')
    expect(applyHeartbeatOverdue('healthy', [{ overdue: false }])).toBe('healthy')
    expect(applyHeartbeatOverdue('down', [{ overdue: false }])).toBe('down')
  })

  it('混合多筆心跳，只要有一筆逾期就降級', () => {
    expect(applyHeartbeatOverdue('healthy', [{ overdue: false }, { overdue: true }])).toBe('degraded')
  })
})
