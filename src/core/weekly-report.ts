// 週報模型：把一週資料整理成可渲染的結構（純函式，時鐘由 input.now 注入）
import type { HealthStatus, IssueStatus, Severity } from '@/core/types'
import type { OverallStatus } from '@/core/security/view'
import type { FindingSeverity } from '@/core/security/types'

/** 長期未處理門檻（天）；first_seen 早於此天數才進清單 */
export const LONG_STANDING_DAYS = 7

const DAY_MS = 86400000
const HOUR_MS = 3600000
const TAIPEI_OFFSET_MS = 8 * HOUR_MS

export interface ReportWindow { start: Date; end: Date; label: string }

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 以 now 推算剛結束的完整週：[上週一 00:00, 本週一 00:00)（台北時間，UTC+8 無夏令） */
export function reportWindow(now: Date): ReportWindow {
  const wall = now.getTime() + TAIPEI_OFFSET_MS
  const dayStart = Math.floor(wall / DAY_MS) * DAY_MS
  const dow = new Date(dayStart).getUTCDay() // 0=週日
  const mondayWall = dayStart - ((dow + 6) % 7) * DAY_MS
  const endMs = mondayWall - TAIPEI_OFFSET_MS
  const startMs = endMs - 7 * DAY_MS
  const fmt = (ms: number) => {
    const d = new Date(ms + TAIPEI_OFFSET_MS)
    return `${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())}`
  }
  return { start: new Date(startMs), end: new Date(endMs), label: `${fmt(startMs)}–${fmt(endMs - DAY_MS)}` }
}

/** 折成單行並截斷（以 code point 計，截斷時以 … 結尾，總長不超過 max） */
export function toOneLine(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim())
  if (chars.length <= max) return chars.join('')
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…'
}

export interface WeeklyReportInput {
  now: Date
  services: Array<{ id: string; name: string; healthStatus: HealthStatus; openCounts: Record<Severity, number> }>
  issues: Array<{
    id: string; serviceId: string; severity: Severity; status: IssueStatus; message: string; count: number
    firstSeen: string; lastSeen: string; resolvedAt: string | null; acknowledgedBy: string | null; reopenCount: number
  }>
  healthFailEvents: Array<{ serviceId: string; occurredAt: string }>
  alertsSent: number
  securityRows: Array<{ serviceId: string; overall: OverallStatus; stale: boolean }>
  securityFindings: Array<{
    serviceId: string; severity: FindingSeverity; status: 'open' | 'resolved' | 'ignored'
    firstSeenAt: string; lastSeenAt: string; reopenCount: number
  }>
}

export type ReportVerdict = 'ok' | 'attention' | 'critical'
export interface IssueRow {
  kind: 'issue'; severity: Severity; serviceName: string; message: string
  daysOpen: number; count: number; acknowledgedBy: string | null; isNew: boolean
  reopenCount: number; status: IssueStatus
}
export interface SecurityGroupRow {
  kind: 'security'; serviceName: string; counts: Record<FindingSeverity, number>; oldestDays: number; isNew: boolean
}
export type ListRow = IssueRow | SecurityGroupRow
export interface WeeklyReport {
  window: ReportWindow
  generatedAt: string
  verdict: ReportVerdict
  headline: string
  stats: { pollFailures: number; pollFailureServices: number; newIssues: number; resolvedIssues: number; alertsSent: number }
  services: Array<{ name: string; health: HealthStatus; pollFailures: number; openIssues: number }>
  security: Array<{ serviceName: string; status: OverallStatus; note: 'stale' | 'none' | null; openFindings: Record<FindingSeverity, number> }>
  longStanding: ListRow[]
  recurring: ListRow[]
}

const SEVERITY_ORDER: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 }
const MESSAGE_MAX = 60

const emptyCounts = (): Record<FindingSeverity, number> => ({ high: 0, medium: 0, low: 0 })

export function buildWeeklyReport(input: WeeklyReportInput): WeeklyReport {
  const { now } = input
  const nowMs = now.getTime()
  const window = reportWindow(now)
  const startMs = window.start.getTime()
  const endMs = window.end.getTime()
  const inWindow = (iso: string) => {
    const t = Date.parse(iso)
    return t >= startMs && t < endMs
  }
  // 本週新進長期未處理：first_seen ∈ [start − 7d, end − 7d)
  const thresholdMs = LONG_STANDING_DAYS * DAY_MS
  const isNewLongStanding = (firstSeen: string) => {
    const t = Date.parse(firstSeen)
    return t >= startMs - thresholdMs && t < endMs - thresholdMs
  }
  const daysSince = (iso: string) => Math.floor((nowMs - Date.parse(iso)) / DAY_MS)
  const serviceName = new Map(input.services.map((s) => [s.id, s.name]))
  const nameOf = (id: string) => serviceName.get(id) ?? id

  // --- issues 清單 ---
  const toIssueRow = (i: WeeklyReportInput['issues'][number], isNew: boolean): IssueRow => ({
    kind: 'issue',
    severity: i.severity,
    serviceName: nameOf(i.serviceId),
    message: toOneLine(i.message, MESSAGE_MAX),
    daysOpen: daysSince(i.firstSeen),
    count: i.count,
    acknowledgedBy: i.acknowledgedBy,
    isNew,
    reopenCount: i.reopenCount,
    status: i.status,
  })
  const bySeverityThenAge = (a: IssueRow, b: IssueRow) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.daysOpen - a.daysOpen

  const longIssues = input.issues
    .filter((i) => (i.status === 'open' || i.status === 'acknowledged') && nowMs - Date.parse(i.firstSeen) >= thresholdMs)
    .map((i) => toIssueRow(i, isNewLongStanding(i.firstSeen)))
    .sort(bySeverityThenAge)
  const recurringIssues = input.issues
    .filter((i) => i.reopenCount >= 1 && inWindow(i.lastSeen))
    .map((i) => toIssueRow(i, false))
    .sort(bySeverityThenAge)

  // --- 資安 finding 依服務聚合 ---
  type F = WeeklyReportInput['securityFindings'][number]
  const groupFindings = (list: F[], markNew: boolean): SecurityGroupRow[] => {
    const groups = new Map<string, SecurityGroupRow>()
    for (const f of list) {
      const g = groups.get(f.serviceId) ?? {
        kind: 'security' as const, serviceName: nameOf(f.serviceId), counts: emptyCounts(), oldestDays: 0, isNew: false,
      }
      g.counts[f.severity] += 1
      g.oldestDays = Math.max(g.oldestDays, daysSince(f.firstSeenAt))
      if (markNew && isNewLongStanding(f.firstSeenAt)) g.isNew = true
      groups.set(f.serviceId, g)
    }
    return [...groups.values()].sort((a, b) => b.oldestDays - a.oldestDays || a.serviceName.localeCompare(b.serviceName))
  }
  const openFindings = input.securityFindings.filter((f) => f.status === 'open')
  const longSecurity = groupFindings(
    openFindings.filter((f) => nowMs - Date.parse(f.firstSeenAt) >= thresholdMs),
    true,
  )
  const recurringSecurity = groupFindings(
    openFindings.filter((f) => f.reopenCount >= 1 && inWindow(f.lastSeenAt)),
    false,
  )
  const longStanding: ListRow[] = [...longIssues, ...longSecurity]
  const recurring: ListRow[] = [...recurringIssues, ...recurringSecurity]

  // --- 服務與資安列 ---
  const failsByService = new Map<string, number>()
  let pollFailures = 0
  for (const e of input.healthFailEvents) {
    if (!inWindow(e.occurredAt)) continue
    pollFailures += 1
    failsByService.set(e.serviceId, (failsByService.get(e.serviceId) ?? 0) + 1)
  }
  const services = input.services.map((s) => ({
    name: s.name,
    health: s.healthStatus,
    pollFailures: failsByService.get(s.id) ?? 0,
    openIssues: s.openCounts.P0 + s.openCounts.P1 + s.openCounts.P2,
  }))
  const securityRowByService = new Map(input.securityRows.map((r) => [r.serviceId, r]))
  const security = input.services.map((s) => {
    const row = securityRowByService.get(s.id)
    const counts = emptyCounts()
    for (const f of openFindings) if (f.serviceId === s.id) counts[f.severity] += 1
    return {
      serviceName: s.name,
      status: row ? row.overall : ('unknown' as OverallStatus),
      note: row ? (row.stale ? ('stale' as const) : null) : ('none' as const),
      openFindings: counts,
    }
  })

  // --- 結論 ---
  const downCount = input.services.filter((s) => s.healthStatus === 'down').length
  const degradedCount = input.services.filter((s) => s.healthStatus === 'degraded').length
  const p0Count = input.issues.filter((i) => i.severity === 'P0' && (i.status === 'open' || i.status === 'acknowledged')).length
  const securityBadCount = security.filter((s) => s.status === 'bad').length
  const recurringCount = recurring.length
  const newLongCount = longStanding.filter((r) => r.isNew).length
  const newSecurityFindings = openFindings.filter((f) => f.severity !== 'low' && inWindow(f.firstSeenAt)).length
  const staleCount = security.filter((s) => s.note !== null).length

  const verdict: ReportVerdict =
    downCount > 0 || p0Count > 0 || securityBadCount > 0
      ? 'critical'
      : degradedCount > 0 || recurringCount > 0 || newLongCount > 0 || newSecurityFindings > 0 || staleCount > 0
        ? 'attention'
        : 'ok'

  let headline: string
  if (verdict === 'ok') {
    const total = input.services.length
    headline = longStanding.length > 0
      ? `${total}/${total} 服務正常 · 另有 ${longStanding.length} 筆既有待處理`
      : `${total}/${total} 服務正常，無待處理事項`
  } else {
    const reasons: Array<[number, string]> = [
      [downCount, `${downCount} 個服務異常`],
      [degradedCount, `${degradedCount} 個服務降級`],
      [p0Count, `${p0Count} 筆未解 P0`],
      [securityBadCount, `資安異常 ${securityBadCount} 個服務`],
      [recurringCount, `${recurringCount} 筆反覆出現`],
      [newLongCount, `${newLongCount} 筆本週新進長期未處理`],
      [newSecurityFindings, `${newSecurityFindings} 筆新資安發現`],
      [staleCount, `資安掃描過期或缺漏 ${staleCount} 個服務`],
    ]
    headline = reasons.filter(([n]) => n > 0).map(([, text]) => text).join('、')
  }

  return {
    window,
    generatedAt: now.toISOString(),
    verdict,
    headline,
    stats: {
      pollFailures,
      pollFailureServices: failsByService.size,
      newIssues: input.issues.filter((i) => inWindow(i.firstSeen)).length,
      resolvedIssues: input.issues.filter((i) => i.status === 'resolved' && i.resolvedAt !== null && inWindow(i.resolvedAt)).length,
      alertsSent: input.alertsSent,
    },
    services,
    security,
    longStanding,
    recurring,
  }
}

const VERDICT_LABEL: Record<ReportVerdict, string> = { ok: '正常', attention: '需關注', critical: '異常' }

/** Discord 訊息本文（圖片的文字備援） */
export function formatReportText(report: WeeklyReport, opts: { dashboardUrl: string | null; imageFailed: boolean }): string {
  const lines = [
    `**TH-BEACON 週報 ${report.window.label}** · ${VERDICT_LABEL[report.verdict]}：${report.headline}`,
    `長期未處理 ${report.longStanding.length} 筆 · 反覆出現 ${report.recurring.length} 筆`,
  ]
  if (opts.imageFailed) lines.push('（圖片產生失敗）')
  if (opts.dashboardUrl) lines.push(opts.dashboardUrl)
  return lines.join('\n')
}
