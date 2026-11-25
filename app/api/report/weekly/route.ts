import { paginateReport } from '@/core/weekly-report-pages'
import { buildWeeklyReport } from '@/core/weekly-report'
import { loadWeeklyReportInput } from '@/report/load'
import { renderReportPage } from '@/report/render'
import { runWeeklyReport } from '@/report/run-weekly-report'
import { bearerMatches } from '@/web/bearer'
import { createServerReportSender, createServerStore, getCronSecret } from '@/store/server'

export const runtime = 'nodejs'
export const maxDuration = 60

function dashboardUrlFromEnv(): string | null {
  const url = process.env.APP_URL
  return url === undefined || url === '' ? null : url.replace(/\/+$/, '')
}

export async function GET(request: Request): Promise<Response> {
  let secret: string
  try {
    secret = getCronSecret()
  } catch {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (!bearerMatches(request.headers.get('authorization'), secret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const params = new URL(request.url).searchParams
  const nowParam = params.get('now')
  const preview = params.get('preview') === '1'
  let now = new Date()
  if (nowParam !== null) {
    // now 只供預覽除錯；正式模式若可被指定時間，會讓發送到 Discord 的週報內容被竄改
    if (!preview) return Response.json({ error: 'now is preview-only' }, { status: 400 })
    now = new Date(nowParam)
    if (Number.isNaN(now.getTime())) return Response.json({ error: 'invalid now' }, { status: 400 })
  }
  const dashboardUrl = dashboardUrlFromEnv()
  const load = (at: Date) => loadWeeklyReportInput(createServerStore().rawClient(), at)

  if (preview) {
    const pageIndex = Number(params.get('page') ?? '0')
    try {
      const report = buildWeeklyReport(await load(now))
      const pages = paginateReport(report)
      const page = Number.isInteger(pageIndex) ? pages[pageIndex] : undefined
      if (page === undefined) return Response.json({ error: 'page not found' }, { status: 404 })
      const bytes = await renderReportPage(report, page, { dashboardUrl })
      return new Response(bytes as BodyInit, { headers: { 'content-type': 'image/png' } })
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'preview failed' }, { status: 500 })
    }
  }

  const send = createServerReportSender()
  if (send === null) return Response.json({ error: 'discord not configured' }, { status: 500 })
  const result = await runWeeklyReport({
    now,
    dashboardUrl,
    load,
    render: (report, page) => renderReportPage(report, page, { dashboardUrl }),
    send,
  })
  if (!result.ok) return Response.json({ stage: result.stage, reason: result.reason }, { status: 500 })
  return Response.json({ pages: result.pages, imageFailed: result.imageFailed, verdict: result.verdict })
}
