import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createServiceRoleClient, cleanDatabase } from './helpers'
import { SupabaseStore } from '@/store/supabase'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/db/database.types'
import type { CanonicalEvent } from '@/core/types'

let client: SupabaseClient<Database>
let store: SupabaseStore
let serviceId: string

const event = (over: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  serviceId,
  source: 'push',
  level: 'error',
  errorType: 'TypeError',
  message: 'boom',
  fingerprint: 'fp-1',
  occurredAt: '2026-07-27T10:00:00.000Z',
  metadata: {},
  ...over,
})

beforeAll(() => {
  client = createServiceRoleClient()
  store = new SupabaseStore(client)
})

beforeEach(async () => {
  await cleanDatabase(client)
  const { data, error } = await client
    .from('services')
    .insert({ name: 'svc-int' })
    .select('id')
    .single()
  if (error) throw error
  serviceId = data.id
})

describe('SupabaseStore.upsertIssueWithEvent', () => {
  it('creates issue with defaults and persists the event row', async () => {
    const { issue, created, duplicate } = await store.upsertIssueWithEvent(event())
    expect(created).toBe(true)
    expect(duplicate).toBe(false)
    expect(issue).toMatchObject({ severity: 'P2', status: 'open', count: 1, tags: [] })

    const { count } = await client
      .from('events')
      .select('*', { count: 'exact', head: true })
      .eq('issue_id', issue.id)
    expect(count).toBe(1)
  })

  it('increments count and keeps first_seen on repeat fingerprint', async () => {
    await store.upsertIssueWithEvent(event())
    const { issue, created } = await store.upsertIssueWithEvent(
      event({ occurredAt: '2026-07-27T10:05:00.000Z' }),
    )
    expect(created).toBe(false)
    expect(issue.count).toBe(2)
    expect(new Date(issue.lastSeen).toISOString()).toBe('2026-07-27T10:05:00.000Z')
    expect(new Date(issue.firstSeen).toISOString()).toBe('2026-07-27T10:00:00.000Z')
  })

  it('dedupes by externalId: count stays, single event row (驗收條件 #1)', async () => {
    const first = await store.upsertIssueWithEvent(
      event({ source: 'poll', metadata: { externalId: 'x-1' } }),
    )
    const second = await store.upsertIssueWithEvent(
      event({ source: 'poll', metadata: { externalId: 'x-1' } }),
    )
    expect(second.duplicate).toBe(true)
    expect(second.issue.id).toBe(first.issue.id)
    expect(second.issue.count).toBe(1)

    const { count } = await client
      .from('events')
      .select('*', { count: 'exact', head: true })
      .eq('service_id', serviceId)
    expect(count).toBe(1)
    // externalId 必須被 lift 到欄位（而非只留在 metadata）
    const { data: rows } = await client
      .from('events')
      .select('external_id')
      .eq('service_id', serviceId)
    expect(rows?.[0]?.external_id).toBe('x-1')
  })

  it('does not dedupe events without externalId', async () => {
    await store.upsertIssueWithEvent(event())
    const { issue, duplicate } = await store.upsertIssueWithEvent(event())
    expect(duplicate).toBe(false)
    expect(issue.count).toBe(2)
  })

  it('reopens resolved issue; ignored stays', async () => {
    const { issue } = await store.upsertIssueWithEvent(event())
    await client.from('issues').update({ status: 'resolved' }).eq('id', issue.id)
    const reopened = await store.upsertIssueWithEvent(event())
    expect(reopened.issue.status).toBe('open')

    await client.from('issues').update({ status: 'ignored' }).eq('id', issue.id)
    const still = await store.upsertIssueWithEvent(event())
    expect(still.issue.status).toBe('ignored')
  })
})

describe('SupabaseStore.loadRules', () => {
  it('returns only global + own-service rules, priority desc, jsonb serviceId ignored (驗收條件 #2)', async () => {
    const { data: other } = await client
      .from('services')
      .insert({ name: 'svc-other' })
      .select('id')
      .single()
    const rules = [
      { service_id: serviceId, priority: 5, severity: 'P1', match: {} as Json },
      { service_id: other!.id, priority: 99, severity: 'P0', match: {} as Json },
      { service_id: null, priority: 1, severity: 'P2', match: { serviceId: other!.id } as Json },
    ]
    const { error } = await client.from('triage_rules').insert(rules)
    expect(error).toBeNull()

    const loaded = await store.loadRules(serviceId)
    expect(loaded.map((r) => r.priority)).toEqual([5, 1]) // 不含 other 服務的 99
    // jsonb 內的 serviceId 被忽略，不會讓全域規則變成別服務專屬（或反之）
    expect(loaded.every((r) => !('serviceId' in r.match))).toBe(true)
  })

  it('excludes disabled rules', async () => {
    await client
      .from('triage_rules')
      .insert({ service_id: null, priority: 1, severity: 'P0', match: {} as Json, enabled: false })
    expect(await store.loadRules(serviceId)).toEqual([])
  })
})

describe('SupabaseStore service/issue updates', () => {
  it('updateIssueTriage + listOpenIssues + updateServiceHealth roundtrip', async () => {
    const { issue } = await store.upsertIssueWithEvent(event())
    await store.updateIssueTriage(issue.id, 'P0', ['crit'])
    const open = await store.listOpenIssues(serviceId)
    expect(open).toHaveLength(1)
    expect(open[0].severity).toBe('P0')

    await store.updateServiceHealth(serviceId, 'down')
    expect((await store.getService(serviceId))?.healthStatus).toBe('down')
    expect(await store.getService('00000000-0000-0000-0000-000000000001')).toBeNull()
  })
})
