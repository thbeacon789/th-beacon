import type { RawPolledError } from '@/core/normalize'

export type PolledErrorsResult =
  | { ok: true; value: RawPolledError[]; truncated: boolean }
  | { ok: false; errors: string[] }

// error 端點慣例：{"errors": [...]}；message 必填，其餘選填——
// 選填欄位型別不符時靜默略過該欄位（服務端資料品質不一，missing-lenient 較實用）。
export function parsePolledErrors(input: unknown, maxItems = 100): PolledErrorsResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['response must be a JSON object with an errors array'] }
  }
  const list = (input as Record<string, unknown>).errors
  if (!Array.isArray(list)) return { ok: false, errors: ['errors must be an array'] }

  const problems: string[] = []
  const value: RawPolledError[] = []
  const truncated = list.length > maxItems

  for (const [index, item] of list.slice(0, maxItems).entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      problems.push(`errors[${index}] must be an object`)
      continue
    }
    const obj = item as Record<string, unknown>
    if (typeof obj.message !== 'string' || obj.message.trim() === '') {
      problems.push(`errors[${index}].message is required and must be a non-empty string`)
      continue
    }
    const raw: RawPolledError = { message: obj.message }
    if (typeof obj.id === 'string') raw.externalId = obj.id
    if (typeof obj.errorType === 'string') raw.errorType = obj.errorType
    if (typeof obj.level === 'string') raw.level = obj.level
    if (typeof obj.occurredAt === 'string' && !Number.isNaN(Date.parse(obj.occurredAt))) {
      raw.occurredAt = obj.occurredAt
    }
    if (typeof obj.metadata === 'object' && obj.metadata !== null && !Array.isArray(obj.metadata)) {
      raw.metadata = obj.metadata as Record<string, unknown>
    }
    value.push(raw)
  }

  if (problems.length > 0) return { ok: false, errors: problems }
  return { ok: true, value, truncated }
}
