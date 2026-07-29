import Link from 'next/link'
import { requireUser } from '@/web/supabase-server'
import { createServerStore } from '@/store/server'
import { getServicesOverview } from '@/web/queries'
import type { HealthStatus } from '@/core/types'

export const dynamic = 'force-dynamic'

const HEALTH_LABEL: Record<HealthStatus, string> = {
  healthy: '正常',
  degraded: '降級',
  down: '中斷',
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
      <div className="cards">
        {overview.map((service) => (
          <div key={service.id} className="card">
            <div className="card-head">
              <h2>{service.name}</h2>
              <span className={`status status-${service.healthStatus}`}>
                {HEALTH_LABEL[service.healthStatus]}
              </span>
            </div>
            <ul className="sev-counts" aria-label="未解決 issue 數">
              {SEVERITIES.map((severity) => (
                <li key={severity} className={`sev sev-${severity}`}>
                  <span className={`badge badge-${severity}`}>{severity}</span>
                  <span className="sev-count">{service.openCounts[severity]}</span>
                </li>
              ))}
            </ul>
            {service.heartbeats.length > 0 && (
              <ul className="heartbeats">
                {service.heartbeats.map((hb) => (
                  <li key={hb.name} className={hb.overdue ? 'heartbeat overdue' : 'heartbeat'}>
                    <strong>{hb.name}</strong>
                    {hb.overdue && <span className="badge badge-P1">逾期</span>}
                    <span>
                      {hb.lastRunAt === null
                        ? '從未回報'
                        : `最後執行 ${formatTime(hb.lastRunAt)} ${
                            hb.lastRunStatus === 'fail' ? '失敗' : '成功'
                          }`}
                    </span>
                    {hb.lastRunUrl !== null && (
                      <a href={hb.lastRunUrl} target="_blank" rel="noreferrer noopener">
                        查看 run
                      </a>
                    )}
                    {hb.lastSuccessAt !== null && (
                      <span className="hint">最後成功 {formatTime(hb.lastSuccessAt)}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <Link className="card-link" href={`/issues?serviceId=${service.id}`}>
              看 issues →
            </Link>
          </div>
        ))}
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
