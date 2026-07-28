import { handleIngest } from '@/ingest/handle-ingest'
import { createServerStore, createServerNotifyDeps } from '@/store/server'

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text()
  const result = await handleIngest(
    createServerStore(),
    createServerNotifyDeps(),
    {
      rawBody,
      serviceName: request.headers.get('x-beacon-service'),
      timestamp: request.headers.get('x-beacon-timestamp'),
      signature: request.headers.get('x-beacon-signature'),
    },
    new Date(),
  )
  return Response.json(result.body, { status: result.status })
}
