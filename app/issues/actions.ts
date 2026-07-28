'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/web/supabase-server'
import { createServerStore } from '@/store/server'
import { changeIssueStatus } from '@/pipeline/change-issue-status'
import { narrowIssueStatus } from '@/store/mapping'
import { isUuid } from '@/web/queries'

export async function changeIssueStatusAction(issueId: string, status: string): Promise<void> {
  await requireUser()
  if (!isUuid(issueId)) throw new Error(`unknown issue: ${issueId}`)
  await changeIssueStatus(createServerStore(), issueId, narrowIssueStatus(status), new Date())
  revalidatePath('/')
  revalidatePath('/issues')
  revalidatePath(`/issues/${issueId}`)
}
