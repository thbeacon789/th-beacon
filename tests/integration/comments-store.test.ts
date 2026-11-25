import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createServiceRoleClient, cleanDatabase } from './helpers'
import { SupabaseStore } from '@/store/supabase'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/db/database.types'

let client: SupabaseClient<Database>
let store: SupabaseStore
let serviceId: string
let issueId: string

beforeAll(() => {
  client = createServiceRoleClient()
  store = new SupabaseStore(client)
})

beforeEach(async () => {
  await cleanDatabase(client)
  const a = await client.from('services').insert({ name: 'svc-comments' }).select('id').single()
  if (a.error) throw a.error
  serviceId = a.data.id
  const i = await client
    .from('issues')
    .insert({ service_id: serviceId, fingerprint: 'fp-1', message: 'boom', error_type: 'TypeError', level: 'error', severity: 'P1', status: 'open', first_seen: '2026-11-25T00:00:00Z', last_seen: '2026-11-25T00:00:00Z', incident_first_seen: '2026-11-25T00:00:00Z' })
    .select('id')
    .single()
  if (i.error) throw i.error
  issueId = i.data.id
})

describe('SupabaseStore 留言', () => {
  it('issue 留言新增並依序列出', async () => {
    const a = await store.addIssueComment({ issueId, author: 'a@x.com', body: '一', kind: 'comment' })
    const b = await store.addIssueComment({ issueId, author: 'b@x.com', body: '二', kind: 'resolve' })
    const list = await store.listIssueComments(issueId)
    expect(list.map((c) => c.id)).toEqual([a.id, b.id])
    expect(list[1]).toMatchObject({ author: 'b@x.com', body: '二', kind: 'resolve' })
  })

  it('刪除 issue 會 cascade 刪除留言', async () => {
    await store.addIssueComment({ issueId, author: 'a@x.com', body: '一', kind: 'comment' })
    const del = await client.from('issues').delete().eq('id', issueId)
    expect(del.error).toBeNull()
    const left = await client.from('issue_comments').select('id')
    expect(left.data).toHaveLength(0)
  })

  it('body 2001 字 insert 失敗（check constraint）', async () => {
    await expect(store.addIssueComment({ issueId, author: 'a@x.com', body: 'x'.repeat(2001), kind: 'comment' })).rejects.toThrow(/addIssueComment failed/)
  })

  it('資安留言：空陣列回 []、多 id 查詢、cascade', async () => {
    await store.upsertSecurityFindings([{ serviceId, fingerprint: 'ports:22', check: 'ports', status: 'open', severity: 'high', title: 't', recommendation: 'r', keyFallback: false, firstSeenAt: '2026-11-20T00:00:00.000Z', lastSeenAt: '2026-11-20T00:00:00.000Z', statusChangedAt: '2026-11-20T00:00:00.000Z', statusChangedBy: 'system', reopenCount: 0, missedCount: 0 }])
    const [found] = await store.listSecurityFindings(serviceId)
    const f = { data: { id: found.id } }
    expect(await store.listSecurityFindingComments([])).toEqual([])
    await store.addSecurityFindingComment({ findingId: f.data.id, author: 'a@x.com', body: '備註', kind: 'comment' })
    const list = await store.listSecurityFindingComments([f.data.id])
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ findingId: f.data.id, body: '備註' })
    await client.from('security_findings').delete().eq('id', f.data.id)
    expect(await store.listSecurityFindingComments([f.data.id])).toEqual([])
  })
})
