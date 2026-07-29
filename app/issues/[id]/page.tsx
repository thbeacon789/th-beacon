import { notFound } from 'next/navigation'
import { requireUser } from '@/web/supabase-server'
import { createServerStore } from '@/store/server'
import { getIssueDetail, extractRunUrl } from '@/web/queries'
import { SubmitButton } from '@/web/submit-button'
import { ExternalLinkIcon } from '@/web/icons'
import { changeIssueStatusAction } from '../actions'

export const dynamic = 'force-dynamic'

const NEXT_STATUSES = ['acknowledged', 'resolved', 'ignored', 'open'] as const

export default async function IssueDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  // 與 requireUser 並行（理由同 app/page.tsx）
  const [, detail] = await Promise.all([
    requireUser(),
    getIssueDetail(createServerStore().rawClient(), id),
  ])
  if (detail === null) notFound()
  const { issue, serviceName, events } = detail

  return (
    <main>
      <div className="page-head">
        <h1>
          <span className={`badge badge-${issue.severity}`}>{issue.severity}</span> {serviceName} —{' '}
          {issue.errorType}
        </h1>
      </div>
      <p className="detail-message">{issue.message}</p>
      <ul className="meta">
        <li>
          <span className="meta-key">狀態</span>
          <strong className="meta-val">{issue.status}</strong>
        </li>
        <li>
          <span className="meta-key">次數</span>
          <span className="meta-val">{issue.count}</span>
        </li>
        <li>
          <span className="meta-key">first seen</span>
          <span className="meta-val">{new Date(issue.firstSeen).toLocaleString('zh-TW')}</span>
        </li>
        <li>
          <span className="meta-key">last seen</span>
          <span className="meta-val">{new Date(issue.lastSeen).toLocaleString('zh-TW')}</span>
        </li>
        {issue.tags.length > 0 && (
          <li>
            <span className="meta-key">tags</span>
            <span className="meta-val">{issue.tags.join(', ')}</span>
          </li>
        )}
      </ul>
      <p className="hint">severity 為歷史最高判級（只升不降）；降級請改操作狀態（resolve / ignore）。</p>
      <div className="actions">
        {NEXT_STATUSES.filter((s) => s !== issue.status).map((status) => (
          <form key={status} action={changeIssueStatusAction.bind(null, issue.id, status)}>
            <SubmitButton pendingLabel={`更新中…`}>{`標記為 ${status}`}</SubmitButton>
          </form>
        ))}
      </div>
      <h2>事件（最近 {events.length} 筆）</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">時間</th>
              <th scope="col">來源</th>
              <th scope="col">level</th>
              <th scope="col">訊息</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td className="cell-time">{new Date(event.occurredAt).toLocaleString('zh-TW')}</td>
                <td>{event.source}</td>
                <td>{event.level}</td>
                <td>
                  {event.message}
                  {extractRunUrl(event.metadata) !== null && (
                    <>
                      {' '}
                      <a
                        className="link-external"
                        href={extractRunUrl(event.metadata) as string}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        查看 CI run
                        <ExternalLinkIcon />
                        <span className="sr-only">（在新分頁開啟）</span>
                      </a>
                    </>
                  )}
                  {event.metadata !== null && Object.keys(event.metadata as object).length > 0 && (
                    <pre>{JSON.stringify(event.metadata, null, 2)}</pre>
                  )}
                </td>
              </tr>
            ))}
            {events.length === 0 && (
              <tr>
                <td colSpan={4} className="empty">
                  <strong>尚無事件紀錄</strong>
                  <span>這筆 issue 的原始事件已超出保留範圍或尚未寫入。</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  )
}
