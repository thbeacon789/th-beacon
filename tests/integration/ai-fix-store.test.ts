import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createServiceRoleClient, cleanDatabase } from './helpers'
import { SupabaseStore } from '@/store/supabase'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/db/database.types'
import type { CanonicalEvent } from '@/core/types'

let client: SupabaseClient<Database>
let store: SupabaseStore
let serviceId: string

const event = (over: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  serviceId,
  source: 'push',
  level: 'error',
  errorType: 'test_failure',
  message: 'e2e failed',
  fingerprint: 'fp-fix',
  occurredAt: '2026-11-13T10:00:00.000Z',
  metadata: {},
  ...over,
})

beforeAll(() => {
  client = createServiceRoleClient()
  store = new SupabaseStore(client)
})

beforeEach(async () => {
  await cleanDatabase(client)
  const { data, error } = await client.from('services').insert({ name: 'svc-fix' }).select('id').single()
  if (error) throw error
  serviceId = data.id
})

describe('SupabaseStore ai fix', () => {
  it('recordIssueAiFix 寫入後 getIssue 讀回相同', async () => {
    const { issue } = await store.upsertIssueWithEvent(event())
    expect((await store.getIssue(issue.id))?.aiFix).toBeNull()
    const fix = {
      status: 'pr_opened' as const,
      prUrl: 'https://github.com/o/r/pull/1',
      summary: 'fixed',
      reportedAt: '2026-11-13T11:00:00+00:00',
    }
    await store.recordIssueAiFix(issue.id, fix)
    expect((await store.getIssue(issue.id))?.aiFix).toEqual(fix)
  })

  it('recordIssueAiFix 對不存在的 issue throw unknown issue', async () => {
    const id = '11111111-1111-1111-1111-111111111111'
    await expect(
      store.recordIssueAiFix(id, { status: 'no_fix', prUrl: null, summary: null, reportedAt: '2026-11-13T11:00:00+00:00' }),
    ).rejects.toThrow(`unknown issue: ${id}`)
  })

  it('getHeartbeat 讀回 disabled 心跳', async () => {
    const { error } = await client
      .from('heartbeats')
      .insert({ service_id: serviceId, name: 'e2e-daily', interval_seconds: 86_400, grace_seconds: 3_600, enabled: false })
    if (error) throw error
    const hb = await store.getHeartbeat(serviceId, 'e2e-daily')
    expect(hb?.name).toBe('e2e-daily')
    expect(hb?.enabled).toBe(false)
    expect(await store.getHeartbeat(serviceId, 'missing')).toBeNull()
  })

  it('status 非三值被 DB check 拒絕', async () => {
    const { issue } = await store.upsertIssueWithEvent(event())
    const { error } = await client.from('issues').update({ ai_fix_status: 'bogus' }).eq('id', issue.id)
    expect(error).not.toBeNull()
  })

  it('pr_opened 缺 prUrl 被 DB check 拒絕', async () => {
    const { issue } = await store.upsertIssueWithEvent(event())
    const { error } = await client
      .from('issues')
      .update({ ai_fix_status: 'pr_opened', ai_fix_pr_url: null })
      .eq('id', issue.id)
    expect(error).not.toBeNull()
  })
})
