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

  it('concurrent duplicate externalId submissions count once (race guard)', async () => {
    const ev = event({ source: 'poll', metadata: { externalId: 'race-1' } })
    const [a, b] = await Promise.all([
      store.upsertIssueWithEvent(ev),
      store.upsertIssueWithEvent(ev),
    ])
    expect([a.duplicate, b.duplicate].filter(Boolean)).toHaveLength(1)
    const winner = a.duplicate ? b : a
    expect(winner.issue.count).toBe(1)
    const { count } = await client
      .from('events')
      .select('*', { count: 'exact', head: true })
      .eq('service_id', serviceId)
    expect(count).toBe(1)
    const { data: issueRow } = await client
      .from('issues')
      .select('count')
      .eq('service_id', serviceId)
      .single()
    expect(issueRow?.count).toBe(1)
  })

  it('keeps latest level across out-of-order arrival, last_seen never regresses', async () => {
    await store.upsertIssueWithEvent(
      event({ level: 'error', occurredAt: '2026-07-27T10:05:00.000Z' }),
    )
    const { issue } = await store.upsertIssueWithEvent(
      event({ level: 'fatal', occurredAt: '2026-07-27T10:01:00.000Z' }),
    )
    expect(issue.level).toBe('fatal')
    expect(new Date(issue.lastSeen).toISOString()).toBe('2026-07-27T10:05:00.000Z')
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

describe('SupabaseStore.getServiceByName', () => {
  it('returns service with webhook secret; null when unknown', async () => {
    await client
      .from('services')
      .update({ webhook_secret: 'int-secret' })
      .eq('id', serviceId)
    const auth = await store.getServiceByName('svc-int')
    expect(auth?.service.id).toBe(serviceId)
    expect(auth?.webhookSecret).toBe('int-secret')
    expect(await store.getServiceByName('no-such-service')).toBeNull()
  })
})

describe('SupabaseStore poll extensions', () => {
  it('listPollableServices/updatePollState roundtrip incl. cursor', async () => {
    await client
      .from('services')
      .update({ poll_health_url: 'https://a/health', poll_error_url: 'https://a/errors' })
      .eq('id', serviceId)
    const before = await store.listPollableServices()
    expect(before).toHaveLength(1)
    expect(before[0].config).toMatchObject({
      healthUrl: 'https://a/health',
      errorUrl: 'https://a/errors',
      timeoutMs: 5000,
      expectedStatus: 200,
      cursor: null,
    })
    await store.updatePollState(serviceId, {
      lastPollAt: '2026-07-28T10:00:00.000Z',
      healthy: true,
      consecutiveFailures: 0,
      cursor: '2026-07-28T10:00:00.000Z',
    })
    const after = await store.listPollableServices()
    expect(after[0].lastPollAt).not.toBeNull()
    expect(after[0].config.cursor).not.toBeNull()
  })

  it('unknown ids reject across update methods (0-rows unified)', async () => {
    const ghost = '00000000-0000-0000-0000-000000000001'
    await expect(store.updateServiceHealth(ghost, 'down')).rejects.toThrow(/unknown service/)
    await expect(store.updateIssueTriage(ghost, 'P0', [])).rejects.toThrow(/unknown issue/)
    await expect(
      store.updatePollState(ghost, { lastPollAt: '2026-07-28T10:00:00.000Z', healthy: null, consecutiveFailures: 0 }),
    ).rejects.toThrow(/unknown service/)
  })

  it('resolveHealthCheckIssue resolves health issues only', async () => {
    await store.upsertIssueWithEvent(event({ errorType: 'health_check_failed', fingerprint: 'fp-h', source: 'poll' }))
    await store.upsertIssueWithEvent(event({ fingerprint: 'fp-o' }))
    expect(await store.resolveHealthCheckIssue(serviceId)).toBe(true)
    expect(await store.resolveHealthCheckIssue(serviceId)).toBe(false)
    const { data } = await client.from('issues').select('error_type,status').eq('service_id', serviceId)
    const byType = Object.fromEntries(data!.map((r) => [r.error_type, r.status]))
    expect(byType.health_check_failed).toBe('resolved')
    expect(byType.TypeError).toBe('open')
  })
})

describe('SupabaseStore notifications', () => {
  it('records and reads back latest sent notification (failed excluded)', async () => {
    const { issue } = await store.upsertIssueWithEvent(event())
    const base = { issueId: issue.id, serviceId, fingerprint: issue.fingerprint, countAtSend: 1 }
    await store.recordNotification({ ...base, severity: 'P1', status: 'sent', sentAt: '2026-07-28T10:00:00.000Z' })
    await store.recordNotification({ ...base, severity: 'P0', status: 'failed', sentAt: '2026-07-28T10:05:00.000Z' })
    const latest = await store.getLatestSentNotification(serviceId, issue.fingerprint)
    expect(latest?.severity).toBe('P1')
    const { data } = await client.from('notifications').select('status,severity,count_at_send').order('sent_at')
    expect(data).toHaveLength(2)
    expect(data![1]).toMatchObject({ status: 'failed', severity: 'P0', count_at_send: 1 })
  })
})

describe('SupabaseStore.updateIssueStatus', () => {
  it('updates status, returns mapped issue, rejects unknown id', async () => {
    const { issue } = await store.upsertIssueWithEvent(event())
    const updated = await store.updateIssueStatus(issue.id, 'resolved')
    expect(updated.status).toBe('resolved')
    expect(updated.id).toBe(issue.id)
    const { data } = await client.from('issues').select('status').eq('id', issue.id).single()
    expect(data?.status).toBe('resolved')
    await expect(
      store.updateIssueStatus('00000000-0000-0000-0000-000000000001', 'resolved'),
    ).rejects.toThrow(/unknown issue/)
  })
})

describe('SupabaseStore 登記（後台）', () => {
  it('createService 建立服務並寫入金鑰', async () => {
    const created = await store.createService('svc-registered', 'secret-abc')
    expect(created?.name).toBe('svc-registered')

    const auth = await store.getServiceByName('svc-registered')
    expect(auth?.webhookSecret).toBe('secret-abc')
    // 新服務的預設值來自 DB schema，不是應用層填的
    expect(created?.healthStatus).toBe('healthy')
    expect(created?.poll).toBeNull()
  })

  it('createService 名稱重複時回 null 而不是拋錯', async () => {
    // beforeEach 已插入 svc-int
    expect(await store.createService('svc-int', 'another-secret')).toBeNull()
  })

  it('createHeartbeat 同服務重複名稱回 null，跨服務允許同名', async () => {
    const hb = { name: 'daily-test', intervalSeconds: 86_400, graceSeconds: 3_600 }
    const first = await store.createHeartbeat(serviceId, hb)
    expect(first?.name).toBe('daily-test')
    expect(first?.enabled).toBe(true)
    expect(first?.lastRunAt).toBeNull()

    expect(await store.createHeartbeat(serviceId, hb)).toBeNull()

    const other = await store.createService('svc-other', 's')
    expect(await store.createHeartbeat(other!.id, hb)).not.toBeNull()
  })

  it('登記後心跳即可接受回報（登記→回報的完整路徑）', async () => {
    await store.createHeartbeat(serviceId, {
      name: 'daily-test',
      intervalSeconds: 86_400,
      graceSeconds: 0,
    })
    const recorded = await store.recordHeartbeatRun(serviceId, 'daily-test', {
      status: 'pass',
      runUrl: null,
      summary: null,
      at: '2026-08-01T00:00:00.000Z',
    })
    expect(recorded?.lastRunAt).not.toBeNull()
    expect(recorded?.lastSuccessAt).not.toBeNull()
  })

  it('rotateWebhookSecret 換掉金鑰；未知 id 回 false', async () => {
    expect(await store.rotateWebhookSecret(serviceId, 'rotated-secret')).toBe(true)
    expect((await store.getServiceByName('svc-int'))?.webhookSecret).toBe('rotated-secret')
    expect(
      await store.rotateWebhookSecret('00000000-0000-0000-0000-000000000000', 'x'),
    ).toBe(false)
  })

  it('listRegisteredServices 帶出心跳，且不外洩金鑰明文', async () => {
    await store.createHeartbeat(serviceId, {
      name: 'daily-test',
      intervalSeconds: 86_400,
      graceSeconds: 0,
    })
    const listed = await store.listRegisteredServices()
    const target = listed.find((s) => s.name === 'svc-int')
    expect(target?.heartbeats.map((h) => h.name)).toEqual(['daily-test'])
    // 型別上就沒有 secret 欄位；這裡確認實際物件也沒有夾帶
    expect(JSON.stringify(listed)).not.toContain('webhook_secret')
  })
})
