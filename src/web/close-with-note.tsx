'use client'

import { useActionState, useId, useState } from 'react'
import { COMMENT_MAX } from '@/core/comments'
import { SubmitButton } from '@/web/submit-button'

export type CloseState =
  | { kind: 'idle' }
  | { kind: 'ok' }
  | { kind: 'stale' }
  | { kind: 'invalid'; errors: string[] }
  | { kind: 'note_failed'; note: string }

const IDLE: CloseState = { kind: 'idle' }

type CloseAction = (prev: CloseState, form: FormData) => Promise<CloseState>

// 外層以 key 重掛內層：「取消」時一併清掉上次的訊息與輸入。
export function CloseWithNote({ action, label }: { action: CloseAction; label: string }) {
  const [epoch, setEpoch] = useState(0)
  return <CloseWithNoteInner key={epoch} action={action} label={label} onCancel={() => setEpoch((e) => e + 1)} />
}

function CloseWithNoteInner({ action, label, onCancel }: { action: CloseAction; label: string; onCancel: () => void }) {
  const noteId = useId()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [state, formAction] = useActionState(action, IDLE)
  const failed = state.kind === 'note_failed'
  return (
    <div className="close-with-note">
      {failed ? (
        <div className="comment-form">
          <span className="hint" role="status">已關閉，但留言未儲存。請重新整理後到留言區重貼下列原文：</span>
          <label className="sr-only" htmlFor={noteId}>未儲存的備註</label>
          <textarea id={noteId} readOnly rows={3} value={state.note} onFocus={(e) => e.currentTarget.select()} />
        </div>
      ) : !open ? (
        <button type="button" onClick={() => setOpen(true)}>{label}</button>
      ) : (
        <form action={formAction} className="comment-form">
          <label className="sr-only" htmlFor={noteId}>備註</label>
          <textarea
            id={noteId}
            name="note"
            rows={3}
            maxLength={COMMENT_MAX}
            placeholder="備註（選填）"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="comment-form-row">
            <SubmitButton pendingLabel="更新中…">確認關閉</SubmitButton>
            <SubmitButton pendingLabel="更新中…" name="skip" value="1">略過</SubmitButton>
            <button type="button" onClick={onCancel}>取消</button>
          </div>
        </form>
      )}
      {state.kind === 'stale' && <span className="hint" role="status">狀態已被更新，請重新整理</span>}
      {state.kind === 'invalid' && <span className="hint" role="alert">{state.errors.join('；')}</span>}
    </div>
  )
}
