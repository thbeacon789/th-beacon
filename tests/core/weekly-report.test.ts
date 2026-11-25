import { describe, it, expect } from 'vitest'
import {
  LONG_STANDING_DAYS,
  reportWindow,
  toOneLine,
  buildWeeklyReport,
  formatReportText,
  type WeeklyReportInput,
} from '@/core/weekly-report'

const DAY = 86400000
const HOUR = 3600000
// 台北週一 09:00；窗為 11/23–11/29 → [2026-11-22T16:00Z, 2026-11-29T16:00Z)
const now = new Date('2026-11-30T01:00:00Z')
const winStart = Date.parse('2026-11-22T16:00:00Z')
const winEnd = Date.parse('2026-11-29T16:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

const zero = { P0: 0, P1: 0, P2: 0 }
function svc(id: string, healthStatus: 'healthy' | 'degraded' | 'down' = 'healthy', openCounts = zero) {
  return { id, name: id, healthStatus, openCounts }
}
const fiveServices = ['a', 'b', 'c', 'd', 'e']
function baseInput(over: Partial<WeeklyReportInput> = {}): WeeklyReportInput {
  return {
    now,
    services: fiveServices.map((id) => svc(id)),
    issues: [],
    healthFailEvents: [],
    alertsSent: 0,
    securityRows: fiveServices.map((id) => ({ serviceId: id, overall: 'ok' as const, stale: false })),
    securityFindings: [],
    ...over,
  }
}
function issue(over: Partial<WeeklyReportInput['issues'][number]> = {}): WeeklyReportInput['issues'][number] {
  return {
    id: 'i1', serviceId: 'a', severity: 'P1', status: 'open', message: 'boom', count: 3,
    firstSeen: iso(winStart - 30 * DAY), lastSeen: iso(winStart - 29 * DAY),
    resolvedAt: null, acknowledgedBy: null, reopenCount: 0, ...over,
  }
}
function finding(over: Partial<WeeklyReportInput['securityFindings'][number]> = {}): WeeklyReportInput['securityFindings'][number] {
  return {
    serviceId: 'a', severity: 'low', status: 'open',
    firstSeenAt: iso(winStart - 30 * DAY), lastSeenAt: iso(winStart - 1 * DAY), reopenCount: 0, ...over,
  }
}

describe('reportWindow', () => {
  it('週二觸發也推算出剛結束的完整週（週一 00:00 台北為界）', () => {
    // 2026-11-24 為週二，台北本週一 = 11/23
    const w = reportWindow(new Date('2026-11-24T01:30:00Z'))
    expect(w.start.toISOString()).toBe('2026-11-15T16:00:00.000Z')
    expect(w.end.toISOString()).toBe('2026-11-22T16:00:00.000Z')
    expect(w.label).toBe('11/16–11/22')
  })

  it('台北週一 00:00 之前（週日 23:30）仍屬上一個週期', () => {
    const w = reportWindow(new Date('2026-11-22T15:30:00Z'))
    expect(w.start.toISOString()).toBe('2026-11-08T16:00:00.000Z')
    expect(w.end.toISOString()).toBe('2026-11-15T16:00:00.000Z')
    expect(w.label).toBe('11/09–11/15')
  })

  it('台北週一 00:00 整點起算新週期（半開區間）', () => {
    const w = reportWindow(new Date('2026-11-22T16:00:00Z'))
    expect(w.end.toISOString()).toBe('2026-11-22T16:00:00.000Z')
  })

  it('跨月且月日補零', () => {
    const w = reportWindow(new Date('2026-12-07T01:00:00Z'))
    expect(w.start.toISOString()).toBe('2026-11-29T16:00:00.000Z')
    expect(w.label).toBe('11/30–12/06')
  })
})

describe('toOneLine', () => {
  it('折疊空白與換行', () => {
    expect(toOneLine('a\n\tb   c', 99)).toBe('a b c')
  })
  it('超長截斷並含 … 共 max 字元', () => {
    expect(toOneLine('x'.repeat(10), 5)).toBe('xxxx…')
  })
  it('以 code point 計，不切半個 emoji', () => {
    expect(toOneLine('😀😀😀😀', 3)).toBe('😀😀…')
    expect(toOneLine('😀😀', 2)).toBe('😀😀')
  })
})

describe('verdict', () => {
  it('LONG_STANDING_DAYS 為 7', () => {
    expect(LONG_STANDING_DAYS).toBe(7)
  })

  it('全無項目 → ok', () => {
    const r = buildWeeklyReport(baseInput())
    expect(r.verdict).toBe('ok')
    expect(r.headline).toBe('5/5 服務正常，無待處理事項')
  })

  it('服務 down → critical', () => {
    const r = buildWeeklyReport(baseInput({ services: [svc('a', 'down'), ...fiveServices.slice(1).map((i) => svc(i))] }))
    expect(r.verdict).toBe('critical')
    expect(r.headline).toBe('1 個服務異常')
  })

  it('acknowledged 的 P0 → critical', () => {
    const r = buildWeeklyReport(baseInput({ issues: [issue({ severity: 'P0', status: 'acknowledged', acknowledgedBy: 'x' })] }))
    expect(r.verdict).toBe('critical')
    expect(r.headline).toContain('1 筆未解 P0')
  })

  it('已解決的 P0 不算 critical', () => {
    const r = buildWeeklyReport(baseInput({ issues: [issue({ severity: 'P0', status: 'resolved', resolvedAt: iso(winStart + DAY) })] }))
    expect(r.verdict).toBe('ok')
  })

  it('資安 bad → critical', () => {
    const rows = fiveServices.map((id, i) => ({ serviceId: id, overall: i === 0 ? ('bad' as const) : ('ok' as const), stale: false }))
    const r = buildWeeklyReport(baseInput({ securityRows: rows }))
    expect(r.verdict).toBe('critical')
    expect(r.headline).toBe('資安異常 1 個服務')
  })

  it('degraded → attention，與本週新進長期未處理以「、」串接', () => {
    const r = buildWeeklyReport(baseInput({
      services: [svc('a', 'degraded'), ...fiveServices.slice(1).map((i) => svc(i))],
      issues: [issue({ firstSeen: iso(winStart - 7 * DAY + HOUR) })],
    }))
    expect(r.verdict).toBe('attention')
    expect(r.headline).toBe('1 個服務降級、1 筆本週新進長期未處理')
  })

  it('反覆出現 → attention', () => {
    const r = buildWeeklyReport(baseInput({ issues: [issue({ reopenCount: 2, lastSeen: iso(winStart + DAY) })] }))
    expect(r.verdict).toBe('attention')
    expect(r.headline).toContain('1 筆反覆出現')
  })

  it('本週新進長期未處理 → attention；既有項 → 仍為 ok', () => {
    const fresh = buildWeeklyReport(baseInput({ issues: [issue({ firstSeen: iso(winStart - 7 * DAY + HOUR) })] }))
    expect(fresh.verdict).toBe('attention')
    expect(fresh.longStanding[0]).toMatchObject({ kind: 'issue', isNew: true })

    const old = buildWeeklyReport(baseInput({ issues: [issue({ firstSeen: iso(winStart - 30 * DAY) })] }))
    expect(old.verdict).toBe('ok')
    expect(old.headline).toBe('5/5 服務正常 · 另有 1 筆既有待處理')
    expect(old.longStanding[0]).toMatchObject({ isNew: false })
  })

  it('窗內新出現的 medium finding → attention', () => {
    const r = buildWeeklyReport(baseInput({ securityFindings: [finding({ severity: 'medium', firstSeenAt: iso(winStart + DAY) })] }))
    expect(r.verdict).toBe('attention')
    expect(r.headline).toBe('1 筆新資安發現')
  })

  it('窗內新出現的 low finding 不影響結論', () => {
    const r = buildWeeklyReport(baseInput({ securityFindings: [finding({ severity: 'low', firstSeenAt: iso(winStart + DAY) })] }))
    expect(r.verdict).toBe('ok')
  })

  it('掃描過期 → attention，note=stale', () => {
    const rows = fiveServices.map((id, i) => ({ serviceId: id, overall: i === 0 ? ('unknown' as const) : ('ok' as const), stale: i === 0 }))
    const r = buildWeeklyReport(baseInput({ securityRows: rows }))
    expect(r.verdict).toBe('attention')
    expect(r.headline).toBe('資安掃描過期或缺漏 1 個服務')
    expect(r.security[0]).toMatchObject({ status: 'unknown', note: 'stale' })
  })

  it('完全沒有掃描列 → attention，status=unknown、note=none', () => {
    const r = buildWeeklyReport(baseInput({ securityRows: fiveServices.slice(1).map((id) => ({ serviceId: id, overall: 'ok' as const, stale: false })) }))
    expect(r.verdict).toBe('attention')
    expect(r.security[0]).toMatchObject({ serviceName: 'a', status: 'unknown', note: 'none' })
  })

  it('標題原因順序固定', () => {
    const r = buildWeeklyReport(baseInput({
      services: [svc('a', 'down'), svc('b', 'degraded'), ...fiveServices.slice(2).map((i) => svc(i))],
      issues: [
        issue({ id: 'p0', severity: 'P0', status: 'open' }),
        issue({ id: 'r', reopenCount: 1, lastSeen: iso(winStart + DAY) }),
        issue({ id: 'n', firstSeen: iso(winStart - 7 * DAY + HOUR) }),
      ],
      securityRows: fiveServices.map((id, i) => ({ serviceId: id, overall: i === 0 ? ('bad' as const) : i === 1 ? ('unknown' as const) : ('ok' as const), stale: i === 1 })),
      securityFindings: [finding({ severity: 'high', firstSeenAt: iso(winStart + DAY) })],
    }))
    expect(r.headline).toBe(
      '1 個服務異常、1 個服務降級、1 筆未解 P0、資安異常 1 個服務、1 筆反覆出現、1 筆本週新進長期未處理、1 筆新資安發現、資安掃描過期或缺漏 1 個服務',
    )
  })
})

describe('longStanding', () => {
  it('open 與 acknowledged 都列、帶出 acknowledgedBy；ignored/resolved 與未滿 7 天不列', () => {
    const r = buildWeeklyReport(baseInput({
      issues: [
        issue({ id: '1', status: 'open' }),
        issue({ id: '2', status: 'acknowledged', acknowledgedBy: 'amy' }),
        issue({ id: '3', status: 'ignored' }),
        issue({ id: '4', status: 'resolved', resolvedAt: iso(winStart + DAY) }),
        issue({ id: '5', firstSeen: iso(now.getTime() - 3 * DAY) }),
      ],
    }))
    expect(r.longStanding).toHaveLength(2)
    expect(r.longStanding.find((x) => x.kind === 'issue' && x.status === 'acknowledged')).toMatchObject({ acknowledgedBy: 'amy' })
  })

  it('排序 P0→P2、同級 daysOpen 大到小；daysOpen 為 floor 天數', () => {
    const r = buildWeeklyReport(baseInput({
      issues: [
        issue({ id: 'a', severity: 'P2', firstSeen: iso(now.getTime() - 40 * DAY) }),
        issue({ id: 'b', severity: 'P0', firstSeen: iso(now.getTime() - 10 * DAY - HOUR) }),
        issue({ id: 'c', severity: 'P0', firstSeen: iso(now.getTime() - 20 * DAY - HOUR) }),
      ],
    }))
    const rows = r.longStanding.filter((x) => x.kind === 'issue')
    expect(rows.map((x) => (x.kind === 'issue' ? [x.severity, x.daysOpen] : []))).toEqual([['P0', 20], ['P0', 10], ['P2', 40]])
  })

  it('資安 finding 依服務聚合：counts、oldestDays、isNew；ignored 不計', () => {
    const r = buildWeeklyReport(baseInput({
      securityFindings: [
        finding({ severity: 'medium', firstSeenAt: iso(now.getTime() - 20 * DAY) }),
        finding({ severity: 'medium', firstSeenAt: iso(now.getTime() - 9 * DAY) }),
        finding({ severity: 'low', firstSeenAt: iso(winStart - 7 * DAY + HOUR) }),
        finding({ severity: 'high', status: 'ignored', firstSeenAt: iso(now.getTime() - 50 * DAY) }),
      ],
    }))
    expect(r.longStanding).toHaveLength(1)
    expect(r.longStanding[0]).toEqual({
      kind: 'security', serviceName: 'a', counts: { high: 0, medium: 2, low: 1 }, oldestDays: 20, isNew: true,
    })
  })

  it('issues 在前、security 群組在後', () => {
    const r = buildWeeklyReport(baseInput({ issues: [issue()], securityFindings: [finding()] }))
    expect(r.longStanding.map((x) => x.kind)).toEqual(['issue', 'security'])
  })
})

describe('recurring', () => {
  it('reopenCount ≥ 1 且 lastSeen 在窗內才列', () => {
    const r = buildWeeklyReport(baseInput({
      issues: [
        issue({ id: '1', reopenCount: 1, lastSeen: iso(winStart + DAY) }),
        issue({ id: '2', reopenCount: 0, lastSeen: iso(winStart + DAY) }),
        issue({ id: '3', reopenCount: 2, lastSeen: iso(winStart - DAY) }),
        issue({ id: '4', reopenCount: 2, lastSeen: iso(winEnd) }),
      ],
    }))
    expect(r.recurring).toHaveLength(1)
    expect(r.recurring[0]).toMatchObject({ kind: 'issue', reopenCount: 1, status: 'open' })
  })

  it('資安 finding 依服務聚合', () => {
    const r = buildWeeklyReport(baseInput({
      securityFindings: [
        finding({ reopenCount: 1, lastSeenAt: iso(winStart + DAY), severity: 'high' }),
        finding({ reopenCount: 1, lastSeenAt: iso(winStart + DAY), severity: 'low' }),
        finding({ reopenCount: 0, lastSeenAt: iso(winStart + DAY) }),
      ],
    }))
    expect(r.recurring).toHaveLength(1)
    expect(r.recurring[0]).toMatchObject({ kind: 'security', serviceName: 'a', counts: { high: 1, medium: 0, low: 1 } })
  })
})

describe('stats 與服務列', () => {
  it('stats 計算', () => {
    const r = buildWeeklyReport(baseInput({
      healthFailEvents: [
        { serviceId: 'a', occurredAt: iso(winStart + DAY) },
        { serviceId: 'a', occurredAt: iso(winStart + 2 * DAY) },
        { serviceId: 'b', occurredAt: iso(winStart + 3 * DAY) },
        { serviceId: 'b', occurredAt: iso(winStart - DAY) },
        { serviceId: 'b', occurredAt: iso(winEnd) },
      ],
      alertsSent: 4,
      issues: [
        issue({ id: '1', firstSeen: iso(winStart + DAY) }),
        issue({ id: '2', firstSeen: iso(winStart - DAY) }),
        issue({ id: '3', status: 'resolved', resolvedAt: iso(winStart + DAY) }),
        issue({ id: '4', status: 'resolved', resolvedAt: iso(winStart - DAY) }),
        issue({ id: '5', status: 'open', resolvedAt: iso(winStart + DAY) }),
      ],
    }))
    expect(r.stats).toEqual({ pollFailures: 3, pollFailureServices: 2, newIssues: 1, resolvedIssues: 1, alertsSent: 4 })
    expect(r.services[0]).toMatchObject({ name: 'a', pollFailures: 2 })
    expect(r.services[1]).toMatchObject({ name: 'b', pollFailures: 1 })
  })

  it('服務列帶出未解 issue 數與健康度', () => {
    const r = buildWeeklyReport(baseInput({ services: [svc('a', 'degraded', { P0: 0, P1: 2, P2: 1 }), svc('b')] }))
    expect(r.services[0]).toMatchObject({ health: 'degraded', openIssues: 3 })
    expect(r.window.label).toBe('11/23–11/29')
    expect(r.generatedAt).toBe(now.toISOString())
  })

  it('security 帶出 open finding 計數', () => {
    const r = buildWeeklyReport(baseInput({
      securityFindings: [finding({ severity: 'high' }), finding({ severity: 'low' }), finding({ severity: 'low', status: 'resolved' })],
    }))
    expect(r.security[0].openFindings).toEqual({ high: 1, medium: 0, low: 1 })
  })
})

describe('formatReportText', () => {
  const report = buildWeeklyReport(baseInput())

  it('首行含週期、結論中文與標題', () => {
    const text = formatReportText(report, { dashboardUrl: null, imageFailed: false })
    expect(text.split('\n')[0]).toBe('**TH-BEACON 週報 11/23–11/29** · 正常：5/5 服務正常，無待處理事項')
    expect(text).toContain('長期未處理 0 筆 · 反覆出現 0 筆')
    expect(text).not.toContain('圖片產生失敗')
  })

  it('imageFailed 附註、dashboardUrl 為最後一行', () => {
    const text = formatReportText(report, { dashboardUrl: 'https://x.test/', imageFailed: true })
    expect(text).toContain('（圖片產生失敗）')
    expect(text.split('\n').at(-1)).toBe('https://x.test/')
  })

  it('verdict 中文對應', () => {
    const crit = buildWeeklyReport(baseInput({ services: [svc('a', 'down')] }))
    expect(formatReportText(crit, { dashboardUrl: null, imageFailed: false })).toContain('· 異常：')
    const att = buildWeeklyReport(baseInput({ services: [svc('a', 'degraded')] }))
    expect(formatReportText(att, { dashboardUrl: null, imageFailed: false })).toContain('· 需關注：')
  })
})
