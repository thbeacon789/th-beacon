import { describe, expect, it } from 'vitest'
import type { IssueRow, WeeklyReport } from '@/core/weekly-report'
import { LAYOUT, MAX_PAGES, PAGE_MAX_HEIGHT, paginateReport, type ReportBlock } from '@/core/weekly-report-pages'

const issueRow = (n: number): IssueRow => ({
  kind: 'issue', severity: 'P1', serviceName: `svc${n}`, message: `m${n}`, daysOpen: 9, count: 1,
  acknowledgedBy: null, isNew: false, reopenCount: 0, status: 'open',
})
const rows = (n: number) => Array.from({ length: n }, (_, i) => issueRow(i))

function makeReport(opts: { services?: number; long?: number; recurring?: number } = {}): WeeklyReport {
  const n = opts.services ?? 5
  return {
    window: { start: new Date(0), end: new Date(0), label: '01/01–01/07' },
    generatedAt: new Date(0).toISOString(),
    verdict: 'ok', headline: 'ok',
    stats: { pollFailures: 0, pollFailureServices: 0, newIssues: 0, resolvedIssues: 0, alertsSent: 0 },
    services: Array.from({ length: n }, (_, i) => ({ name: `s${i}`, health: 'healthy' as const, pollFailures: 0, openIssues: 0 })),
    security: Array.from({ length: n }, (_, i) => ({
      serviceName: `s${i}`, status: 'ok' as const, note: null, openFindings: { high: 0, medium: 0, low: 0 },
    })),
    longStanding: rows(opts.long ?? 0),
    recurring: rows(opts.recurring ?? 0),
  }
}
const listRows = (pages: ReturnType<typeof paginateReport>) =>
  pages.flatMap((p) => p.blocks).reduce((s, b) => s + (b.kind === 'list' ? b.rows.length : 0), 0)

describe('paginateReport', () => {
  it('空清單：1 頁，固定 block 順序', () => {
    const pages = paginateReport(makeReport())
    expect(pages).toHaveLength(1)
    expect(pages[0].total).toBe(1)
    const kinds = pages[0].blocks.map((b) => (b.kind === 'list' ? `list:${b.list}:${b.rows.length}` : b.kind))
    expect(kinds).toEqual(['verdict', 'stats', 'services', 'security', 'list:longStanding:0', 'list:recurring:0'])
  })

  it('長期未處理 60 列：多頁、續頁、高度不超限', () => {
    const pages = paginateReport(makeReport({ long: 60 }))
    expect(pages.length).toBeGreaterThan(1)
    const first = pages[1].blocks[0] as Extract<ReportBlock, { kind: 'list' }>
    expect(first.kind).toBe('list')
    expect(first.list).toBe('longStanding')
    expect(first.continued).toBe(true)
    for (const p of pages) {
      expect(p.height).toBeLessThanOrEqual(PAGE_MAX_HEIGHT)
      expect(p.total).toBe(pages.length)
    }
    expect(listRows(pages)).toBe(60)
  })

  it('500 列：恰 MAX_PAGES 頁，最後 block 為 overflow', () => {
    const pages = paginateReport(makeReport({ long: 500 }))
    expect(pages).toHaveLength(MAX_PAGES)
    const last = pages[pages.length - 1]
    const tail = last.blocks[last.blocks.length - 1]
    expect(tail.kind).toBe('overflow')
    expect((tail as { remaining: number }).remaining).toBe(500 - listRows(pages))
    for (const p of pages) expect(p.height).toBeLessThanOrEqual(PAGE_MAX_HEIGHT)
  })

  it('恰好填滿一頁不產生空白第 2 頁', () => {
    const base = paginateReport(makeReport({ long: 1 }))[0]
    const fit = Math.floor((PAGE_MAX_HEIGHT - base.height) / LAYOUT.row)
    const pages = paginateReport(makeReport({ long: 1 + fit }))
    expect(pages).toHaveLength(1)
    expect(pages[0].height).toBeLessThanOrEqual(PAGE_MAX_HEIGHT)
    // 再多一列則進第 2 頁
    expect(paginateReport(makeReport({ long: 2 + fit }))).toHaveLength(2)
  })

  it('兩份清單皆有資料且第一份被截斷：第二份全數計入 remaining', () => {
    const pages = paginateReport(makeReport({ long: 500, recurring: 10 }))
    expect(pages).toHaveLength(MAX_PAGES)
    const tail = pages[pages.length - 1].blocks.at(-1) as { kind: string; remaining: number }
    expect(tail.kind).toBe('overflow')
    expect(tail.remaining).toBeGreaterThan(0)
    expect(tail.remaining).toBe(510 - listRows(pages))
    const recurringBlocks = pages.flatMap((p) => p.blocks).filter((b) => b.kind === 'list' && b.list === 'recurring')
    expect(recurringBlocks).toHaveLength(0)
    for (const p of pages) expect(p.height).toBeLessThanOrEqual(PAGE_MAX_HEIGHT)
  })

  it('空清單在末頁放不下：不得靜默消失，須以 overflow 呈現', () => {
    let hit = false
    for (let n = 100; n < 300 && !hit; n++) {
      const pages = paginateReport(makeReport({ long: n }))
      const blocks = pages.flatMap((p) => p.blocks)
      const hasEmptyRecurring = blocks.some((b) => b.kind === 'list' && b.list === 'recurring' && b.rows.length === 0)
      const tail = pages[pages.length - 1].blocks.at(-1)
      if (!hasEmptyRecurring) {
        // 空清單放不下時，預留 overflow 會再擠掉末頁的列，remaining >= 1 且 = n − 已上圖列數
        expect(tail?.kind).toBe('overflow')
        expect((tail as { remaining: number }).remaining).toBeGreaterThan(0)
        expect((tail as { remaining: number }).remaining).toBe(n - listRows(pages))
        for (const p of pages) expect(p.height).toBeLessThanOrEqual(PAGE_MAX_HEIGHT)
        hit = true
      }
      // 任何情況下，空 recurring 不可無聲消失
      expect(hasEmptyRecurring || tail?.kind === 'overflow').toBe(true)
    }
    expect(hit).toBe(true)
  })
})
