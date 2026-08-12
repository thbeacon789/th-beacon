import Link from 'next/link'
import { headers } from 'next/headers'
import { requireUser } from '@/web/supabase-server'
import { createServerStore } from '@/store/server'
import { formatDateTime } from '@/web/format'
import { RegisterServiceForm, AddHeartbeatForm, RotateSecretForm } from './registration-ui'

export const dynamic = 'force-dynamic'

async function resolveOrigin(): Promise<string> {
  const configured = process.env.APP_URL
  if (configured !== undefined && configured !== '') return configured.replace(/\/$/, '')
  const headerList = await headers()
  const host = headerList.get('host')
  if (host === null) return 'https://<你的 beacon 網域>'
  const proto = headerList.get('x-forwarded-proto') ?? 'https'
  return `${proto}://${host}`
}

export default async function ServicesPage() {
  // 與 requireUser 並行（理由同 app/page.tsx）
  const [, services, origin] = await Promise.all([
    requireUser(),
    createServerStore().listRegisteredServices(),
    resolveOrigin(),
  ])

  const ciSnippet = `- name: Report heartbeat
  if: always()          # 失敗也要送——沒送才代表 CI 死了
  env:
    BEACON_URL: ${origin}/api/heartbeat
    BEACON_SERVICE: <服務名稱>
    BEACON_SECRET: \${{ secrets.BEACON_SECRET }}
  run: |
    ./scripts/heartbeat-to-beacon.sh <心跳名稱> \\
      "\${{ job.status == 'success' && 'pass' || 'fail' }}" \\
      "\${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}"`

  return (
    <main>
      <div className="page-head">
        <h1>服務登記</h1>
        <p className="hint">
          登記服務、取得 HMAC 金鑰、登記心跳名稱。完成後把金鑰交給該專案的 CI 即可接入。
        </p>
      </div>

      <section className="card reg-guide">
        <h2>怎麼接：三步</h2>
        <ol className="reg-steps">
          <li>
            <strong>登記服務</strong>
            <span>
              下方填服務名稱送出，會拿到一把 <code className="mono">BEACON_SECRET</code>。
              <em>只顯示一次</em>，請立刻存進該專案 CI 的 secrets。
            </span>
          </li>
          <li>
            <strong>登記心跳名稱</strong>
            <span>
              心跳採登記制：<strong>沒先登記，CI 送過來一律 404</strong>。順序不能反。
            </span>
          </li>
          <li>
            <strong>CI 接線</strong>
            <span>
              把 <code className="mono">scripts/heartbeat-to-beacon.sh</code> 複製進該專案，
              加上回報步驟（需要 <code className="mono">jq</code>、
              <code className="mono">openssl</code>、<code className="mono">curl</code>）。
            </span>
          </li>
        </ol>

        <h3>GitHub Actions 範例</h3>
        <pre className="reg-code">
          <code>{ciSnippet}</code>
        </pre>

        <h3>先手動驗一次再交給排程</h3>
        <pre className="reg-code">
          <code>{`BEACON_URL=${origin}/api/heartbeat \\
BEACON_SERVICE=<服務名稱> BEACON_SECRET=<金鑰> \\
  ./scripts/heartbeat-to-beacon.sh <心跳名稱> pass`}</code>
        </pre>

        <ul className="reg-tips">
          <li>
            <strong>200</strong> = 通了　<strong>401</strong> = 金鑰錯，或 CI 機器時鐘偏移超過 5
            分鐘　<strong>404</strong> = 心跳名稱沒登記或拼錯
          </li>
          <li>
            心跳只回答「有沒有跑」。測試失敗的細節要另外送{' '}
            <code className="mono">/api/ingest</code>（見{' '}
            <Link href="/docs">API 文件</Link>）。
          </li>
        </ul>
      </section>

      <section className="card">
        <h2>登記新服務</h2>
        <RegisterServiceForm />
      </section>

      <section className="card">
        <div className="card-head">
          <h2>已登記的服務</h2>
          <span className="hint">{services.length} 個</span>
        </div>

        {services.length === 0 && (
          <p className="empty">
            <strong>還沒有任何服務</strong>
            <span>用上面的表單登記第一個。</span>
          </p>
        )}

        {services.map((service) => (
          <article key={service.id} className="reg-service">
            <div className="reg-service-head">
              <h3 className="mono">{service.name}</h3>
              {!service.hasWebhookSecret && (
                <span className="badge badge-P1">未設定金鑰</span>
              )}
              <RotateSecretForm serviceId={service.id} serviceName={service.name} />
            </div>

            {service.heartbeats.length === 0 ? (
              <p className="reg-warn">
                尚未登記任何心跳——CI 現在送過來會收到 404。請在下方登記。
              </p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">心跳名稱</th>
                      <th scope="col" className="num">
                        間隔
                      </th>
                      <th scope="col" className="num">
                        寬限
                      </th>
                      <th scope="col">最後回報</th>
                      <th scope="col">狀態</th>
                    </tr>
                  </thead>
                  <tbody>
                    {service.heartbeats.map((hb) => (
                      <tr key={hb.id}>
                        <td className="mono">{hb.name}</td>
                        <td className="num">{hb.intervalSeconds}s</td>
                        <td className="num">{hb.graceSeconds}s</td>
                        <td className="cell-time">
                          {hb.lastRunAt === null ? (
                            <span className="muted">尚未回報</span>
                          ) : (
                            formatDateTime(hb.lastRunAt)
                          )}
                        </td>
                        <td>
                          {hb.lastRunStatus === null ? (
                            <span className="muted">—</span>
                          ) : (
                            <span
                              className={
                                hb.lastRunStatus === 'pass' ? 'status-healthy' : 'status-down'
                              }
                            >
                              {hb.lastRunStatus}
                            </span>
                          )}
                          {!hb.enabled && <span className="muted"> · 已停用</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <AddHeartbeatForm serviceId={service.id} serviceName={service.name} />
          </article>
        ))}
      </section>
    </main>
  )
}
