import type { CanonicalEvent, Severity } from '@/core/types'
import { computeFingerprint } from '@/core/fingerprint'

export type HeartbeatRunStatus = 'pass' | 'fail'

// runUrl 來自外部輸入（CI 回報、心跳表既有資料），且會被嵌進 markdown 連結
// `[查看 run](${runUrl})` 或 dashboard 的 <a href>。除了 scheme 檢查，整串都必須落在
// 合法 URL 字元白名單內——尤其要擋掉 `(`、`)`、空白（含換行/tab）與反引號，否則可被
// 注入內容提前閉合連結、偽造第二個連結（釣魚），或以 `javascript:` 等 scheme 執行任意程式碼。
// 用白名單而非黑名單更穩固。此為唯一權威實作，寫入端（parseHeartbeatPayload）、
// 讀取端（web/queries extractRunUrl）、通知端（notify/message extractNotifyDetails）皆共用。
const RUN_URL_PATTERN = /^https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=%]+$/i

export function isSafeRunUrl(value: unknown): value is string {
  return typeof value === 'string' && RUN_URL_PATTERN.test(value)
}

export interface HeartbeatDefinition {
  name: string
  intervalSeconds: number
  graceSeconds: number
  lastRunAt: string | null
  createdAt: string
}

// 名稱走 errorType 位置參與雜湊：computeFingerprint 只正規化 message，
// 其中 \b\d+\b 會被換成 <n>，若名稱只從 message 進入，daily-2 與 daily-3
// 會產生相同指紋而被錯誤聚合成同一筆 issue。
export function heartbeatFingerprint(
  serviceId: string,
  errorType: string,
  name: string,
): string {
  return computeFingerprint({ serviceId, errorType: `${errorType}:${name}`, message: '' })
}

export function heartbeatDueAt(hb: HeartbeatDefinition): Date {
  const base = hb.lastRunAt ?? hb.createdAt
  return new Date(new Date(base).getTime() + hb.intervalSeconds * 1000)
}

export function isHeartbeatOverdue(hb: HeartbeatDefinition, now: Date): boolean {
  return now.getTime() > heartbeatDueAt(hb).getTime() + hb.graceSeconds * 1000
}

export function synthesizeHeartbeatMissedEvent(
  serviceId: string,
  hb: HeartbeatDefinition,
  occurredAt: Date,
): CanonicalEvent {
  const errorType = 'heartbeat_missed'
  // 訊息刻意只含名稱（不含逾期秒數等變動值），確保同一心跳的重複掃描聚合成同一 issue。
  const message = `Heartbeat missed: ${hb.name}`
  const overdueMs = occurredAt.getTime() - heartbeatDueAt(hb).getTime()
  return {
    serviceId,
    source: 'poll',
    level: 'error',
    errorType,
    message,
    fingerprint: heartbeatFingerprint(serviceId, errorType, hb.name),
    occurredAt: occurredAt.toISOString(),
    metadata: {
      heartbeat: hb.name,
      intervalSeconds: hb.intervalSeconds,
      graceSeconds: hb.graceSeconds,
      lastRunAt: hb.lastRunAt,
      overdueSeconds: Math.floor(overdueMs / 1000),
    },
  }
}

export const TEST_FAILURE_ENV = 'test_failure_env'

export interface HeartbeatFailurePayload {
  runUrl?: string
  summary?: string
  diagnosis?: HeartbeatDiagnosis
  diagnosisError?: string
}

export function normalizeHeartbeatFailure(
  serviceId: string,
  hb: HeartbeatDefinition,
  payload: HeartbeatFailurePayload,
  occurredAt: Date,
): CanonicalEvent {
  const diagnosis = payload.diagnosis
  const isEnv = diagnosis?.category === 'env'
  const errorType = isEnv ? TEST_FAILURE_ENV : 'test_failure'
  const message = isEnv ? `Test failed (env): ${hb.name}` : `Test failed: ${hb.name}`
  const summary = truncateRunSummary(payload.summary)
  return {
    serviceId,
    source: 'push',
    level: 'error',
    errorType,
    message,
    fingerprint: heartbeatFingerprint(serviceId, errorType, hb.name),
    occurredAt: occurredAt.toISOString(),
    ...(diagnosis ? { severity: diagnosis.severity } : {}),
    metadata: {
      heartbeat: hb.name,
      ...(payload.runUrl !== undefined ? { runUrl: payload.runUrl } : {}),
      ...(summary !== null ? { summary } : {}),
      ...(diagnosis ? { diagnosis } : {}),
      ...(payload.diagnosisError !== undefined ? { ciDiagnosisError: payload.diagnosisError } : {}),
    },
  }
}

// 回報端不保證截斷（chatxbuy-api 目前有做，但那是它的實作細節），DB 不該吃下無上限字串。
export const RUN_SUMMARY_LIMIT = 500

export function truncateText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

export function truncateRunSummary(summary: string | undefined): string | null {
  if (summary === undefined || summary === '') return null
  return truncateText(summary, RUN_SUMMARY_LIMIT)
}

// AI 診斷（CI 端附帶的 e2e 失敗判讀）。
export type DiagnosisCategory = 'env' | 'app'
export interface HeartbeatDiagnosis {
  category: DiagnosisCategory
  severity: Severity
  reason: string
  suggestion: string
  model?: string
}
export const DIAGNOSIS_REASON_LIMIT = 500
export const DIAGNOSIS_SUGGESTION_LIMIT = 1000
export const DIAGNOSIS_ERROR_LIMIT = 200
