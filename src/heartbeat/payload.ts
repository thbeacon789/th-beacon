import { parseTriageOutput } from '@/core/ai-triage'
import {
  DIAGNOSIS_ERROR_LIMIT,
  isSafeRunUrl,
  truncateText,
  type HeartbeatDiagnosis,
  type HeartbeatRunStatus,
} from '@/core/heartbeat'

export interface RawHeartbeatReport {
  name: string
  status: HeartbeatRunStatus
  runUrl?: string
  summary?: string
  diagnosis?: HeartbeatDiagnosis
  diagnosisError?: string
}

export type HeartbeatParseResult =
  | { ok: true; value: RawHeartbeatReport; warnings: string[] }
  | { ok: false; errors: string[] }

const STATUSES: readonly string[] = ['pass', 'fail']
const CATEGORIES: readonly string[] = ['env', 'app']
const SEVERITIES: readonly string[] = ['P0', 'P1', 'P2']

function parseDiagnosis(raw: unknown): { value: HeartbeatDiagnosis } | { reason: string } {
  const r = parseTriageOutput(raw)
  return r.ok ? { value: r.value } : { reason: r.reason }
}

// 註：input 來自 JSON.parse，故所有值必為 JSON-safe。
export function parseHeartbeatPayload(input: unknown): HeartbeatParseResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['payload must be a JSON object'] }
  }
  const obj = input as Record<string, unknown>
  const errors: string[] = []
  const warnings: string[] = []

  if (typeof obj.name !== 'string' || obj.name.trim() === '') {
    errors.push('name is required and must be a non-empty string')
  }
  if (typeof obj.status !== 'string' || !STATUSES.includes(obj.status)) {
    errors.push('status is required and must be "pass" or "fail"')
  }
  for (const key of ['runUrl', 'summary'] as const) {
    if (obj[key] !== undefined && typeof obj[key] !== 'string') errors.push(`${key} must be a string`)
  }
  // runUrl 是純裝飾性欄位。CI 端常用 `set -e` + `curl --fail-with-body`：若因 runUrl
  // 格式問題整包回報被拒（422），存活訊號本身就送不出去，隔天反而觸發假的
  // heartbeat missed 告警——後果比「少一個連結」嚴重得多。因此格式不合法時濾掉、
  // 回 warning，而不是拒收整包。安全性不放寬：非法 runUrl 仍絕不寫入 DB（見下方
  // isSafeRunUrl 保護的是唯一寫入路徑），讀取端 extractRunUrl 仍是最後一道防線。
  const runUrlIsSafe = typeof obj.runUrl !== 'string' || isSafeRunUrl(obj.runUrl)
  if (typeof obj.runUrl === 'string' && !runUrlIsSafe) {
    warnings.push('runUrl was rejected: must be an http(s) URL')
  }

  // diagnosis／diagnosisError 同為附帶資訊：不合法時丟棄並回 warning，絕不拒收整包。
  let diagnosis: HeartbeatDiagnosis | undefined
  if (obj.diagnosis !== undefined) {
    const parsed = parseDiagnosis(obj.diagnosis)
    if ('value' in parsed) diagnosis = parsed.value
    else warnings.push(`diagnosis was rejected: ${parsed.reason}`)
  }
  let diagnosisError: string | undefined
  if (obj.diagnosisError !== undefined) {
    if (typeof obj.diagnosisError === 'string') {
      diagnosisError = truncateText(obj.diagnosisError, DIAGNOSIS_ERROR_LIMIT)
    } else {
      warnings.push('diagnosisError was rejected: must be a string')
    }
  }

  // 診斷被拒且 CI 端沒給明確的 diagnosisError：補一個，讓 Discord 訊息顯示「AI 判讀失敗」而非靜默退回
  if (obj.diagnosis !== undefined && diagnosis === undefined && diagnosisError === undefined) {
    const rejected = warnings.find((w) => w.startsWith('diagnosis was rejected: '))
    if (rejected) {
      diagnosisError = truncateText(`diagnosis rejected: ${rejected.slice('diagnosis was rejected: '.length)}`, DIAGNOSIS_ERROR_LIMIT)
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  const value: RawHeartbeatReport = {
    name: obj.name as string,
    status: obj.status as HeartbeatRunStatus,
  }
  if (obj.runUrl !== undefined && runUrlIsSafe) value.runUrl = obj.runUrl as string
  if (obj.summary !== undefined) value.summary = obj.summary as string
  if (diagnosis) value.diagnosis = diagnosis
  if (diagnosisError !== undefined) value.diagnosisError = diagnosisError
  return { ok: true, value, warnings }
}
