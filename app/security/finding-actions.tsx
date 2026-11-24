'use client'

import { useActionState } from 'react'
import { SubmitButton } from '@/web/submit-button'
import { setFindingStatusAction, type FindingActionState } from './actions'
import type { SecurityFindingStatus } from '@/core/security/findings'

const IDLE: FindingActionState = { kind: 'idle' }

const LABEL: Record<SecurityFindingStatus, { label: string; pending: string }> = {
  resolved: { label: '標為已解決', pending: '處理中…' },
  ignored: { label: '忽略', pending: '處理中…' },
  open: { label: '取消忽略', pending: '處理中…' },
}

function ActionForm({ id, from, to }: { id: string; from: SecurityFindingStatus; to: SecurityFindingStatus }) {
  const [state, action] = useActionState(setFindingStatusAction, IDLE)
  return (
    <form action={action} className="security-finding-form">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="from" value={from} />
      <input type="hidden" name="to" value={to} />
      <SubmitButton pendingLabel={LABEL[to].pending}>{LABEL[to].label}</SubmitButton>
      {state.kind === 'stale' && <span className="hint" role="status">狀態已被更新，請重新整理</span>}
      {state.kind === 'invalid' && <span className="hint" role="alert">操作無效</span>}
    </form>
  )
}

export function FindingActions({ id, status, transitions }: {
  id: string
  status: SecurityFindingStatus
  transitions: readonly SecurityFindingStatus[]
}) {
  return (
    <div className="security-finding-actions">
      {transitions.map((to) => (
        <ActionForm key={to} id={id} from={status} to={to} />
      ))}
    </div>
  )
}
