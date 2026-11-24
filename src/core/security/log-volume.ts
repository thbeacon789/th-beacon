import type { Evaluation, Finding, HourCount, LogSourceVolume, ScanKind } from './types.ts'
import { LOG_BASELINE_MIN_SCANS, LOG_SPIKE_MIN_EXCESS, LOG_SPIKE_RATIO } from './constants.ts'

const HOUR_MS = 3600_000

// 同一 hour 重複時取最後一筆
function dedupeHours(hourly: HourCount[]): HourCount[] {
  const byHour = new Map<string, HourCount>()
  for (const h of hourly) byHour.set(h.hour, h)
  return [...byHour.values()]
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function hhmm(ms: number): string {
  return `${String(new Date(ms).getUTCHours()).padStart(2, '0')}:00`
}

export function evaluateLogVolume(
  kind: ScanKind,
  current: LogSourceVolume[] | undefined,
  history: LogSourceVolume[][],
): Evaluation & { logVolume: LogSourceVolume[] } {
  if (kind === 'hosted' || !current || current.length === 0) {
    return { check: { status: 'na', summary: '' }, findings: [], logVolume: [] }
  }

  const findings: Finding[] = []
  const logVolume: LogSourceVolume[] = []
  let hasError = false
  let insufficient = false
  let maxRatio = 0
  let anyAnomaly = false
  let zeroBaselineSpike = false

  for (const src of current) {
    if (src.error || !src.hourly) {
      if (src.error) hasError = true
      logVolume.push({ ...src })
      continue
    }

    const counts: number[] = []
    let scans = 0
    for (const snapshot of history) {
      let counted = false
      for (const h of snapshot) {
        if (h.source !== src.source || h.error || !h.hourly) continue
        counted = true
        for (const hc of dedupeHours(h.hourly)) counts.push(hc.count)
      }
      if (counted) scans++
    }

    const hourly = dedupeHours(src.hourly)
    if (scans < LOG_BASELINE_MIN_SCANS || counts.length === 0) {
      insufficient = true
      logVolume.push({ ...src, hourly, anomalousHours: [] })
      continue
    }

    const baseline = median(counts)
    const anomalous = hourly.filter(
      (h) => h.count > baseline * LOG_SPIKE_RATIO && h.count - baseline >= LOG_SPIKE_MIN_EXCESS,
    )
    logVolume.push({ ...src, hourly, anomalousHours: anomalous.map((h) => h.hour) })
    if (anomalous.length === 0) continue

    anyAnomaly = true
    const times = anomalous.map((h) => new Date(h.hour).getTime()).sort((a, b) => a - b)
    const range = `${hhmm(times[0])}–${hhmm(times[times.length - 1] + HOUR_MS)} UTC`
    let title: string
    if (baseline === 0) {
      zeroBaselineSpike = true
      title = `${src.source} 在 ${range} 的 log 量暴增（平常幾乎為 0）`
    } else {
      const ratio = Math.max(...anomalous.map((h) => h.count / baseline))
      maxRatio = Math.max(maxRatio, ratio)
      title = `${src.source} 在 ${range} 的 log 量為平常的 ${Math.round(ratio)} 倍`
    }
    findings.push({
      check: 'logVolume',
      key: src.source,
      severity: 'high',
      title,
      recommendation: '檢查該時段的存取紀錄與來源 IP，確認是攻擊、爬蟲或程式異常',
    })
  }

  if (anyAnomaly) {
    // 只要有任一基準為 0 的異常，倍數無從計算，summary 一律為「暴增」
    const summary = zeroBaselineSpike ? '暴增' : `暴增 ${Math.round(maxRatio)} 倍`
    return { check: { status: 'bad', summary }, findings, logVolume }
  }
  if (hasError) return { check: { status: 'unknown', summary: '來源讀不到' }, findings, logVolume }
  if (insufficient) return { check: { status: 'unknown', summary: '基準建立中' }, findings, logVolume }
  return { check: { status: 'ok', summary: '正常' }, findings, logVolume }
}
