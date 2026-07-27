import type { RawPushEvent } from '@/core/normalize'

export type ParseResult = { ok: true; value: RawPushEvent } | { ok: false; errors: string[] }

// 註：input 來自 JSON.parse，故所有值必為 JSON-safe——CanonicalEvent.metadata
// 的 JSON 安全性由這個邊界保證（Plan 3 必要事項 #4）。
export function parsePushPayload(input: unknown): ParseResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['payload must be a JSON object'] }
  }
  const obj = input as Record<string, unknown>
  const errors: string[] = []

  if (typeof obj.message !== 'string' || obj.message.trim() === '') {
    errors.push('message is required and must be a non-empty string')
  }
  for (const key of ['errorType', 'level'] as const) {
    if (obj[key] !== undefined && typeof obj[key] !== 'string') errors.push(`${key} must be a string`)
  }
  if (obj.occurredAt !== undefined) {
    if (typeof obj.occurredAt !== 'string' || Number.isNaN(Date.parse(obj.occurredAt))) {
      errors.push('occurredAt must be an ISO 8601 string')
    }
  }
  if (
    obj.metadata !== undefined &&
    (typeof obj.metadata !== 'object' || obj.metadata === null || Array.isArray(obj.metadata))
  ) {
    errors.push('metadata must be a JSON object')
  }

  if (errors.length > 0) return { ok: false, errors }

  const value: RawPushEvent = { message: obj.message as string }
  if (obj.errorType !== undefined) value.errorType = obj.errorType as string
  if (obj.level !== undefined) value.level = obj.level as string
  if (obj.occurredAt !== undefined) value.occurredAt = obj.occurredAt as string
  if (obj.metadata !== undefined) value.metadata = obj.metadata as Record<string, unknown>
  return { ok: true, value }
}
