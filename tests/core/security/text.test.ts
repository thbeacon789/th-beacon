import { describe, expect, it } from 'vitest'
import { truncateToUtf16Length } from '@/core/security/text'
import { parseSecurityScanPayload } from '@/core/security/payload'

describe('truncateToUtf16Length', () => {
  it('短字串原樣回傳', () => {
    expect(truncateToUtf16Length('abc', 5)).toBe('abc')
  })
  it('一般字串依長度截斷', () => {
    expect(truncateToUtf16Length('abcdef', 3)).toBe('abc')
  })
  it('結尾跨越 emoji 時整個 emoji 被丟棄而不留孤立 surrogate', () => {
    const s = 'ab😀cd' // 😀 佔 2 個 UTF-16 單元
    const out = truncateToUtf16Length(s, 3) // ab 佔 2，再加 😀 會到 4 > 3，整個丟棄
    expect(out).toBe('ab')
    expect(out.isWellFormed()).toBe(true)
    expect(truncateToUtf16Length(s, 4)).toBe('ab😀')
    expect('😀😀'.slice(0, 1).isWellFormed()).toBe(false) // 對照：slice 會留下孤立 surrogate
    expect(truncateToUtf16Length('😀😀', 1)).toBe('')
  })
  it('200 個 emoji、max 120 → UTF-16 長度 <= 120、60 個完整 emoji、無孤立 surrogate', () => {
    const out = truncateToUtf16Length('😀'.repeat(200), 120)
    expect(out.length).toBeLessThanOrEqual(120)
    expect(Array.from(out)).toHaveLength(60)
    expect(out).toBe('😀'.repeat(60))
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(false)
  })
  it('純 ASCII 未超長原樣回傳', () => {
    expect(truncateToUtf16Length('hello', 120)).toBe('hello')
  })
  it('截斷後的 title 通過 parseSecurityScanPayload', () => {
    const title = truncateToUtf16Length('😀'.repeat(200), 120)
    const r = parseSecurityScanPayload(
      {
        scannedAt: '2026-11-18T22:00:00.000Z',
        kind: 'vm',
        checks: { ports: { status: 'ok', summary: 'x' }, updates: { status: 'ok', summary: 'x' }, logins: { status: 'na', summary: '' } },
        certs: [],
        exposure: [],
        findings: [{ check: 'ports', severity: 'low', title, recommendation: 'r' }],
      },
      new Date('2026-11-18T22:10:00.000Z'),
    )
    expect(r.ok).toBe(true)
  })
})
