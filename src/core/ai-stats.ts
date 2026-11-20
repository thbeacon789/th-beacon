import type { AiUsageSource, JudgmentLabel, Severity } from './types'
import type { DiagnosisCategory } from './heartbeat'

export const STATS_TZ_OFFSET_MINUTES = 480 // Asia/Taipei，無日光節約
export const STATS_WEEKS = 12
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

export interface TrendPoint {
  costUsd: number
  unpricedCount: number
  byModel: Record<string, { severity: Rate; category: Rate }>
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
  monthly: Array<{ month: string } & TrendPoint>
  /** 近 STATS_WEEKS 週（台北週一起算），week = 該週週一的 'YYYY-MM-DD'，由舊到新 */
  weekly: Array<{ week: string } & TrendPoint>
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
// 以 Record 列舉而非陣列：AiUsageSource 新增成員時，漏列會在 typecheck 失敗，
// 不會等到頁面讀取 costBySource[新來源] 時才在執行期炸掉。
const SOURCE_SET: Record<AiUsageSource, true> = {
  server_triage: true,
  ci_diagnosis: true,
  ci_pr: true,
  ci_security: true,
}
const SOURCES = Object.keys(SOURCE_SET) as AiUsageSource[]
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

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function weekKeyOfShifted(d: Date): string {
  const back = (d.getUTCDay() + 6) % 7 // 週一 = 0
  const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back))
  return `${mon.getUTCFullYear()}-${pad2(mon.getUTCMonth() + 1)}-${pad2(mon.getUTCDate())}`
}

/** 該週週一的台北日期 'YYYY-MM-DD'（週一 00:00 台北起算） */
export function weekKey(iso: string): string {
  return weekKeyOfShifted(taipeiShifted(Date.parse(iso)))
}

/** 含本週往前共 weeks 週，由舊到新 */
export function weekWindow(now: Date, weeks: number): { keys: string[] } {
  const cur = taipeiShifted(now.getTime())
  const keys: string[] = []
  for (let i = weeks - 1; i >= 0; i--) {
    keys.push(weekKeyOfShifted(new Date(cur.getTime() - i * 7 * 86_400_000)))
  }
  return { keys }
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

// 月／週共用的分桶聚合：keys 之外的資料略過；空桶仍會出現
function buildSeries(
  keys: string[],
  keyFn: (iso: string) => string,
  usage: UsageStatRow[],
  judgments: JudgmentStatRow[],
): Array<{ key: string } & TrendPoint> {
  const cost = new Map(keys.map((k) => [k, { costUsd: 0, unpricedCount: 0 }]))
  const tallies = new Map<string, Map<string, Tally>>(keys.map((k) => [k, new Map()]))
  for (const r of usage) {
    const c = cost.get(keyFn(r.occurredAt))
    if (!c) continue
    if (r.costUsd === null) c.unpricedCount++
    else c.costUsd += r.costUsd
  }
  for (const r of judgments) {
    const perModel = tallies.get(keyFn(r.judgedAt))
    if (!perModel) continue
    const model = r.model ?? UNKNOWN_MODEL
    const t = perModel.get(model) ?? emptyTally()
    perModel.set(model, t)
    addToTally(t, r.label)
  }
  return keys.map((key) => {
    const c = cost.get(key)!
    const byModel: TrendPoint['byModel'] = {}
    for (const [model, t] of tallies.get(key)!) {
      byModel[model] = { severity: rate(t.sevCorrect, t.sevTotal), category: rate(t.catCorrect, t.catTotal) }
    }
    return { key, costUsd: c.costUsd, unpricedCount: c.unpricedCount, byModel }
  })
}

export function computeAiStats(input: {
  judgments: JudgmentStatRow[]
  usage: UsageStatRow[]
  services: Array<{ id: string; name: string }>
  now: Date
  months: number
  weeks?: number
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
  const svcCost = new Map<string, { costUsd: number; unpricedCount: number }>()
  for (const r of usage) {
    const mk = monthKey(r.occurredAt)
    const sc = svcCost.get(r.serviceId) ?? { costUsd: 0, unpricedCount: 0 }
    svcCost.set(r.serviceId, sc)
    const isCurrent = mk === currentKey
    if (r.costUsd === null) {
      sc.unpricedCount++
      if (isCurrent) {
        monthUnpricedCount++
        costBySource[r.source].unpricedCount++
      }
    } else {
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

  const monthly = buildSeries(keys, monthKey, usage, judgments).map(({ key, ...rest }) => ({ month: key, ...rest }))
  // 週序列用同一批未過濾資料（月視窗須涵蓋週視窗）；視窗外的由 buildSeries 略過
  const weekly = buildSeries(
    weekWindow(input.now, input.weeks ?? STATS_WEEKS).keys,
    weekKey,
    input.usage,
    input.judgments,
  ).map(({ key, ...rest }) => ({ week: key, ...rest }))

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
    weekly,
    miss: { severityMatrix: matrix, tooHigh, tooLow, envToApp, appToEnv },
    services,
  }
}
