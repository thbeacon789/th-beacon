// 注意：本檔會被 Node 直接執行（type stripping），import 只能用相對路徑加 .ts 副檔名。
import { MAX_SUMMARY, MAX_TITLE } from './constants.ts'
import { truncateToUtf16Length } from './text.ts'
import type { CheckStatus, Evaluation, Finding, ImageDeps } from './types.ts'

const MAX_NAMED = 3
const RECOMMENDATION = '升級映像檔內受影響的套件或基礎映像檔後重建部署'

type DepsInput = { images: ImageDeps[] } | { failed: true } | { none: true }

/** 以每映像檔的掃描摘要判 deps 燈號（規則見 image-deps-scan spec §5.3） */
export function evaluateDeps(input: DepsInput): Evaluation {
  if ('none' in input) return { check: { status: 'na', summary: '' }, findings: [] }
  if ('failed' in input) return { check: { status: 'unknown', summary: '無法取得容器映像檔清單' }, findings: [] }

  const { images } = input
  if (images.length === 0) return { check: { status: 'na', summary: '' }, findings: [] }

  const scanFailed = images.filter((i) => i.error !== undefined || !i.counts).length
  const critical = images.reduce((n, i) => n + (i.counts?.critical ?? 0), 0)
  const high = images.reduce((n, i) => n + (i.counts?.high ?? 0), 0)
  const flagged = images.filter((i) => (i.counts?.critical ?? 0) > 0 || (i.counts?.high ?? 0) > 0)

  let status: CheckStatus = 'ok'
  if (images.some((i) => (i.counts?.critical ?? 0) > 0)) status = 'bad'
  else if (high > 0) status = 'warn'
  else if (scanFailed > 0) status = 'unknown'

  const findings: Finding[] = []
  for (const i of flagged) {
    const c = i.counts!
    const isCritical = c.critical > 0
    const title = truncateToUtf16Length(
      `映像檔 ${i.image} 有 ${isCritical ? `critical ${c.critical}、` : ''}high ${c.high} 個漏洞套件`,
      MAX_TITLE,
    )
    findings.push({ check: 'deps', key: `image:${i.image}`, severity: isCritical ? 'high' : 'medium', title, recommendation: RECOMMENDATION })
  }
  // critical 的排前面（穩定排序，同級維持輸入順序）
  findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1))

  return { check: { status, summary: buildSummary(images.length, critical, high, flagged, scanFailed) }, findings }
}

function buildSummary(total: number, critical: number, high: number, flagged: ImageDeps[], scanFailed: number): string {
  const counts: string[] = []
  if (critical > 0) counts.push(`critical ${critical}`)
  if (high > 0) counts.push(`high ${high}`)
  const head = `${total} 個映像檔：`
  const tail = scanFailed > 0 ? `；${scanFailed} 個未能掃描` : ''
  if (counts.length === 0) {
    return truncateToUtf16Length(scanFailed > 0 ? `${head}${tail.slice(1)}` : `${total} 個映像檔皆無嚴重漏洞`, MAX_SUMMARY)
  }
  const body = counts.join('、')
  const more = flagged.length > MAX_NAMED ? '等' : ''
  const names = flagged.slice(0, MAX_NAMED).map((i) => i.image).join('、')
  // 名稱可能很長：保留數量與未能掃描數，只截名稱
  const budget = MAX_SUMMARY - head.length - body.length - tail.length - 2 - more.length
  const shown = budget > 0 ? truncateToUtf16Length(names, budget) : ''
  const namePart = shown ? `（${shown}${more}）` : ''
  return truncateToUtf16Length(`${head}${body}${namePart}${tail}`, MAX_SUMMARY)
}
