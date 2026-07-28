import Link from 'next/link'
import { requireUser } from '@/web/supabase-server'
import { createServerStore } from '@/store/server'
import { listIssues, type IssueListFilters } from '@/web/queries'
import { narrowSeverity, narrowIssueStatus } from '@/store/mapping'

export const dynamic = 'force-dynamic'

const SEVERITIES = ['P0', 'P1', 'P2'] as const
const STATUSES = ['open', 'acknowledged', 'resolved', 'ignored'] as const

export default async function IssuesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireUser()
  const params = await searchParams
  const filters: IssueListFilters = {}
  if (typeof params.serviceId === 'string' && params.serviceId !== '') {
    filters.serviceId = params.serviceId
  }
  if (typeof params.severity === 'string' && params.severity !== '') {
    filters.severity = narrowSeverity(params.severity)
  }
  if (typeof params.status === 'string' && params.status !== '') {
    filters.status = narrowIssueStatus(params.status)
  }

  const issues = await listIssues(createServerStore().rawClient(), filters)

  return (
    <main>
      <h1>檢傷列表</h1>
      <form className="filters" method="get">
        {typeof params.serviceId === 'string' && params.serviceId !== '' && (
          <input type="hidden" name="serviceId" value={params.serviceId} />
        )}
        <select name="severity" defaultValue={typeof params.severity === 'string' ? params.severity : ''}>
          <option value="">全部 severity</option>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select name="status" defaultValue={typeof params.status === 'string' ? params.status : ''}>
          <option value="">全部狀態</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button type="submit">篩選</button>
      </form>
      <table>
        <thead>
          <tr>
            <th>severity</th>
            <th>服務</th>
            <th>錯誤</th>
            <th>次數</th>
            <th>狀態</th>
            <th>最後發生</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue) => (
            <tr key={issue.id}>
              <td>
                <span className={`badge badge-${issue.severity}`}>{issue.severity}</span>
              </td>
              <td>{issue.serviceName}</td>
              <td>
                <Link href={`/issues/${issue.id}`}>
                  {issue.errorType}: {issue.message.slice(0, 80)}
                </Link>
              </td>
              <td>{issue.count}</td>
              <td>{issue.status}</td>
              <td>{new Date(issue.lastSeen).toLocaleString('zh-TW')}</td>
            </tr>
          ))}
          {issues.length === 0 && (
            <tr>
              <td colSpan={6}>沒有符合條件的 issue。</td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  )
}
