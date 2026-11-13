export const AI_FIX_STATUSES = ['pr_opened', 'no_fix', 'failed'] as const
export type AiFixStatus = (typeof AI_FIX_STATUSES)[number]

export const AI_FIX_SUMMARY_LIMIT = 500

// owner／repo 字元集嚴格限縮；`.`、`..` 另行排除（避免路徑穿越樣式）。
const PR_URL_PATTERN = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/\d+$/

export function isSafePrUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const m = PR_URL_PATTERN.exec(value)
  if (m === null) return false
  return m[1] !== '.' && m[1] !== '..' && m[2] !== '.' && m[2] !== '..'
}
