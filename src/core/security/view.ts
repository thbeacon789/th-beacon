// 讀取端推導：憑證、過期、整體狀態、頁面視圖模型（純函式，時鐘由 now 注入）
import { CERT_BAD_DAYS, CERT_WARN_DAYS, STALE_AFTER_HOURS } from './constants.ts'
import type {
  CertFact,
  CheckKey,
  CheckResult,
  CheckStatus,
  ComputedCheckKey,
  Evaluation,
  ExposureFact,
  Finding,
  FindingSeverity,
  Inventory,
  JudgedCheckKey,
  LogSourceVolume,
  ScanKind,
} from './types.ts'

export type OverallStatus = 'ok' | 'warn' | 'bad' | 'unknown'
export type StoredCheckKey = JudgedCheckKey | ComputedCheckKey

export interface StoredSecurityScan {
  id: string
  serviceId: string
  scannedAt: string
  kind: ScanKind
  checks: Record<StoredCheckKey, CheckResult>
  findings: Finding[]
  certs: CertFact[]
  logVolume: LogSourceVolume[]
  exposure: ExposureFact[]
  inventory: Inventory | null
}

const DAY_MS = 86400000
const HOUR_MS = 3600000

export const CHECK_ORDER: readonly CheckKey[] = ['ports', 'updates', 'logins', 'cert', 'exposure', 'changes', 'logVolume']
export const CHECK_LABEL: Record<CheckKey, string> = {
  ports: '連接埠',
  updates: '待更新',
  logins: '異常登入',
  cert: 'SSL 憑證',
  exposure: '對外暴露',
  changes: '變動',
  logVolume: 'log 量',
}

export function evaluateCert(certs: CertFact[], now: Date): Evaluation {
  if (certs.length === 0) return { check: { status: 'unknown', summary: '未檢查' }, findings: [] }
  const earliest = certs.reduce((a, b) => (Date.parse(b.notAfter) < Date.parse(a.notAfter) ? b : a))
  const diff = Date.parse(earliest.notAfter) - now.getTime()
  const recommendation = '更新憑證，並確認自動續期是否正常'
  if (diff <= 0) {
    return {
      check: { status: 'bad', summary: '已過期' },
      findings: [{ check: 'cert', severity: 'high', title: `${earliest.domain} 的 SSL 憑證已過期`, recommendation }],
    }
  }
  const days = Math.floor(diff / DAY_MS)
  const summary = `剩 ${days} 天`
  const title = `${earliest.domain} 的 SSL 憑證剩 ${days} 天到期`
  if (days < CERT_BAD_DAYS) {
    return { check: { status: 'bad', summary }, findings: [{ check: 'cert', severity: 'high', title, recommendation }] }
  }
  if (days < CERT_WARN_DAYS) {
    return { check: { status: 'warn', summary }, findings: [{ check: 'cert', severity: 'medium', title, recommendation }] }
  }
  return { check: { status: 'ok', summary }, findings: [] }
}

export function isScanStale(scannedAt: string, now: Date): boolean {
  return now.getTime() - Date.parse(scannedAt) > STALE_AFTER_HOURS * HOUR_MS
}

const OVERALL_RANK: Record<OverallStatus, number> = { ok: 0, unknown: 1, warn: 2, bad: 3 }

export function overallStatus(statuses: CheckStatus[]): OverallStatus {
  let worst: OverallStatus | null = null
  for (const s of statuses) {
    if (s === 'na') continue
    if (worst === null || OVERALL_RANK[s] > OVERALL_RANK[worst]) worst = s
  }
  return worst ?? 'unknown'
}

export interface TodoItem {
  serviceName: string
  severity: FindingSeverity
  check: CheckKey | 'scan'
  title: string
  recommendation: string
}
export interface ServiceSecurityRow {
  serviceId: string
  serviceName: string
  scannedAt: string
  stale: boolean
  overall: OverallStatus
  checks: Record<CheckKey, CheckResult>
  logVolume: LogSourceVolume[]
}
export interface SecurityView {
  todos: TodoItem[]
  rows: ServiceSecurityRow[]
}

const SEVERITY_RANK: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2 }
const checkRank = (c: CheckKey | 'scan') => (c === 'scan' ? -1 : CHECK_ORDER.indexOf(c))

export function buildSecurityView(
  input: Array<{ serviceName: string; scan: StoredSecurityScan }>,
  now: Date,
): SecurityView {
  const todos: TodoItem[] = []
  const rows: ServiceSecurityRow[] = []

  for (const { serviceName, scan } of input) {
    const cert = evaluateCert(scan.certs, now)
    const checks: Record<CheckKey, CheckResult> = { ...scan.checks, cert: cert.check }
    const stale = isScanStale(scan.scannedAt, now)
    rows.push({
      serviceId: scan.serviceId,
      serviceName,
      scannedAt: scan.scannedAt,
      stale,
      overall: stale ? 'unknown' : overallStatus(CHECK_ORDER.map((k) => checks[k].status)),
      checks,
      logVolume: scan.logVolume,
    })
    if (stale) {
      const hours = Math.floor((now.getTime() - Date.parse(scan.scannedAt)) / HOUR_MS)
      todos.push({
        serviceName,
        severity: 'high',
        check: 'scan',
        title: `資安掃描已停擺 ${hours} 小時`,
        recommendation: '檢查 GitHub Actions 的 security-scan workflow',
      })
    } else {
      for (const fd of [...scan.findings, ...cert.findings]) {
        todos.push({ serviceName, severity: fd.severity, check: fd.check, title: fd.title, recommendation: fd.recommendation })
      }
    }
  }

  todos.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.serviceName.localeCompare(b.serviceName) ||
      checkRank(a.check) - checkRank(b.check),
  )
  rows.sort((a, b) => a.serviceName.localeCompare(b.serviceName))
  return { todos, rows }
}
