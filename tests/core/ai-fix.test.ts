import { describe, it, expect } from 'vitest'
import { isSafePrUrl, AI_FIX_STATUSES, AI_FIX_SUMMARY_LIMIT } from '@/core/ai-fix'

describe('isSafePrUrl', () => {
  it('接受合法 GitHub PR 網址', () => {
    expect(isSafePrUrl('https://github.com/trustnel/trustnel-viewer-android/pull/123')).toBe(true)
  })

  it.each([
    'http://github.com/o/r/pull/1',
    'https://github.com.evil.com/o/r/pull/1',
    'https://evil.com/github.com/o/r/pull/1',
    'https://github.com/o/r/pull/abc',
    'https://github.com/o/r/pull/12/files',
    'https://github.com/o/r/pull/12?x=1',
    'https://github.com/o/r/pull/12#c',
    'https://github.com/o/r/pull/12)',
    'https://github.com/o/r/pull/1 2',
    'https://github.com/o/r/pull/1\n',
    'https://github.com/o/r/issues/12',
    'https://github.com/../r/pull/1',
    'https://github.com/o/./pull/1',
    'HTTPS://GITHUB.COM/o/r/pull/1',
  ])('拒絕 %j', (url) => {
    expect(isSafePrUrl(url)).toBe(false)
  })

  it('非字串 → false', () => {
    expect(isSafePrUrl(null)).toBe(false)
    expect(isSafePrUrl(123)).toBe(false)
  })
})

describe('常數', () => {
  it('狀態與摘要上限', () => {
    expect(AI_FIX_STATUSES).toEqual(['pr_opened', 'no_fix', 'failed'])
    expect(AI_FIX_SUMMARY_LIMIT).toBe(500)
  })
})
