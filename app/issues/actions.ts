'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/web/supabase-server'
import { createServerNotifyDeps, createServerStore } from '@/store/server'
import { transitionIssue } from '@/pipeline/transition-issue'
import { narrowIssueStatus } from '@/store/mapping'
import { isUuid } from '@/web/queries'
import { validateJudgmentLabel } from '@/core/ai-judgment'

export async function changeIssueStatusAction(issueId: string, status: string): Promise<void> {
  const user = await requireUser()
  if (!isUuid(issueId)) throw new Error(`unknown issue: ${issueId}`)
  const result = await transitionIssue(
    createServerStore(),
    createServerNotifyDeps().bot ?? null,
    issueId,
    narrowIssueStatus(status),
    { kind: 'dashboard', email: user.email ?? 'dashboard' },
    new Date(),
  )
  if (result.outcome === 'not_found') throw new Error(`unknown issue: ${issueId}`)
  revalidatePath('/')
  revalidatePath('/issues')
  revalidatePath(`/issues/${issueId}`)
}

export type LabelState = { status: 'idle' } | { status: 'error'; errors: string[] } | { status: 'saved' }

function formString(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value : ''
}

export async function labelJudgmentAction(
  issueId: string,
  judgmentId: string,
  _prev: LabelState,
  form: FormData,
): Promise<LabelState> {
  const user = await requireUser()
  const notFound: LabelState = { status: 'error', errors: ['找不到這筆判定'] }
  if (!isUuid(issueId) || !isUuid(judgmentId)) return notFound
  const store = createServerStore()
  const judgment = await store.getAiJudgment(judgmentId)
  if (judgment === null || judgment.issueId !== issueId) return notFound

  const result = validateJudgmentLabel(
    {
      severityVerdict: formString(form, 'severityVerdict'),
      severityCorrect: formString(form, 'severityCorrect'),
      categoryVerdict: formString(form, 'categoryVerdict'),
      categoryCorrect: formString(form, 'categoryCorrect'),
    },
    judgment,
  )
  if (!result.ok) return { status: 'error', errors: result.errors }

  const saved = await store.labelAiJudgment(judgmentId, result.value, user.email ?? 'dashboard', new Date().toISOString())
  if (!saved) return notFound
  revalidatePath(`/issues/${issueId}`)
  revalidatePath('/ai-stats')
  return { status: 'saved' }
}
