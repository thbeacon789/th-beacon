import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createServiceRoleClient, cleanDatabase } from './helpers'
import { getServicesOverview, listIssues, getIssueDetail } from '@/web/queries'
import { SupabaseStore } from '@/store/supabase'
import { processEvent } from '@/pipeline/process-event'
import { normalizePushEvent } from '@/core/normalize'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/db/database.types'

let client: SupabaseClient<Database>
let store: SupabaseStore
let svcA: string
let svcB: string

const now = new Date('2026-07-28T10:10:00.000Z')
const receivedAt = new Date('2026-07-28T10:09:00.000Z')

beforeAll(() => {
  client = createServiceRoleClient()
  store = new SupabaseStore(client)
})

beforeEach(async () => {
  await cleanDatabase(client)
  const { data: a } = await client.from('services').insert({ name: 'svc-a' }).select('id').single()
  const { data: b } = await client.from('services').insert({ name: 'svc-b' }).select('id').single()
  svcA = a!.id
  svcB = b!.id
  await client.from('triage_rules').insert({
    service_id: null,
    priority: 10,
    severity: 'P1',
    match: { errorType: 'DBError' } as Json,
  })
  // svc-a：一筆 P1（DBError）＋一筆 P2；svc-b：無 issue
  await processEvent(store, normalizePushEvent(svcA, { message: 'db down', errorType: 'DBError' }, receivedAt), now)
  await processEvent(store, normalizePushEvent(svcA, { message: 'minor', errorType: 'Warn' }, receivedAt), now)
})

describe('getServicesOverview', () => {
  it('returns services ordered by name with per-severity open counts', async () => {
    const overview = await getServicesOverview(client, now)
    expect(overview.map((s) => s.name)).toEqual(['svc-a', 'svc-b'])
    expect(overview[0].openCounts).toEqual({ P0: 0, P1: 1, P2: 1 })
    expect(overview[0].healthStatus).toBe('degraded')
    expect(overview[1].openCounts).toEqual({ P0: 0, P1: 0, P2: 0 })
  })

  it('excludes resolved/ignored from counts', async () => {
    const issues = await listIssues(client, { serviceId: svcA, severity: 'P1' })
    await store.updateIssueStatus(issues[0].id, 'resolved')
    const overview = await getServicesOverview(client, now)
    expect(overview[0].openCounts).toEqual({ P0: 0, P1: 0, P2: 1 })
  })

  it('健康度視窗過期但心跳逾期時，燈號取最差降級為 degraded（回歸測試：spec §7）', async () => {
    // svc-b 的 health_status 目前是 healthy（沒有任何近期 issue）
    await client.from('heartbeats').insert({
      service_id: svcB,
      name: 'daily-test',
      interval_seconds: 86_400,
      grace_seconds: 3_600,
      // 3 天前跑過一次，早已超過 interval + grace，判定逾期
      last_run_at: '2026-07-25T00:00:00.000Z',
    })
    const overview = await getServicesOverview(client, now)
    const svcBOverview = overview.find((s) => s.id === svcB)
    expect(svcBOverview?.healthStatus).toBe('degraded')
    expect(svcBOverview?.heartbeats[0]?.overdue).toBe(true)
  })
})

describe('listIssues', () => {
  it('filters by service, severity and status', async () => {
    expect(await listIssues(client, {})).toHaveLength(2)
    expect(await listIssues(client, { severity: 'P1' })).toHaveLength(1)
    expect(await listIssues(client, { serviceId: svcB })).toHaveLength(0)
    const p1 = (await listIssues(client, { severity: 'P1' }))[0]
    expect(p1.serviceName).toBe('svc-a')
    await store.updateIssueStatus(p1.id, 'acknowledged')
    expect(await listIssues(client, { status: 'acknowledged' })).toHaveLength(1)
  })
})

describe('getIssueDetail', () => {
  it('returns issue with service name and events; null when missing', async () => {
    const [item] = await listIssues(client, { severity: 'P1' })
    const detail = await getIssueDetail(client, item.id)
    expect(detail?.serviceName).toBe('svc-a')
    expect(detail?.issue.severity).toBe('P1')
    expect(detail?.events).toHaveLength(1)
    expect(detail?.events[0].message).toBe('db down')
    expect(await getIssueDetail(client, '00000000-0000-0000-0000-000000000001')).toBeNull()
  })
})
