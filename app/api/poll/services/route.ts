import { CRON_AI_BUDGET } from '@/core/ai-triage'
import { runPoll } from '@/poll/poll-service'
import { httpGet } from '@/poll/http'
import { RETENTION_DAYS } from '@/core/security/constants'
import { runHeartbeatScan } from '@/heartbeat/scan'
import { bearerMatches } from '@/web/bearer'
import { createServerStore, createServerNotifyDeps, getCronSecret } from '@/store/server'

export const maxDuration = 300

export async function GET(request: Request): Promise<Response> {
  let secret: string
  try {
    secret = getCronSecret()
  } catch {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (!bearerMatches(request.headers.get('authorization'), secret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  const store = createServerStore()
  const deps = createServerNotifyDeps({ budget: { remaining: CRON_AI_BUDGET } }) // runPoll 與 runHeartbeatScan 共用同一個 budget
  const now = new Date()

  let outcomes: Awaited<ReturnType<typeof runPoll>>
  try {
    outcomes = await runPoll(store, httpGet, deps, now)
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'poll run failed' },
      { status: 500 },
    )
  }

  // Hobby cron 一天只跑一次：心跳掃描若在 listEnabledHeartbeats() 這一步就炸開
  // （runHeartbeatScan 內部的 try/catch 保護不到這一步），不能連累已經跑完、
  // 已經寫入的輪詢結果一起變成 500——那會讓當天完全沒有可查的 poll 結果。
  let heartbeats: Awaited<ReturnType<typeof runHeartbeatScan>> = []
  let heartbeatsError: string | undefined
  try {
    heartbeats = await runHeartbeatScan(store, deps, now)
  } catch (error) {
    heartbeatsError = error instanceof Error ? error.message : 'heartbeat scan failed'
  }

  // 資安快照只留 RETENTION_DAYS 天；清除失敗不可影響輪詢與心跳結果
  let securityScansPurged: number | undefined
  let securityPurgeError: string | undefined
  try {
    securityScansPurged = await store.purgeSecurityScansBefore(
      new Date(now.getTime() - RETENTION_DAYS * 86400000).toISOString(),
    )
  } catch (error) {
    securityPurgeError = error instanceof Error ? error.message : 'security purge failed'
  }

  return Response.json(
    {
      polled: outcomes.length,
      outcomes,
      heartbeatsOverdue: heartbeats.length,
      heartbeats,
      ...(heartbeatsError !== undefined ? { heartbeatsError } : {}),
      ...(securityScansPurged !== undefined ? { securityScansPurged } : {}),
      ...(securityPurgeError !== undefined ? { securityPurgeError } : {}),
    },
    { status: 200 },
  )
}
