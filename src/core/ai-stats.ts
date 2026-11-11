import type { AiUsageSource, JudgmentLabel, Severity } from './types'
import type { DiagnosisCategory } from './heartbeat'

export const STATS_TZ_OFFSET_MINUTES = 480 // Asia/Taipei，無日光節約
export const UNKNOWN_MODEL = '未知 model'

export interface Rate {
  correct: number
  total: number
  rate: number | null // total=0 → null
}

export interface JudgmentStatRow {
  serviceId: string
  severity: Severity
  category: DiagnosisCategory
  model: string | null
  judgedAt: string
  label: JudgmentLabel
}

export interface UsageStatRow {
  serviceId: string
  source: AiUsageSource
  costUsd: number | null
  occurredAt: string
}

export interface AiStatsView {
  windowMonths: number
  summary: {
    monthCostUsd: number
    monthUnpricedCount: number
    severity: Rate
    category: Rate
    labelRate: Rate
  }
  costBySource: Record<AiUsageSource, { costUsd: number; unpricedCount: number }>
  models: string[]
  monthly: Array<{
    month: string
    costUsd: number
    unpricedCount: number
    byModel: Record<string, { severity: Rate; category: Rate }>
  }>
  miss: {
    severityMatrix: Record<Severity, Record<Severity, number>>
    tooHigh: number
    tooLow: number
    envToApp: number
    appToEnv: number
  }
  services: Array<{
    serviceId: string
    name: string
    judgments: number
    labeled: number
    severity: Rate
    category: Rate
    costUsd: number
    unpricedCount: number
  }>
}

const SEVERITIES: Severity[] = ['P0', 'P1', 'P2']
const SOURCES: AiUsageSource[] = ['server_triage', 'ci_diagnosis', 'ci_pr']
const SEVERITY_RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 }

function taipeiShifted(ms: number): Date {
  return new Date(ms + STATS_TZ_OFFSET_MINUTES * 60_000)
}

function keyOf(year: number, month0: number): string {
  const d = new Date(Date.UTC(year, month0, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** 'YYYY-MM'（台北時間） */
export function monthKey(iso: string): string {
  const d = taipeiShifted(Date.parse(iso))
  return keyOf(d.getUTCFullYear(), d.getUTCMonth())
}

/** 含本月往前共 months 個月；sinceIso = 最早月份台北 00:00 的 UTC ISO */
export function monthWindow(now: Date, months: number): { keys: string[]; sinceIso: string } {
  const cur = taipeiShifted(now.getTime())
  const y = cur.getUTCFullYear()
  const m = cur.getUTCMonth()
  const keys: string[] = []
  for (let i = months - 1; i >= 0; i--) keys.push(keyOf(y, m - i))
  const sinceMs = Date.UTC(y, m - (months - 1), 1) - STATS_TZ_OFFSET_MINUTES * 60_000
  return { keys, sinceIso: new Date(sinceMs).toISOString() }
}

function rate(correct: number, total: number): Rate {
  return { correct, total, rate: total === 0 ? null : correct / total }
}

interface Tally {
  sevCorrect: number
  sevTotal: number
  catCorrect: number
  catTotal: number
}
const emptyTally = (): Tally => ({ sevCorrect: 0, sevTotal: 0, catCorrect: 0, catTotal: 0 })

function addToTally(t: Tally, l: JudgmentLabel): void {
  if (l.severityVerdict !== null) {
    t.sevTotal++
    if (l.severityVerdict === 'correct') t.sevCorrect++
  }
  if (l.categoryVerdict !== null) {
    t.catTotal++
    if (l.categoryVerdict === 'correct') t.catCorrect++
  }
}

const isLabeled = (l: JudgmentLabel): boolean => l.severityVerdict !== null || l.categoryVerdict !== null

export function computeAiStats(input: {
  judgments: JudgmentStatRow[]
  usage: UsageStatRow[]
  services: Array<{ id: string; name: string }>
  now: Date
  months: number
}): AiStatsView {
  const { keys } = monthWindow(input.now, input.months)
  const inWindow = new Set(keys)
  const currentKey = keys[keys.length - 1]

  const judgments = input.judgments.filter((r) => inWindow.has(monthKey(r.judgedAt)))
  const usage = input.usage.filter((r) => inWindow.has(monthKey(r.occurredAt)))

  // 花費
  let monthCostUsd = 0
  let monthUnpricedCount = 0
  const costBySource = Object.fromEntries(
    SOURCES.map((s) => [s, { costUsd: 0, unpricedCount: 0 }]),
  ) as AiStatsView['costBySource']
  const monthCost = new Map<string, { costUsd: number; unpricedCount: number }>(
    keys.map((k) => [k, { costUsd: 0, unpricedCount: 0 }]),
  )
  const svcCost = new Map<string, { costUsd: number; unpricedCount: number }>()
  for (const r of usage) {
    const mk = monthKey(r.occurredAt)
    const m = monthCost.get(mk)!
    const sc = svcCost.get(r.serviceId) ?? { costUsd: 0, unpricedCount: 0 }
    svcCost.set(r.serviceId, sc)
    const isCurrent = mk === currentKey
    if (r.costUsd === null) {
      m.unpricedCount++
      sc.unpricedCount++
      if (isCurrent) {
        monthUnpricedCount++
        costBySource[r.source].unpricedCount++
      }
    } else {
      m.costUsd += r.costUsd
      sc.costUsd += r.costUsd
      if (isCurrent) {
        monthCostUsd += r.costUsd
        costBySource[r.source].costUsd += r.costUsd
      }
    }
  }

  // 判定
  const total = emptyTally()
  let labeledCount = 0
  const byMonthModel = new Map<string, Map<string, Tally>>(keys.map((k) => [k, new Map()]))
  const models = new Set<string>()
  const matrix = Object.fromEntries(
    SEVERITIES.map((a) => [a, Object.fromEntries(SEVERITIES.map((b) => [b, 0]))]),
  ) as Record<Severity, Record<Severity, number>>
  let tooHigh = 0
  let tooLow = 0
  let envToApp = 0
  let appToEnv = 0
  const svcJ = new Map<string, { judgments: number; labeled: number; tally: Tally }>()

  for (const r of judgments) {
    const model = r.model ?? UNKNOWN_MODEL
    models.add(model)
    addToTally(total, r.label)
    if (isLabeled(r.label)) labeledCount++

    const perModel = byMonthModel.get(monthKey(r.judgedAt))!
    const mt = perModel.get(model) ?? emptyTally()
    perModel.set(model, mt)
    addToTally(mt, r.label)

    const sj = svcJ.get(r.serviceId) ?? { judgments: 0, labeled: 0, tally: emptyTally() }
    svcJ.set(r.serviceId, sj)
    sj.judgments++
    if (isLabeled(r.label)) sj.labeled++
    addToTally(sj.tally, r.label)

    if (r.label.severityVerdict === 'wrong' && r.label.severityCorrect !== null) {
      matrix[r.severity][r.label.severityCorrect]++
      const diff = SEVERITY_RANK[r.severity] - SEVERITY_RANK[r.label.severityCorrect]
      if (diff < 0) tooHigh++
      else if (diff > 0) tooLow++
    }
    if (r.label.categoryVerdict === 'wrong' && r.label.categoryCorrect !== null) {
      if (r.category === 'env' && r.label.categoryCorrect === 'app') envToApp++
      else if (r.category === 'app' && r.label.categoryCorrect === 'env') appToEnv++
    }
  }

  const monthly = keys.map((month) => {
    const c = monthCost.get(month)!
    const byModel: Record<string, { severity: Rate; category: Rate }> = {}
    for (const [model, t] of byMonthModel.get(month)!) {
      byModel[model] = { severity: rate(t.sevCorrect, t.sevTotal), category: rate(t.catCorrect, t.catTotal) }
    }
    return { month, costUsd: c.costUsd, unpricedCount: c.unpricedCount, byModel }
  })

  const names = new Map(input.services.map((s) => [s.id, s.name]))
  const ids = new Set([...svcJ.keys(), ...svcCost.keys()])
  const services = [...ids].map((serviceId) => {
    const sj = svcJ.get(serviceId)
    const sc = svcCost.get(serviceId)
    const t = sj?.tally ?? emptyTally()
    return {
      serviceId,
      name: names.get(serviceId) ?? '(unknown)',
      judgments: sj?.judgments ?? 0,
      labeled: sj?.labeled ?? 0,
      severity: rate(t.sevCorrect, t.sevTotal),
      category: rate(t.catCorrect, t.catTotal),
      costUsd: sc?.costUsd ?? 0,
      unpricedCount: sc?.unpricedCount ?? 0,
    }
  })
  services.sort((a, b) => {
    const ra = a.severity.rate
    const rb = b.severity.rate
    if (ra === null && rb !== null) return 1
    if (ra !== null && rb === null) return -1
    if (ra !== null && rb !== null && ra !== rb) return ra - rb
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })

  return {
    windowMonths: input.months,
    summary: {
      monthCostUsd,
      monthUnpricedCount,
      severity: rate(total.sevCorrect, total.sevTotal),
      category: rate(total.catCorrect, total.catTotal),
      labelRate: rate(labeledCount, judgments.length),
    },
    costBySource,
    models: [...models].sort(),
    monthly,
    miss: { severityMatrix: matrix, tooHigh, tooLow, envToApp, appToEnv },
    services,
  }
}
