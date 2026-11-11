import { describe, it, expect } from 'vitest'
import {
  monthKey,
  monthWindow,
  computeAiStats,
  UNKNOWN_MODEL,
  type JudgmentStatRow,
  type UsageStatRow,
} from '@/core/ai-stats'
import { EMPTY_LABEL, type JudgmentLabel, type Severity } from '@/core/types'
import type { DiagnosisCategory } from '@/core/heartbeat'

const NOW = new Date('2026-11-11T04:00:00Z')
const SVCS = [
  { id: 's1', name: 'alpha' },
  { id: 's2', name: 'beta' },
]

const j = (over: Partial<Omit<JudgmentStatRow, 'label'>> & { label?: Partial<JudgmentLabel> } = {}): JudgmentStatRow => {
  const { label, ...rest } = over
  return {
    serviceId: 's1',
    severity: 'P1' as Severity,
    category: 'app' as DiagnosisCategory,
    model: 'm1',
    judgedAt: '2026-11-05T00:00:00Z',
    ...rest,
    label: { ...EMPTY_LABEL, ...label },
  }
}
const u = (over: Partial<UsageStatRow> = {}): UsageStatRow => ({
  serviceId: 's1',
  source: 'server_triage',
  costUsd: 1,
  occurredAt: '2026-11-05T00:00:00Z',
  ...over,
})
const run = (judgments: JudgmentStatRow[] = [], usage: UsageStatRow[] = [], months = 3) =>
  computeAiStats({ judgments, usage, services: SVCS, now: NOW, months })

describe('monthKey / monthWindow', () => {
  it('monthKey 以台北時間切月：2026-10-31T16:30:00Z → 2026-11', () => {
    expect(monthKey('2026-10-31T16:30:00Z')).toBe('2026-11')
    expect(monthKey('2026-10-31T15:59:59Z')).toBe('2026-10')
  })
  it('monthWindow(2026-11-11, 3)', () => {
    expect(monthWindow(NOW, 3)).toEqual({
      keys: ['2026-09', '2026-10', '2026-11'],
      sinceIso: '2026-08-31T16:00:00.000Z',
    })
  })
  it('monthWindow 跨年', () => {
    expect(monthWindow(new Date('2026-01-15T00:00:00Z'), 3).keys).toEqual(['2025-11', '2025-12', '2026-01'])
  })
})

describe('花費', () => {
  it('本月花費加總 priced 金額；cost null 計入 monthUnpricedCount 不計入金額', () => {
    const v = run([], [u({ costUsd: 1.5 }), u({ costUsd: 0.5 }), u({ costUsd: null })])
    expect(v.summary.monthCostUsd).toBe(2)
    expect(v.summary.monthUnpricedCount).toBe(1)
  })
  it('上月的用量不計入本月花費，但出現在 monthly', () => {
    const v = run([], [u({ costUsd: 3, occurredAt: '2026-10-05T00:00:00Z' })])
    expect(v.summary.monthCostUsd).toBe(0)
    expect(v.monthly.find((m) => m.month === '2026-10')?.costUsd).toBe(3)
  })
  it('costBySource 三鍵皆存在', () => {
    const v = run([], [u({ source: 'ci_pr', costUsd: 2 }), u({ source: 'ci_pr', costUsd: null })])
    expect(Object.keys(v.costBySource).sort()).toEqual(['ci_diagnosis', 'ci_pr', 'server_triage'])
    expect(v.costBySource.ci_pr).toEqual({ costUsd: 2, unpricedCount: 1 })
    expect(v.costBySource.server_triage).toEqual({ costUsd: 0, unpricedCount: 0 })
  })
})

describe('準確率', () => {
  it('3 判對 1 判錯 1 未標 → 3/4 = 0.75', () => {
    const ok = { severityVerdict: 'correct' as const }
    const v = run([
      j({ label: ok }),
      j({ label: ok }),
      j({ label: ok }),
      j({ label: { severityVerdict: 'wrong', severityCorrect: 'P0' } }),
      j(),
    ])
    expect(v.summary.severity).toEqual({ correct: 3, total: 4, rate: 0.75 })
  })
  it('無任何標記 → rate null', () => {
    const v = run([j(), j()])
    expect(v.summary.severity).toEqual({ correct: 0, total: 0, rate: null })
    expect(v.summary.category.rate).toBeNull()
  })
  it('labelRate：只標了類型的判定也算已標記', () => {
    const v = run([j({ label: { categoryVerdict: 'correct' } }), j(), j({ judgedAt: '2020-01-01T00:00:00Z' })])
    expect(v.summary.labelRate).toEqual({ correct: 1, total: 2, rate: 0.5 })
  })
  it('monthly 依判定月份歸類（10 月判定、11 月才標記 → 算 10 月）', () => {
    const v = run([j({ judgedAt: '2026-10-20T00:00:00Z', label: { severityVerdict: 'correct' } })])
    const oct = v.monthly.find((m) => m.month === '2026-10')!
    expect(oct.byModel.m1.severity).toEqual({ correct: 1, total: 1, rate: 1 })
    expect(v.monthly.find((m) => m.month === '2026-11')!.byModel).toEqual({})
  })
  it('monthly 依 model 分線；null 歸 UNKNOWN_MODEL；空月份仍出現', () => {
    const v = run([j({ model: null, label: { severityVerdict: 'correct' } }), j({ model: 'a' })])
    expect(v.models).toEqual(['a', UNKNOWN_MODEL].sort())
    expect(v.monthly.map((m) => m.month)).toEqual(['2026-09', '2026-10', '2026-11'])
    expect(v.monthly[0].byModel).toEqual({})
    expect(v.monthly[2].byModel[UNKNOWN_MODEL].severity.total).toBe(1)
  })
})

describe('miss', () => {
  it('AI P0 應為 P1 → tooHigh；AI P2 應為 P0 → tooLow', () => {
    const v = run([
      j({ severity: 'P0', label: { severityVerdict: 'wrong', severityCorrect: 'P1' } }),
      j({ severity: 'P2', label: { severityVerdict: 'wrong', severityCorrect: 'P0' } }),
    ])
    expect(v.miss.tooHigh).toBe(1)
    expect(v.miss.tooLow).toBe(1)
    expect(v.miss.severityMatrix.P0.P1).toBe(1)
    expect(v.miss.severityMatrix.P2.P0).toBe(1)
    expect(v.miss.severityMatrix.P1.P1).toBe(0)
  })
  it('env/app 誤判方向', () => {
    const v = run([
      j({ category: 'env', label: { categoryVerdict: 'wrong', categoryCorrect: 'app' } }),
      j({ category: 'app', label: { categoryVerdict: 'wrong', categoryCorrect: 'env' } }),
    ])
    expect(v.miss.envToApp).toBe(1)
    expect(v.miss.appToEnv).toBe(1)
  })
})

describe('services', () => {
  it('依嚴重度準確率升冪；null 排最後；同率依名稱', () => {
    const ok = { severityVerdict: 'correct' as const }
    const bad = { severityVerdict: 'wrong' as const, severityCorrect: 'P0' as const }
    const v = computeAiStats({
      judgments: [
        j({ serviceId: 'a', label: ok }),
        j({ serviceId: 'b', label: ok }),
        j({ serviceId: 'c', label: bad }),
        j({ serviceId: 'd' }),
      ],
      usage: [],
      services: [
        { id: 'a', name: 'zeta' },
        { id: 'b', name: 'eta' },
        { id: 'c', name: 'c' },
        { id: 'd', name: 'a-null' },
      ],
      now: NOW,
      months: 3,
    })
    expect(v.services.map((s) => s.name)).toEqual(['c', 'eta', 'zeta', 'a-null'])
    expect(v.services[0].labeled).toBe(1)
    expect(v.services[3].judgments).toBe(1)
  })
  it('只有用量沒有判定的服務也列入', () => {
    const v = run([], [u({ serviceId: 's2', costUsd: 2 })])
    expect(v.services).toHaveLength(1)
    expect(v.services[0]).toMatchObject({ serviceId: 's2', name: 'beta', judgments: 0, costUsd: 2 })
  })
  it('查無名稱 → (unknown)', () => {
    const v = run([j({ serviceId: 'zzz' })])
    expect(v.services[0].name).toBe('(unknown)')
  })
})
