import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/db/database.types'
import { computeAiStats, monthWindow, type AiStatsView, type JudgmentStatRow, type UsageStatRow } from '@/core/ai-stats'
import { narrowAiUsageSource, rowToAiJudgment } from '@/store/mapping'

type Client = SupabaseClient<Database>

// PostgREST 單次回應預設上限 1000 列，超過會被默默截斷，所以必須分頁
export const PAGE_SIZE = 1000

export async function fetchAllRows<T>(
  fetchPage: (from: number, to: number) => Promise<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const all: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`AI 統計查詢失敗：${error.message}`)
    const page = data ?? []
    all.push(...page)
    if (page.length < PAGE_SIZE) return all
  }
}

export async function getAiStats(client: Client, now: Date, months: number): Promise<AiStatsView> {
  const { sinceIso } = monthWindow(now, months)
  const [judgmentRows, usageRows, servicesRes] = await Promise.all([
    fetchAllRows(async (from, to) =>
      await client.from('ai_judgments').select('*').gte('judged_at', sinceIso).order('id').range(from, to),
    ),
    fetchAllRows(async (from, to) =>
      await client.from('ai_usage').select('*').gte('occurred_at', sinceIso).order('id').range(from, to),
    ),
    client.from('services').select('id, name'),
  ])
  if (servicesRes.error) throw new Error(`AI 統計查詢失敗：${servicesRes.error.message}`)

  const judgments: JudgmentStatRow[] = judgmentRows.map((row) => {
    const j = rowToAiJudgment(row)
    return {
      serviceId: j.serviceId,
      severity: j.severity,
      category: j.category,
      model: j.model,
      judgedAt: j.judgedAt,
      label: j.label,
    }
  })
  const usage: UsageStatRow[] = usageRows.map((row) => ({
    serviceId: row.service_id,
    source: narrowAiUsageSource(row.source),
    // numeric 欄位 PostgREST 回字串；null 代表未定價，不可轉成 0
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    occurredAt: row.occurred_at,
  }))

  return computeAiStats({ judgments, usage, services: servicesRes.data ?? [], now, months })
}
