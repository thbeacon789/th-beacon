import Link from 'next/link'
import { requireUser } from '@/web/supabase-server'
import { createServerStore } from '@/store/server'
import { getServicesOverview } from '@/web/queries'

export const dynamic = 'force-dynamic'

export default async function OverviewPage() {
  await requireUser()
  const overview = await getServicesOverview(createServerStore().rawClient(), new Date())

  return (
    <main>
      <h1>服務總覽</h1>
      <div className="cards">
        {overview.map((service) => (
          <div key={service.id} className="card">
            <h2>
              <span className={`health health-${service.healthStatus}`} />
              {service.name}
            </h2>
            <p>
              <span className="badge badge-P0">P0 {service.openCounts.P0}</span>{' '}
              <span className="badge badge-P1">P1 {service.openCounts.P1}</span>{' '}
              <span className="badge badge-P2">P2 {service.openCounts.P2}</span>
            </p>
            {service.heartbeats.length > 0 && (
              <ul className="heartbeats">
                {service.heartbeats.map((hb) => (
                  <li key={hb.name} className={hb.overdue ? 'heartbeat overdue' : 'heartbeat'}>
                    <strong>{hb.name}</strong>
                    {hb.overdue && <span className="badge badge-P1">逾期</span>}
                    <span>
                      {hb.lastRunAt === null
                        ? '從未回報'
                        : `最後執行 ${new Date(hb.lastRunAt).toLocaleString('zh-TW')} ${
                            hb.lastRunStatus === 'fail' ? '失敗' : '成功'
                          }`}
                    </span>
                    {hb.lastRunUrl !== null && (
                      <a href={hb.lastRunUrl} target="_blank" rel="noreferrer noopener">
                        查看 run
                      </a>
                    )}
                    {hb.lastSuccessAt !== null && (
                      <span className="hint">
                        最後成功 {new Date(hb.lastSuccessAt).toLocaleString('zh-TW')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <Link href={`/issues?serviceId=${service.id}`}>看 issues →</Link>
          </div>
        ))}
        {overview.length === 0 && <p>尚未註冊任何服務。</p>}
      </div>
    </main>
  )
}
