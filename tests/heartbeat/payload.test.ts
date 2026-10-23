import { describe, it, expect } from 'vitest'
import { parseHeartbeatPayload } from '@/heartbeat/payload'
import {
  DIAGNOSIS_ERROR_LIMIT,
  DIAGNOSIS_REASON_LIMIT,
  DIAGNOSIS_SUGGESTION_LIMIT,
} from '@/core/heartbeat'

describe('parseHeartbeatPayload', () => {
  it('接受最小合法 payload', () => {
    const result = parseHeartbeatPayload({ name: 'daily-test', status: 'pass' })
    expect(result).toEqual({ ok: true, value: { name: 'daily-test', status: 'pass' }, warnings: [] })
  })

  it('保留選填欄位', () => {
    const result = parseHeartbeatPayload({
      name: 'daily-test',
      status: 'fail',
      runUrl: 'https://ci/run/1',
      summary: '3 failed',
    })
    expect(result).toEqual({
      ok: true,
      value: { name: 'daily-test', status: 'fail', runUrl: 'https://ci/run/1', summary: '3 failed' },
      warnings: [],
    })
  })

  it('拒絕非物件', () => {
    expect(parseHeartbeatPayload([]).ok).toBe(false)
    expect(parseHeartbeatPayload(null).ok).toBe(false)
    expect(parseHeartbeatPayload('x').ok).toBe(false)
  })

  it('name 必填且非空', () => {
    const result = parseHeartbeatPayload({ status: 'pass' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join()).toContain('name')
  })

  it('status 只接受 pass 或 fail', () => {
    const result = parseHeartbeatPayload({ name: 'x', status: 'ok' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join()).toContain('status')
  })

  it('選填欄位型別錯誤時拒絕', () => {
    const result = parseHeartbeatPayload({ name: 'x', status: 'pass', runUrl: 42 })
    expect(result.ok).toBe(false)
  })

  it('runUrl 非 http(s) scheme 時濾掉並回 warning，但不拒收整包（避免存活訊號送不出去）', () => {
    const result = parseHeartbeatPayload({ name: 'x', status: 'pass', runUrl: 'javascript:alert(1)' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({ name: 'x', status: 'pass' })
      expect(result.value.runUrl).toBeUndefined()
      expect(result.warnings.join()).toContain('runUrl')
    }
  })
})

describe('diagnosis', () => {
  const base = { name: 'x', status: 'fail' }
  const good = { category: 'env', severity: 'P2', reason: 'r', suggestion: 's', model: 'claude-sonnet-5-5' }
  const parse = (extra: Record<string, unknown>) => {
    const r = parseHeartbeatPayload({ ...base, ...extra })
    if (!r.ok) throw new Error('expected ok')
    return r
  }

  it('合法 diagnosis 被保留', () => {
    const r = parse({ diagnosis: good })
    expect(r.value.diagnosis).toEqual(good)
    expect(r.warnings).toEqual([])
  })

  it.each([
    ['enum 不合法', { ...good, category: 'flaky' }],
    ['severity 不合法', { ...good, severity: 'P3' }],
    ['reason 空字串', { ...good, reason: '' }],
    ['diagnosis 不是物件', 'env'],
  ])('%s時丟棄並回 warning', (_n, diagnosis) => {
    const r = parse({ diagnosis })
    expect(r.value.diagnosis).toBeUndefined()
    expect(r.warnings.join()).toContain('diagnosis was rejected')
  })

  it('未知欄位不進入結果', () => {
    const r = parse({ diagnosis: { ...good, extra: 1 } })
    expect(r.value.diagnosis).toEqual(good)
    expect(r.value.diagnosis).not.toHaveProperty('extra')
  })

  it('超長 reason 與 suggestion 被截斷', () => {
    const r = parse({ diagnosis: { ...good, reason: 'a'.repeat(600), suggestion: 'b'.repeat(1200) } })
    expect(r.value.diagnosis?.reason).toHaveLength(DIAGNOSIS_REASON_LIMIT)
    expect(r.value.diagnosis?.suggestion).toHaveLength(DIAGNOSIS_SUGGESTION_LIMIT)
    expect(r.value.diagnosis?.reason.endsWith('…')).toBe(true)
    expect(r.value.diagnosis?.suggestion.endsWith('…')).toBe(true)
  })

  it('diagnosisError 字串被保留並截斷', () => {
    expect(parse({ diagnosisError: 'oops' }).value.diagnosisError).toBe('oops')
    expect(parse({ diagnosisError: 'e'.repeat(300) }).value.diagnosisError).toHaveLength(DIAGNOSIS_ERROR_LIMIT)
  })

  it('diagnosisError 非字串時丟棄並回 warning', () => {
    const r = parse({ diagnosisError: 5 })
    expect(r.value.diagnosisError).toBeUndefined()
    expect(r.warnings.join()).toContain('diagnosisError was rejected')
  })

  it('diagnosis 被拒且無 diagnosisError 時補上 diagnosisError', () => {
    const r = parse({ diagnosis: 'env' })
    expect(r.value.diagnosisError).toContain('diagnosis rejected:')
    expect(r.warnings.join()).toContain('diagnosis was rejected')
  })

  it('diagnosis 被拒但有明確 diagnosisError 時以明確者為準', () => {
    expect(parse({ diagnosis: 'env', diagnosisError: 'explicit' }).value.diagnosisError).toBe('explicit')
  })

  it('合法 diagnosis 不產生 diagnosisError', () => {
    expect(parse({ diagnosis: good }).value).not.toHaveProperty('diagnosisError')
  })

  it('舊格式（無 diagnosis）行為不變', () => {
    const r = parse({})
    expect(r.value).not.toHaveProperty('diagnosis')
    expect(r.value).not.toHaveProperty('diagnosisError')
  })
})
