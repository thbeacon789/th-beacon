import { runPoll } from '@/poll/poll-service'
import { httpGet } from '@/poll/http'
import { createServerStore, getCronSecret } from '@/store/server'

export async function GET(request: Request): Promise<Response> {
  let secret: string
  try {
    secret = getCronSecret()
  } catch {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  const outcomes = await runPoll(createServerStore(), httpGet, new Date())
  return Response.json({ polled: outcomes.length, outcomes }, { status: 200 })
}
