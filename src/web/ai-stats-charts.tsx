'use client'

import { useEffect, useState } from 'react'
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { AiStatsView } from '@/core/ai-stats'

const TOKENS = ['--gold', '--green', '--pink', '--line', '--fg', '--fg-muted'] as const
type Colors = Record<(typeof TOKENS)[number], string>

// model 以線型區分：實線／長虛線／點線，循環
const DASHES = [undefined, '6 3', '2 3'] as const

const pct = (v: number) => `${Math.round(v * 100)}%`

export function MonthlyTrendChart({
  monthly,
  models,
}: {
  monthly: AiStatsView['monthly']
  models: string[]
}) {
  // SVG presentation attribute 不保證支援 var()，mount 後讀出實際色值
  const [colors, setColors] = useState<Colors | null>(null)
  useEffect(() => {
    const style = getComputedStyle(document.documentElement)
    setColors(Object.fromEntries(TOKENS.map((t) => [t, style.getPropertyValue(t).trim()])) as Colors)
  }, [])

  const data = monthly.map((m) => {
    const row: Record<string, string | number | null> = { month: m.month, costUsd: m.costUsd }
    // dataKey 不含 model 名稱（Recharts 把字串中的 . 當路徑），以索引為 key
    models.forEach((model, i) => {
      const r = m.byModel[model]
      row[`sev_${i}`] = r?.severity.rate ?? null
      row[`cat_${i}`] = r?.category.rate ?? null
      row[`sevN_${i}`] = r ? `${r.severity.correct}／${r.severity.total}` : '0／0'
      row[`catN_${i}`] = r ? `${r.category.correct}／${r.category.total}` : '0／0'
    })
    return row
  })

  if (!colors) return <div className="ai-stats-chart" aria-hidden="true" />

  const axis = { stroke: colors['--line'], tick: { fill: colors['--fg-muted'], fontSize: 12 } }

  return (
    <div className="ai-stats-chart">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={colors['--line']} strokeDasharray="3 3" />
          <XAxis dataKey="month" {...axis} />
          <YAxis yAxisId="cost" width={48} tickFormatter={(v: number) => `$${v}`} {...axis} />
          <YAxis
            yAxisId="rate"
            orientation="right"
            domain={[0, 1]}
            width={40}
            tickFormatter={(v: number) => pct(v)}
            {...axis}
          />
          <Tooltip
            contentStyle={{ background: 'var(--bg)', border: `1px solid ${colors['--line']}`, color: colors['--fg'] }}
            labelStyle={{ color: colors['--fg'] }}
            formatter={(value, name, item) => {
              const key = String(item.dataKey)
              if (key === 'costUsd') return [`$${Number(value).toFixed(2)}`, name]
              const [kind, idx] = key.split('_')
              const n = (item.payload as Record<string, string>)[`${kind}N_${idx}`]
              return [value === null || value === undefined ? `—（${n}）` : `${pct(Number(value))}（${n}）`, name]
            }}
          />
          <Legend wrapperStyle={{ color: colors['--fg-muted'], fontSize: 12 }} />
          <Bar yAxisId="cost" dataKey="costUsd" name="花費" fill={colors['--gold']} fillOpacity={0.6} />
          {models.flatMap((model, i) => {
            const dash = DASHES[i % DASHES.length]
            return [
              <Line
                key={`sev_${i}`}
                yAxisId="rate"
                dataKey={`sev_${i}`}
                name={`嚴重度 ${model}`}
                stroke={colors['--green']}
                strokeDasharray={dash}
                connectNulls={false}
                dot={{ r: 3 }}
              />,
              <Line
                key={`cat_${i}`}
                yAxisId="rate"
                dataKey={`cat_${i}`}
                name={`類型 ${model}`}
                stroke={colors['--pink']}
                strokeDasharray={dash}
                connectNulls={false}
                dot={{ r: 3 }}
              />,
            ]
          })}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
