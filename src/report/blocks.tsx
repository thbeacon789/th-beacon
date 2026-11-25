// 週報各區塊（Satori 版：只用 flexbox、inline style；每個高度皆取自 LAYOUT / blockHeight）
import type { CSSProperties, ReactNode } from 'react'
import { toOneLine, VERDICT_LABEL, type IssueRow, type ListRow, type SecurityGroupRow, type WeeklyReport } from '@/core/weekly-report'
import { LAYOUT, blockHeight, type ReportBlock } from '@/core/weekly-report-pages'
import type { HealthStatus, Severity } from '@/core/types'
import type { FindingSeverity } from '@/core/security/types'
import {
  COLORS, FONT_BODY, FONT_PIXEL, FONT_TITLE, GAUGE_GRADIENT, HEALTH_COLOR, HEALTH_SHAPE,
  SECURITY_COLOR, SECURITY_SHAPE,
} from './tokens'

type Shape = 'circle' | 'triangle' | 'octagon' | 'unknown'

/** 燈號：形狀＋顏色（形狀同 src/web/icons.tsx，不只靠顏色區分） */
export function Light({ shape, color, size = 28 }: { shape: Shape; color: string; size?: number }) {
  // 外框＋內部符號，同 src/web/icons.tsx（healthy 打勾、degraded「!」、down「X」）
  const paths: Record<Shape, ReactNode[]> = {
    circle: [<circle key="o" cx="12" cy="12" r="9" />, <path key="a" d="M8 12l3 3 5-6" />],
    unknown: [<circle key="o" cx="12" cy="12" r="9" strokeDasharray="3 3" />, <path key="a" d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7" />, <path key="b" d="M12 17v.5" />],
    triangle: [<path key="o" d="M12 3l10 18H2z" />, <path key="a" d="M12 10v4" />, <path key="b" d="M12 17.5v.5" />],
    octagon: [<path key="o" d="M8.5 3h7L21 8.5v7L15.5 21h-7L3 15.5v-7z" />, <path key="a" d="M9 9l6 6" />, <path key="b" d="M15 9l-6 6" />],
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} fillOpacity="0.18" stroke={color} strokeWidth="2.2" strokeLinejoin="miter">
      {paths[shape]}
    </svg>
  )
}

const SEV_COLOR: Record<Severity, string> = { P0: COLORS.pink, P1: COLORS.yellow, P2: COLORS.lilac }
const HEALTH_LABEL: Record<HealthStatus, string> = { healthy: '正常', degraded: '降級', down: '中斷' }
const SEC_LABEL = { ok: '正常', warn: '注意', bad: '異常', unknown: '未知' } as const

const text = (o: CSSProperties = {}): CSSProperties => ({ display: 'flex', fontFamily: FONT_BODY, color: COLORS.fg, ...o })

function Badge({ label, color, solid = false }: { label: string; color: string; solid?: boolean }) {
  return (
    <div style={text({
      fontSize: 16, fontWeight: 700, padding: '2px 10px', color: solid ? COLORS.bg : color,
      backgroundColor: solid ? color : 'transparent', border: `2px solid ${color}`, flexShrink: 0, justifyContent: 'center',
    })}>
      {label}
    </div>
  )
}

function SectionTitle({ label, count }: { label: string; count?: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', height: LAYOUT.sectionTitle, borderBottom: `2px solid ${COLORS.lineStrong}`, paddingBottom: 6 }}>
      <div style={text({ fontFamily: FONT_TITLE, fontSize: 26, fontWeight: 700, color: COLORS.gold, letterSpacing: 1 })}>{label}</div>
      {count !== undefined && (
        <div style={text({ fontFamily: FONT_PIXEL, fontSize: 22, color: COLORS.lilac, marginLeft: 14 })}>{`(${count})`}</div>
      )}
    </div>
  )
}

const row: CSSProperties = { display: 'flex', alignItems: 'center', height: LAYOUT.row, gap: 12 }

export function Header({ report, index, total }: { report: WeeklyReport; index: number; total: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: LAYOUT.header, borderBottom: `2px solid ${COLORS.lineStrong}`, backgroundColor: COLORS.sunken, padding: '0 40px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 20 }}>
        <div style={text({ fontFamily: FONT_TITLE, fontSize: 38, fontWeight: 700, color: COLORS.gold, letterSpacing: 2 })}>TH-BEACON 週報</div>
        <div style={text({ fontFamily: FONT_PIXEL, fontSize: 28, color: COLORS.lilac })}>{report.window.label}</div>
      </div>
      <div style={text({ fontFamily: FONT_PIXEL, fontSize: 28, color: COLORS.lilac })}>{`${index + 1}/${total}`}</div>
    </div>
  )
}

const VERDICT_COLOR: Record<WeeklyReport['verdict'], string> = { ok: COLORS.green, attention: COLORS.yellow, critical: COLORS.pink }
const SCORE: Record<HealthStatus, number> = { healthy: 100, degraded: 50, down: 0 }

function VerdictBlock({ report }: { report: WeeklyReport }) {
  const v = { label: VERDICT_LABEL[report.verdict], color: VERDICT_COLOR[report.verdict] }
  const n = report.services.length
  const score = n === 0 ? 100 : Math.round(report.services.reduce((s, x) => s + SCORE[x.health], 0) / n)
  const barW = 300
  return (
    <div style={{ display: 'flex', alignItems: 'center', height: blockHeight({ kind: 'verdict' }, report), padding: '0 40px', gap: 40, backgroundColor: COLORS.panel, border: `2px solid ${COLORS.line}`, margin: '0 40px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: barW, gap: 10 }}>
        <div style={text({ fontFamily: FONT_PIXEL, fontSize: 44, color: v.color })}>{String(score)}</div>
        <div style={{ display: 'flex', position: 'relative', width: barW, height: 44 }}>
          <div style={{ display: 'flex', position: 'absolute', left: 0, top: 18, width: barW, height: 14, backgroundImage: GAUGE_GRADIENT }} />
          <div style={{ display: 'flex', position: 'absolute', left: Math.round((score / 100) * (barW - 16)), top: 0, width: 0, height: 0, borderLeft: '8px solid transparent', borderRight: '8px solid transparent', borderTop: `18px solid ${COLORS.lilac}` }} />
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
        <div style={text({ fontFamily: FONT_PIXEL, fontSize: 64, color: v.color, lineHeight: 1 })}>{v.label}</div>
        <div style={text({ fontSize: 24, color: COLORS.fgMuted })}>{report.headline}</div>
      </div>
    </div>
  )
}

function StatsBlock({ report }: { report: WeeklyReport }) {
  const s = report.stats
  const cells: Array<[string, number, string]> = [
    ['中斷', s.pollFailures, s.pollFailures > 0 ? COLORS.pink : COLORS.green],
    ['新問題', s.newIssues, s.newIssues > 0 ? COLORS.yellow : COLORS.green],
    ['已解決', s.resolvedIssues, COLORS.green],
    ['告警', s.alertsSent, s.alertsSent > 0 ? COLORS.yellow : COLORS.fg],
  ]
  return (
    <div style={{ display: 'flex', height: blockHeight({ kind: 'stats' }, report), margin: '0 40px', gap: 16 }}>
      {cells.map(([label, n, color]) => (
        <div key={label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 8, backgroundColor: COLORS.panel, border: `2px solid ${COLORS.line}` }}>
          <div style={text({ fontFamily: FONT_PIXEL, fontSize: 56, color, lineHeight: 1 })}>{String(n)}</div>
          <div style={text({ fontSize: 22, color: COLORS.fgMuted })}>{label}</div>
        </div>
      ))}
    </div>
  )
}

function ServicesBlock({ report }: { report: WeeklyReport }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: blockHeight({ kind: 'services' }, report), margin: '0 40px' }}>
      <SectionTitle label="服務" />
      <div style={{ display: 'flex', flexWrap: 'wrap', width: 1120 }}>
        {report.services.map((s) => (
          <div key={s.name} style={{ ...row, height: LAYOUT.serviceRow, width: 560 }}>
            <Light shape={HEALTH_SHAPE[s.health]} color={HEALTH_COLOR[s.health]} />
            <div style={text({ fontSize: 22, fontWeight: 700, maxWidth: 300, flexShrink: 1, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' })}>{s.name}</div>
            <div style={text({ fontSize: 18, color: HEALTH_COLOR[s.health] })}>{HEALTH_LABEL[s.health]}</div>
            {s.openIssues > 0 && <div style={text({ fontSize: 18, color: COLORS.fgMuted })}>{`${s.openIssues} 件未解`}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}

function SecurityBlock({ report }: { report: WeeklyReport }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: blockHeight({ kind: 'security' }, report), margin: '0 40px' }}>
      <SectionTitle label="資安" />
      {report.security.map((s) => {
        const f = s.openFindings
        const parts = (['high', 'medium', 'low'] as FindingSeverity[]).filter((k) => f[k] > 0).map((k) => `${f[k]} ${k}`)
        const note = s.note === 'stale' ? '資料過期' : s.note === 'none' ? '尚無快照' : ''
        return (
          <div key={s.serviceName} style={row}>
            <Light shape={s.status === 'unknown' ? 'unknown' : SECURITY_SHAPE[s.status]} color={SECURITY_COLOR[s.status]} />
            <div style={text({ fontSize: 22, fontWeight: 700, width: 240, flexShrink: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' })}>{s.serviceName}</div>
            <div style={text({ fontSize: 18, color: SECURITY_COLOR[s.status], width: 70 })}>{SEC_LABEL[s.status]}</div>
            <div style={text({ fontSize: 18, color: COLORS.fgMuted, flex: 1, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' })}>{[parts.join('／'), note].filter(Boolean).join(' · ')}</div>
          </div>
        )
      })}
    </div>
  )
}

function IssueLine({ r }: { r: IssueRow }) {
  const recurring = r.reopenCount > 0
  return (
    <div style={row}>
      <div style={{ display: 'flex', width: 52, flexShrink: 0 }}><Badge label={r.severity} color={SEV_COLOR[r.severity]} solid /></div>
      <div style={text({ fontSize: 20, fontWeight: 700, width: 190, flexShrink: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' })}>{r.serviceName}</div>
      <div style={text({ fontSize: 20, color: COLORS.fgMuted, flex: 1, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' })}>{toOneLine(r.message, 48)}</div>
      {r.acknowledgedBy && <Badge label={`已確認 · ${toOneLine(r.acknowledgedBy, 12)}`} color={COLORS.lilac} />}
      {recurring && <div style={text({ fontSize: 18, color: COLORS.yellow, flexShrink: 0 })}>{`重開 ${r.reopenCount} 次`}</div>}
      {recurring && <div style={text({ fontSize: 18, color: r.status === 'resolved' ? COLORS.green : COLORS.pink, flexShrink: 0 })}>{r.status === 'resolved' ? '已再次解決' : '仍未解'}</div>}
      {r.isNew && <Badge label="NEW" color={COLORS.green} solid />}
      <div style={text({ fontFamily: FONT_PIXEL, fontSize: 22, color: COLORS.gold, flexShrink: 0 })}>{`${r.daysOpen} 天`}</div>
      <div style={text({ fontFamily: FONT_PIXEL, fontSize: 22, color: COLORS.lilac, flexShrink: 0 })}>{`×${r.count}`}</div>
    </div>
  )
}

function SecurityLine({ r }: { r: SecurityGroupRow }) {
  const parts = (['high', 'medium', 'low'] as FindingSeverity[]).filter((k) => r.counts[k] > 0).map((k) => `${r.counts[k]} ${k}`)
  return (
    <div style={row}>
      <Badge label="資安" color={COLORS.lilac} />
      <div style={text({ fontSize: 20, flex: 1, overflow: 'hidden', whiteSpace: 'nowrap' })}>{`${r.serviceName}：${parts.join('／')}，最久 ${r.oldestDays} 天`}</div>
      {r.isNew && <Badge label="NEW" color={COLORS.green} solid />}
    </div>
  )
}

function ListBlock({ block, report }: { block: Extract<ReportBlock, { kind: 'list' }>; report: WeeklyReport }) {
  const base = block.list === 'longStanding' ? '長期未處理' : '反覆出現'
  const total = (block.list === 'longStanding' ? report.longStanding : report.recurring).length
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: blockHeight(block, report), margin: '0 40px' }}>
      <SectionTitle label={block.continued ? `${base}（續）` : base} count={total} />
      {block.rows.length === 0
        ? <div style={{ ...row }}><div style={text({ fontSize: 20, color: COLORS.fgMuted })}>本週無</div></div>
        : block.rows.map((r: ListRow, i) => (r.kind === 'issue' ? <IssueLine key={i} r={r} /> : <SecurityLine key={i} r={r} />))}
    </div>
  )
}

function OverflowBlock({ remaining, report }: { remaining: number; report: WeeklyReport }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: blockHeight({ kind: 'overflow', remaining }, report), margin: '0 40px', border: `2px dashed ${COLORS.lineStrong}` }}>
      <div style={text({ fontSize: 20, color: COLORS.yellow })}>{`另有 ${remaining} 筆，詳見 dashboard`}</div>
    </div>
  )
}

export function Block({ block, report }: { block: ReportBlock; report: WeeklyReport }) {
  switch (block.kind) {
    case 'verdict': return <VerdictBlock report={report} />
    case 'stats': return <StatsBlock report={report} />
    case 'services': return <ServicesBlock report={report} />
    case 'security': return <SecurityBlock report={report} />
    case 'list': return <ListBlock block={block} report={report} />
    case 'overflow': return <OverflowBlock remaining={block.remaining} report={report} />
  }
}

export function Footer({ text: t }: { text: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', height: LAYOUT.footer, padding: '0 40px', borderTop: `2px solid ${COLORS.lineStrong}`, backgroundColor: COLORS.sunken }}>
      <div style={text({ fontSize: 20, color: COLORS.fgMuted })}>{t}</div>
    </div>
  )
}
