import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createServiceRoleClient, cleanDatabase } from './helpers'
import { SupabaseStore } from '@/store/supabase'
import type { NewAiJudgment } from '@/store/contracts'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/db/database.types'
import { EMPTY_LABEL } from '@/core/types'

let client: SupabaseClient<Database>
let store: SupabaseStore
let serviceId: string
let issueId: string

const judgment = (over: Partial<NewAiJudgment> = {}): NewAiJudgment => ({
  issueId,
  serviceId,
  source: 'server',
  severity: 'P1',
  category: 'app',
  model: 'claude-sonnet-5-5',
  judgedAt: '2026-11-11T01:00:00.000Z',
  ...over,
})

beforeAll(() => {
  client = createServiceRoleClient()
  store = new SupabaseStore(client)
})

beforeEach(async () => {
  await cleanDatabase(client)
  const { data, error } = await client.from('services').insert({ name: 'svc-ai' }).select('id').single()
  if (error) throw error
  serviceId = data.id
  const { issue } = await store.upsertIssueWithEvent({
    serviceId,
    source: 'push',
    level: 'error',
    errorType: 'TypeError',
    message: 'boom',
    fingerprint: 'fp-ai',
    occurredAt: '2026-11-11T00:00:00.000Z',
    metadata: {},
  })
  issueId = issue.id
})

describe('SupabaseStore AI 統計', () => {
  it('recordAiJudgment：新增、相同則合併（merge_count=2、同 id）、A→B→A 第三筆新增', async () => {
    const a1 = await store.recordAiJudgment(judgment())
    expect(a1.merged).toBe(false)
    const a2 = await store.recordAiJudgment(judgment({ judgedAt: '2026-11-11T02:00:00.000Z' }))
    expect(a2).toEqual({ id: a1.id, merged: true })
    const merged = await store.getAiJudgment(a1.id)
    expect(merged?.mergeCount).toBe(2)
    expect(new Date(merged!.lastJudgedAt).toISOString()).toBe('2026-11-11T02:00:00.000Z')

    const b = await store.recordAiJudgment(judgment({ severity: 'P0', judgedAt: '2026-11-11T03:00:00.000Z' }))
    expect(b.merged).toBe(false)
    expect(b.id).not.toBe(a1.id)
    const a3 = await store.recordAiJudgment(judgment({ judgedAt: '2026-11-11T04:00:00.000Z' }))
    expect(a3.merged).toBe(false)
    expect(a3.id).not.toBe(a1.id)
    expect(a3.id).not.toBe(b.id)
  })

  it('合併沿用標記：label 後再 record 相同判定 → getAiJudgment 標記不變', async () => {
    const { id } = await store.recordAiJudgment(judgment())
    const label = { severityVerdict: 'wrong', severityCorrect: 'P0', categoryVerdict: 'correct', categoryCorrect: null } as const
    expect(await store.labelAiJudgment(id, label, 'u-1', '2026-11-11T05:00:00.000Z')).toBe(true)
    const again = await store.recordAiJudgment(judgment({ judgedAt: '2026-11-11T06:00:00.000Z' }))
    expect(again).toEqual({ id, merged: true })
    const got = await store.getAiJudgment(id)
    expect(got?.label).toEqual(label)
    expect(got?.labeledBy).toBe('u-1')
  })

  it('labelAiJudgment 寫入；不存在回 false；不一致標記被 check constraint 拒絕', async () => {
    const { id } = await store.recordAiJudgment(judgment())
    expect(await store.getAiJudgment(id)).toMatchObject({ label: EMPTY_LABEL })
    expect(await store.labelAiJudgment('00000000-0000-0000-0000-000000000001', EMPTY_LABEL, 'u', '2026-11-11T05:00:00.000Z')).toBe(false)
    const { error } = await client
      .from('ai_judgments')
      .update({ severity_verdict: 'wrong', severity_correct: 'P1' })
      .eq('id', id)
    expect(error?.message).toContain('ai_judgments_severity_label_chk')
  })

  it('recordAiUsage：cost_usd null 可寫；tokens 與 cost 皆 null 被拒', async () => {
    const base = { serviceId, source: 'server_triage', model: 'm', occurredAt: '2026-11-11T01:00:00.000Z' } as const
    const ok = await store.recordAiUsage({ ...base, inputTokens: 100, outputTokens: 20, costUsd: null })
    expect(ok.id).toBeTruthy()
    const priced = await store.recordAiUsage({ ...base, inputTokens: null, outputTokens: null, costUsd: 0.0123 })
    expect(priced.id).toBeTruthy()
    await expect(store.recordAiUsage({ ...base, inputTokens: null, outputTokens: null, costUsd: null })).rejects.toThrow()
  })
})
