import { requireUser } from '@/web/supabase-server'
import { createServerStore } from '@/store/server'
import Link from 'next/link'
import { getSecurityView, getSecurityFindings } from '@/web/security-queries'
import { LogSparkline } from '@/web/security-sparkline'
import { formatDateTime } from '@/web/format'
import { CHECK_LABEL, CHECK_ORDER, type OverallStatus } from '@/core/security/view'
import type { FindingSeverity } from '@/core/security/types'
import { MANUAL_TRANSITIONS, type SecurityFindingStatus } from '@/core/security/findings'
import { BASELINE_WINDOW_DAYS } from '@/core/security/constants'
import { FindingActions } from './finding-actions'
import { CommentThread } from '@/web/comment-thread'
import { CommentForm } from '@/web/comment-form'
import { addFindingCommentAction } from './actions'
import type { StoredComment } from '@/core/comments'

export const dynamic = 'force-dynamic'

const SEVERITY_LABEL: Record<FindingSeverity, string> = { high: '高', medium: '中', low: '低' }
const OVERALL_LABEL: Record<OverallStatus, string> = { bad: '需處理', warn: '留意', ok: '正常', unknown: '未知' }

const TABS: readonly SecurityFindingStatus[] = ['open', 'resolved', 'ignored']
const TAB_LABEL: Record<SecurityFindingStatus, string> = { open: 'Open', resolved: 'Closed', ignored: 'Ignored' }
const EMPTY_TEXT: Record<SecurityFindingStatus, string> = {
  open: '沒有待處理的資安發現',
  resolved: '尚無已解決紀錄',
  ignored: '沒有已忽略的項目',
}
const DAY_MS = 86_400_000

export default async function SecurityPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const { tab: rawTab } = await searchParams
  const tab: SecurityFindingStatus = TABS.find((t) => t === rawTab) ?? 'open'
  const now = new Date()
  const client = createServerStore().rawClient()
  const [, view, findings] = await Promise.all([
    requireUser(),
    getSecurityView(client, now),
    getSecurityFindings(client, tab),
  ])
  const commentRows = await createServerStore().listSecurityFindingComments(findings.items.map((f) => f.id))
  const commentsByFinding = new Map<string, StoredComment[]>()
  for (const { findingId, ...c } of commentRows) {
    const list = commentsByFinding.get(findingId) ?? []
    list.push(c)
    commentsByFinding.set(findingId, list)
  }
  const staleServices = new Set(view.staleServices.map((x) => x.serviceName))
  const windowStart = now.getTime() - BASELINE_WINDOW_DAYS * DAY_MS

  return (
    <main>
      <div className="page-head">
        <h1>Security</h1>
        <p className="hint">共 {view.rows.length} 項服務｜每日 06:00 掃描</p>
      </div>

      {view.staleServices.length > 0 && (
        <div className="security-todos" role="alert">
          <ul>
            {view.staleServices.map((x) => (
              <li key={x.serviceName} className="security-todo">
                <span className="badge security-sev-high">高</span>
                <div className="security-todo-body">
                  <div>
                    <span className="security-todo-service">{x.serviceName}</span>
                    <span>資安掃描已停擺 {x.hours} 小時</span>
                  </div>
                  <div className="security-todo-rec">檢查 GitHub Actions 的 security-scan workflow</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

    <section className="security-todos" aria-labelledby="security-todos-title">
      <h2 id="security-todos-title" className="sr-only">資安發現</h2>
      <nav className="security-tabs" aria-label="資安發現狀態">
        {TABS.map((t) => (
          <Link
            key={t}
            href={t === 'open' ? '/security' : `/security?tab=${t}`}
            className={t === tab ? 'security-tab is-active' : 'security-tab'}
            aria-current={t === tab ? 'page' : undefined}
          >
            {TAB_LABEL[t]} ({findings.counts[t]})
          </Link>
        ))}
      </nav>
      {findings.items.length === 0 ? (
        <p className="hint">{EMPTY_TEXT[tab]}</p>
      ) : (
        <ul>
          {findings.items.map((f) => {
            const comments = commentsByFinding.get(f.id) ?? []
            return (
            <li key={f.id} className="security-todo">
              <span className={`badge security-sev-${f.severity}`}>{SEVERITY_LABEL[f.severity]}</span>
              <div className="security-todo-body">
                <div>
                  <span className="security-todo-service">{f.serviceName}</span>
                  <span className="security-todo-check">{CHECK_LABEL[f.check]}</span>
                  {f.keyFallback && <span className="security-stale">未分類</span>}
                  <span>{f.title}</span>
                </div>
                {f.recommendation !== '' && <div className="security-todo-rec">{f.recommendation}</div>}
                <div className="security-todo-meta">
                  首次 {formatDateTime(f.firstSeenAt)} · 最後 {formatDateTime(f.lastSeenAt)}
                  {f.reopenCount > 0 && ` · 復發 ${f.reopenCount} 次`}
                  {f.status === 'open' && staleServices.has(f.serviceName) && (
                    <span className="security-stale">掃描停擺，狀態可能過期</span>
                  )}
                  {f.status === 'open' && f.check === 'changes' && Date.parse(f.lastSeenAt) < windowStart && (
                    <span className="security-stale">已不在變動比對窗內</span>
                  )}
                </div>
                <FindingActions id={f.id} status={f.status} transitions={MANUAL_TRANSITIONS[f.status]} />
                <details className="security-comments">
                  <summary>留言 ({comments.length})</summary>
                  <CommentThread comments={comments} />
                  <CommentForm action={addFindingCommentAction.bind(null, f.id)} />
                </details>
              </div>
            </li>
            )
          })}
        </ul>
      )}
    </section>

      {view.rows.length === 0 ? (
        <p className="hint">尚無掃描資料。資料由每日排程的 security-scan workflow 推送。</p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="security-matrix">
              <thead>
                <tr>
                  <th scope="col">服務</th>
                  <th scope="col">整體</th>
                  {CHECK_ORDER.map((k) => (
                    <th key={k} scope="col">{CHECK_LABEL[k]}</th>
                  ))}
                  <th scope="col">上次掃描</th>
                </tr>
              </thead>
              <tbody>
                {view.rows.map((row) => (
                  <tr key={row.serviceId}>
                    <th scope="row">
                      {row.serviceName}
                      {row.stale && <span className="security-stale">資料過期</span>}
                    </th>
                    <td>
                      <span className="security-cell">
                        <span className={`security-dot security-dot-${row.overall}`} aria-hidden />
                        <span className="security-cell-text">{OVERALL_LABEL[row.overall]}</span>
                      </span>
                    </td>
                    {CHECK_ORDER.map((k) => {
                      const c = row.checks[k]
                      const text = c.status === 'na' ? '不適用' : c.status === 'unknown' && c.summary === '' ? '未知' : c.summary
                      // 過期列的結果不可再顯示成綠燈：一律用 unknown 的灰，文字保留但降低對比
                      const dot = row.stale ? 'unknown' : c.status
                      return (
                        <td key={k}>
                          <span className={row.stale ? 'security-cell is-stale' : 'security-cell'}>
                            <span className={`security-dot security-dot-${dot}`} aria-hidden />
                            {k === 'logVolume' && <LogSparkline sources={row.logVolume} />}
                            <span className="security-cell-text">{text}</span>
                          </span>
                        </td>
                      )
                    })}
                    <td className="cell-time">
                      {formatDateTime(row.scannedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 舊快照（本功能上線前）沒有套件掃描明細：明說，避免讀成「沒有漏洞」（spec §5.9） */}
          {view.rows.filter((r) => r.kind === 'vm' && r.deps === null).map((row) => (
            <p key={row.serviceId} className="hint">{row.serviceName}：此快照無套件掃描</p>
          ))}

          {view.rows.filter((r) => r.deps !== null && r.deps.length > 0).map((row) => (
            <details key={row.serviceId} className="security-deps">
              <summary>{row.serviceName} 映像檔套件漏洞</summary>
              {row.deps!.map((d) => (
                <div key={`${d.image}-${d.containers.join(',')}`} className="security-deps-image">
                  <div className="security-todo-meta">
                    <span className="security-todo-service">{d.image}</span>
                    容器：{d.containers.join('、')}
                  </div>
                  {d.error !== undefined ? (
                    <p className="hint">掃描失敗：{d.error}</p>
                  ) : (
                    <>
                      {d.counts && (
                        <p className="hint">
                          嚴重 {d.counts.critical}｜高 {d.counts.high}｜中 {d.counts.moderate}｜低 {d.counts.low}｜未分級 {d.counts.unscored}
                        </p>
                      )}
                      {d.packages && d.packages.length > 0 && (
                        <div className="table-wrap">
                          <table>
                            <thead>
                              <tr>
                                <th scope="col">套件</th>
                                <th scope="col">版本</th>
                                <th scope="col">生態系</th>
                                <th scope="col">嚴重度</th>
                                <th scope="col">編號</th>
                              </tr>
                            </thead>
                            <tbody>
                              {d.packages.map((pkg) => (
                                <tr key={`${pkg.ecosystem}-${pkg.name}-${pkg.version}`}>
                                  <th scope="row">{pkg.name}</th>
                                  <td>{pkg.version}</td>
                                  <td>{pkg.ecosystem}</td>
                                  <td>{pkg.severity}</td>
                                  <td>{pkg.ids.join('、')}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
            </details>
          ))}
        </>
      )}
    </main>
  )
}
