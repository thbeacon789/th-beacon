// 週報分頁：依估算高度把週報切成多張圖（純函式）
import type { ListRow, WeeklyReport } from '@/core/weekly-report'

export const PAGE_WIDTH = 1200
export const PAGE_MAX_HEIGHT = 1600
export const MAX_PAGES = 4
export const LAYOUT = {
  header: 96, verdict: 180, stats: 140, sectionTitle: 56, row: 48, serviceRow: 48, footer: 64, gap: 24,
} as const // 數值為初值，Task 4 實測後可調，但只改這裡

export type ReportBlock =
  | { kind: 'verdict' } | { kind: 'stats' } | { kind: 'services' } | { kind: 'security' }
  | { kind: 'list'; list: 'longStanding' | 'recurring'; continued: boolean; rows: ListRow[] }
  | { kind: 'overflow'; remaining: number }
export interface ReportPage { index: number; total: number; height: number; blocks: ReportBlock[] }

/** 單一 block 的高度；空清單算一列（渲染端顯示「本週無」）。services/security 的項目數取自 report */
export function blockHeight(block: ReportBlock, report: WeeklyReport): number {
  switch (block.kind) {
    case 'verdict': return LAYOUT.verdict
    case 'stats': return LAYOUT.stats
    case 'services': return LAYOUT.sectionTitle + Math.ceil(report.services.length / 2) * LAYOUT.serviceRow
    case 'security': return LAYOUT.sectionTitle + report.security.length * LAYOUT.row
    case 'list': return LAYOUT.sectionTitle + Math.max(block.rows.length, 1) * LAYOUT.row
    case 'overflow': return LAYOUT.row
  }
}

/** 整頁高度：header、各 block、footer，相鄰元素間各一個 gap */
export function pageHeight(blocks: ReportBlock[], report: WeeklyReport): number {
  const sum = blocks.reduce((s, b) => s + blockHeight(b, report), 0)
  return LAYOUT.header + LAYOUT.footer + sum + LAYOUT.gap * (blocks.length + 1)
}

function layout(report: WeeklyReport, reserveOverflow: boolean): { pages: ReportBlock[][]; remaining: number; droppedEmpty: boolean } {
  const pages: ReportBlock[][] = [[{ kind: 'verdict' }, { kind: 'stats' }, { kind: 'services' }, { kind: 'security' }]]
  const lists = [
    { list: 'longStanding' as const, rows: report.longStanding },
    { list: 'recurring' as const, rows: report.recurring },
  ]
  let remaining = 0
  let stopped = false
  let droppedEmpty = false
  for (const { list, rows } of lists) {
    let placed = 0
    // 空清單仍輸出一個空 block；其餘在還有列時持續填入
    do {
      let page = pages[pages.length - 1]
      const isLast = () => pages.length === MAX_PAGES
      const limit = () => PAGE_MAX_HEIGHT - (reserveOverflow && isLast() ? LAYOUT.gap + LAYOUT.row : 0)
      const fitRows = () => Math.floor((limit() - pageHeight(page, report) - LAYOUT.gap - LAYOUT.sectionTitle) / LAYOUT.row)
      const need = 1 // 至少要塞得下一列（空清單也算一列）
      if (stopped || fitRows() < need) {
        if (stopped || isLast()) {
          stopped = true
          remaining += rows.length - placed
          if (rows.length === 0) droppedEmpty = true
          break
        }
        page = []
        pages.push(page)
      }
      const take = rows.length === 0 ? 0 : Math.min(fitRows(), rows.length - placed)
      page.push({ list, continued: placed > 0, rows: rows.slice(placed, placed + take), kind: 'list' })
      placed += take
    } while (placed < rows.length)
  }
  return { pages, remaining, droppedEmpty }
}

export function paginateReport(report: WeeklyReport): ReportPage[] {
  let result = layout(report, false)
  if (result.remaining > 0 || result.droppedEmpty) {
    result = layout(report, true)
    // 只剩空清單（「本週無」佔位列）放不下時，remaining 記為 1，讓使用者看得到仍有內容未上圖
    const remaining = result.remaining > 0 ? result.remaining : 1
    result.pages[result.pages.length - 1].push({ kind: 'overflow', remaining })
  }
  const total = result.pages.length
  return result.pages.map((blocks, i) => ({ index: i, total, height: pageHeight(blocks, report), blocks }))
}
