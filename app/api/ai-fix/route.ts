import { handleAiFix } from '@/ai-fix/handle-ai-fix'
import { createServerStore, createServerNotifyDeps } from '@/store/server'

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text()
  const result = await handleAiFix(
    createServerStore(),
    createServerNotifyDeps({ budget: null }).bot ?? null,
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
