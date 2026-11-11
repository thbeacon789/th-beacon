import { describe, it, expect } from 'vitest'
import { isSameJudgment, extractCiJudgment, validateJudgmentLabel } from '@/core/ai-judgment'
import { EMPTY_LABEL, type CanonicalEvent } from '@/core/types'

const ev = (over: Partial<CanonicalEvent>): CanonicalEvent => ({
  serviceId: 's1',
  source: 'push',
  level: 'error',
  errorType: 'test_failure',
  message: 'm',
  fingerprint: 'f',
  occurredAt: '2026-11-11T00:00:00.000Z',
  metadata: {},
  ...over,
})
const diag = (over: Record<string, unknown> = {}) => ({
  category: 'app',
  severity: 'P1',
  reason: 'r',
  suggestion: 's',
  model: 'claude-sonnet-5-5',
  ...over,
})
const empty = { severityVerdict: '', severityCorrect: '', categoryVerdict: '', categoryCorrect: '' }
const ai = { severity: 'P1', category: 'app' } as const

describe('isSameJudgment', () => {
  it('severity 與 category 皆同才 true', () => {
    expect(isSameJudgment({ severity: 'P1', category: 'app' }, { severity: 'P1', category: 'app' })).toBe(true)
    expect(isSameJudgment({ severity: 'P1', category: 'app' }, { severity: 'P0', category: 'app' })).toBe(false)
    expect(isSameJudgment({ severity: 'P1', category: 'app' }, { severity: 'P1', category: 'env' })).toBe(false)
  })
})

describe('extractCiJudgment', () => {
  it('event.severity 與 metadata.diagnosis 皆有 → 取 diagnosis 的值', () => {
    const e = ev({ severity: 'P0', metadata: { diagnosis: diag({ severity: 'P2', category: 'env' }) } })
    expect(extractCiJudgment(e)).toEqual({ severity: 'P2', category: 'env', model: 'claude-sonnet-5-5' })
  })
  it('diagnosis 缺 model → model null', () => {
    const e = ev({ severity: 'P1', metadata: { diagnosis: diag({ model: undefined }) } })
    expect(extractCiJudgment(e)?.model).toBeNull()
  })
  it('只有 ciDiagnosisError、無 diagnosis → null', () => {
    expect(extractCiJudgment(ev({ metadata: { ciDiagnosisError: 'x' } }))).toBeNull()
  })
  it('event.severity 有值但 metadata 無 diagnosis → null', () => {
    expect(extractCiJudgment(ev({ severity: 'P1' }))).toBeNull()
  })
  it('event.severity 缺 → null', () => {
    expect(extractCiJudgment(ev({ metadata: { diagnosis: diag() } }))).toBeNull()
  })
  it('category 非 env/app 或 severity 非 P0-P2 → null', () => {
    expect(extractCiJudgment(ev({ severity: 'P1', metadata: { diagnosis: diag({ category: 'x' }) } }))).toBeNull()
    expect(extractCiJudgment(ev({ severity: 'P1', metadata: { diagnosis: diag({ severity: 'P9' }) } }))).toBeNull()
  })
})

describe('validateJudgmentLabel', () => {
  it('兩項皆空 → ok 且等於 EMPTY_LABEL', () => {
    expect(validateJudgmentLabel(empty, ai)).toEqual({ ok: true, value: EMPTY_LABEL })
  })
  it('嚴重度判對 → severityCorrect 為 null（即使表單帶了答案）', () => {
    const r = validateJudgmentLabel({ ...empty, severityVerdict: 'correct', severityCorrect: 'P0' }, ai)
    expect(r).toEqual({ ok: true, value: { ...EMPTY_LABEL, severityVerdict: 'correct' } })
  })
  it('嚴重度判錯且選 P0（AI 為 P1）→ ok', () => {
    const r = validateJudgmentLabel({ ...empty, severityVerdict: 'wrong', severityCorrect: 'P0' }, ai)
    expect(r).toEqual({ ok: true, value: { ...EMPTY_LABEL, severityVerdict: 'wrong', severityCorrect: 'P0' } })
  })
  it('判錯未選答案 → 請選擇正確的嚴重度', () => {
    const r = validateJudgmentLabel({ ...empty, severityVerdict: 'wrong' }, ai)
    expect(r).toEqual({ ok: false, errors: ['請選擇正確的嚴重度'] })
  })
  it('判錯且答案等於 AI 答案 → 正確答案不能與 AI 判定相同', () => {
    const r = validateJudgmentLabel({ ...empty, severityVerdict: 'wrong', severityCorrect: 'P1' }, ai)
    expect(r).toEqual({ ok: false, errors: ['正確答案不能與 AI 判定相同'] })
  })
  it('類型判錯選 env（AI 為 app）→ ok；選 app → error；未選 → 請選擇正確的類型', () => {
    expect(validateJudgmentLabel({ ...empty, categoryVerdict: 'wrong', categoryCorrect: 'env' }, ai)).toEqual({
      ok: true,
      value: { ...EMPTY_LABEL, categoryVerdict: 'wrong', categoryCorrect: 'env' },
    })
    expect(validateJudgmentLabel({ ...empty, categoryVerdict: 'wrong', categoryCorrect: 'app' }, ai)).toEqual({
      ok: false,
      errors: ['正確答案不能與 AI 判定相同'],
    })
    expect(validateJudgmentLabel({ ...empty, categoryVerdict: 'wrong' }, ai)).toEqual({
      ok: false,
      errors: ['請選擇正確的類型'],
    })
  })
  it('verdict 為非法字串 → 標記值不合法', () => {
    expect(validateJudgmentLabel({ ...empty, severityVerdict: 'maybe' }, ai)).toEqual({
      ok: false,
      errors: ['標記值不合法'],
    })
  })
  it('correct 值為非法字串（判錯時）→ 標記值不合法', () => {
    expect(validateJudgmentLabel({ ...empty, severityVerdict: 'wrong', severityCorrect: 'P9' }, ai)).toEqual({
      ok: false,
      errors: ['標記值不合法'],
    })
  })
})
