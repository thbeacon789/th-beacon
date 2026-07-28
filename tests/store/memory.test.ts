import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryStore } from '@/store/memory'
import type { ServiceRecord, StoredHeartbeat } from '@/store/contracts'
import type { CanonicalEvent } from '@/core/types'

const svc: ServiceRecord = {
  id: 's-1',
  name: 'svc-a',
  healthWindowMinutes: 15,
  healthFailureThreshold: 2,
  healthStatus: 'healthy',
  poll: null,
  discordWebhookUrl: null,
}

const pollConfig = (over: Partial<import('@/store/contracts').PollConfig> = {}) => ({
  healthUrl: 'https://a/health',
  errorUrl: null,
  intervalSeconds: 60,
  timeoutMs: 5000,
  expectedStatus: 200,
  cursor: null,
  ...over,
})

const event = (over: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  serviceId: 's-1',
  source: 'push',
  level: 'error',
  errorType: 'TypeError',
  message: 'boom',
  fingerprint: 'fp-1',
  occurredAt: '2026-07-27T10:00:00.000Z',
  metadata: {},
  ...over,
})

describe('InMemoryStore', () => {
  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc)
  })

  it('creates a new issue with defaults on first event', async () => {
    const { issue, created, duplicate } = await store.upsertIssueWithEvent(event())
    expect(created).toBe(true)
    expect(duplicate).toBe(false)
    expect(issue).toMatchObject({
      serviceId: 's-1',
      fingerprint: 'fp-1',
      severity: 'P2',
      status: 'open',
      count: 1,
      firstSeen: '2026-07-27T10:00:00.000Z',
      lastSeen: '2026-07-27T10:00:00.000Z',
      tags: [],
    })
  })

  it('increments count and advances lastSeen on same fingerprint', async () => {
    await store.upsertIssueWithEvent(event())
    const { issue, created } = await store.upsertIssueWithEvent(
      event({ occurredAt: '2026-07-27T10:05:00.000Z' }),
    )
    expect(created).toBe(false)
    expect(issue.count).toBe(2)
    expect(issue.lastSeen).toBe('2026-07-27T10:05:00.000Z')
    expect(issue.firstSeen).toBe('2026-07-27T10:00:00.000Z')
  })

  it('does not move lastSeen backwards for late-arriving events', async () => {
    await store.upsertIssueWithEvent(event({ occurredAt: '2026-07-27T10:05:00.000Z' }))
    const { issue } = await store.upsertIssueWithEvent(event({ occurredAt: '2026-07-27T10:01:00.000Z' }))
    expect(issue.count).toBe(2)
    expect(issue.lastSeen).toBe('2026-07-27T10:05:00.000Z')
  })

  it('dedupes by (serviceId, externalId): no count increment', async () => {
    const first = await store.upsertIssueWithEvent(event({ metadata: { externalId: 'x-1' } }))
    const second = await store.upsertIssueWithEvent(event({ metadata: { externalId: 'x-1' } }))
    expect(second.duplicate).toBe(true)
    expect(second.issue.id).toBe(first.issue.id)
    expect(second.issue.count).toBe(1)
  })

  it('never dedupes events without externalId', async () => {
    await store.upsertIssueWithEvent(event())
    const { issue, duplicate } = await store.upsertIssueWithEvent(event())
    expect(duplicate).toBe(false)
    expect(issue.count).toBe(2)
  })

  it('reopens a resolved issue on new event; ignored stays ignored', async () => {
    const { issue } = await store.upsertIssueWithEvent(event())
    store.setIssueStatus(issue.id, 'resolved')
    const reopened = await store.upsertIssueWithEvent(event())
    expect(reopened.issue.status).toBe('open')

    store.setIssueStatus(issue.id, 'ignored')
    const still = await store.upsertIssueWithEvent(event())
    expect(still.issue.status).toBe('ignored')
  })

  it('loadRules returns global + matching service rules only', async () => {
    const rule = (id: string) => ({ id, priority: 1, severity: 'P1' as const, match: {} })
    store.seedRule('s-1', rule('mine'))
    store.seedRule('s-2', rule('other'))
    store.seedRule(null, rule('global'))
    const rules = await store.loadRules('s-1')
    expect(rules.map((r) => r.id).sort()).toEqual(['global', 'mine'])
  })

  it('updateIssueTriage persists severity and tags', async () => {
    const { issue } = await store.upsertIssueWithEvent(event())
    await store.updateIssueTriage(issue.id, 'P0', ['db'])
    const open = await store.listOpenIssues('s-1')
    expect(open).toEqual([
      { severity: 'P0', status: 'open', lastSeen: '2026-07-27T10:00:00.000Z' },
    ])
  })

  it('listOpenIssues excludes resolved/ignored', async () => {
    const { issue } = await store.upsertIssueWithEvent(event())
    store.setIssueStatus(issue.id, 'resolved')
    expect(await store.listOpenIssues('s-1')).toEqual([])
  })

  it('updateServiceHealth + getService roundtrip', async () => {
    await store.updateServiceHealth('s-1', 'down')
    expect((await store.getService('s-1'))?.healthStatus).toBe('down')
    expect(await store.getService('nope')).toBeNull()
  })

  it('setIssueStatus throws on unknown issue', () => {
    expect(() => store.setIssueStatus('unknown-id', 'acknowledged')).toThrow(/unknown issue/)
  })

  it('updateIssueTriage throws on unknown issue', async () => {
    await expect(store.updateIssueTriage('unknown-id', 'P0', [])).rejects.toThrow(
      /unknown issue/,
    )
  })

  it('updateServiceHealth throws on unknown service', async () => {
    await expect(store.updateServiceHealth('unknown-svc', 'down')).rejects.toThrow(
      /unknown service/,
    )
  })

  it('level takes last-arriving event regardless of occurredAt order', async () => {
    // First event: occurredAt 10:05, level 'error'
    await store.upsertIssueWithEvent(
      event({ occurredAt: '2026-07-27T10:05:00.000Z', level: 'error' }),
    )
    // Second event: occurredAt 10:01 (older), level 'fatal' (more severe)
    const { issue } = await store.upsertIssueWithEvent(
      event({ occurredAt: '2026-07-27T10:01:00.000Z', level: 'fatal' }),
    )
    // lastSeen should not move backward
    expect(issue.lastSeen).toBe('2026-07-27T10:05:00.000Z')
    // level should be from the last-arriving event ('fatal')
    expect(issue.level).toBe('fatal')
  })

  it('defensive copies prevent external mutation of stored state', async () => {
    const { issue } = await store.upsertIssueWithEvent(event())
    issue.tags.push('mutated')
    // Fetch again and verify tags are still empty (defensive copy worked)
    const { issue: refetched } = await store.upsertIssueWithEvent(event())
    expect(refetched.tags).toEqual([])
  })

  it('getService returns defensive copy of ServiceRecord', async () => {
    const svcCopy = await store.getService('s-1')
    if (svcCopy) {
      svcCopy.name = 'mutated'
    }
    const svcAgain = await store.getService('s-1')
    expect(svcAgain?.name).toBe('svc-a')
  })

  it('getServiceByName returns service with secret; null when unknown', async () => {
    const withSecret = { ...svc, id: 's-sec', name: 'svc-sec' }
    store.seedService(withSecret, 'topsecret')
    expect(await store.getServiceByName('svc-sec')).toEqual({
      service: withSecret,
      webhookSecret: 'topsecret',
    })
    expect(await store.getServiceByName('svc-a')).toEqual({ service: svc, webhookSecret: null })
    expect(await store.getServiceByName('nope')).toBeNull()
  })

  it('listPollableServices returns only services with poll config', async () => {
    store.seedService({ ...svc, id: 's-p', name: 'svc-p' })
    store.seedPollConfig('s-p', pollConfig())
    const pollables = await store.listPollableServices()
    expect(pollables).toHaveLength(1)
    expect(pollables[0].service.id).toBe('s-p')
    expect(pollables[0].lastPollAt).toBeNull()
  })

  it('updatePollState updates lastPollAt/poll and rejects unknown id', async () => {
    store.seedService({ ...svc, id: 's-p', name: 'svc-p' })
    store.seedPollConfig('s-p', pollConfig())
    await store.updatePollState('s-p', {
      lastPollAt: '2026-07-28T10:00:00.000Z',
      healthy: false,
      consecutiveFailures: 2,
      cursor: 'c-1',
    })
    const pollables = await store.listPollableServices()
    expect(pollables[0].lastPollAt).toBe('2026-07-28T10:00:00.000Z')
    expect(pollables[0].config.cursor).toBe('c-1')
    expect((await store.getService('s-p'))?.poll).toEqual({
      lastPollAt: '2026-07-28T10:00:00.000Z',
      healthy: false,
      consecutiveFailures: 2,
    })
    await expect(
      store.updatePollState('nope', { lastPollAt: 'x', healthy: null, consecutiveFailures: 0 }),
    ).rejects.toThrow(/unknown service/)
  })

  it('resolveHealthCheckIssue resolves only health_check_failed open issues', async () => {
    const health = await store.upsertIssueWithEvent(event({ errorType: 'health_check_failed', fingerprint: 'fp-h' }))
    const other = await store.upsertIssueWithEvent(event({ fingerprint: 'fp-o' }))
    expect(await store.resolveHealthCheckIssue('s-1')).toBe(true)
    expect(await store.resolveHealthCheckIssue('s-1')).toBe(false) // 已無可 resolve
    const open = await store.listOpenIssues('s-1')
    expect(open).toHaveLength(1) // 只剩 other
    void health
    void other
  })

  it('records notifications and returns latest sent only', async () => {
    const base = {
      issueId: 'i-1',
      serviceId: 's-1',
      fingerprint: 'fp-n',
      countAtSend: 1,
    }
    await store.recordNotification({ ...base, severity: 'P1', status: 'sent', sentAt: '2026-07-28T10:00:00.000Z' })
    await store.recordNotification({ ...base, severity: 'P0', status: 'failed', sentAt: '2026-07-28T10:05:00.000Z' })
    // failed 不計入冷卻判斷
    expect(await store.getLatestSentNotification('s-1', 'fp-n')).toEqual({
      severity: 'P1',
      sentAt: '2026-07-28T10:00:00.000Z',
    })
    await store.recordNotification({ ...base, severity: 'P0', status: 'sent', sentAt: '2026-07-28T10:06:00.000Z' })
    expect(await store.getLatestSentNotification('s-1', 'fp-n')).toEqual({
      severity: 'P0',
      sentAt: '2026-07-28T10:06:00.000Z',
    })
    expect(await store.getLatestSentNotification('s-1', 'nope')).toBeNull()
  })

  it('updateIssueStatus returns updated copy and rejects unknown id', async () => {
    const { issue } = await store.upsertIssueWithEvent(event())
    const updated = await store.updateIssueStatus(issue.id, 'acknowledged')
    expect(updated.status).toBe('acknowledged')
    updated.tags.push('mutate') // 呼叫端改動不得污染 store
    expect((await store.listOpenIssues('s-1'))[0].status).toBe('acknowledged')
    await expect(store.updateIssueStatus('nope', 'resolved')).rejects.toThrow(/unknown issue/)
  })
})

describe('InMemoryStore 心跳', () => {
  const svc: ServiceRecord = {
    id: 's-1',
    name: 'svc-a',
    healthWindowMinutes: 15,
    healthFailureThreshold: 2,
    healthStatus: 'healthy',
    poll: null,
    discordWebhookUrl: null,
  }
  const hb: Omit<StoredHeartbeat, 'serviceId'> = {
    id: 'hb-1',
    name: 'daily-test',
    intervalSeconds: 86_400,
    graceSeconds: 3_600,
    enabled: true,
    lastRunAt: null,
    lastSuccessAt: null,
    lastRunStatus: null,
    lastRunUrl: null,
    createdAt: '2026-07-01T00:00:00.000Z',
  }

  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc)
    store.seedHeartbeat('s-1', hb)
  })

  it('pass 回報同時更新 last_run_at 與 last_success_at', async () => {
    const updated = await store.recordHeartbeatRun('s-1', 'daily-test', {
      status: 'pass',
      runUrl: 'https://ci/run/1',
      at: '2026-07-29T03:00:00.000Z',
    })
    expect(updated?.lastRunAt).toBe('2026-07-29T03:00:00.000Z')
    expect(updated?.lastSuccessAt).toBe('2026-07-29T03:00:00.000Z')
    expect(updated?.lastRunStatus).toBe('pass')
    expect(updated?.lastRunUrl).toBe('https://ci/run/1')
  })

  it('fail 回報只更新 last_run_at，不動 last_success_at', async () => {
    await store.recordHeartbeatRun('s-1', 'daily-test', {
      status: 'pass',
      runUrl: null,
      at: '2026-07-28T03:00:00.000Z',
    })
    const updated = await store.recordHeartbeatRun('s-1', 'daily-test', {
      status: 'fail',
      runUrl: null,
      at: '2026-07-29T03:00:00.000Z',
    })
    expect(updated?.lastRunAt).toBe('2026-07-29T03:00:00.000Z')
    expect(updated?.lastSuccessAt).toBe('2026-07-28T03:00:00.000Z')
    expect(updated?.lastRunStatus).toBe('fail')
  })

  it('未登記的心跳回傳 null', async () => {
    const result = await store.recordHeartbeatRun('s-1', 'nope', {
      status: 'pass',
      runUrl: null,
      at: '2026-07-29T03:00:00.000Z',
    })
    expect(result).toBeNull()
  })

  it('listEnabledHeartbeats 略過 enabled=false', async () => {
    store.seedHeartbeat('s-1', { ...hb, id: 'hb-2', name: 'off', enabled: false })
    const list = await store.listEnabledHeartbeats()
    expect(list.map((h) => h.name)).toEqual(['daily-test'])
  })

  it('resolveIssueByFingerprint 只關掉指定指紋的未解 issue', async () => {
    await store.upsertIssueWithEvent({
      serviceId: 's-1',
      source: 'poll',
      level: 'error',
      errorType: 'heartbeat_missed',
      message: 'Heartbeat missed: daily-test',
      fingerprint: 'fp-a',
      occurredAt: '2026-07-29T01:00:00.000Z',
      metadata: {},
    })
    await store.upsertIssueWithEvent({
      serviceId: 's-1',
      source: 'push',
      level: 'error',
      errorType: 'other',
      message: 'unrelated',
      fingerprint: 'fp-b',
      occurredAt: '2026-07-29T01:00:00.000Z',
      metadata: {},
    })

    expect(await store.resolveIssueByFingerprint('s-1', 'fp-a')).toBe(true)
    const open = await store.listOpenIssues('s-1')
    expect(open).toHaveLength(1)
    expect(await store.resolveIssueByFingerprint('s-1', 'fp-a')).toBe(false)
  })
})
