import { after } from 'next/server'
import { handleIngest } from '@/ingest/handle-ingest'
import { createServerStore, createServerNotifyDeps } from '@/store/server'

export const maxDuration = 300

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text()
  const result = await handleIngest(
    createServerStore(),
    createServerNotifyDeps({ budget: null }),
    {
      rawBody,
      serviceName: request.headers.get('x-beacon-service'),
      timestamp: request.headers.get('x-beacon-timestamp'),
      signature: request.headers.get('x-beacon-signature'),
    },
    new Date(),
    (task) => after(task),
  )
  return Response.json(result.body, { status: result.status })
}
