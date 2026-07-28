import { verifyIngestSignature } from '@/ingest/hmac'
import { parsePushPayload } from '@/ingest/payload'
import { normalizePushEvent } from '@/core/normalize'
import { processAndNotify } from '@/pipeline/process-and-notify'
import type { NotifyDeps } from '@/pipeline/process-and-notify'
import type { Store } from '@/store/contracts'

export interface IngestRequest {
  rawBody: string
  serviceName: string | null
  timestamp: string | null
  signature: string | null
}

export interface IngestResponse {
  status: number
  body: Record<string, unknown>
}

const UNAUTHORIZED: IngestResponse = { status: 401, body: { error: 'unauthorized' } }

export async function handleIngest(
  store: Store,
  deps: NotifyDeps,
  request: IngestRequest,
  now: Date,
): Promise<IngestResponse> {
  if (request.serviceName === null || request.timestamp === null || request.signature === null) {
    return UNAUTHORIZED
  }

  const auth = await store.getServiceByName(request.serviceName)
  if (auth === null || auth.webhookSecret === null) return UNAUTHORIZED

  const verdict = verifyIngestSignature({
    secret: auth.webhookSecret,
    rawBody: request.rawBody,
    timestamp: request.timestamp,
    signature: request.signature,
    now,
  })
  if (!verdict.ok) return UNAUTHORIZED

  let json: unknown
  try {
    json = JSON.parse(request.rawBody)
  } catch {
    return { status: 400, body: { error: 'invalid JSON' } }
  }

  const parsed = parsePushPayload(json)
  if (!parsed.ok) return { status: 422, body: { error: 'invalid payload', details: parsed.errors } }

  const event = normalizePushEvent(auth.service.id, parsed.value, now)
  const result = await processAndNotify(store, deps, event, now)
  return {
    status: 201,
    body: {
      issueId: result.issue.id,
      severity: result.issue.severity,
      health: result.health,
      duplicate: result.duplicate,
      notified: result.notified,
    },
  }
}
