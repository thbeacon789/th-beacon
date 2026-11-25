// issue／資安發現留言的輸入驗證。純函式，無 I/O、無時鐘。
// 表單 <textarea maxLength> 直接引用 COMMENT_MAX，與後端同源。

import type { ValidationResult } from '@/core/registration'

export const COMMENT_MAX = 2000

export type CommentKind = 'comment' | 'resolve'

export interface StoredComment {
  id: string
  author: string
  body: string
  kind: CommentKind
  createdAt: string
}

export function validateCommentBody(raw: unknown): ValidationResult<string> {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, errors: ['留言為必填'] }
  }
  const body = raw.trim()
  if (body.length > COMMENT_MAX) {
    return { ok: false, errors: [`留言不可超過 ${COMMENT_MAX} 字`] }
  }
  return { ok: true, value: body }
}

/** 選填備註：非字串或 trim 後為空 → null（視為未填）。 */
export function parseOptionalNote(raw: unknown): ValidationResult<string | null> {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: true, value: null }
  const note = raw.trim()
  if (note.length > COMMENT_MAX) {
    return { ok: false, errors: [`留言不可超過 ${COMMENT_MAX} 字`] }
  }
  return { ok: true, value: note }
}
