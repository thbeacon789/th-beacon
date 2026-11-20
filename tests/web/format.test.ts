import { describe, it, expect } from 'vitest'
import { formatDateTime, formatDateTimeSeconds } from '@/web/format'

describe('formatDateTime', () => {
  it('台北時間、24 小時制，日期與時間之間是一般空白（U+0020）', () => {
    expect(formatDateTime('2026-11-20T09:38:15Z')).toBe('2026/11/20 17:38')
  })
  it('午夜顯示為 00:00', () => {
    expect(formatDateTime('2026-11-19T16:00:00Z')).toBe('2026/11/20 00:00')
  })
  it('不含 thin space／narrow no-break space／no-break space', () => {
    expect(formatDateTime('2026-11-20T09:38:15Z')).not.toMatch(/[   ]/)
    expect(formatDateTimeSeconds('2026-11-20T09:38:15Z')).not.toMatch(/[   ]/)
  })
})

describe('formatDateTimeSeconds', () => {
  it('保留秒', () => {
    expect(formatDateTimeSeconds('2026-11-20T09:38:15Z')).toBe('2026/11/20 17:38:15')
  })
})
