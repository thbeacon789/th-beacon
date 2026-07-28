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
  try {
    const store = createServerStore()
    const deps = createServerNotifyDeps()
    const now = new Date()
    const outcomes = await runPoll(store, httpGet, deps, now)
    const heartbeats = await runHeartbeatScan(store, deps, now)
    return Response.json(
      { polled: outcomes.length, outcomes, heartbeatsOverdue: heartbeats.length, heartbeats },
      { status: 200 },
    )
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'poll run failed' },
      { status: 500 },
    )
  }
}
