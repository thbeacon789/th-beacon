'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/web/supabase-server'
import { createServerStore } from '@/store/server'
import { isUuid } from '@/web/queries'
import { validateCommentBody, parseOptionalNote } from '@/core/comments'
import type { CommentFormState } from '@/web/comment-form'
import type { CloseState } from '@/web/close-with-note'
import { MANUAL_TRANSITIONS, type SecurityFindingStatus } from '@/core/security/findings'

export type FindingActionState = { kind: 'idle' } | { kind: 'ok' } | { kind: 'stale' } | { kind: 'invalid' }

const STATUSES: readonly string[] = ['open', 'resolved', 'ignored']

function field(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

export async function setFindingStatusAction(
  _prev: FindingActionState,
  form: FormData,
): Promise<FindingActionState> {
  const user = await requireUser()

  const id = field(form, 'id')
  const from = field(form, 'from')
  const to = field(form, 'to')
  if (!isUuid(id) || !STATUSES.includes(from) || !STATUSES.includes(to)) return { kind: 'invalid' }
  if (!MANUAL_TRANSITIONS[from as SecurityFindingStatus].includes(to as SecurityFindingStatus)) return { kind: 'invalid' }

  const ok = await createServerStore().setSecurityFindingStatus(
    id,
    to as SecurityFindingStatus,
    from as SecurityFindingStatus,
    user.email ?? user.id,
    new Date().toISOString(),
  )
  revalidatePath('/security')
  return ok ? { kind: 'ok' } : { kind: 'stale' }
}

export async function addFindingCommentAction(
  findingId: string,
  _prev: CommentFormState,
  form: FormData,
): Promise<CommentFormState> {
  const user = await requireUser()
  if (!isUuid(findingId)) throw new Error(`unknown finding: ${findingId}`)
  const body = validateCommentBody(form.get('body'))
  if (!body.ok) return { kind: 'invalid', errors: body.errors }
  await createServerStore().addSecurityFindingComment({
    findingId,
    author: user.email ?? user.id,
    body: body.value,
    kind: 'comment',
  })
  revalidatePath('/security')
  return { kind: 'ok' }
}

export async function closeFindingAction(
  findingId: string,
  _prev: CloseState,
  form: FormData,
): Promise<CloseState> {
  const user = await requireUser()
  if (!isUuid(findingId)) throw new Error(`unknown finding: ${findingId}`)
  let note: string | null = null
  if (form.get('skip') !== '1') {
    const parsed = parseOptionalNote(form.get('note'))
    if (!parsed.ok) return { kind: 'invalid', errors: parsed.errors }
    note = parsed.value
  }
  const author = user.email ?? user.id
  const store = createServerStore()
  const ok = await store.setSecurityFindingStatus(findingId, 'resolved', 'open', author, new Date().toISOString())
  revalidatePath('/security')
  if (!ok) return { kind: 'stale' }
  if (note) {
    try {
      await store.addSecurityFindingComment({ findingId, author, body: note, kind: 'resolve' })
    } catch (err) {
      console.error('closeFindingAction: 備註寫入失敗', err)
      return { kind: 'note_failed' }
    }
  }
  return { kind: 'ok' }
}
