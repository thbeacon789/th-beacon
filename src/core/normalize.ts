import type { CanonicalEvent } from '@/core/types'
import { computeFingerprint } from '@/core/fingerprint'

export interface RawPushEvent {
  message: string
  errorType?: string
  level?: string
  occurredAt?: string
  metadata?: Record<string, unknown>
}

export function normalizePushEvent(
  serviceId: string,
  raw: RawPushEvent,
  receivedAt: Date,
): CanonicalEvent {
  const errorType = raw.errorType ?? 'unknown'
  return {
    serviceId,
    source: 'push',
    level: raw.level ?? 'error',
    errorType,
    message: raw.message,
    fingerprint: computeFingerprint({ serviceId, errorType, message: raw.message }),
    occurredAt: raw.occurredAt ?? receivedAt.toISOString(),
    metadata: raw.metadata ?? {},
  }
}

export interface HealthFailDetail {
  reason: string
  statusCode?: number
  url?: string
}

export function synthesizeHealthCheckFailedEvent(
  serviceId: string,
  detail: HealthFailDetail,
  occurredAt: Date,
): CanonicalEvent {
  const errorType = 'health_check_failed'
  // 訊息刻意不含變動細節（reason 進 metadata），確保同服務的 health 失敗聚合成同一 issue。
  const message = 'Health check failed'
  return {
    serviceId,
    source: 'poll',
    level: 'error',
    errorType,
    message,
    fingerprint: computeFingerprint({ serviceId, errorType, message }),
    occurredAt: occurredAt.toISOString(),
    metadata: {
      reason: detail.reason,
      ...(detail.statusCode !== undefined ? { statusCode: detail.statusCode } : {}),
      ...(detail.url !== undefined ? { url: detail.url } : {}),
    },
  }
}

export interface RawPolledError {
  message: string
  errorType?: string
  level?: string
  externalId?: string
  occurredAt?: string
  metadata?: Record<string, unknown>
}

export function normalizePolledError(
  serviceId: string,
  raw: RawPolledError,
  fetchedAt: Date,
): CanonicalEvent {
  const errorType = raw.errorType ?? 'unknown'
  return {
    serviceId,
    source: 'poll',
    level: raw.level ?? 'error',
    errorType,
    message: raw.message,
    fingerprint: computeFingerprint({ serviceId, errorType, message: raw.message }),
    occurredAt: raw.occurredAt ?? fetchedAt.toISOString(),
    metadata: {
      ...(raw.metadata ?? {}),
      ...(raw.externalId !== undefined ? { externalId: raw.externalId } : {}),
    },
  }
}
