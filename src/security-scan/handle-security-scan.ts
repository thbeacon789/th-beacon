import { verifyIngestSignature } from '@/ingest/hmac'
import type { IngestRequest, IngestResponse } from '@/ingest/handle-ingest'
import { parseSecurityScanPayload } from '@/core/security/payload'
import { evaluateLogVolume } from '@/core/security/log-volume'
import { evaluateExposure } from '@/core/security/exposure'
import { evaluateChanges, pickBaseline } from '@/core/security/changes'
import { BASELINE_WINDOW_DAYS } from '@/core/security/constants'
import type { Store } from '@/store/contracts'

const UNAUTHORIZED: IngestResponse = { status: 401, body: { error: 'unauthorized' } }
const DAY_MS = 86400000
// payload 中多個陣列沒有筆數上限，驗簽後先擋過大的 body
const MAX_BODY_BYTES = 512 * 1024

export async function handleSecurityScan(
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

  if (Buffer.byteLength(request.rawBody, 'utf8') > MAX_BODY_BYTES) {
    return { status: 413, body: { error: 'payload too large' } }
  }

  let json: unknown
  try {
    json = JSON.parse(request.rawBody)
  } catch {
    return { status: 400, body: { error: 'invalid JSON' } }
  }

  const parsed = parseSecurityScanPayload(json, now)
  if (!parsed.ok) return { status: 422, body: { error: 'invalid payload', details: parsed.errors } }
  const payload = parsed.value

  // 歷史上界是 payload 的 scannedAt（不是 now）：亂序抵達時不可拿較新的快照當基準
  const fromIso = new Date(new Date(payload.scannedAt).getTime() - BASELINE_WINDOW_DAYS * DAY_MS).toISOString()
  const history = await store.listSecurityScansBetween(auth.service.id, fromIso, payload.scannedAt)

  const logVolume = evaluateLogVolume(payload.kind, payload.logVolume, history.map((h) => h.logVolume))
  const exposure = evaluateExposure(payload.exposure)
  const changes = evaluateChanges(payload.kind, payload.inventory, pickBaseline(history))

  const checks = {
    ...payload.checks,
    logVolume: logVolume.check,
    exposure: exposure.check,
    changes: changes.check,
  }
  const inserted = await store.insertSecurityScan({
    serviceId: auth.service.id,
    scannedAt: payload.scannedAt,
    kind: payload.kind,
    checks,
    findings: [...payload.findings, ...logVolume.findings, ...exposure.findings, ...changes.findings],
    certs: payload.certs,
    logVolume: logVolume.logVolume,
    exposure: payload.exposure,
    inventory: payload.inventory ?? null,
  })
  if (inserted === null) return { status: 200, body: { duplicate: true } }
  return { status: 201, body: { id: inserted.id, checks } }
}
