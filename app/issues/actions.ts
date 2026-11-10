'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/web/supabase-server'
import { createServerNotifyDeps, createServerStore } from '@/store/server'
import { transitionIssue } from '@/pipeline/transition-issue'
import { narrowIssueStatus } from '@/store/mapping'
import { isUuid } from '@/web/queries'

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
