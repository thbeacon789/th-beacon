'use client'

import { useActionState, useRef } from 'react'
import { COMMENT_MAX } from '@/core/comments'
import { SubmitButton } from '@/web/submit-button'

export type CommentFormState = { kind: 'idle' } | { kind: 'ok' } | { kind: 'invalid'; errors: string[] }

const IDLE: CommentFormState = { kind: 'idle' }

export function CommentForm({
  action,
}: {
  action: (prev: CommentFormState, form: FormData) => Promise<CommentFormState>
}) {
  const formRef = useRef<HTMLFormElement>(null)
  const [state, formAction] = useActionState(async (prev: CommentFormState, form: FormData) => {
    const next = await action(prev, form)
    if (next.kind === 'ok') formRef.current?.reset()
    return next
  }, IDLE)
  return (
    <form ref={formRef} action={formAction} className="comment-form">
      <label className="sr-only" htmlFor="comment-body">留言內容</label>
      <textarea id="comment-body" name="body" required rows={3} maxLength={COMMENT_MAX} placeholder="新增留言" />
      <div className="comment-form-row">
        <SubmitButton pendingLabel="送出中…">送出留言</SubmitButton>
        {state.kind === 'invalid' && (
          <span className="hint" role="alert">{state.errors.join('；')}</span>
        )}
      </div>
    </form>
  )
}
