import { isSafeRunUrl, type HeartbeatRunStatus } from '@/core/heartbeat'

export interface RawHeartbeatReport {
  name: string
  status: HeartbeatRunStatus
  runUrl?: string
  summary?: string
}

export type HeartbeatParseResult =
  | { ok: true; value: RawHeartbeatReport }
  | { ok: false; errors: string[] }

const STATUSES: readonly string[] = ['pass', 'fail']

// 註：input 來自 JSON.parse，故所有值必為 JSON-safe。
export function parseHeartbeatPayload(input: unknown): HeartbeatParseResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['payload must be a JSON object'] }
  }
  const obj = input as Record<string, unknown>
  const errors: string[] = []

  if (typeof obj.name !== 'string' || obj.name.trim() === '') {
    errors.push('name is required and must be a non-empty string')
  }
  if (typeof obj.status !== 'string' || !STATUSES.includes(obj.status)) {
    errors.push('status is required and must be "pass" or "fail"')
  }
  for (const key of ['runUrl', 'summary'] as const) {
    if (obj[key] !== undefined && typeof obj[key] !== 'string') errors.push(`${key} must be a string`)
  }
  // runUrl 會被寫進 heartbeats 表並在 dashboard 渲染成 <a href>，寫入端就要擋非 http(s)
  // scheme（如 javascript:），不能只靠讀取端過濾——讀取端是防禦既有髒資料的最後一道。
  if (typeof obj.runUrl === 'string' && !isSafeRunUrl(obj.runUrl)) {
    errors.push('runUrl must be an http(s) URL')
  }

  if (errors.length > 0) return { ok: false, errors }

  const value: RawHeartbeatReport = {
    name: obj.name as string,
    status: obj.status as HeartbeatRunStatus,
  }
  if (obj.runUrl !== undefined) value.runUrl = obj.runUrl as string
  if (obj.summary !== undefined) value.summary = obj.summary as string
  return { ok: true, value }
}
