import { describe, it, expect } from 'vitest'
import { computeCostUsd, MODEL_PRICES } from '@/core/ai-pricing'

describe('computeCostUsd', () => {
  it('sonnet 5.5 依 $2／$10 per MTok 換算', () => {
    expect(computeCostUsd('claude-sonnet-5-5', 1_000_000, 1_000_000)).toBe(12)
    expect(computeCostUsd('claude-sonnet-5-5', 1000, 500)).toBeCloseTo(0.007, 10)
  })
  it('未定價 model、model 為 null、任一 tokens 為 null → null', () => {
    expect(computeCostUsd('claude-unknown', 10, 10)).toBeNull()
    expect(computeCostUsd('toString', 10, 10)).toBeNull()
    expect(computeCostUsd(null, 10, 10)).toBeNull()
    expect(computeCostUsd('claude-sonnet-5-5', null, 10)).toBeNull()
    expect(computeCostUsd('claude-sonnet-5-5', 10, null)).toBeNull()
  })
  it('MODEL_PRICES 含 claude-sonnet-5-5 = {2, 10}', () => {
    expect(MODEL_PRICES['claude-sonnet-5-5']).toEqual({ inputPerMTok: 2, outputPerMTok: 10 })
  })
})
