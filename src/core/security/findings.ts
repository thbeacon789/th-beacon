// 注意：本目錄會被 Node 直接執行（type stripping），import 只能用相對路徑加 .ts 副檔名。
import {
  AUTO_RESOLVE_MISSES_COMPUTED,
  AUTO_RESOLVE_MISSES_JUDGED,
  CHANGES_REOPEN_GAP_DAYS,
  MAX_TITLE,
} from './constants.ts'
import { fingerprintOf } from './finding-key.ts'
import { truncateToUtf16Length } from './text.ts'
import type { CertFact, CheckKey, CheckResult, ExposureFact, Finding, ImageDeps, FindingSeverity, LogSourceVolume } from './types.ts'
import type { StoredCheckKey } from './view.ts'

export type SecurityFindingStatus = 'open' | 'resolved' | 'ignored'

export interface SecurityFindingRecord {
  id: string
  serviceId: string
  fingerprint: string
  check: CheckKey
  status: SecurityFindingStatus
  severity: FindingSeverity
  title: string
  recommendation: string
  keyFallback: boolean
  firstSeenAt: string
  lastSeenAt: string
  statusChangedAt: string
  statusChangedBy: string | null
  reopenCount: number
  missedCount: number
}

/**
 * 既有列帶 id＋expectedStatus（reconcile 讀到的 status）：僅在 DB status 仍相符時才更新，
 * 避免蓋掉 list 之後的人工狀態變更。新列不帶：insert，唯一鍵衝突則略過。
 */
export type SecurityFindingWrite = Omit<SecurityFindingRecord, 'id'> & {
  id?: string
  expectedStatus?: SecurityFindingStatus
}

export interface CoverageInput {
  /** deps 只有 vm 帶；缺席（hosted／舊快照）視為未檢查 */
  checks: Record<Exclude<StoredCheckKey, 'deps'>, CheckResult> & { deps?: CheckResult }
  exposure: ExposureFact[]
  logVolume: LogSourceVolume[]
  /** 本次基準足夠、真正完成評估的 logVolume 來源（基準建立中不算檢查過） */
  evaluatedLogSources: string[]
  /** LLM 判讀類發現達上限被截斷：ports／updates／logins 無法確認「沒出現」 */
  judgedTruncated: boolean
  certs: CertFact[]
  /** 本次 deps 明細（vm）；用來排除掃描失敗的映像檔，其既有發現不可算「沒出現」 */
  deps?: ImageDeps[] | null
}

export const MANUAL_TRANSITIONS: Record<SecurityFindingStatus, readonly SecurityFindingStatus[]> = {
  open: ['resolved', 'ignored'],
  resolved: ['ignored'],
  ignored: ['open'],
}

const SEVERITY_RANK: Record<FindingSeverity, number> = { low: 0, medium: 1, high: 2 }
const DAY_MS = 86_400_000
const JUDGED = new Set<CheckKey>(['ports', 'updates', 'logins'])

const checked = (r: CheckResult | undefined) => r?.status === 'ok' || r?.status === 'warn' || r?.status === 'bad'

/** 該筆紀錄本次掃描是否「確實檢查過」，只有如此才可累計 miss 並自動解決 */
export function isCovered(record: Pick<SecurityFindingRecord, 'check' | 'fingerprint'>, cov: CoverageInput): boolean {
  const { check, fingerprint } = record
  const key = fingerprint.slice(fingerprint.indexOf(':') + 1)
  switch (check) {
    case 'ports':
    case 'updates':
    case 'logins':
      return !cov.judgedTruncated && checked(cov.checks[check]) // 含 _fallback（類別級）
    case 'deps':
      // runner 確定性計算，不受 judgedTruncated 影響；整體 warn／bad 仍可能夾帶掃描失敗的映像檔
      if (!checked(cov.checks.deps)) return false
      if (!cov.deps) return true
      return !cov.deps.some((d) => `image:${d.image}` === key && (d.error !== undefined || d.counts === undefined))
    case 'changes':
      return false
    case 'logVolume':
      return cov.evaluatedLogSources.includes(key) && cov.logVolume.some((s) => s.source === key && s.error !== true)
    case 'cert': {
      const domain = key.slice(key.indexOf(':') + 1)
      return cov.certs.some((c) => c.domain === domain)
    }
    case 'exposure': {
      if (cov.checks.exposure?.status === 'unknown') return false
      const sep = key.indexOf(':')
      const kind = key.slice(0, sep)
      const rest = key.slice(sep + 1)
      const domain = kind === 'path' || kind === 'header' ? rest.split('|')[0] : rest
      const fact = cov.exposure.find((e) => e.domain === domain)
      if (!fact) return false
      if (kind === 'path') return fact.probeErrors === 0
      if (kind === 'legacy-tls') return fact.legacyTls !== null
      return kind === 'header'
    }
  }
}

function mergeObserved(observed: Finding[]): Map<string, Finding> {
  const map = new Map<string, Finding>()
  for (const f of observed) {
    const fp = fingerprintOf(f)
    const prev = map.get(fp)
    if (!prev || SEVERITY_RANK[f.severity] > SEVERITY_RANK[prev.severity]) map.set(fp, f)
  }
  return map
}

export function reconcileFindings(input: {
  serviceId: string
  existing: SecurityFindingRecord[]
  observed: Finding[]
  coverage: CoverageInput
  scannedAt: string
}): SecurityFindingWrite[] {
  const { serviceId, existing, coverage, scannedAt } = input
  const observed = mergeObserved(input.observed)
  const existingByFp = new Map(existing.map((r) => [r.fingerprint, r]))
  const out: SecurityFindingWrite[] = []

  for (const [fp, f] of observed) {
    const content = {
      severity: f.severity,
      title: truncateToUtf16Length(f.title, MAX_TITLE),
      recommendation: f.recommendation,
      keyFallback: f.keyFallback === true,
    }
    const prev = existingByFp.get(fp)
    if (!prev) {
      out.push({
        serviceId, fingerprint: fp, check: f.check, status: 'open', ...content,
        firstSeenAt: scannedAt, lastSeenAt: scannedAt, statusChangedAt: scannedAt, statusChangedBy: 'system',
        reopenCount: 0, missedCount: 0,
      })
      continue
    }
    const { id, ...rest } = prev
    const base = { ...rest, id, expectedStatus: prev.status }
    if (prev.status === 'resolved') {
      const gapMs = Date.parse(scannedAt) - Date.parse(prev.lastSeenAt)
      if (prev.check === 'changes' && gapMs <= CHANGES_REOPEN_GAP_DAYS * DAY_MS) {
        out.push({ ...base, lastSeenAt: scannedAt }) // 同一事件的重報
      } else {
        out.push({
          ...base, ...content, status: 'open', lastSeenAt: scannedAt, statusChangedAt: scannedAt,
          statusChangedBy: 'system', reopenCount: prev.reopenCount + 1, missedCount: 0,
        })
      }
    } else if (prev.status === 'ignored') {
      out.push({ ...base, ...content, lastSeenAt: scannedAt })
    } else {
      out.push({ ...base, ...content, lastSeenAt: scannedAt, missedCount: 0 })
    }
  }

  for (const prev of existing) {
    if (observed.has(prev.fingerprint)) continue
    if (prev.status !== 'open' || prev.check === 'changes') continue
    if (!isCovered(prev, coverage)) continue
    const { id, ...rest } = prev
    const base = { ...rest, id, expectedStatus: prev.status }
    const missed = prev.missedCount + 1
    const threshold = JUDGED.has(prev.check) ? AUTO_RESOLVE_MISSES_JUDGED : AUTO_RESOLVE_MISSES_COMPUTED
    out.push(
      missed >= threshold
        ? { ...base, status: 'resolved', missedCount: missed, statusChangedAt: scannedAt, statusChangedBy: 'system' }
        : { ...base, missedCount: missed },
    )
  }
  return out
}

