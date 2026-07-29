import type { HealthSummary } from '@/web/queries'

/**
 * 總體健康度半圓指示燈。
 * 移植自 trading-stream 的 mood meter（src/app/mood-meter/page.jsx ＋ public/score_bar.svg）：
 * 同一條 pink→yellow→green 漸層弧與 lilac 三角指針，色值與本專案調色盤完全一致。
 * 差別是這裡改成 inline SVG 的 server component——資料在伺服器就備妥，不需要 client state。
 */

const LABEL: Record<HealthSummary['worst'], string> = {
  healthy: 'All Healthy',
  degraded: 'Degraded',
  down: 'Down',
}

export function HealthGauge({ summary }: { summary: HealthSummary }) {
  // 0 → 左端（-90deg，pink）；100 → 右端（90deg，green）
  const angle = (summary.score / 100) * 180 - 90

  return (
    <section className="gauge-block" aria-labelledby="gauge-title">
      <div className="gauge">
        <svg
          className="gauge-arc"
          viewBox="0 0 189 92"
          role="img"
          aria-label={`總體健康度 ${summary.score} 分，狀態 ${LABEL[summary.worst]}`}
        >
          <defs>
            <linearGradient id="gauge-scale" x1="0" y1="45.82" x2="189" y2="45.82"
              gradientUnits="userSpaceOnUse">
              <stop stopColor="#ff7db2" />
              <stop offset="0.5" stopColor="#ffd561" />
              <stop offset="1" stopColor="#82ff9a" />
            </linearGradient>
          </defs>
          <path
            d="M94.5 17.18C136.91 17.18 171.28 50.51 171.28 91.63H189C189 41.03 146.69 0 94.5 0C42.31 0 0 41.03 0 91.64H17.72C17.72 50.52 52.09 17.18 94.5 17.18Z"
            fill="url(#gauge-scale)"
          />
        </svg>

        {/* 指針：以半圓底部中心為軸旋轉 */}
        <div className="gauge-needle" style={{ transform: `translateX(-50%) rotate(${angle}deg)` }}>
          <span className="gauge-needle-head" />
        </div>

        <div className={`gauge-score status-${summary.worst}`}>{summary.score}</div>
      </div>

      <div className="gauge-readout">
        <h2 id="gauge-title" className={`gauge-label status-${summary.worst}`}>
          {LABEL[summary.worst]}
        </h2>
        <dl className="gauge-counts">
          <div>
            <dt>Healthy</dt>
            <dd className="status-healthy">{summary.counts.healthy}</dd>
          </div>
          <div>
            <dt>Degraded</dt>
            <dd className="status-degraded">{summary.counts.degraded}</dd>
          </div>
          <div>
            <dt>Down</dt>
            <dd className="status-down">{summary.counts.down}</dd>
          </div>
        </dl>
        <p className="hint">
          指針位置為 {summary.total} 項服務的健康度平均；文字與顏色取最差值，單一服務中斷不會被平均掩蓋。
        </p>
      </div>
    </section>
  )
}
