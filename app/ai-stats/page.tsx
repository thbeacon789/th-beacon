import { requireUser } from '@/web/supabase-server'
import { createServerStore } from '@/store/server'
import { getAiStats } from '@/web/ai-stats-queries'
import { MonthlyTrendChart } from '@/web/ai-stats-charts'
import type { AiStatsView, Rate } from '@/core/ai-stats'
import type { AiUsageSource, Severity } from '@/core/types'

export const dynamic = 'force-dynamic'

const MONTHS = 6
const SEVERITIES: Severity[] = ['P0', 'P1', 'P2']
const SOURCE_LABEL: Record<AiUsageSource, string> = {
  server_triage: '伺服器判級',
  ci_diagnosis: 'CI 診斷',
  ci_pr: 'CI 開 PR',
}

const usd = (v: number) => `$${v.toFixed(2)}`

// 準確率一律與樣本數並列；rate null → 「—」
// 樣本數縮小字級並禁止換行，避免窄卡片把「（43／50 已標記）」拆成兩行
function formatRate(r: Rate, unit = '已標記') {
  const sample = r.rate === null ? `（${r.total} ${unit}）` : `（${r.correct}／${r.total} ${unit}）`
  return (
    <>
      {r.rate === null ? '—' : `${Math.round(r.rate * 100)}%`}
      <span className="ai-stats-sample">{sample}</span>
    </>
  )
}

function unpriced(n: number): string {
  return n > 0 ? `（另有 ${n} 筆未定價）` : ''
}

function Cards({ s }: { s: AiStatsView['summary'] }) {
  return (
    <div className="ai-stats-cards">
      <div className="ai-stats-card">
        <div className="ai-stats-card-label">本月花費</div>
        <div className="ai-stats-card-value">{usd(s.monthCostUsd)}</div>
        {s.monthUnpricedCount > 0 && <p className="hint">另有 {s.monthUnpricedCount} 筆未定價</p>}
      </div>
      <div className="ai-stats-card">
        <div className="ai-stats-card-label">嚴重度準確率（近 6 個月）</div>
        <div className="ai-stats-card-value">{formatRate(s.severity)}</div>
      </div>
      <div className="ai-stats-card">
        <div className="ai-stats-card-label">類型準確率（近 6 個月）</div>
        <div className="ai-stats-card-value">{formatRate(s.category)}</div>
      </div>
      <div className="ai-stats-card">
        <div className="ai-stats-card-label">標記率（近 6 個月）</div>
        <div className="ai-stats-card-value">
          {formatRate(s.labelRate, '筆判定')}
        </div>
      </div>
    </div>
  )
}

export default async function AiStatsPage() {
  const [, stats] = await Promise.all([
    requireUser(),
    getAiStats(createServerStore().rawClient(), new Date(), MONTHS),
  ])
  const empty = stats.services.length === 0 && stats.monthly.every((m) => m.costUsd === 0 && m.unpricedCount === 0)

  return (
    <main>
      <div className="page-head">
        <h1>AI Stats</h1>
        <p className="hint">統計範圍：近 {stats.windowMonths} 個月｜準確率按判定月份（台北時間）歸類，僅計已標記的判定</p>
      </div>

      {empty ? (
        <p className="hint">尚無 AI 判定或用量紀錄</p>
      ) : (
        <>
          <Cards s={stats.summary} />

          <section className="ai-stats-section">
            <h2>每月趨勢</h2>
            <MonthlyTrendChart monthly={stats.monthly} models={stats.models} />
            <p className="hint">柱狀＝花費（左軸）｜綠線＝嚴重度準確率、粉線＝類型準確率（右軸）｜線型區分 model｜無樣本的月份斷線</p>
          </section>

          <section className="ai-stats-section">
            <h2>判太嚴／判太鬆</h2>
            <div className="table-wrap">
              <table className="ai-stats-matrix">
                <caption className="hint">嚴重度：列＝AI 判，欄＝正確答案</caption>
                <thead>
                  <tr>
                    <th>AI 判 ＼ 正確</th>
                    {SEVERITIES.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {SEVERITIES.map((row) => (
                    <tr key={row}>
                      <th scope="row">{row}</th>
                      {SEVERITIES.map((col) => (
                        <td key={col}>{row === col ? '—' : stats.miss.severityMatrix[row][col]}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="ai-stats-miss">
              <span>判太高 {stats.miss.tooHigh}／判太低 {stats.miss.tooLow}</span>
              <span>類型：env→app {stats.miss.envToApp}／app→env {stats.miss.appToEnv}</span>
            </div>
          </section>

          <section className="ai-stats-section">
            <h2>各服務</h2>
            <div className="table-wrap">
              <table className="ai-stats-table">
                <thead>
                  <tr>
                    <th>服務</th>
                    <th>判定數</th>
                    <th>已標記</th>
                    <th>嚴重度準確率（近 6 個月）</th>
                    <th>類型準確率（近 6 個月）</th>
                    <th>花費（近 {stats.windowMonths} 個月）</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.services.map((s) => (
                    <tr key={s.serviceId}>
                      <td>{s.name}</td>
                      <td>{s.judgments}</td>
                      <td>{s.labeled}</td>
                      <td>{formatRate(s.severity)}</td>
                      <td>{formatRate(s.category)}</td>
                      <td>
                        {usd(s.costUsd)}
                        {unpriced(s.unpricedCount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="ai-stats-section">
            <h2>本月花費依來源</h2>
            <div className="table-wrap">
              <table className="ai-stats-table">
                <thead>
                  <tr>
                    <th>來源</th>
                    <th>金額</th>
                    <th>未定價筆數</th>
                  </tr>
                </thead>
                <tbody>
                  {(Object.keys(SOURCE_LABEL) as AiUsageSource[]).map((src) => (
                    <tr key={src}>
                      <td>{SOURCE_LABEL[src]}</td>
                      <td>{usd(stats.costBySource[src].costUsd)}</td>
                      <td>{stats.costBySource[src].unpricedCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  )
}
