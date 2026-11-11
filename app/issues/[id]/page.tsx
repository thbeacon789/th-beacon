import { notFound } from 'next/navigation'
import { requireUser } from '@/web/supabase-server'
import { createServerStore } from '@/store/server'
import { getIssueDetail, extractRunUrl, describeLabel } from '@/web/queries'
import { SubmitButton } from '@/web/submit-button'
import { JudgmentLabelForm } from '@/web/judgment-label-form'
import { ExternalLinkIcon } from '@/web/icons'
import { formatDateTime, formatDateTimeSeconds } from '@/web/format'
import { allowedFrom } from '@/core/lifecycle'
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
  const { issue, ai, judgment, serviceName, events } = detail

  return (
    <main>
      <div className="page-head">
        <h1>
          <span className={`badge badge-${issue.severity}`}>{issue.severity}</span> {serviceName} —{' '}
          {issue.errorType}
        </h1>
      </div>
      <p className="detail-message">{issue.message}</p>
      {(ai !== null || judgment !== null) && (
        <section aria-labelledby="ai-triage-title">
          <h2 id="ai-triage-title">AI 判定</h2>
          {ai !== null && (
          <ul className="meta">
            {ai.severity !== null && (
              <li>
                <span className="meta-key">AI 等級</span>
                <span className="meta-val">
                  <span className={`badge badge-${ai.severity}`}>{ai.severity}</span>
                </span>
              </li>
            )}
            {ai.category !== null && (
              <li>
                <span className="meta-key">分類</span>
                <span className="meta-val">{ai.category === 'env' ? '環境問題' : 'app 問題'}</span>
              </li>
            )}
            {ai.reason !== null && ai.reason !== '' && (
              <li>
                <span className="meta-key">判定原因</span>
                <span className="meta-val" style={{ whiteSpace: 'pre-wrap' }}>{ai.reason}</span>
              </li>
            )}
            {ai.suggestion !== null && ai.suggestion !== '' && (
              <li>
                <span className="meta-key">修正建議</span>
                <span className="meta-val" style={{ whiteSpace: 'pre-wrap' }}>{ai.suggestion}</span>
              </li>
            )}
            <li>
              <span className="meta-key">判定時間</span>
              <span className="meta-val">
                {formatDateTime(ai.judgedAt)}
                {ai.model !== null && ` · ${ai.model}`}
              </span>
            </li>
            {ai.error !== null && ai.error !== '' && (
              <li>
                <span className="meta-key">錯誤</span>
                <span className="meta-val" style={{ whiteSpace: 'pre-wrap' }}>AI 判讀失敗：{ai.error}</span>
              </li>
            )}
          </ul>
          )}
          {judgment !== null && (
            <div className="judgment-label">
              <h3>判定標記</h3>
              <ul className="meta">
                <li>
                  <span className="meta-key">來源</span>
                  <span className="meta-val">{judgment.source === 'server' ? '伺服器判級' : 'CI 診斷'}</span>
                </li>
                <li>
                  <span className="meta-key">AI 嚴重度</span>
                  <span className="meta-val">
                    <span className={`badge badge-${judgment.severity}`}>{judgment.severity}</span>
                  </span>
                </li>
                <li>
                  <span className="meta-key">AI 類型</span>
                  <span className="meta-val">{judgment.category === 'env' ? '環境問題' : 'app 問題'}</span>
                </li>
                <li>
                  <span className="meta-key">model</span>
                  <span className="meta-val">{judgment.model ?? '未知 model'}</span>
                </li>
                <li>
                  <span className="meta-key">判定時間</span>
                  <span className="meta-val">
                    {formatDateTime(judgment.judgedAt)}
                    {judgment.mergeCount > 1 && ` · 已合併 ${judgment.mergeCount} 次相同判定`}
                  </span>
                </li>
                <li>
                  <span className="meta-key">目前標記</span>
                  <span className="meta-val">
                    嚴重度：{describeLabel(judgment.label).severity}；類型：{describeLabel(judgment.label).category}
                  </span>
                </li>
              </ul>
              <JudgmentLabelForm
                issueId={issue.id}
                judgmentId={judgment.id}
                aiSeverity={judgment.severity}
                aiCategory={judgment.category}
                label={judgment.label}
              />
            </div>
          )}
        </section>
      )}
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
          <span className="meta-val">{formatDateTime(issue.firstSeen)}</span>
        </li>
        <li>
          <span className="meta-key">last seen</span>
          <span className="meta-val">{formatDateTime(issue.lastSeen)}</span>
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
        {NEXT_STATUSES.filter((s) => s !== issue.status && allowedFrom(s).includes(issue.status)).map((status) => (
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
                <td className="cell-time">{formatDateTimeSeconds(event.occurredAt)}</td>
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
