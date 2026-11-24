'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/web/supabase-server'
import { createServerStore } from '@/store/server'
import { isUuid } from '@/web/queries'
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
