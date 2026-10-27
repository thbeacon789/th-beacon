import { describe, it, expect, beforeEach } from 'vitest'
import { processAndNotify, stageEvent, finishEvent } from '@/pipeline/process-and-notify'
import type { NotifyDeps, TriageDeps } from '@/pipeline/process-and-notify'
import { InMemoryStore } from '@/store/memory'
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
  usage: { inputTokens: 1, outputTokens: 1 },
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
    await store.updateIssueStatus(first.issue.id, 'resolved')
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
    await processAndNotify(
      store,
      h.deps,
      event({ metadata: { ciDiagnosisError: 'wif exchange failed: 401' } }),
      after(40),
    )
    expect(h.calls()).toBe(0)
    expect(h.sent).toHaveLength(1)
    expect(text(h.sent[0])).not.toContain('wif exchange failed')
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
