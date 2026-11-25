import type { WeeklyReport, IssueRow, ListRow } from '@/core/weekly-report'

export function issueRow(i: number, over: Partial<IssueRow> = {}): IssueRow {
  return {
    kind: 'issue', severity: 'P2', serviceName: 'chatxbuy-api', message: `連線逾時：資料庫查詢超過 30 秒 #${i}`,
    daysOpen: 27, count: 3, acknowledgedBy: null, isNew: false, reopenCount: 0, status: 'open', ...over,
  }
}

export function makeReport(over: Partial<WeeklyReport> = {}): WeeklyReport {
  const sec = (serviceName: string, status: 'ok' | 'warn' | 'bad' | 'unknown') => ({
    serviceName, status, note: null, openFindings: { high: 0, medium: status === 'warn' ? 3 : 0, low: 0 },
  })
  return {
    window: { start: new Date('2026-11-16T16:00:00Z'), end: new Date('2026-11-23T16:00:00Z'), label: '11/17–11/23' },
    generatedAt: '2026-11-24T01:12:00Z',
    verdict: 'attention',
    headline: '4/5 服務正常 · 1 項需關注',
    stats: { pollFailures: 2, pollFailureServices: 1, newIssues: 3, resolvedIssues: 1, alertsSent: 2 },
    services: [
      { name: 'altinvest', health: 'healthy', pollFailures: 0, openIssues: 0 },
      { name: 'chatxbuy-api', health: 'degraded', pollFailures: 0, openIssues: 2 },
      { name: 'chatxbuy-deploy', health: 'healthy', pollFailures: 0, openIssues: 0 },
      { name: 'trustnel-ios', health: 'down', pollFailures: 2, openIssues: 1 },
      { name: 'trustnel-web-with-an-extremely-long-service-name-40', health: 'healthy', pollFailures: 0, openIssues: 3 },
    ],
    security: [sec('altinvest', 'ok'), sec('chatxbuy-api', 'warn'), sec('trustnel-ios', 'bad'), sec('trustnel-web-with-an-extremely-long-service-name-40', 'unknown')],
    longStanding: [
      issueRow(1, { severity: 'P0', acknowledgedBy: 'navi-with-a-very-long-acknowledger-name-here', daysOpen: 31 }),
      issueRow(2, { isNew: true, daysOpen: 8, count: 12 }),
      { kind: 'security', serviceName: 'chatxbuy-api', counts: { high: 0, medium: 3, low: 1 }, oldestDays: 20, isNew: false },
    ],
    recurring: [
      issueRow(3, { severity: 'P1', reopenCount: 2, status: 'open' }),
      issueRow(4, { reopenCount: 1, status: 'resolved' }),
    ],
    ...over,
  }
}

export function manyRows(n: number): ListRow[] {
  return Array.from({ length: n }, (_, i) => issueRow(i + 10))
}
