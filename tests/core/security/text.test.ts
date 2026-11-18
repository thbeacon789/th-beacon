import { describe, expect, it } from 'vitest'
import { truncateCodePoints } from '@/core/security/text'

describe('truncateCodePoints', () => {
  it('短字串原樣回傳', () => {
    expect(truncateCodePoints('abc', 5)).toBe('abc')
  })
  it('一般字串依長度截斷', () => {
    expect(truncateCodePoints('abcdef', 3)).toBe('abc')
  })
  it('結尾跨越 emoji 時整個 emoji 被丟棄而不留孤立 surrogate', () => {
    const s = 'ab😀cd' // 😀 佔 2 個 UTF-16 單元
    const out = truncateCodePoints(s, 3)
    expect(out).toBe('ab😀')
    expect(out.isWellFormed()).toBe(true)
    // 以 code point 計算，截到 2 個就只剩 ab，不會切在 emoji 中間
    expect(truncateCodePoints(s, 2)).toBe('ab')
    expect('😀😀'.slice(0, 1).isWellFormed()).toBe(false) // 對照：slice 會留下孤立 surrogate
    expect(truncateCodePoints('😀😀', 1).isWellFormed()).toBe(true)
  })
})
