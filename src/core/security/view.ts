// 讀取端推導：憑證、過期、整體狀態、頁面視圖模型（純函式，時鐘由 now 注入）
import { CERT_BAD_DAYS, FALLBACK_KEY, CERT_WARN_DAYS, STALE_AFTER_HOURS } from './constants.ts'
import type {
  CertFact,
  CheckKey,
  CheckResult,
  CheckStatus,
  ComputedCheckKey,
  Evaluation,
  ExposureFact,
  Finding,
  ImageDeps,
  Inventory,
  JudgedCheckKey,
  LogSourceVolume,
  RunnerCheckKey,
  ScanKind,
} from './types.ts'

export type OverallStatus = 'ok' | 'warn' | 'bad' | 'unknown'
export type StoredCheckKey = JudgedCheckKey | ComputedCheckKey | RunnerCheckKey

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
  /** 映像檔套件漏洞明細；hosted 與舊快照為 null */
  deps: ImageDeps[] | null
}

const DAY_MS = 86400000
const HOUR_MS = 3600000

export const CHECK_ORDER: readonly CheckKey[] = ['ports', 'updates', 'logins', 'deps', 'cert', 'exposure', 'changes', 'logVolume']
export const CHECK_LABEL: Record<CheckKey, string> = {
  ports: '連接埠',
  updates: '待更新',
  logins: '異常登入',
  cert: 'SSL 憑證',
  exposure: '對外暴露',
  changes: '變動',
  logVolume: 'log 量',
  deps: '套件漏洞',
}

export function evaluateCert(certs: CertFact[], now: Date): Evaluation {
  const expiry = evaluateCertExpiry(certs, now)
  if (certs.length === 0) return expiry
  // 不受信任的憑證（自簽、鏈不完整、主機名不符）即使還沒到期也不能顯示為正常
  const untrusted = certs.filter((c) => c.trusted === false)
  if (untrusted.length === 0) return expiry
  const trustFindings: Finding[] = untrusted.map((c) => ({
    check: 'cert',
    key: FALLBACK_KEY,
    severity: 'high',
    title: `${c.domain} 的 SSL 憑證不受信任（${c.error && c.error.length > 0 ? c.error : '未知原因'}）`,
    recommendation: '檢查憑證鏈與網域名稱是否相符，重新簽發憑證',
  }))
  // 不受信任即為 bad（已是最差，取較差者的結果必為此項）；到期判定照常進行，兩筆發現都列出
  return { check: { status: 'bad', summary: '憑證不受信任' }, findings: [...trustFindings, ...expiry.findings] }
}

function evaluateCertExpiry(certs: CertFact[], now: Date): Evaluation {
  if (certs.length === 0) return { check: { status: 'unknown', summary: '未檢查' }, findings: [] }
  const earliest = certs.reduce((a, b) => (Date.parse(b.notAfter) < Date.parse(a.notAfter) ? b : a))
  const diff = Date.parse(earliest.notAfter) - now.getTime()
  const recommendation = '更新憑證，並確認自動續期是否正常'
  if (diff <= 0) {
    return {
      check: { status: 'bad', summary: '已過期' },
      findings: [{ check: 'cert', key: FALLBACK_KEY, severity: 'high', title: `${earliest.domain} 的 SSL 憑證已過期`, recommendation }],
    }
  }
  const days = Math.floor(diff / DAY_MS)
  const summary = `剩 ${days} 天`
  const title = `${earliest.domain} 的 SSL 憑證剩 ${days} 天到期`
  if (days < CERT_BAD_DAYS) {
    return { check: { status: 'bad', summary }, findings: [{ check: 'cert', key: FALLBACK_KEY, severity: 'high', title, recommendation }] }
  }
  if (days < CERT_WARN_DAYS) {
    return { check: { status: 'warn', summary }, findings: [{ check: 'cert', key: FALLBACK_KEY, severity: 'medium', title, recommendation }] }
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

export interface ServiceSecurityRow {
  serviceId: string
  serviceName: string
  scannedAt: string
  stale: boolean
  overall: OverallStatus
  checks: Record<CheckKey, CheckResult>
  logVolume: LogSourceVolume[]
  kind: ScanKind
  deps: ImageDeps[] | null
}
export interface SecurityView {
  /** 掃描停擺的服務名稱；待處理紀錄仍顯示，但標註狀態可能過期 */
  staleServices: Array<{ serviceName: string; hours: number }>
  rows: ServiceSecurityRow[]
}

export function buildSecurityView(
  input: Array<{ serviceName: string; scan: StoredSecurityScan }>,
  now: Date,
): SecurityView {
  const staleServices: Array<{ serviceName: string; hours: number }> = []
  const rows: ServiceSecurityRow[] = []

  for (const { serviceName, scan } of input) {
    const cert = evaluateCert(scan.certs, now)
    const checks: Record<CheckKey, CheckResult> = {
      ...scan.checks,
      cert: cert.check,
      // 舊快照沒有 deps：讀取端補 na（spec §5.9）
      deps: (scan.checks as Partial<Record<CheckKey, CheckResult>>).deps ?? { status: 'na', summary: '' },
    }
    const stale = isScanStale(scan.scannedAt, now)
    rows.push({
      serviceId: scan.serviceId,
      serviceName,
      scannedAt: scan.scannedAt,
      stale,
      overall: stale ? 'unknown' : overallStatus(CHECK_ORDER.map((k) => checks[k].status)),
      checks,
      logVolume: scan.logVolume,
      kind: scan.kind,
      deps: scan.deps ?? null,
    })
    if (stale) staleServices.push({ serviceName, hours: Math.floor((now.getTime() - Date.parse(scan.scannedAt)) / HOUR_MS) })
  }

  rows.sort((a, b) => a.serviceName.localeCompare(b.serviceName))
  return { staleServices, rows }
}
