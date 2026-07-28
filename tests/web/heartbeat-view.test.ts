import { describe, it, expect } from 'vitest'
import { extractRunUrl } from '@/web/queries'

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
