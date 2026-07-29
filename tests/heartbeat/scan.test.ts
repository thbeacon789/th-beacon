import { describe, it, expect, beforeEach } from 'vitest'
import { runHeartbeatScan } from '@/heartbeat/scan'
import { InMemoryStore } from '@/store/memory'
import type { ServiceRecord, StoredHeartbeat } from '@/store/contracts'
import type { NotifyDeps } from '@/pipeline/process-and-notify'

const noopDeps: NotifyDeps = {
  sender: async () => ({ ok: true }) as const,
  fallbackWebhookUrl: null,
}

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
  lastRunAt: '2026-07-27T03:00:00.000Z',
  lastSuccessAt: '2026-07-27T03:00:00.000Z',
  lastRunStatus: 'pass',
  lastRunUrl: null,
  lastRunSummary: null,
  createdAt: '2026-07-01T00:00:00.000Z',
}

describe('runHeartbeatScan', () => {
  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc)
    store.seedRule(null, {
      id: 'r-hb',
      priority: 100,
      severity: 'P1',
      tags: ['heartbeat'],
      match: { errorType: 'heartbeat_missed' },
    })
  })

  it('未逾期時不產生任何 outcome', async () => {
    store.seedHeartbeat('s-1', hb)
    // 到期 07-28T03:00 + grace 1h = 04:00
    const outcomes = await runHeartbeatScan(store, noopDeps, new Date('2026-07-28T03:30:00.000Z'))
    expect(outcomes).toHaveLength(0)
    expect(await store.listOpenIssues('s-1')).toHaveLength(0)
  })

  it('逾期時合成事件並判為 P1', async () => {
    store.seedHeartbeat('s-1', hb)
    const outcomes = await runHeartbeatScan(store, noopDeps, new Date('2026-07-29T09:00:00.000Z'))
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ name: 'daily-test', severity: 'P1' })
    const open = await store.listOpenIssues('s-1')
    expect(open).toHaveLength(1)
    expect(open[0].severity).toBe('P1')
  })

  it('enabled=false 的心跳被略過', async () => {
    store.seedHeartbeat('s-1', { ...hb, enabled: false })
    const outcomes = await runHeartbeatScan(store, noopDeps, new Date('2026-07-29T09:00:00.000Z'))
    expect(outcomes).toHaveLength(0)
  })

  it('重複掃描聚合成同一筆 issue 而非新增', async () => {
    store.seedHeartbeat('s-1', hb)
    await runHeartbeatScan(store, noopDeps, new Date('2026-07-29T09:00:00.000Z'))
    await runHeartbeatScan(store, noopDeps, new Date('2026-07-29T10:00:00.000Z'))
    expect(await store.listOpenIssues('s-1')).toHaveLength(1)
  })

  it('單一心跳出錯不中斷整輪', async () => {
    store.seedHeartbeat('s-1', hb)
    store.seedHeartbeat('missing-service', { ...hb, id: 'hb-2', name: 'orphan' })
    const outcomes = await runHeartbeatScan(store, noopDeps, new Date('2026-07-29T09:00:00.000Z'))
    expect(outcomes).toHaveLength(2)
    expect(outcomes.filter((o) => o.error !== undefined)).toHaveLength(1)
    expect(outcomes.filter((o) => o.issueId !== undefined)).toHaveLength(1)
  })
})
