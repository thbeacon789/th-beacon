import type { LogSourceVolume } from '@/core/security/types'

const HEIGHT = 22
const BAR_WIDTH = 4
const STEP = 5

export function LogSparkline({ sources }: { sources: LogSourceVolume[] }) {
  const source = sources.find((s) => s.hourly && s.hourly.length > 0)
  const hourly = source?.hourly
  if (!source || !hourly) return null
  const anomalous = new Set(source.anomalousHours ?? [])
  const max = Math.max(...hourly.map((h) => h.count), 1)
  return (
    <svg
      className="security-spark"
      width={hourly.length * STEP}
      height={HEIGHT}
      viewBox={`0 0 ${hourly.length * STEP} ${HEIGHT}`}
      role="img"
      aria-label="過去 24 小時 log 量"
    >
      {hourly.map((h, i) => {
        const barHeight = Math.max(1, (h.count / max) * HEIGHT)
        return (
          <rect
            key={h.hour}
            className={anomalous.has(h.hour) ? 'is-anomalous' : undefined}
            x={i * STEP}
            y={HEIGHT - barHeight}
            width={BAR_WIDTH}
            height={barHeight}
          />
        )
      })}
    </svg>
  )
}
