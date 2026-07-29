import Link from 'next/link'
import { requireUser } from '@/web/supabase-server'
import { createServerStore } from '@/store/server'
import { getServicesOverview, summarizeHealth } from '@/web/queries'
import { HealthGauge } from '@/web/health-gauge'
import type { HealthStatus } from '@/core/types'
import {
  ArrowRightIcon,
  DegradedIcon,
  DownIcon,
  ExternalLinkIcon,
  HealthyIcon,
} from '@/web/icons'

export const dynamic = 'force-dynamic'

const HEALTH: Record<HealthStatus, { label: string; Icon: typeof HealthyIcon }> = {
  healthy: { label: 'Healthy', Icon: HealthyIcon },
  degraded: { label: 'Degraded', Icon: DegradedIcon },
  down: { label: 'Down', Icon: DownIcon },
}

const SEVERITIES = ['P0', 'P1', 'P2'] as const

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-TW')
}

export default async function OverviewPage() {
  await requireUser()
  const overview = await getServicesOverview(createServerStore().rawClient(), new Date())

  return (
    <main>
      <div className="page-head">
        <h1>Service Overview</h1>
        <p className="hint">共 {overview.length} 項服務｜燈號取輪詢與未解 issue 的最差值</p>
      </div>
      <HealthGauge summary={summarizeHealth(overview)} />
      <div className="cards">
        {overview.map((service) => {
          const health = HEALTH[service.healthStatus]
          return (
          <div key={service.id} className="card">
            <div className="card-head">
              <h2>{service.name}</h2>
              <span className={`status status-${service.healthStatus}`}>
                <health.Icon />
                {health.label}
              </span>
            </div>
            <ul className="sev-counts" aria-label="未解決 issue 數">
              {SEVERITIES.map((severity) => {
                const count = service.openCounts[severity]
                return (
                  <li key={severity} className={`sev sev-${severity}`}>
                    <span className={`badge badge-${severity}`}>{severity}</span>
                    <span className={count === 0 ? 'sev-count is-zero' : 'sev-count'}>{count}</span>
                  </li>
                )
              })}
            </ul>
            {service.heartbeats.length > 0 && (
              <ul className="heartbeats">
                {service.heartbeats.map((hb) => (
                  <li key={hb.name} className={hb.overdue ? 'heartbeat overdue' : 'heartbeat'}>
                    <strong>{hb.name}</strong>
                    {hb.overdue && <span className="badge badge-P1">逾期</span>}
                    <span className="heartbeat-run">
                      {hb.lastRunAt === null
                        ? '從未回報'
                        : `最後執行 ${formatTime(hb.lastRunAt)} ${
                            hb.lastRunStatus === 'fail' ? '失敗' : '成功'
                          }`}
                    </span>
                    {hb.lastRunUrl !== null && (
                      <a
                        className="link-external"
                        href={hb.lastRunUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        查看 run
                        <ExternalLinkIcon />
                        <span className="sr-only">（在新分頁開啟）</span>
                      </a>
                    )}
                    {/* 上次執行成功時 last_success_at === last_run_at，兩行會完全重複；
                        只在失敗（兩者不同）時才顯示——那時「上次成功是什麼時候」才有資訊量 */}
                    {hb.lastSuccessAt !== null && hb.lastSuccessAt !== hb.lastRunAt && (
                      <span className="hint">最後成功 {formatTime(hb.lastSuccessAt)}</span>
                    )}
                    {hb.lastRunSummary !== null && (
                      <span className="heartbeat-summary">{hb.lastRunSummary}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <Link className="card-link" href={`/issues?serviceId=${service.id}`}>
              Issues
              <ArrowRightIcon size={22} />
            </Link>
          </div>
          )
        })}
      </div>
      {overview.length === 0 && (
        <div className="card empty">
          <strong>尚未註冊任何服務</strong>
          <span>在 services 表新增一列後，輪詢與 ingest 就會開始寫入這裡。</span>
        </div>
      )}
    </main>
  )
}
