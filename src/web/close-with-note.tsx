'use client'

import { useActionState, useId, useState } from 'react'
import { COMMENT_MAX } from '@/core/comments'
import { SubmitButton } from '@/web/submit-button'

export type CloseState =
  | { kind: 'idle' }
  | { kind: 'ok' }
  | { kind: 'stale' }
  | { kind: 'invalid'; errors: string[] }
  | { kind: 'note_failed' }

const IDLE: CloseState = { kind: 'idle' }

export function CloseWithNote({
  action,
  hidden,
  label,
}: {
  action: (prev: CloseState, form: FormData) => Promise<CloseState>
  hidden: Record<string, string>
  label: string
}) {
  const noteId = useId()
  const [open, setOpen] = useState(false)
  const [state, formAction] = useActionState(action, IDLE)
  return (
    <div className="close-with-note">
      {!open ? (
        <button type="button" onClick={() => setOpen(true)}>{label}</button>
      ) : (
        <form action={formAction} className="comment-form">
          {Object.entries(hidden).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <label className="sr-only" htmlFor={noteId}>備註</label>
          <textarea id={noteId} name="note" rows={3} maxLength={COMMENT_MAX} placeholder="備註（選填）" />
          <div className="comment-form-row">
            <SubmitButton pendingLabel="更新中…">確認關閉</SubmitButton>
            <SubmitButton pendingLabel="更新中…" name="skip" value="1">略過</SubmitButton>
            <button type="button" onClick={() => setOpen(false)}>取消</button>
          </div>
        </form>
      )}
      {state.kind === 'stale' && <span className="hint" role="status">狀態已被更新，請重新整理</span>}
      {state.kind === 'note_failed' && <span className="hint" role="status">已關閉，但留言未儲存</span>}
      {state.kind === 'invalid' && <span className="hint" role="alert">{state.errors.join('；')}</span>}
    </div>
  )
}
