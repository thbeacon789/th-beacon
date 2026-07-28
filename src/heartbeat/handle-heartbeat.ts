import { verifyIngestSignature } from '@/ingest/hmac'
import type { IngestRequest, IngestResponse } from '@/ingest/handle-ingest'
import { parseHeartbeatPayload } from '@/heartbeat/payload'
import { heartbeatFingerprint, normalizeHeartbeatFailure } from '@/core/heartbeat'
import { processAndNotify } from '@/pipeline/process-and-notify'
import type { NotifyDeps } from '@/pipeline/process-and-notify'
import { refreshServiceHealth } from '@/pipeline/refresh-health'
import type { Store } from '@/store/contracts'

const UNAUTHORIZED: IngestResponse = { status: 401, body: { error: 'unauthorized' } }

export async function handleHeartbeat(
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

  const parsed = parseHeartbeatPayload(json)
  if (!parsed.ok) return { status: 422, body: { error: 'invalid payload', details: parsed.errors } }

  const serviceId = auth.service.id
  const report = parsed.value
  const heartbeat = await store.recordHeartbeatRun(serviceId, report.name, {
    status: report.status,
    runUrl: report.runUrl ?? null,
    at: now.toISOString(),
  })
  // 登記制：未登記的名稱要立刻炸給 CI 看，而不是靜靜長出幽靈心跳。
  if (heartbeat === null) return { status: 404, body: { error: 'unknown heartbeat' } }

  // 只要有回報就證明排程還活著——pass 與 fail 都關掉逾期 issue。
  await store.resolveIssueByFingerprint(
    serviceId,
    heartbeatFingerprint(serviceId, 'heartbeat_missed', report.name),
  )

  const body: Record<string, unknown> = {
    name: heartbeat.name,
    status: report.status,
    lastRunAt: heartbeat.lastRunAt,
    lastSuccessAt: heartbeat.lastSuccessAt,
  }

  if (report.status === 'fail') {
    const event = normalizeHeartbeatFailure(
      serviceId,
      heartbeat,
      { ...(report.runUrl !== undefined ? { runUrl: report.runUrl } : {}),
        ...(report.summary !== undefined ? { summary: report.summary } : {}) },
      now,
    )
    const result = await processAndNotify(store, deps, event, now)
    body.issueId = result.issue.id
    body.severity = result.issue.severity
    body.notified = result.notified
  } else {
    // 測試修好了，關掉先前的失敗 issue
    await store.resolveIssueByFingerprint(
      serviceId,
      heartbeatFingerprint(serviceId, 'test_failure', report.name),
    )
    await refreshServiceHealth(store, serviceId, now)
  }

  return { status: 200, body }
}
