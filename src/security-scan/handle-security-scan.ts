import { verifyIngestSignature } from '@/ingest/hmac'
import type { IngestRequest, IngestResponse } from '@/ingest/handle-ingest'
import { parseSecurityScanPayload } from '@/core/security/payload'
import { evaluateLogVolume } from '@/core/security/log-volume'
import { evaluateExposure } from '@/core/security/exposure'
import { evaluateChanges, pickBaseline } from '@/core/security/changes'
import { BASELINE_WINDOW_DAYS, JUDGE_MAX_FINDINGS } from '@/core/security/constants'
import { evaluateCertFindings } from '@/core/security/cert-findings'
import { reconcileFindings } from '@/core/security/findings'
import type { CheckResult } from '@/core/security/types'
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
    deps: { status: 'na', summary: '' } as CheckResult, // hosted 不帶；vm 由 payload.checks 覆蓋
    ...payload.checks,
    logVolume: logVolume.check,
    exposure: exposure.check,
    changes: changes.check,
  }
  // 先取最新快照時間（insert 前）：晚到的舊快照只存檔，不可用過期事實改寫發現紀錄
  const latestScanAt = await store.getLatestSecurityScanAt(auth.service.id)
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
    deps: payload.deps ?? null,
  })
  if (inserted === null) return { status: 200, body: { duplicate: true } }

  // 以 Date.parse 比較：Supabase 回傳 PG 正規化字串（+00:00），不可直接比字串
  if (latestScanAt === null || Date.parse(payload.scannedAt) >= Date.parse(latestScanAt)) {
    try {
      const observed = [
        ...payload.findings,
        ...logVolume.findings,
        ...exposure.findings,
        ...changes.findings,
        ...evaluateCertFindings(payload.certs, new Date(payload.scannedAt)),
      ]
      const existing = await store.listSecurityFindings(auth.service.id)
      const rows = reconcileFindings({
        serviceId: auth.service.id,
        existing,
        observed,
        coverage: {
          checks,
          exposure: payload.exposure,
          logVolume: logVolume.logVolume,
          evaluatedLogSources: logVolume.evaluatedSources,
          judgedTruncated: payload.findings.filter((f) => f.check !== 'deps').length >= JUDGE_MAX_FINDINGS,
          certs: payload.certs,
          deps: payload.deps ?? null,
        },
        scannedAt: payload.scannedAt,
      })
      await store.upsertSecurityFindings(rows)
    } catch (err) {
      // 快照已寫入；發現紀錄下次掃描會自行補齊，不讓 reconcile 失敗拖垮回報
      console.error('[security-scan] reconcile failed', err)
    }
  }
  return { status: 201, body: { id: inserted.id, checks } }
}
