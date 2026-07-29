import Link from 'next/link'
import { requireUser } from '@/web/supabase-server'
import { createServerStore } from '@/store/server'
import { listIssues, parseIssueFilters } from '@/web/queries'

export const dynamic = 'force-dynamic'

const SEVERITIES = ['P0', 'P1', 'P2'] as const
const STATUSES = ['open', 'acknowledged', 'resolved', 'ignored'] as const

export default async function IssuesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const filters = parseIssueFilters(params)

  // 與 requireUser 並行（理由同 app/page.tsx）
  const [, issues] = await Promise.all([
    requireUser(),
    listIssues(createServerStore().rawClient(), filters),
  ])

  return (
    <main>
      <div className="page-head">
        <h1>Issue Triage</h1>
        <p className="hint">符合條件 {issues.length} 筆</p>
      </div>
      <form className="filters" method="get">
        {typeof params.serviceId === 'string' && params.serviceId !== '' && (
          <input type="hidden" name="serviceId" value={params.serviceId} />
        )}
        <label>
          Severity
          <select
            name="severity"
            defaultValue={typeof params.severity === 'string' ? params.severity : ''}
          >
            <option value="">全部 severity</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          狀態
          <select
            name="status"
            defaultValue={typeof params.status === 'string' ? params.status : ''}
          >
            <option value="">全部狀態</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">篩選</button>
      </form>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">severity</th>
              <th scope="col">服務</th>
              <th scope="col">錯誤</th>
              <th scope="col" className="num">
                次數
              </th>
              <th scope="col">狀態</th>
              <th scope="col">最後發生</th>
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
                <td className="num">{issue.count}</td>
                <td>{issue.status}</td>
                <td className="cell-time">{new Date(issue.lastSeen).toLocaleString('zh-TW')}</td>
              </tr>
            ))}
            {issues.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  <strong>沒有符合條件的 issue</strong>
                  <span>放寬 severity 或狀態篩選，或回到服務總覽挑一個服務。</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  )
}
