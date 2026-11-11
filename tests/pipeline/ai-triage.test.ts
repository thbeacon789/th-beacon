import { describe, it, expect, beforeEach, vi } from 'vitest'
import { processAndNotify, stageEvent, finishEvent } from '@/pipeline/process-and-notify'
import type { NotifyDeps, TriageDeps } from '@/pipeline/process-and-notify'
import { InMemoryStore } from '@/store/memory'
import type { NewAiJudgment, NewAiUsage } from '@/store/contracts'
import type { DiscordMessage } from '@/notify/message'
import type { ServiceRecord } from '@/store/contracts'
import type { CanonicalEvent, Severity } from '@/core/types'
import type { Triager, TriageCallResult } from '@/triage/claude'

const t0 = new Date('2026-10-27T10:00:00.000Z')
const after = (min: number) => new Date(t0.getTime() + min * 60_000)

const svc: ServiceRecord = {
  id: 's-1',
  name: 'svc-a',
  healthWindowMinutes: 15,
  healthFailureThreshold: 2,
  healthStatus: 'healthy',
  poll: null,
  discordWebhookUrl: 'https://discord/webhook',
  description: '付款服務',
  ownerDiscordId: null,
}

const event = (over: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  serviceId: 's-1',
  source: 'push',
  level: 'error',
  errorType: 'TypeError',
  message: 'boom',
  fingerprint: 'fp-1',
  occurredAt: '2026-10-27T09:59:00.000Z',
  metadata: {},
  ...over,
})

const ok = (severity: Severity, reason = '有使用者受影響'): TriageCallResult => ({
  ok: true,
  diagnosis: { category: 'app', severity, reason, suggestion: '重啟服務' },
  usage: { inputTokens: 1, outputTokens: 1, model: 'claude-sonnet-5-5' },
})

function setup(
  results: Array<TriageCallResult | Error>,
  opts: { triager?: Triager | null; budget?: { remaining: number } | null } = {},
) {
  const sent: DiscordMessage[] = []
  let calls = 0
  const prompts: Array<{ system: string; user: string }> = []
  const triager: Triager = async (p) => {
    prompts.push(p)
    const r = results[Math.min(calls, results.length - 1)]
    calls++
    if (r instanceof Error) throw r
    return r
  }
  const triage: TriageDeps = {
    triager: opts.triager === undefined ? triager : opts.triager,
    budget: opts.budget === undefined ? null : opts.budget,
  }
  const deps: NotifyDeps = {
    sender: async (_u, m) => {
      sent.push(m)
      return { ok: true }
    },
    fallbackWebhookUrl: null,
    triage,
  }
  return { deps, sent, prompts, calls: () => calls }
}

const text = (m: DiscordMessage) => JSON.stringify(m)

describe('pipeline AI 判級', () => {
  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc)
  })

  it('新 issue：呼叫 1 次、等級 = AI、訊息含判定原因', async () => {
    const h = setup([ok('P0', '付款全面失敗')])
    const r = await processAndNotify(store, h.deps, event(), t0)
    expect(h.calls()).toBe(1)
    expect(r.issue.severity).toBe('P0')
    expect(r.issue.ai?.severity).toBe('P0')
    expect(text(h.sent[0])).toContain('判定原因')
    expect(text(h.sent[0])).toContain('付款全面失敗')
  })

  it('同 issue 10 分後：不呼叫、沿用、等級不變', async () => {
    const h = setup([ok('P1')])
    await processAndNotify(store, h.deps, event(), t0)
    const r = await processAndNotify(store, h.deps, event(), after(10))
    expect(h.calls()).toBe(1)
    expect(r.issue.severity).toBe('P1')
  })

  it('31 分後再呼叫；AI 判低 → ratchet 不降', async () => {
    const h = setup([ok('P1'), ok('P2')])
    await processAndNotify(store, h.deps, event(), t0)
    const r = await processAndNotify(store, h.deps, event(), after(31))
    expect(h.calls()).toBe(2)
    expect(r.issue.severity).toBe('P1')
  })

  it('resolved 後再來一筆：reopened、呼叫、AI 判低 → 降級', async () => {
    const h = setup([ok('P0'), ok('P2')])
    const first = await processAndNotify(store, h.deps, event(), t0)
    await store.transitionIssueStatus(first.issue.id, 'resolved', ['open', 'acknowledged'], null, t0.toISOString())
    const r = await processAndNotify(store, h.deps, event(), after(5))
    expect(h.calls()).toBe(2)
    expect(r.issue.severity).toBe('P2')
  })

  it('triager ok:false：等級 = 規則、訊息含 AI 判讀失敗、issue.ai.error 有值、通知照發', async () => {
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P1', match: {} })
    const h = setup([{ ok: false, error: 'timeout after 25000ms' }])
    const r = await processAndNotify(store, h.deps, event(), t0)
    expect(r.issue.severity).toBe('P1')
    expect(r.notified).toBe(true)
    expect(text(h.sent[0])).toContain('AI 判讀失敗')
    expect(text(h.sent[0])).toContain('timeout after 25000ms')
    const stored = await store.upsertIssueWithEvent(event({ occurredAt: '2026-10-27T10:00:30.000Z' }))
    expect(stored.issue.ai?.error).toContain('timeout')
    expect(stored.issue.ai?.severity).toBeNull()
  })

  it('triager 拋例外：同 ok:false', async () => {
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P1', match: {} })
    const h = setup([new Error('network down')])
    const r = await processAndNotify(store, h.deps, event(), t0)
    expect(r.issue.severity).toBe('P1')
    expect(r.notified).toBe(true)
    expect(text(h.sent[0])).toContain('network down')
  })

  it('event 已帶 severity（CI 判讀）：不呼叫 triager', async () => {
    const h = setup([ok('P0')])
    const r = await processAndNotify(store, h.deps, event({ severity: 'P1' }), t0)
    expect(h.calls()).toBe(0)
    expect(r.issue.severity).toBe('P1')
  })

  it('CI 帶 diagnosisError 無 severity：呼叫 triager，Discord 不出現 CI 錯誤字串', async () => {
    const h = setup([ok('P1')])
    await processAndNotify(
      store,
      h.deps,
      event({ metadata: { ciDiagnosisError: 'wif exchange failed: 401' } }),
      t0,
    )
    expect(h.calls()).toBe(1)
    expect(text(h.sent[0])).not.toContain('wif exchange failed')
    expect(h.prompts[0].user).not.toContain('wif exchange failed')
  })

  it('budget remaining 1、兩個不同 fingerprint：第二筆略過並註明', async () => {
    const h = setup([ok('P1')], { budget: { remaining: 1 } })
    await processAndNotify(store, h.deps, event({ fingerprint: 'a' }), t0)
    const r = await processAndNotify(store, h.deps, event({ fingerprint: 'b' }), t0)
    expect(h.calls()).toBe(1)
    expect(r.issue.severity).toBe('P2')
    expect(text(h.sent[1])).toContain('本輪呼叫數已達上限')
  })

  it('triager null：等同現行行為，不寫 diagnosisError', async () => {
    const h = setup([ok('P0')], { triager: null })
    const r = await processAndNotify(store, h.deps, event(), t0)
    expect(h.calls()).toBe(0)
    expect(r.issue.severity).toBe('P2')
    expect(text(h.sent[0])).not.toContain('AI 判讀')
  })

  it('health_check_failed 15 分內第 2 次、AI 沿用 P2 → P0', async () => {
    store.seedRule(null, {
      id: 'r',
      priority: 10,
      severity: 'P0',
      match: { errorType: 'health_check_failed', minCountInWindow: 2, windowMinutes: 15 },
    })
    const h = setup([ok('P2')])
    const ev = (iso: string) => event({ errorType: 'health_check_failed', source: 'poll', occurredAt: iso })
    const first = await processAndNotify(store, h.deps, ev('2026-10-27T09:59:00.000Z'), t0)
    expect(first.issue.severity).toBe('P2')
    const second = await processAndNotify(store, h.deps, ev('2026-10-27T10:05:00.000Z'), after(5))
    expect(h.calls()).toBe(1)
    expect(second.issue.severity).toBe('P0')
  })

  it('no_ai 路徑（AI 停用）：CI 的 ciDiagnosisError 不進 Discord', async () => {
    const h = setup([ok('P0')], { triager: null })
    await processAndNotify(store, h.deps, event({ metadata: { ciDiagnosisError: 'wif exchange failed: 401' } }), t0)
    expect(h.calls()).toBe(0)
    expect(text(h.sent[0])).not.toContain('wif exchange failed')
    expect(text(h.sent[0])).not.toContain('AI 判讀失敗')
  })

  it('no_ai 路徑（AI 啟用但既有 issue 無 AI 紀錄）：CI 錯誤不進 Discord', async () => {
    const off = setup([ok('P0')], { triager: null })
    await processAndNotify(store, off.deps, event(), t0) // 建立無 ai 的 issue
    const h = setup([ok('P0')])
    // firstSeen 為 09:59；10:00:30 仍在首次判定寬限內 → no_ai
    await processAndNotify(
      store,
      h.deps,
      event({ metadata: { ciDiagnosisError: 'wif exchange failed: 401' } }),
      new Date(t0.getTime() + 30_000),
    )
    expect(h.calls()).toBe(0)
    expect(h.sent.map(text).join('')).not.toContain('wif exchange failed') // 冷卻內不再發，且絕不含 CI 錯誤
  })
})

describe('既有 issue 無 AI 紀錄（首次判定）', () => {
  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc)
  })
  const seedP1 = async () => {
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P1', match: {} })
    const off = setup([ok('P0')], { triager: null })
    const first = await processAndNotify(store, off.deps, event(), t0)
    expect(first.issue.severity).toBe('P1')
  }
  it('firstSeen 已舊：呼叫 triager，AI 判 P2 → 降為 P2', async () => {
    await seedP1()
    const h = setup([ok('P2')])
    const r = await processAndNotify(store, h.deps, event(), after(60))
    expect(h.calls()).toBe(1)
    expect(r.issue.severity).toBe('P2')
  })
  it('health_check_failed 規則 P0 → AI 判 P2 仍為 P0', async () => {
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P0', match: { errorType: 'health_check_failed' } })
    const off = setup([ok('P2')], { triager: null })
    const ev = () => event({ errorType: 'health_check_failed', source: 'poll' })
    const first = await processAndNotify(store, off.deps, ev(), t0)
    expect(first.issue.severity).toBe('P0')
    const h = setup([ok('P2')])
    const r = await processAndNotify(store, h.deps, ev(), after(60))
    expect(h.calls()).toBe(1)
    expect(r.issue.severity).toBe('P0')
  })

  it('prompt 附帶服務近 7 天 issue 統計', async () => {
    await store.upsertIssueWithEvent(event({ fingerprint: 'old', occurredAt: '2026-09-01T00:00:00.000Z' }))
    await store.upsertIssueWithEvent(event({ fingerprint: 'other', errorType: 'E2', occurredAt: '2026-10-26T00:00:00.000Z' }))
    const h = setup([ok('P1')])
    await processAndNotify(store, h.deps, event(), t0)
    const u = h.prompts[0].user
    expect(u).toContain('<service_stats>')
    expect(u).toContain('issue 數：2（open 2、acknowledged 0、resolved 0、ignored 0）')
    expect(u).toContain('其中新出現：2')
    expect(u).toContain('未解決的等級分布：P0 0、P1 0、P2 2')
  })
})

describe('cron 預算（逐筆 stage→finish）', () => {
  it('budget 5、連續 7 個不同 fingerprint 新 issue → triager 只呼叫 5 次，後 2 筆 skip_budget', async () => {
    const store = new InMemoryStore()
    store.seedService(svc, null)
    const h = setup([ok('P1')], { budget: { remaining: 5 } })
    const decisions: string[] = []
    for (let i = 0; i < 7; i++) {
      const staged = await stageEvent(store, h.deps, event({ fingerprint: `fp-budget-${i}` }), t0)
      decisions.push(staged.decision.kind)
      await finishEvent(store, h.deps, staged, t0)
    }
    expect(h.calls()).toBe(5)
    expect(decisions).toEqual(['call', 'call', 'call', 'call', 'call', 'skip_budget', 'skip_budget'])
    expect(h.deps.triage?.budget?.remaining).toBe(0)
  })
})

describe('旁路寫入 AI 判定與用量', () => {
  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc)
  })
  const okWithModel = (severity: Severity): TriageCallResult => ({
    ok: true,
    diagnosis: { category: 'app', severity, reason: 'r', suggestion: 's', model: 'claude-sonnet-5-5' },
    usage: { inputTokens: 1000, outputTokens: 200, model: 'claude-sonnet-5-5' },
  })
  const ciEvent = (over: Partial<CanonicalEvent> = {}) =>
    event({
      severity: 'P1',
      metadata: { diagnosis: { severity: 'P1', category: 'env', model: 'ci-model' } },
      ...over,
    })

  it('伺服器判級成功：寫一筆 source=server 判定與一筆 server_triage 用量', async () => {
    const h = setup([okWithModel('P0')])
    const r = await processAndNotify(store, h.deps, event(), t0)
    const js = store.listAiJudgments()
    expect(js).toHaveLength(1)
    expect(js[0]).toMatchObject({
      issueId: r.issue.id,
      serviceId: 's-1',
      source: 'server',
      severity: 'P0',
      category: 'app',
      model: 'claude-sonnet-5-5',
      judgedAt: t0.toISOString(),
    })
    const us = store.listAiUsage()
    expect(us).toHaveLength(1)
    expect(us[0]).toMatchObject({
      serviceId: 's-1',
      source: 'server_triage',
      model: 'claude-sonnet-5-5',
      inputTokens: 1000,
      outputTokens: 200,
      occurredAt: t0.toISOString(),
    })
    expect(us[0]!.costUsd).toBeCloseTo((1000 * 2 + 200 * 10) / 1_000_000, 10)
  })

  it('10 分內 reuse：不新增判定、不新增用量', async () => {
    const h = setup([okWithModel('P1')])
    await processAndNotify(store, h.deps, event(), t0)
    await processAndNotify(store, h.deps, event(), after(10))
    expect(store.listAiJudgments()).toHaveLength(1)
    expect(store.listAiUsage()).toHaveLength(1)
  })

  it('31 分後重判結果相同 → 判定 mergeCount=2；用量新增第二筆', async () => {
    const h = setup([okWithModel('P1')])
    await processAndNotify(store, h.deps, event(), t0)
    await processAndNotify(store, h.deps, event(), after(31))
    const js = store.listAiJudgments()
    expect(js).toHaveLength(1)
    expect(js[0]!.mergeCount).toBe(2)
    expect(store.listAiUsage()).toHaveLength(2)
  })

  it('triager ok:false 帶 usage → 不寫判定、寫用量；無 usage → 兩者皆不寫', async () => {
    const withUsage = setup([
      { ok: false, error: 'bad', usage: { inputTokens: 10, outputTokens: 5, model: 'claude-sonnet-5-5' } },
    ])
    await processAndNotify(store, withUsage.deps, event({ fingerprint: 'a' }), t0)
    expect(store.listAiJudgments()).toHaveLength(0)
    expect(store.listAiUsage()).toHaveLength(1)
    const without = setup([{ ok: false, error: 'timeout' }])
    await processAndNotify(store, without.deps, event({ fingerprint: 'b' }), t0)
    expect(store.listAiJudgments()).toHaveLength(0)
    expect(store.listAiUsage()).toHaveLength(1)
  })

  it('recordAiUsage 與 recordAiJudgment 拋錯 → 判級結果、通知照常', async () => {
    class Throwing extends InMemoryStore {
      override async recordAiJudgment(_j: NewAiJudgment): Promise<{ id: string; merged: boolean }> {
        throw new Error('judgment down')
      }
      override async recordAiUsage(_u: NewAiUsage): Promise<{ id: string }> {
        throw new Error('usage down')
      }
    }
    const bad = new Throwing()
    bad.seedService(svc)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = setup([okWithModel('P0')])
    const r = await processAndNotify(bad, h.deps, event(), t0)
    expect(r.issue.severity).toBe('P0')
    expect(r.notified).toBe(true)
    expect(spy).toHaveBeenCalledTimes(2)
    spy.mockRestore()
  })

  it('CI 診斷 → 寫一筆 source=ci 判定，model 取 diagnosis.model；不呼叫 triager、不寫用量', async () => {
    const h = setup([okWithModel('P0')])
    const r = await processAndNotify(store, h.deps, ciEvent(), t0)
    expect(h.calls()).toBe(0)
    expect(store.listAiUsage()).toHaveLength(0)
    const js = store.listAiJudgments()
    expect(js).toHaveLength(1)
    expect(js[0]).toMatchObject({
      issueId: r.issue.id,
      source: 'ci',
      severity: 'P1',
      category: 'env',
      model: 'ci-model',
      judgedAt: t0.toISOString(),
    })
  })

  it('CI 只帶 ciDiagnosisError → 不寫判定', async () => {
    const h = setup([okWithModel('P1')], { triager: null })
    await processAndNotify(store, h.deps, event({ metadata: { ciDiagnosisError: 'x' } }), t0)
    expect(store.listAiJudgments()).toHaveLength(0)
  })

  it('event 自帶 severity 但無 diagnosis → 不寫判定', async () => {
    const h = setup([okWithModel('P1')])
    await processAndNotify(store, h.deps, event({ severity: 'P1' }), t0)
    expect(store.listAiJudgments()).toHaveLength(0)
  })

  it('duplicate event（externalId 重送）→ 不寫判定', async () => {
    const h = setup([okWithModel('P1')])
    const ev = ciEvent({ metadata: { externalId: 'run-1', diagnosis: { severity: 'P1', category: 'env' } } })
    await processAndNotify(store, h.deps, ev, t0)
    await processAndNotify(store, h.deps, ev, after(1))
    expect(store.listAiJudgments()).toHaveLength(1)
    expect(store.listAiJudgments()[0]!.mergeCount).toBe(1)
  })

  it('同一 CI 測試連兩天同判定 → 一筆判定 mergeCount=2', async () => {
    const h = setup([okWithModel('P1')])
    await processAndNotify(store, h.deps, ciEvent(), t0)
    await processAndNotify(store, h.deps, ciEvent({ occurredAt: '2026-10-28T09:59:00.000Z' }), after(24 * 60))
    const js = store.listAiJudgments()
    expect(js).toHaveLength(1)
    expect(js[0]!.mergeCount).toBe(2)
  })
})
