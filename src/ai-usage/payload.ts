export interface AiUsageReport {
  source: 'ci_diagnosis' | 'ci_pr'
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  costUsd: number | null
}

type ParseResult = { ok: true; value: AiUsageReport } | { ok: false; errors: string[] }

const SOURCES = ['ci_diagnosis', 'ci_pr'] as const
const MODEL_MAX = 100
const TOKENS_MAX = 2_147_483_647 // int4
const COST_MAX_EXCLUSIVE = 1_000_000 // numeric(12,6)

function optionalTokens(obj: Record<string, unknown>, key: string, errors: string[]): number | null {
  const v = obj[key]
  if (v === undefined || v === null) return null
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    errors.push(`${key} 必須是非負整數`)
    return null
  }
  if (v > TOKENS_MAX) {
    errors.push(`${key} 不可超過 ${TOKENS_MAX}`)
    return null
  }
  return v
}

export function parseAiUsagePayload(input: unknown): ParseResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['payload 必須是 JSON 物件'] }
  }
  const obj = input as Record<string, unknown>
  const errors: string[] = []

  const source = (SOURCES as readonly unknown[]).includes(obj.source)
    ? (obj.source as AiUsageReport['source'])
    : null
  if (source === null) errors.push(`source 必須是 ${SOURCES.join('／')}`)

  let model: string | null = null
  if (obj.model !== undefined && obj.model !== null) {
    if (typeof obj.model !== 'string' || obj.model.length === 0 || obj.model.length > MODEL_MAX) {
      errors.push(`model 必須是 1–${MODEL_MAX} 字的字串`)
    } else {
      model = obj.model
    }
  }

  const inputTokens = optionalTokens(obj, 'inputTokens', errors)
  const outputTokens = optionalTokens(obj, 'outputTokens', errors)

  let costUsd: number | null = null
  if (obj.costUsd !== undefined && obj.costUsd !== null) {
    if (typeof obj.costUsd !== 'number' || !Number.isFinite(obj.costUsd) || obj.costUsd < 0) {
      errors.push('costUsd 必須是非負有限數')
    } else {
      costUsd = obj.costUsd
    }
    if (typeof obj.costUsd === 'number' && obj.costUsd >= COST_MAX_EXCLUSIVE) {
      errors.push(`costUsd 必須小於 ${COST_MAX_EXCLUSIVE}`)
      costUsd = null
    }
  }

  if (errors.length === 0 && costUsd === null && (inputTokens === null || outputTokens === null)) {
    errors.push('需提供 costUsd 或 inputTokens＋outputTokens')
  }

  if (errors.length > 0 || source === null) return { ok: false, errors }
  return { ok: true, value: { source, model, inputTokens, outputTokens, costUsd } }
}
