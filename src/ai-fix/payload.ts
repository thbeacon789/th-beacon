import { AI_FIX_STATUSES, AI_FIX_SUMMARY_LIMIT, isSafePrUrl, type AiFixStatus } from '@/core/ai-fix'
import { isSafeRunUrl, truncateText } from '@/core/heartbeat'

export interface AiFixReport {
  heartbeat: string
  status: AiFixStatus
  prUrl: string | null
  summary: string | null
  runUrl: string | null
}

type ParseResult = { ok: true; value: AiFixReport } | { ok: false; errors: string[] }

export function parseAiFixPayload(input: unknown): ParseResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['payload 必須是 JSON 物件'] }
  }
  const obj = input as Record<string, unknown>
  const errors: string[] = []

  let heartbeat = ''
  if (typeof obj.heartbeat !== 'string' || obj.heartbeat.trim() === '') {
    errors.push('heartbeat 必須是非空字串')
  } else {
    heartbeat = obj.heartbeat
  }

  const status = (AI_FIX_STATUSES as readonly unknown[]).includes(obj.status)
    ? (obj.status as AiFixStatus)
    : null
  if (status === null) errors.push(`status 必須是 ${AI_FIX_STATUSES.join('／')}`)

  // 只有 pr_opened 才有意義的 prUrl；其餘狀態一律存 null
  let prUrl: string | null = null
  if (status === 'pr_opened') {
    if (isSafePrUrl(obj.prUrl)) prUrl = obj.prUrl
    else errors.push('status=pr_opened 時 prUrl 必須是 https://github.com/<owner>/<repo>/pull/<number>')
  }

  const summary =
    typeof obj.summary === 'string' && obj.summary !== ''
      ? truncateText(obj.summary, AI_FIX_SUMMARY_LIMIT)
      : null

  const runUrl = isSafeRunUrl(obj.runUrl) ? obj.runUrl : null

  if (errors.length > 0 || status === null) return { ok: false, errors }
  return { ok: true, value: { heartbeat, status, prUrl, summary, runUrl } }
}
