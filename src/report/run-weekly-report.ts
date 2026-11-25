import { buildWeeklyReport, formatReportText, type ReportVerdict, type WeeklyReport, type WeeklyReportInput } from '@/core/weekly-report'
import { paginateReport, type ReportPage } from '@/core/weekly-report-pages'
import type { DiscordFile } from '@/notify/discord-files'
import type { SendResult } from '@/notify/discord'

export type ReportSender = (content: string, files: DiscordFile[]) => Promise<SendResult>

export interface RunWeeklyReportDeps {
  now: Date
  dashboardUrl: string | null
  load: (now: Date) => Promise<WeeklyReportInput>
  render: (report: WeeklyReport, page: ReportPage) => Promise<Uint8Array>
  send: ReportSender
}

export type RunWeeklyReportResult =
  | { ok: true; pages: number; imageFailed: boolean; verdict: ReportVerdict }
  | { ok: false; stage: 'load' | 'send'; reason: string }

export async function runWeeklyReport(deps: RunWeeklyReportDeps): Promise<RunWeeklyReportResult> {
  let input: WeeklyReportInput
  try {
    input = await deps.load(deps.now)
  } catch (error) {
    return { ok: false, stage: 'load', reason: error instanceof Error ? error.message : String(error) }
  }

  const report = buildWeeklyReport(input)
  const pages = paginateReport(report)

  let files: DiscordFile[] = []
  let imageFailed = false
  try {
    for (const page of pages) {
      const data = await deps.render(report, page)
      files.push({ filename: `weekly-report-${files.length + 1}.png`, data, contentType: 'image/png' })
    }
  } catch {
    imageFailed = true
    files = []
  }

  const content = formatReportText(report, { dashboardUrl: deps.dashboardUrl, imageFailed })
  const sent = await deps.send(content, files)
  if (!sent.ok) return { ok: false, stage: 'send', reason: sent.reason }
  return { ok: true, pages: pages.length, imageFailed, verdict: report.verdict }
}
