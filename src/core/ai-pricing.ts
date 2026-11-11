// 單價（USD per MTok）。出處：claude-api skill「Current Models (cached: 2026-11-03)」價目表
// （Anthropic first-party API 價），查證日期 2026-11-11。
// 本專案兩條呼叫路徑皆未用 prompt caching，故不計 cache 價。opus/haiku 為 ≤100K prompt 價。
export interface ModelPrice {
  inputPerMTok: number
  outputPerMTok: number
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20 },
  'claude-haiku-5-5': { inputPerMTok: 0.1, outputPerMTok: 0.5 },
}

/** 未定價 model 或缺 tokens 回 null（不得當 0）。不四捨五入，精度交給 DB numeric(12,6)。 */
export function computeCostUsd(
  model: string | null,
  inputTokens: number | null,
  outputTokens: number | null,
): number | null {
  if (model === null || inputTokens === null || outputTokens === null) return null
  const price = Object.hasOwn(MODEL_PRICES, model) ? MODEL_PRICES[model] : undefined
  if (!price) return null
  return (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000
}
