import { describe, it, expect } from 'vitest'
import { COMMENT_MAX, parseOptionalNote, validateCommentBody } from '@/core/comments'

describe('validateCommentBody', () => {
  it('trim 後回傳', () => {
    expect(validateCommentBody('  hi  ')).toEqual({ ok: true, value: 'hi' })
  })
  it.each(['', '   ', undefined, null, 5])('必填：%s', (v) => {
    expect(validateCommentBody(v).ok).toBe(false)
  })
  it('剛好 2000 字 ok', () => {
    expect(validateCommentBody('a'.repeat(COMMENT_MAX)).ok).toBe(true)
  })
  it('2001 字錯誤且訊息含 2000', () => {
    const r = validateCommentBody('a'.repeat(COMMENT_MAX + 1))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toContain('2000')
  })
})

describe('parseOptionalNote', () => {
  it('空白 → null', () => {
    expect(parseOptionalNote('   ')).toEqual({ ok: true, value: null })
  })
  it('非字串 → null', () => {
    expect(parseOptionalNote(null)).toEqual({ ok: true, value: null })
    expect(parseOptionalNote(undefined)).toEqual({ ok: true, value: null })
  })
  it('trim 後回傳', () => {
    expect(parseOptionalNote(' x ')).toEqual({ ok: true, value: 'x' })
  })
  it('超過上限錯誤', () => {
    expect(parseOptionalNote('a'.repeat(COMMENT_MAX + 1)).ok).toBe(false)
  })
})
