import { timingSafeEqual } from 'node:crypto'
import { runPoll } from '@/poll/poll-service'
import { httpGet } from '@/poll/http'
import { runHeartbeatScan } from '@/heartbeat/scan'
import { createServerStore, createServerNotifyDeps, getCronSecret } from '@/store/server'

function bearerMatches(header: string | null, secret: string): boolean {
  const provided = Buffer.from(header ?? '')
  const expected = Buffer.from(`Bearer ${secret}`)
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

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
  const deps = createServerNotifyDeps()
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

  return Response.json(
    {
      polled: outcomes.length,
      outcomes,
      heartbeatsOverdue: heartbeats.length,
      heartbeats,
      ...(heartbeatsError !== undefined ? { heartbeatsError } : {}),
    },
    { status: 200 },
  )
}
