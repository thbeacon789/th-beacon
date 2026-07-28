import { describe, it, expect } from 'vitest'
import { isPublicPath } from '@/web/paths'

describe('isPublicPath', () => {
  it('login and self-authenticating APIs are public', () => {
    for (const p of ['/login', '/api/ingest', '/api/poll/services']) {
      expect(isPublicPath(p)).toBe(true)
    }
  })
  it('dashboard pages are protected', () => {
    for (const p of ['/', '/issues', '/issues/abc', '/auth/signout']) {
      expect(isPublicPath(p)).toBe(false)
    }
  })
  it('does not treat prefix-lookalikes as public', () => {
    for (const p of ['/api/ingest2', '/api/pollx', '/loginx']) {
      expect(isPublicPath(p)).toBe(false)
    }
  })
})
