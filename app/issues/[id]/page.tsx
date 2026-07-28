import { notFound } from 'next/navigation'
import { requireUser } from '@/web/supabase-server'
import { createServerStore } from '@/store/server'
import { getIssueDetail } from '@/web/queries'
import { changeIssueStatusAction } from '../actions'

export const dynamic = 'force-dynamic'

const NEXT_STATUSES = ['acknowledged', 'resolved', 'ignored', 'open'] as const

export default async function IssueDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await requireUser()
  const { id } = await params
  const detail = await getIssueDetail(createServerStore().rawClient(), id)
  if (detail === null) notFound()
  const { issue, serviceName, events } = detail

  return (
    <main>
      <h1>
        <span className={`badge badge-${issue.severity}`}>{issue.severity}</span> {serviceName} —{' '}
        {issue.errorType}
      </h1>
      <p>{issue.message}</p>
      <p>
        狀態：<strong>{issue.status}</strong>｜次數：{issue.count}｜first seen:{' '}
        {new Date(issue.firstSeen).toLocaleString('zh-TW')}｜last seen:{' '}
        {new Date(issue.lastSeen).toLocaleString('zh-TW')}
        {issue.tags.length > 0 && <>｜tags: {issue.tags.join(', ')}</>}
      </p>
      <p className="hint">severity 為歷史最高判級（只升不降）；降級請改操作狀態（resolve / ignore）。</p>
      <div className="actions">
        {NEXT_STATUSES.filter((s) => s !== issue.status).map((status) => (
          <form key={status} action={changeIssueStatusAction.bind(null, issue.id, status)}>
            <button type="submit">標記為 {status}</button>
          </form>
        ))}
      </div>
      <h2>事件（最近 {events.length} 筆）</h2>
      <table>
        <thead>
          <tr>
            <th>時間</th>
            <th>來源</th>
            <th>level</th>
            <th>訊息</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id}>
              <td>{new Date(event.occurredAt).toLocaleString('zh-TW')}</td>
              <td>{event.source}</td>
              <td>{event.level}</td>
              <td>
                {event.message}
                {event.metadata !== null && Object.keys(event.metadata as object).length > 0 && (
                  <pre>{JSON.stringify(event.metadata, null, 2)}</pre>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  )
}
