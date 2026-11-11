import { verifyIngestSignature } from '@/ingest/hmac'
import type { IngestRequest, IngestResponse } from '@/ingest/handle-ingest'
import { parseAiUsagePayload } from '@/ai-usage/payload'
import { computeCostUsd } from '@/core/ai-pricing'
import type { Store } from '@/store/contracts'

const UNAUTHORIZED: IngestResponse = { status: 401, body: { error: 'unauthorized' } }

export async function handleAiUsage(
  store: Store,
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

  const parsed = parseAiUsagePayload(json)
  if (!parsed.ok) return { status: 422, body: { error: 'invalid payload', details: parsed.errors } }

  const report = parsed.value
  const costUsd = report.costUsd ?? computeCostUsd(report.model, report.inputTokens, report.outputTokens)
  const { id } = await store.recordAiUsage({
    serviceId: auth.service.id,
    source: report.source,
    model: report.model,
    inputTokens: report.inputTokens,
    outputTokens: report.outputTokens,
    costUsd,
    occurredAt: now.toISOString(),
  })
  return { status: 201, body: { id, costUsd, priced: costUsd !== null } }
}
