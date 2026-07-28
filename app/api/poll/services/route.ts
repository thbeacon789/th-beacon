import { timingSafeEqual } from 'node:crypto'
import { runPoll } from '@/poll/poll-service'
import { httpGet } from '@/poll/http'
import { createServerStore, getCronSecret } from '@/store/server'

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
    const outcomes = await runPoll(createServerStore(), httpGet, new Date())
    return Response.json({ polled: outcomes.length, outcomes }, { status: 200 })
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'poll run failed' },
      { status: 500 },
    )
  }
}
