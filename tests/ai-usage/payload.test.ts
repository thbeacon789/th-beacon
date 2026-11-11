import { describe, it, expect } from 'vitest'
import { parseAiUsagePayload } from '@/ai-usage/payload'

describe('parseAiUsagePayload', () => {
  it('tokens 版本合法', () => {
    const r = parseAiUsagePayload({ source: 'ci_diagnosis', model: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 500 })
    expect(r).toEqual({
      ok: true,
      value: { source: 'ci_diagnosis', model: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 500, costUsd: null },
    })
  })

  it('只回報 costUsd 合法，tokens 為 null', () => {
    const r = parseAiUsagePayload({ source: 'ci_pr', costUsd: 0.12 })
    expect(r).toEqual({
      ok: true,
      value: { source: 'ci_pr', model: null, inputTokens: null, outputTokens: null, costUsd: 0.12 },
    })
  })

  it('source 為 server_triage 或未知值 → 錯誤', () => {
    for (const source of ['server_triage', 'nope', undefined, 1]) {
      expect(parseAiUsagePayload({ source, costUsd: 1 }).ok).toBe(false)
    }
  })

  it('tokens 為負數、小數、字串 "10"、NaN → 錯誤', () => {
    for (const bad of [-1, 1.5, '10', NaN]) {
      expect(parseAiUsagePayload({ source: 'ci_pr', inputTokens: bad, outputTokens: 5 }).ok).toBe(false)
      expect(parseAiUsagePayload({ source: 'ci_pr', inputTokens: 5, outputTokens: bad }).ok).toBe(false)
    }
  })

  it('costUsd 為負或 Infinity → 錯誤', () => {
    for (const bad of [-0.01, Infinity, '1']) {
      expect(parseAiUsagePayload({ source: 'ci_pr', costUsd: bad }).ok).toBe(false)
    }
  })

  it('只有 inputTokens 沒有 outputTokens、也沒有 costUsd → 錯誤', () => {
    const r = parseAiUsagePayload({ source: 'ci_pr', inputTokens: 10 })
    expect(r).toEqual({ ok: false, errors: ['需提供 costUsd 或 inputTokens＋outputTokens'] })
  })

  it('model 空字串或 > 100 字 → 錯誤', () => {
    expect(parseAiUsagePayload({ source: 'ci_pr', costUsd: 1, model: '' }).ok).toBe(false)
    expect(parseAiUsagePayload({ source: 'ci_pr', costUsd: 1, model: 'a'.repeat(101) }).ok).toBe(false)
    expect(parseAiUsagePayload({ source: 'ci_pr', costUsd: 1, model: 'a'.repeat(100) }).ok).toBe(true)
  })

  it('非物件 → 錯誤', () => {
    for (const bad of [null, 'x', 1, [], undefined]) {
      expect(parseAiUsagePayload(bad).ok).toBe(false)
    }
  })
})
