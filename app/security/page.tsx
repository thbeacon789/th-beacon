import { requireUser } from '@/web/supabase-server'
import { createServerStore } from '@/store/server'
import { getSecurityView } from '@/web/security-queries'
import { LogSparkline } from '@/web/security-sparkline'
import { formatDateTime } from '@/web/format'
import { CHECK_LABEL, CHECK_ORDER, type OverallStatus } from '@/core/security/view'
import type { FindingSeverity } from '@/core/security/types'

export const dynamic = 'force-dynamic'

const SEVERITY_LABEL: Record<FindingSeverity, string> = { high: '高', medium: '中', low: '低' }
const OVERALL_LABEL: Record<OverallStatus, string> = { bad: '需處理', warn: '留意', ok: '正常', unknown: '未知' }

export default async function SecurityPage() {
  const [, view] = await Promise.all([
    requireUser(),
    getSecurityView(createServerStore().rawClient(), new Date()),
  ])

  return (
    <main>
      <div className="page-head">
        <h1>Security</h1>
        <p className="hint">共 {view.rows.length} 項服務｜每日 06:00 掃描</p>
      </div>

      {view.rows.length === 0 ? (
        <p className="hint">尚無掃描資料。資料由每日排程的 security-scan workflow 推送。</p>
      ) : (
        <>
          <section className="security-todos" aria-labelledby="security-todos-title">
            <h2 id="security-todos-title">需要處理 {view.todos.length} 項</h2>
            {view.todos.length === 0 ? (
              <p className="hint">目前沒有需要處理的項目</p>
            ) : (
              <ul>
                {view.todos.map((t, i) => (
                  <li key={`${t.serviceName}-${t.check}-${i}`} className="security-todo">
                    <span className={`badge security-sev-${t.severity}`}>{SEVERITY_LABEL[t.severity]}</span>
                    <div className="security-todo-body">
                      <div>
                        <span className="security-todo-service">{t.serviceName}</span>
                        <span>{t.title}</span>
                      </div>
                      {t.recommendation !== '' && <div className="security-todo-rec">{t.recommendation}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

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
        </>
      )}
    </main>
  )
}
