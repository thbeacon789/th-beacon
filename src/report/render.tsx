// 週報單頁 → PNG（next/og ImageResponse；Node runtime）
import { ImageResponse } from 'next/og'
import type { WeeklyReport } from '@/core/weekly-report'
import { LAYOUT, PAGE_WIDTH, type ReportPage } from '@/core/weekly-report-pages'
import { Block, Footer, Header } from './blocks'
import { getReportFonts } from './fonts'
import { COLORS } from './tokens'

const pad2 = (n: number) => String(n).padStart(2, '0')

/** ISO → 台北時間 YYYY-MM-DD HH:mm（UTC+8 無夏令） */
function taipeiStamp(iso: string): string {
  const d = new Date(Date.parse(iso) + 8 * 3600000)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
}

export async function renderReportPage(
  report: WeeklyReport,
  page: ReportPage,
  opts: { dashboardUrl: string | null },
): Promise<Uint8Array> {
  const fonts = await getReportFonts()
  const footer = [`產生時間 ${taipeiStamp(report.generatedAt)}（台北）`, `${page.index + 1}/${page.total}`, opts.dashboardUrl]
    .filter(Boolean)
    .join(' · ')
  const jsx = (
    <div style={{ display: 'flex', flexDirection: 'column', width: PAGE_WIDTH, height: page.height, backgroundColor: COLORS.bg, gap: LAYOUT.gap, color: COLORS.fg }}>
      <Header report={report} index={page.index} total={page.total} />
      {page.blocks.map((b, i) => <Block key={i} block={b} report={report} />)}
      <Footer text={footer} />
    </div>
  )
  const res = new ImageResponse(jsx, { width: PAGE_WIDTH, height: page.height, fonts })
  return new Uint8Array(await res.arrayBuffer())
}
