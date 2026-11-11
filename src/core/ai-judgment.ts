import type { DiagnosisCategory } from '@/core/heartbeat'
import { EMPTY_LABEL, type CanonicalEvent, type JudgmentLabel, type Severity } from '@/core/types'

interface Judgment {
  severity: Severity
  category: DiagnosisCategory
}

const SEVERITIES: readonly string[] = ['P0', 'P1', 'P2']
const CATEGORIES: readonly string[] = ['env', 'app']

export function isSameJudgment(a: Judgment, b: Judgment): boolean {
  return a.severity === b.severity && a.category === b.category
}

/** 取 CI 端附帶的 AI 診斷；ingest 自帶 severity 但無 metadata.diagnosis 者不算 AI 判定。 */
export function extractCiJudgment(
  event: CanonicalEvent,
): { severity: Severity; category: DiagnosisCategory; model: string | null } | null {
  if (event.severity === undefined) return null
  const d = event.metadata.diagnosis
  if (typeof d !== 'object' || d === null) return null
  const { severity, category, model } = d as Record<string, unknown>
  if (typeof severity !== 'string' || !SEVERITIES.includes(severity)) return null
  if (typeof category !== 'string' || !CATEGORIES.includes(category)) return null
  return {
    severity: severity as Severity,
    category: category as DiagnosisCategory,
    model: typeof model === 'string' && model !== '' ? model : null,
  }
}

export interface LabelInput {
  severityVerdict: string
  severityCorrect: string
  categoryVerdict: string
  categoryCorrect: string
}

type Field = 'correct' | 'wrong' | null

function checkVerdict(raw: string, errors: string[]): Field {
  if (raw === '') return null
  if (raw === 'correct' || raw === 'wrong') return raw
  errors.push('標記值不合法')
  return null
}

export function validateJudgmentLabel(
  input: LabelInput,
  ai: Judgment,
): { ok: true; value: JudgmentLabel } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const value: JudgmentLabel = { ...EMPTY_LABEL }

  const sv = checkVerdict(input.severityVerdict, errors)
  value.severityVerdict = sv
  if (sv === 'wrong') {
    if (input.severityCorrect === '') errors.push('請選擇正確的嚴重度')
    else if (!SEVERITIES.includes(input.severityCorrect)) errors.push('標記值不合法')
    else if (input.severityCorrect === ai.severity) errors.push('正確答案不能與 AI 判定相同')
    else value.severityCorrect = input.severityCorrect as Severity
  }

  const cv = checkVerdict(input.categoryVerdict, errors)
  value.categoryVerdict = cv
  if (cv === 'wrong') {
    if (input.categoryCorrect === '') errors.push('請選擇正確的類型')
    else if (!CATEGORIES.includes(input.categoryCorrect)) errors.push('標記值不合法')
    else if (input.categoryCorrect === ai.category) errors.push('正確答案不能與 AI 判定相同')
    else value.categoryCorrect = input.categoryCorrect as DiagnosisCategory
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value }
}
